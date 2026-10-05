import assert from "node:assert/strict";
import test from "node:test";
import { handleCardDraftRequest } from "../worker/card-draft-handler.mjs";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const ENV_BASE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "supabase-public-test-key",
};

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.version = 0;
  }

  _record(key) {
    return this.objects.get(key) || null;
  }

  async get(key) {
    const record = this._record(key);
    if (!record) return null;
    return {
      httpEtag: record.etag,
      etag: record.etag.replaceAll('"', ""),
      json: async () => JSON.parse(record.body),
    };
  }

  async head(key) {
    const record = this._record(key);
    return record ? { etag: record.etag.replaceAll('"', "") } : null;
  }

  async put(key, body) {
    this.version += 1;
    const etag = `"v${this.version}"`;
    this.objects.set(key, { body: String(body), etag });
    return { httpEtag: etag, etag: `v${this.version}` };
  }
}

function storePayload(overrides = {}) {
  return {
    store: {
      schemaVersion: 9,
      activeId: "d1",
      drafts: [{
        id: "d1",
        title: "云端草稿",
        updatedAt: 10,
        data: { content: "<div>cloud</div>" },
      }],
      deletedDrafts: {},
      ...overrides,
    },
  };
}

function authRequest(method, { token = "signed-user-token", body, headers = {} } = {}) {
  return new Request("https://creator.example/api/card-drafts", {
    method,
    headers: {
      authorization: token ? `Bearer ${token}` : "",
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

async function withAuthFetch(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /https:\/\/example\.supabase\.co\/auth\/v1\/user/);
    const token = String(options.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== "signed-user-token") return new Response("no", { status: 401 });
    return new Response(JSON.stringify({ id: USER_ID }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("未启用 R2 或未登录时不能读写云端草稿", async () => {
  const missing = await handleCardDraftRequest(authRequest("GET"), {});
  assert.equal(missing.status, 503);

  const unauthenticated = await handleCardDraftRequest(authRequest("GET", { token: "" }), {
    ...ENV_BASE,
    CARD_DRAFTS: new FakeR2(),
  });
  assert.equal(unauthenticated.status, 401);
});

test("只接受 GET/PUT，并拒绝超大或非法草稿", async () => {
  const env = { ...ENV_BASE, CARD_DRAFTS: new FakeR2() };
  const method = await handleCardDraftRequest(authRequest("POST"), env);
  assert.equal(method.status, 405);

  await withAuthFetch(async () => {
    const tooLarge = await handleCardDraftRequest(authRequest("PUT", {
      body: storePayload(),
      headers: { "content-length": String(50 * 1024 * 1024 + 1) },
    }), env);
    assert.equal(tooLarge.status, 413);

    const invalid = await handleCardDraftRequest(authRequest("PUT", {
      body: { store: { drafts: "nope" } },
    }), env);
    assert.equal(invalid.status, 400);
  });
});

test("同一账户可写入并读回，ETag 冲突返回最新副本", async () => {
  const bucket = new FakeR2();
  const env = { ...ENV_BASE, CARD_DRAFTS: bucket };

  await withAuthFetch(async () => {
    const empty = await handleCardDraftRequest(authRequest("GET"), env);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).store, null);

    const saved = await handleCardDraftRequest(authRequest("PUT", { body: storePayload() }), env);
    assert.equal(saved.status, 200);
    const firstEtag = saved.headers.get("etag");
    assert.ok(firstEtag);

    const loaded = await handleCardDraftRequest(authRequest("GET"), env);
    assert.equal((await loaded.json()).store.drafts[0].title, "云端草稿");

    const conflict = await handleCardDraftRequest(authRequest("PUT", {
      body: storePayload({ drafts: [{
        id: "d1",
        title: "被挡住的写入",
        updatedAt: 11,
        data: { content: "<div>blocked</div>" },
      }] }),
      headers: { "if-match": '"stale-etag"' },
    }), env);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).store.drafts[0].title, "云端草稿");

    const next = await handleCardDraftRequest(authRequest("PUT", {
      body: storePayload({ drafts: [{
        id: "d1",
        title: "更新后的草稿",
        updatedAt: 12,
        data: { content: "<div>updated</div>" },
      }] }),
      headers: { "if-match": firstEtag },
    }), env);
    assert.equal(next.status, 200);
  });
});

test("不同登录用户的草稿对象互相隔离", async () => {
  const bucket = new FakeR2();
  const env = { ...ENV_BASE, CARD_DRAFTS: bucket };
  const originalFetch = globalThis.fetch;
  let currentUser = USER_ID;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: currentUser }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    currentUser = USER_ID;
    const first = await handleCardDraftRequest(authRequest("PUT", { body: storePayload() }), env);
    assert.equal(first.status, 200);

    currentUser = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const other = await handleCardDraftRequest(authRequest("GET"), env);
    assert.equal((await other.json()).store, null);
    assert.equal(bucket.objects.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
