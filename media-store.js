const CARD_MEDIA_DB_NAME = 'chengyi-card-media-v1';
const CARD_MEDIA_DB_VERSION = 1;
const CARD_MEDIA_STORE_NAME = 'media-assets';
const CARD_MEDIA_DRAFT_INDEX = 'by-draft';

function requiredScopePart(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} 不能为空`);
  return text;
}

function normalizeScope(scope, needsMedia = true) {
  const normalized = {
    accountId: requiredScopePart(scope?.accountId, 'accountId'),
    draftId: requiredScopePart(scope?.draftId, 'draftId'),
  };
  if (needsMedia) {
    normalized.mediaId = requiredScopePart(scope?.mediaId, 'mediaId');
    normalized.role = requiredScopePart(scope?.role, 'role');
  }
  return normalized;
}

// JSON 数组不会因账号、草稿或文件名里包含常见分隔符而产生键碰撞。
export function buildMediaKey(scope) {
  const value = normalizeScope(scope, true);
  return JSON.stringify([value.accountId, value.draftId, value.mediaId, value.role]);
}

export function buildDraftKey(scope) {
  const value = normalizeScope(scope, false);
  return JSON.stringify([value.accountId, value.draftId]);
}

function assertBlob(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
    throw new TypeError('blob 必须是浏览器 Blob 或 File');
  }
}

function requestResult(request, fallbackMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(fallbackMessage));
  });
}

// IndexedDB 的 request 成功只代表操作进入事务，必须继续等 complete 才算真正落盘。
function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('媒体数据库事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('媒体数据库事务已中止'));
  });
}

function publicAsset(record) {
  if (!record) return null;
  return {
    accountId: record.accountId,
    draftId: record.draftId,
    mediaId: record.mediaId,
    role: record.role,
    blob: record.blob,
    metadata: record.metadata ?? null,
    mimeType: record.mimeType || record.blob?.type || '',
    size: Number(record.size || record.blob?.size || 0),
    createdAt: Number(record.createdAt || 0),
    updatedAt: Number(record.updatedAt || 0),
  };
}

function hasNamedItem(collection, name) {
  return Boolean(collection && (
    (typeof collection.contains === 'function' && collection.contains(name))
    || Array.from(collection).includes(name)
  ));
}

export class CardMediaStore {
  constructor(options = {}) {
    this.indexedDB = Object.prototype.hasOwnProperty.call(options, 'indexedDB')
      ? options.indexedDB
      : globalThis.indexedDB;
    this.dbName = String(options.dbName || CARD_MEDIA_DB_NAME);
    this._dbPromise = null;
  }

  async open() {
    if (!this.indexedDB || typeof this.indexedDB.open !== 'function') {
      throw new Error('此浏览器不支持 IndexedDB，无法保存图片、视频或 Live Photo 素材。');
    }
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = this.indexedDB.open(this.dbName, CARD_MEDIA_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = hasNamedItem(database.objectStoreNames, CARD_MEDIA_STORE_NAME)
          ? request.transaction.objectStore(CARD_MEDIA_STORE_NAME)
          : database.createObjectStore(CARD_MEDIA_STORE_NAME, { keyPath: 'key' });
        if (!hasNamedItem(store.indexNames, CARD_MEDIA_DRAFT_INDEX)) {
          store.createIndex(CARD_MEDIA_DRAFT_INDEX, 'draftKey', { unique: false });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error('无法打开媒体数据库'));
      request.onblocked = () => reject(new Error('媒体数据库升级被其他页面阻止，请关闭旧页面后重试'));
    }).catch((error) => {
      this._dbPromise = null;
      throw error;
    });

    return this._dbPromise;
  }

  close() {
    if (!this._dbPromise) return;
    this._dbPromise.then((database) => database.close()).catch(() => {});
    this._dbPromise = null;
  }

  async put({ accountId, draftId, mediaId, role, blob, metadata = null }) {
    const scope = normalizeScope({ accountId, draftId, mediaId, role }, true);
    assertBlob(blob);
    const database = await this.open();
    const existing = await this.get(scope);
    const now = Date.now();
    const record = {
      ...scope,
      key: buildMediaKey(scope),
      draftKey: buildDraftKey(scope),
      blob,
      metadata,
      mimeType: blob.type || '',
      size: blob.size,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(CARD_MEDIA_STORE_NAME).put(record);
    await requestResult(request, '媒体素材保存失败');
    await complete;
    return publicAsset(record);
  }

  async get(scopeInput) {
    const scope = normalizeScope(scopeInput, true);
    const database = await this.open();
    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readonly');
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(CARD_MEDIA_STORE_NAME).get(buildMediaKey(scope));
    const record = await requestResult(request, '媒体素材读取失败');
    await complete;
    return publicAsset(record);
  }

  async delete(scopeInput) {
    const scope = normalizeScope(scopeInput, true);
    const database = await this.open();
    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(CARD_MEDIA_STORE_NAME).delete(buildMediaKey(scope));
    await requestResult(request, '媒体素材删除失败');
    await complete;
    return true;
  }

  async listDraft(scopeInput) {
    const scope = normalizeScope(scopeInput, false);
    const database = await this.open();
    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readonly');
    const complete = transactionComplete(transaction);
    const request = transaction
      .objectStore(CARD_MEDIA_STORE_NAME)
      .index(CARD_MEDIA_DRAFT_INDEX)
      .getAll(buildDraftKey(scope));
    const records = await requestResult(request, '草稿媒体读取失败');
    await complete;
    return (records || [])
      .map(publicAsset)
      .sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.role.localeCompare(b.role));
  }

  async deleteDraft(scopeInput) {
    const assets = await this.listDraft(scopeInput);
    if (!assets.length) return 0;
    const database = await this.open();
    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    const store = transaction.objectStore(CARD_MEDIA_STORE_NAME);
    const requests = assets.map((asset) => requestResult(store.delete(buildMediaKey(asset)), '草稿媒体删除失败'));
    await Promise.all(requests);
    await complete;
    return assets.length;
  }

  async cloneDraft(sourceScope, targetScope, options = {}) {
    const source = normalizeScope(sourceScope, false);
    const target = normalizeScope(targetScope, false);
    const assets = await this.listDraft(source);
    if (!assets.length) return [];
    const database = await this.open();
    const now = Date.now();
    const mapMediaId = options.mapMediaId;
    const records = assets.map((asset) => {
      let mediaId = asset.mediaId;
      if (typeof mapMediaId === 'function') mediaId = mapMediaId(asset.mediaId, asset);
      else if (mapMediaId && Object.prototype.hasOwnProperty.call(mapMediaId, asset.mediaId)) mediaId = mapMediaId[asset.mediaId];
      const scope = normalizeScope({ ...target, mediaId, role: asset.role }, true);
      return {
        ...scope,
        key: buildMediaKey(scope),
        draftKey: buildDraftKey(scope),
        blob: asset.blob,
        metadata: asset.metadata,
        mimeType: asset.mimeType,
        size: asset.size,
        createdAt: now,
        updatedAt: now,
      };
    });

    const transaction = database.transaction(CARD_MEDIA_STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    const store = transaction.objectStore(CARD_MEDIA_STORE_NAME);
    const requests = records.map((record) => requestResult(store.put(record), '草稿媒体复制失败'));
    await Promise.all(requests);
    await complete;
    return records.map(publicAsset);
  }

  async exportDraft(scopeInput) {
    const scope = normalizeScope(scopeInput, false);
    return {
      schemaVersion: 1,
      accountId: scope.accountId,
      draftId: scope.draftId,
      exportedAt: Date.now(),
      assets: await this.listDraft(scope),
    };
  }
}

export const cardMediaStoreConstants = Object.freeze({
  databaseName: CARD_MEDIA_DB_NAME,
  databaseVersion: CARD_MEDIA_DB_VERSION,
  storeName: CARD_MEDIA_STORE_NAME,
  draftIndex: CARD_MEDIA_DRAFT_INDEX,
});

// 兼容当前非模块化的 card-layout/app.js；index.html 只需先加载本文件的 module script。
if (typeof globalThis !== 'undefined') {
  globalThis.CardMediaStore = CardMediaStore;
  globalThis.cardMediaStoreUtils = Object.freeze({ buildMediaKey, buildDraftKey });
}

export default CardMediaStore;
