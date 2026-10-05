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
    supabase: overrides.supabase,
    CHENGYI_CLOUD_CONFIG: overrides.CHENGYI_CLOUD_CONFIG,
    fetch: overrides.fetch,
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

test("IndexedDB 按账户读写草稿，空账户直接拒绝", async () => {
  const { CardDraftRepository, indexedDB } = loadStorage();
  const repo = new CardDraftRepository({ indexedDB, BroadcastChannel: FakeBroadcastChannel });
  await assert.rejects(repo.save("", sampleStore), /accountId 不能为空/);
  await repo.save("owner-a", sampleStore);
  const loaded = await repo.load("owner-a");
  assert.equal(loaded.drafts[0].title, "本机草稿");
  assert.equal(await repo.load("owner-b"), null);
  repo.close();
});

test("其他标签页保存同一账户后会通知当前页", async () => {
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
  assert.equal(notices[0].accountId, "owner-a");
  assert.equal(notices[0].type, "saved");
  writer.close();
  reader.close();
});

test("云端首次拉取会合并远端草稿并回写", async () => {
  const remoteStore = {
    ...sampleStore,
    drafts: [{
      id: "d2",
      title: "云端草稿",
      updatedAt: 20,
      data: { content: "<div>cloud</div>" },
    }],
  };
  const events = [];
  let uploaded = null;
  const { CardDraftCloudSync } = loadStorage({
    CHENGYI_CLOUD_CONFIG: {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "pub-key",
    },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({
            data: { session: { access_token: "token", user: { id: "owner-a" } } },
            error: null,
          }),
        },
      }),
    },
    fetch: async (url, options) => {
      events.push(options.method);
      if (options.method === "GET") {
        return new Response(JSON.stringify({ store: remoteStore }), {
          status: 200,
          headers: { etag: '"v1"', "content-type": "application/json" },
        });
      }
      uploaded = JSON.parse(options.body);
      return new Response(JSON.stringify({ saved: true }), {
        status: 200,
        headers: { etag: '"v2"', "content-type": "application/json" },
      });
    },
  });

  let applied = null;
  const sync = new CardDraftCloudSync({
    onRemoteStore: async (store) => {
      applied = store;
      return store;
    },
    getLocalStore: () => sampleStore,
  });
  const merged = await sync.init("owner-a");
  assert.equal(applied.drafts[0].title, "云端草稿");
  assert.equal(merged.drafts[0].title, "云端草稿");
  await sync.flush();
  assert.deepEqual(events, ["GET", "PUT"]);
  assert.equal(uploaded.store.drafts[0].title, "云端草稿");
});

test("云端 409 冲突时先合并再重试写入", async () => {
  let putCount = 0;
  const remoteStore = {
    ...sampleStore,
    drafts: [{
      id: "d3",
      title: "较新云端",
      updatedAt: 30,
      data: { content: "<div>newer</div>" },
    }],
  };
  const { CardDraftCloudSync } = loadStorage({
    CHENGYI_CLOUD_CONFIG: {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "pub-key",
    },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({
            data: { session: { access_token: "token", user: { id: "owner-a" } } },
            error: null,
          }),
        },
      }),
    },
    fetch: async (_url, options) => {
      if (options.method === "GET") {
        return new Response(JSON.stringify({ store: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      putCount += 1;
      if (putCount === 1) {
        return new Response(JSON.stringify({ store: remoteStore }), {
          status: 409,
          headers: { etag: '"remote"', "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ saved: true }), {
        status: 200,
        headers: { etag: '"next"', "content-type": "application/json" },
      });
    },
  });

  const sync = new CardDraftCloudSync({
    onRemoteStore: async (store) => store,
    getLocalStore: () => sampleStore,
  });
  await sync.init("owner-a");
  sync.scheduleSave(sampleStore, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sync.flush();
  assert.equal(putCount, 2);
});
