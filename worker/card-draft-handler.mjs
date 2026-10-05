const MAX_DRAFT_BYTES = 50 * 1024 * 1024;
const SUPABASE_URL = 'https://yyegqknvhpolufrjnhfs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_dlf--4XC98jrrs7NJ1U6Eg_sXVhxqQk';

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function authenticatedUserId(request, env = {}) {
  const token = bearerToken(request);
  if (token) {
    const supabaseUrl = String(env.SUPABASE_URL || SUPABASE_URL).replace(/\/+$/, "");
    const supabaseKey = String(env.SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY);
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return '';
    const user = await response.json().catch(() => null);
    return String(user?.id || '').trim();
  }
  return String(request.headers.get('oai-authenticated-user-id') || '').trim();
}

async function storageKey(userId) {
  const bytes = new TextEncoder().encode(userId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `card-drafts/${hex}.json`;
}

function normalizedEtag(value) {
  return String(value || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function validStorePayload(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.drafts)
    && value.drafts.length <= 200,
  );
}

export async function handleCardDraftRequest(request, env) {
  if (!env?.CARD_DRAFTS) return json({ error: '云端草稿存储尚未启用' }, 503);
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET, PUT' });
  }
  const userId = await authenticatedUserId(request, env);
  if (!userId) return json({ error: '请先登录后再同步草稿' }, 401);
  const key = await storageKey(userId);

  if (request.method === 'GET') {
    const object = await env.CARD_DRAFTS.get(key);
    if (!object) return json({ store: null });
    const store = await object.json().catch(() => null);
    if (!validStorePayload(store)) return json({ error: '云端草稿格式异常' }, 500);
    return json({ store }, 200, { etag: object.httpEtag || `"${object.etag}"` });
  }

  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > MAX_DRAFT_BYTES) return json({ error: '草稿超过 50MB，请先导出备份并压缩大图' }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_DRAFT_BYTES) {
    return json({ error: '草稿超过 50MB，请先导出备份并压缩大图' }, 413);
  }
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return json({ error: '草稿数据格式不正确' }, 400);
  }
  if (!validStorePayload(payload.store)) return json({ error: '草稿数据格式不正确' }, 400);

  const current = await env.CARD_DRAFTS.head(key);
  const expected = normalizedEtag(request.headers.get('if-match'));
  if (current && expected && expected !== normalizedEtag(current.etag)) {
    const latest = await env.CARD_DRAFTS.get(key);
    return json(
      { store: latest ? await latest.json().catch(() => null) : null },
      409,
      latest ? { etag: latest.httpEtag || `"${latest.etag}"` } : {},
    );
  }

  const stored = await env.CARD_DRAFTS.put(key, JSON.stringify(payload.store), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { updatedAt: new Date().toISOString() },
  });
  return json({ saved: true }, 200, { etag: stored.httpEtag || `"${stored.etag}"` });
}
