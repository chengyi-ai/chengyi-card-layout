(function (root) {
  'use strict';

  const DB_NAME = 'chengyi-card-drafts-v2';
  const DB_VERSION = 1;
  const STORE_NAME = 'draft-stores';
  const CHANNEL_NAME = 'chengyi-card-drafts-updates-v1';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function requiredAccountId(value) {
    const accountId = String(value || '').trim();
    if (!accountId) throw new TypeError('accountId 不能为空');
    return accountId;
  }

  function requestResult(request, fallbackMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(fallbackMessage));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('草稿数据库事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('草稿数据库事务已中止'));
    });
  }

  class CardDraftRepository {
    constructor(options = {}) {
      this.indexedDB = Object.prototype.hasOwnProperty.call(options, 'indexedDB')
        ? options.indexedDB
        : root.indexedDB;
      this.BroadcastChannel = Object.prototype.hasOwnProperty.call(options, 'BroadcastChannel')
        ? options.BroadcastChannel
        : root.BroadcastChannel;
      this.dbName = String(options.dbName || DB_NAME);
      this.clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this._dbPromise = null;
      this._listeners = new Set();
      this._channel = typeof this.BroadcastChannel === 'function'
        ? new this.BroadcastChannel(CHANNEL_NAME)
        : null;
      if (this._channel) {
        this._channel.onmessage = (event) => {
          const message = event?.data;
          if (!message || message.clientId === this.clientId || !message.accountId) return;
          this._listeners.forEach((listener) => listener(message));
        };
      }
    }

    async open() {
      if (!this.indexedDB || typeof this.indexedDB.open !== 'function') {
        throw new Error('此浏览器不支持大容量草稿存储');
      }
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = this.indexedDB.open(this.dbName, DB_VERSION);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'accountId' });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () => reject(request.error || new Error('无法打开草稿数据库'));
        request.onblocked = () => reject(new Error('草稿数据库升级被其他页面阻止，请关闭旧页面后重试'));
      }).catch((error) => {
        this._dbPromise = null;
        throw error;
      });
      return this._dbPromise;
    }

    async load(accountIdInput) {
      const accountId = requiredAccountId(accountIdInput);
      const database = await this.open();
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const complete = transactionComplete(transaction);
      const record = await requestResult(
        transaction.objectStore(STORE_NAME).get(accountId),
        '读取本机草稿失败',
      );
      await complete;
      return record?.store ? clone(record.store) : null;
    }

    async save(accountIdInput, store) {
      const accountId = requiredAccountId(accountIdInput);
      const database = await this.open();
      const record = {
        accountId,
        updatedAt: Date.now(),
        store: clone(store),
      };
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const complete = transactionComplete(transaction);
      await requestResult(transaction.objectStore(STORE_NAME).put(record), '保存本机草稿失败');
      await complete;
      this._channel?.postMessage({
        type: 'saved',
        accountId,
        updatedAt: record.updatedAt,
        clientId: this.clientId,
      });
      return clone(record.store);
    }

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    close() {
      this._channel?.close?.();
      this._listeners.clear();
      if (this._dbPromise) this._dbPromise.then((database) => database.close()).catch(() => {});
      this._dbPromise = null;
    }
  }

  class CardDraftCloudSync {
    constructor(options = {}) {
      this.endpoint = String(options.endpoint || '/api/card-drafts');
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      this.onRemoteStore = typeof options.onRemoteStore === 'function' ? options.onRemoteStore : async () => null;
      this.getLocalStore = typeof options.getLocalStore === 'function' ? options.getLocalStore : () => null;
      this.accountId = '';
      this.client = null;
      this.etag = '';
      this.timer = null;
      this.pendingStore = null;
      this.syncing = false;
      this.retryDelay = 2500;
      this.generation = 0;
    }

    async _client() {
      if (this.client) return this.client;
      const config = root.CHENGYI_CLOUD_CONFIG || {};
      if (!config.supabaseUrl || !config.supabasePublishableKey || !root.supabase?.createClient) return null;
      this.client = root.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
      return this.client;
    }

    async _token(expectedAccountId = this.accountId) {
      const client = await this._client();
      if (!client) return '';
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const session = data?.session;
      if (!session?.access_token || String(session.user?.id || '') !== String(expectedAccountId || '')) return '';
      return session.access_token;
    }

    async _request(method, store, generation = this.generation) {
      const token = await this._token();
      if (!token || generation !== this.generation) return { unavailable: true };
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      };
      if (method === 'PUT') {
        headers['content-type'] = 'application/json';
        if (this.etag) headers['if-match'] = this.etag;
      }
      const response = await fetch(this.endpoint, {
        method,
        headers,
        body: method === 'PUT' ? JSON.stringify({ store }) : undefined,
        cache: 'no-store',
      });
      if (generation !== this.generation) return { stale: true };
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      if (response.status === 401) return { unavailable: true };
      if (response.status === 409) {
        this.etag = response.headers.get('etag') || '';
        return { conflict: true, store: payload?.store || null };
      }
      if (!response.ok) throw new Error(payload?.error || `云端草稿请求失败（${response.status}）`);
      this.etag = response.headers.get('etag') || this.etag;
      return { store: payload?.store || null };
    }

    async init(accountIdInput) {
      const accountId = String(accountIdInput || '').trim();
      this.generation += 1;
      const generation = this.generation;
      clearTimeout(this.timer);
      this.timer = null;
      this.pendingStore = null;
      this.accountId = accountId;
      this.etag = '';
      this.retryDelay = 2500;
      if (!accountId) {
        this.onStatus('temporary');
        return null;
      }
      this.onStatus('connecting');
      try {
        const result = await this._request('GET', null, generation);
        if (generation !== this.generation || result.stale) return null;
        if (result.unavailable) {
          this.onStatus('local-only');
          return null;
        }
        let merged = this.getLocalStore();
        if (result.store) merged = await this.onRemoteStore(result.store);
        this.onStatus('connected');
        if (merged) this.scheduleSave(merged, 100);
        return merged;
      } catch (error) {
        if (generation === this.generation) this.onStatus('offline', error.message || '云端暂不可用');
        return null;
      }
    }

    scheduleSave(store, delay = 1600) {
      if (!this.accountId || !store) return false;
      this.pendingStore = clone(store);
      clearTimeout(this.timer);
      this.onStatus('pending');
      this.timer = setTimeout(() => this.flush(), delay);
      return true;
    }

    async flush() {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.syncing || !this.pendingStore || !this.accountId) return false;
      const generation = this.generation;
      const store = this.pendingStore;
      this.pendingStore = null;
      this.syncing = true;
      this.onStatus('syncing');
      try {
        let result = await this._request('PUT', store, generation);
        if (generation !== this.generation || result.stale) return false;
        if (result.unavailable) {
          this.onStatus('local-only');
          return false;
        }
        if (result.conflict) {
          const merged = await this.onRemoteStore(result.store);
          result = await this._request('PUT', merged || this.getLocalStore(), generation);
          if (result.conflict) throw new Error('另一台设备刚刚更新了草稿，将稍后重新合并');
        }
        this.retryDelay = 2500;
        this.onStatus('synced');
        return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        this.pendingStore = clone(this.getLocalStore() || store);
        this.onStatus('offline', error.message || '云端同步失败');
        const retryAfter = this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
        this.timer = setTimeout(() => this.flush(), retryAfter);
        return false;
      } finally {
        if (generation === this.generation) {
          this.syncing = false;
          if (this.pendingStore && !this.timer) this.timer = setTimeout(() => this.flush(), 200);
        }
      }
    }
  }

  root.CardDraftStorage = Object.freeze({
    CardDraftRepository,
    CardDraftCloudSync,
    constants: Object.freeze({ databaseName: DB_NAME, databaseVersion: DB_VERSION, storeName: STORE_NAME }),
  });
})(globalThis);
