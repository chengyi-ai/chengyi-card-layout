(function (root) {
  'use strict';

  const DB_NAME = 'chengyi-card-drafts-v2';
  const DB_VERSION = 1;
  const STORE_NAME = 'draft-stores';
  const CHANNEL_NAME = 'chengyi-card-drafts-updates-v1';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  const LOCAL_PARTITION = 'local';

  // 同 ID 取较新版本；相同时间优先保留本机版本，并尊重较新的删除记录。
  function mergeLocalStores(stores) {
    const drafts = new Map();
    const deletedDrafts = {};
    let activeId = null;
    let schemaVersion = 2;
    for (const store of stores.filter(Boolean)) {
      if (!Array.isArray(store.drafts)) throw new Error('草稿数据结构不正确');
      schemaVersion = Math.max(schemaVersion, Number(store.schemaVersion) || 2);
      activeId ||= store.activeId;
      for (const [id, time] of Object.entries(store.deletedDrafts || {})) {
        deletedDrafts[id] = Math.max(Number(deletedDrafts[id]) || 0, Number(time) || 0);
      }
      for (const draft of store.drafts || []) {
        const previous = drafts.get(draft.id);
        if (!previous || Number(draft.updatedAt || 0) > Number(previous.updatedAt || 0)) {
          const { accountId, ...localDraft } = clone(draft);
          drafts.set(draft.id, localDraft);
        }
      }
    }
    for (const [id, draft] of drafts) {
      if (deletedDrafts[id] && deletedDrafts[id] >= Number(draft.updatedAt || 0)) drafts.delete(id);
    }
    return { schemaVersion, drafts: [...drafts.values()], deletedDrafts,
      activeId: drafts.has(activeId) ? activeId : ([...drafts.keys()][0] || null) };
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

    async migrateLegacy() {
      const database = await this.open();
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const complete = transactionComplete(transaction);
      const store = transaction.objectStore(STORE_NAME);
      // 在同一个事务中读取、合并并标记；失败时原分区和迁移标记均不改变。
      const request = store.getAll();
      let migrationError = null;
      request.onsuccess = () => {
        try {
          const records = request.result || [];
          const local = records.find((record) => record.accountId === LOCAL_PARTITION);
          if (local?.legacyMigrationComplete) return;
          const stores = [local?.store, ...records.filter((r) => r !== local).map((r) => r.store)];
          const merged = stores.some(Boolean) ? mergeLocalStores(stores) : null;
          store.put({ accountId: LOCAL_PARTITION, store: merged,
            updatedAt: Date.now(), legacyMigrationComplete: true });
        } catch (error) { migrationError = error; transaction.abort(); }
      };
      try { await complete; } catch (error) { throw migrationError || error; }
    }

    async load(accountIdInput) {
      const accountId = LOCAL_PARTITION;
      await this.migrateLegacy();
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
      await this.migrateLegacy();
      const accountId = LOCAL_PARTITION;
      const database = await this.open();
      const record = {
        accountId,
        legacyMigrationComplete: true,
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

  root.CardDraftStorage = Object.freeze({
    CardDraftRepository,
    mergeLocalStores,
    constants: Object.freeze({ databaseName: DB_NAME, databaseVersion: DB_VERSION, storeName: STORE_NAME }),
  });
})(globalThis);
