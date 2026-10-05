import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createCardLayoutServer } from '../server.mjs';

test('本地服务仅提供静态白名单及安全头，API 和开发文件不可访问', async (t) => {
  const server = createCardLayoutServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /草稿只保存在这台设备的浏览器里/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/api/card-drafts', '/cloud-config.js', '/vendor/supabase.js', '/.env', '/server.mjs', '/tests/card-static-server.test.mjs', '/%2e%2e%2f.env']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    await response.text();
  }
  const post = await fetch(base, { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  await post.text();
  const head = await fetch(`${base}/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
