import assert from 'node:assert/strict';
import test from 'node:test';
import CardMediaStore, { buildDraftKey, buildMediaKey } from '../media-store.js';

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
  }
}

class FakeTransaction {
  constructor(database, mode) {
    this.database = database;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.pending = 0;
    this.completeTimer = null;
    this.finished = false;
  }

  objectStore() {
    return new FakeObjectStore(this, this.database.records);
  }

  request(operation) {
    const request = new FakeRequest();
    this.pending += 1;
    clearTimeout(this.completeTimer);
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.({ target: request });
        this.onerror?.({ target: this });
      } finally {
        this.pending -= 1;
        this.scheduleComplete();
      }
    });
    return request;
  }

  scheduleComplete() {
    clearTimeout(this.completeTimer);
    this.completeTimer = setTimeout(() => {
      if (this.pending || this.finished || this.error) return;
      this.finished = true;
      this.database.completedTransactions += 1;
      this.oncomplete?.({ target: this });
    }, 2);
  }
}

class FakeObjectStore {
  constructor(transaction, records) {
    this.transaction = transaction;
    this.records = records;
    this.indexNames = { contains: (name) => name === 'by-draft' };
  }

  createIndex() {}

  put(record) {
    return this.transaction.request(() => {
      this.records.set(record.key, structuredClone(record));
      return record.key;
    });
  }

  get(key) {
    return this.transaction.request(() => {
      const record = this.records.get(key);
      return record ? structuredClone(record) : undefined;
    });
  }

  delete(key) {
    return this.transaction.request(() => this.records.delete(key));
  }

  index(name) {
    assert.equal(name, 'by-draft');
    return {
      getAll: (draftKey) => this.transaction.request(() => Array.from(this.records.values())
        .filter((record) => record.draftKey === draftKey)
        .map((record) => structuredClone(record))),
    };
  }
}

class FakeDatabase {
  constructor() {
    this.records = new Map();
    this.completedTransactions = 0;
    this.objectStoreNames = { contains: () => false };
    this.onversionchange = null;
  }

  createObjectStore() {
    this.objectStoreNames = { contains: (name) => name === 'media-assets' };
    return new FakeObjectStore(new FakeTransaction(this, 'versionchange'), this.records);
  }

  transaction(_name, mode) {
    return new FakeTransaction(this, mode);
  }

  close() {}
}

class FakeIndexedDB {
  constructor() {
    this.database = new FakeDatabase();
  }

  open() {
    const request = new FakeRequest();
    request.result = this.database;
    request.transaction = {
      objectStore: () => new FakeObjectStore(new FakeTransaction(this.database, 'versionchange'), this.database.records),
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}

test('复合键按账号、草稿、媒体和用途四层隔离', () => {
  const base = { accountId: 'a/b', draftId: 'draft:1', mediaId: 'media|1', role: 'source' };
  assert.notEqual(buildMediaKey(base), buildMediaKey({ ...base, accountId: 'a' }));
  assert.notEqual(buildMediaKey(base), buildMediaKey({ ...base, draftId: 'draft:2' }));
  assert.notEqual(buildMediaKey(base), buildMediaKey({ ...base, mediaId: 'media|2' }));
  assert.notEqual(buildMediaKey(base), buildMediaKey({ ...base, role: 'poster' }));
  assert.notEqual(buildDraftKey(base), buildDraftKey({ ...base, accountId: 'another' }));
});

test('不支持 IndexedDB 时给出明确错误', async () => {
  const store = new CardMediaStore({ indexedDB: null });
  await assert.rejects(store.open(), /不支持 IndexedDB.*无法保存图片、视频或 Live Photo/);
});

test('媒体可保存、读取、复制、导出和按草稿删除，且等待事务完成', async () => {
  const indexedDB = new FakeIndexedDB();
  const store = new CardMediaStore({ indexedDB, dbName: 'test-media' });
  const source = { accountId: 'owner', draftId: 'draft-1', mediaId: 'video-1' };
  const video = new Blob(['video-data'], { type: 'video/mp4' });
  const poster = new Blob(['poster-data'], { type: 'image/jpeg' });

  await store.put({ ...source, role: 'source', blob: video, metadata: { duration: 5 } });
  assert.equal(indexedDB.database.completedTransactions, 2, 'put 必须等待内部 get 和写事务都 complete');
  await store.put({ ...source, role: 'poster', blob: poster });

  const saved = await store.get({ ...source, role: 'source' });
  assert.equal(await saved.blob.text(), 'video-data');
  assert.deepEqual(saved.metadata, { duration: 5 });
  assert.equal(await store.get({ ...source, accountId: 'assistant', role: 'source' }), null);

  const listed = await store.listDraft(source);
  assert.deepEqual(listed.map((asset) => asset.role), ['poster', 'source']);

  const cloned = await store.cloneDraft(
    { accountId: 'owner', draftId: 'draft-1' },
    { accountId: 'assistant', draftId: 'draft-copy' },
    { mapMediaId: { 'video-1': 'video-copy' } },
  );
  assert.equal(cloned.length, 2);
  assert.ok(cloned.every((asset) => asset.accountId === 'assistant' && asset.mediaId === 'video-copy'));

  const exported = await store.exportDraft({ accountId: 'assistant', draftId: 'draft-copy' });
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.assets.length, 2);
  assert.equal(await exported.assets.find((asset) => asset.role === 'source').blob.text(), 'video-data');

  assert.equal(await store.deleteDraft({ accountId: 'owner', draftId: 'draft-1' }), 2);
  assert.deepEqual(await store.listDraft({ accountId: 'owner', draftId: 'draft-1' }), []);
  assert.equal((await store.listDraft({ accountId: 'assistant', draftId: 'draft-copy' })).length, 2);
});

test('拒绝空作用域和非 Blob 数据', async () => {
  const store = new CardMediaStore({ indexedDB: new FakeIndexedDB() });
  await assert.rejects(
    store.put({ accountId: '', draftId: 'd', mediaId: 'm', role: 'source', blob: new Blob(['x']) }),
    /accountId 不能为空/,
  );
  await assert.rejects(
    store.put({ accountId: 'a', draftId: 'd', mediaId: 'm', role: 'source', blob: 'not-a-blob' }),
    /blob 必须是浏览器 Blob 或 File/,
  );
});
