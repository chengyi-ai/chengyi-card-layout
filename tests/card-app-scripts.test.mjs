import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_SCRIPTS } from './helpers/app-source.mjs';

const [html, server, build] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../build.mjs', import.meta.url), 'utf8'),
]);

test('拆分后的应用脚本按依赖顺序加载，并在 backup.js 之前', () => {
  const positions = APP_SCRIPTS.map((file) => html.indexOf(`<script src="${file}?`));
  positions.forEach((position, index) => assert.ok(position > 0, `index.html 缺少 ${APP_SCRIPTS[index]}`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '应用脚本顺序错误');
  assert.ok(html.indexOf('collage-layout.js?') < positions[0], 'collage-layout.js 必须先于应用脚本');
  assert.ok(positions.at(-1) < html.indexOf('backup.js?'), 'backup.js 必须在应用脚本之后');
});

test('本地服务白名单和静态构建包含全部应用脚本', () => {
  for (const file of APP_SCRIPTS) {
    assert.match(server, new RegExp(`"${file.replace('.', '\\.')}"`), `server.mjs 未放行 ${file}`);
    assert.match(build, new RegExp(`"${file.replace('.', '\\.')}"`), `build.mjs 未复制 ${file}`);
  }
});
