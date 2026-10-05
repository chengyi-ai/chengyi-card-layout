import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../draft-storage.js", import.meta.url), "utf8");

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

  abort() { this.finished = true; clearTimeout(this.completeTimer); this.onabort?.(); }

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
      this.oncomplete?.({ target: this });
    }, 2);
  }
}

class FakeObjectStore {
  constructor(transaction, records) {
    this.transaction = transaction;
    this.records = records;
  }

  put(record) {
    return this.transaction.request(() => {
      this.records.set(record.accountId, structuredClone(record));
      return record.accountId;
    });
  }

  getAll() { return this.transaction.request(() => [...this.records.values()].map((r) => structuredClone(r))); }

  get(key) {
    return this.transaction.request(() => {
      const record = this.records.get(key);
      return record ? structuredClone(record) : undefined;
    });
  }
}

class FakeDatabase {
  constructor() {
    this.records = new Map();
    this.objectStoreNames = { contains: () => false };
    this.onversionchange = null;
  }

  createObjectStore() {
    this.objectStoreNames = { contains: (name) => name === "draft-stores" };
    return {};
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
    queueMicrotask(() => {
      request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}

class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    const peers = FakeBroadcastChannel.channels.get(name) || [];
    peers.push(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) || []) {
      if (peer === this) continue;
      peer.onmessage?.({ data });
    }
  }

  close() {
    const peers = (FakeBroadcastChannel.channels.get(this.name) || []).filter((peer) => peer !== this);
    FakeBroadcastChannel.channels.set(this.name, peers);
  }
}

function loadStorage(overrides = {}) {
  const context = {
    indexedDB: overrides.indexedDB === undefined ? new FakeIndexedDB() : overrides.indexedDB,
    BroadcastChannel: overrides.BroadcastChannel === undefined ? FakeBroadcastChannel : overrides.BroadcastChannel,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    Set,
    Map,
    TypeError,
    Error,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(source, context, { filename: "draft-storage.js" });
  return {
    context,
    ...context.CardDraftStorage,
    indexedDB: context.indexedDB,
  };
}

const sampleStore = {
  schemaVersion: 9,
  activeId: "d1",
  drafts: [{
    id: "d1",
    title: "本机草稿",
    updatedAt: 10,
    data: { content: "<div>hello</div>" },
  }],
  deletedDrafts: {},
};

test("IndexedDB 固定本机分区并忽略账户参数", async () => {
  const { CardDraftRepository, indexedDB } = loadStorage();
  const repo = new CardDraftRepository({ indexedDB, BroadcastChannel: FakeBroadcastChannel });
  await repo.save("", sampleStore);
  await repo.save("owner-a", sampleStore);
  const loaded = await repo.load("owner-a");
  assert.equal(loaded.drafts[0].title, "本机草稿");
  assert.equal((await repo.load("owner-b")).drafts[0].id, "d1");
  assert.deepEqual([...indexedDB.database.records.keys()], ["local"]);
  repo.close();
});

test("其他标签页保存本机分区后会通知当前页", async () => {
  FakeBroadcastChannel.channels.clear();
  const indexedDB = new FakeIndexedDB();
  const { CardDraftRepository } = loadStorage({ indexedDB, BroadcastChannel: FakeBroadcastChannel });
  const writer = new CardDraftRepository({ indexedDB, BroadcastChannel: FakeBroadcastChannel });
  const reader = new CardDraftRepository({ indexedDB, BroadcastChannel: FakeBroadcastChannel });
  const notices = [];
  reader.subscribe((message) => notices.push(message));
  await writer.save("owner-a", sampleStore);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].accountId, "local");
  assert.equal(notices[0].type, "saved");
  writer.close();
  reader.close();
});


test("首次合并所有旧账户，同 ID 取较新且保留原数据，重新打开不复活", async () => {
  const { CardDraftRepository, indexedDB } = loadStorage();
  const records = indexedDB.database.records;
  const old = (time, title) => ({ ...sampleStore, drafts: [{ ...sampleStore.drafts[0], updatedAt: time, title }] });
  records.set("owner-a", { accountId: "owner-a", store: old(20, "旧较新") });
  records.set("owner-b", { accountId: "owner-b", store: old(5, "旧较早") });
  records.set("local", { accountId: "local", store: old(10, "本机") });
  const repo = new CardDraftRepository({ indexedDB, BroadcastChannel: null });
  assert.equal((await repo.load()).drafts[0].title, "旧较新");
  assert.equal(records.size, 3);
  assert.equal(records.get("owner-b").store.drafts[0].title, "旧较早");
  await repo.save("ignored", { ...sampleStore, drafts: [], activeId: null });
  const reopened = new CardDraftRepository({ indexedDB, BroadcastChannel: null });
  assert.equal((await reopened.load()).drafts.length, 0);
  repo.close(); reopened.close();
});

test("同时间保留本机，删除记录按最新时间合并", () => {
  const { mergeLocalStores } = loadStorage();
  const merged = mergeLocalStores([sampleStore, { ...sampleStore, drafts: [{ ...sampleStore.drafts[0], title: "其他" }] }]);
  assert.equal(merged.drafts[0].title, "本机草稿");
  assert.equal(mergeLocalStores([sampleStore, { deletedDrafts: { d1: 20 }, drafts: [] }]).drafts.length, 0);
});

test("损坏旧分区不会标记迁移成功，修复后可再次合并", async () => {
  const { CardDraftRepository, indexedDB } = loadStorage();
  const records = indexedDB.database.records;
  records.set('old', { accountId: 'old', store: { drafts: 'invalid' } });
  const repo = new CardDraftRepository({ indexedDB, BroadcastChannel: null });
  await assert.rejects(repo.load(), /草稿数据结构不正确/);
  assert.equal(records.has('local'), false);
  records.set('old', { accountId: 'old', store: sampleStore });
  assert.equal((await repo.load()).drafts[0].id, 'd1');
  assert.equal(records.has('old'), true);
});
