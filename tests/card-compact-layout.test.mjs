import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readAppSource } from './helpers/app-source.mjs';

const [html, app, css] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readAppSource(),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
]);

function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `没有找到 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`${name} 未闭合`);
}

test('排版固定为目标紧凑参数，不提供宽松切换', () => {
  assert.doesNotMatch(html, /layout-mode|data-layout-mode|>宽松</);
  assert.doesNotMatch(app, /layoutMode|LAYOUT_PRESETS|setLayoutMode|applyLayoutPreset|normalizeLayoutMode/);
  assert.match(app, /const\s+CARD_PADDING_X\s*=\s*24/);
  assert.match(app, /const\s+CARD_PADDING_Y\s*=\s*36/);
  assert.match(app, /const\s+STYLES\s*=\s*\{[\s\S]*?fontSize:\s*30[\s\S]*?lineHeight:\s*1\.6[\s\S]*?paddingX:\s*CARD_PADDING_X[\s\S]*?paddingY:\s*CARD_PADDING_Y[\s\S]*?imageMargin:\s*8/);
  assert.match(css, /\.card-author\s*\{[^}]*margin-bottom:\s*16px/);
  assert.match(css, /\.card-image-frame\s*\{[\s\S]*?margin:\s*8px auto/);
  assert.match(css, /\.card-image-frame-shadow\s*\{[\s\S]*?margin:\s*12px auto 14px/);
  assert.doesNotMatch(css, /data-layout-mode|layout-mode/);
});

test('旧草稿中的宽松字段被忽略，不再进入保存与恢复链路', () => {
  assert.match(app, /CARD_DRAFT_SCHEMA_VERSION\s*=\s*9/);
  const normalizeDraftBody = extractFunctionBody(app, 'normalizeDraftData');
  assert.doesNotMatch(normalizeDraftBody, /layoutMode|layout-mode|classic/);
  assert.doesNotMatch(app, /layoutMode:\s*this\.|normalized\.layoutMode/);
});

test('单图以中心为基准整体等比缩放，不进入裁剪链路', () => {
  assert.match(html, /id="imgScaleLabel">整体缩放：/);
  assert.match(html, /aria-label="图片整体等比缩放"/);
  assert.match(html, /内部文字和图表一起缩小，不裁切/);
  const resizeStart = app.indexOf('resizeSelectedImage(pct)');
  const resizeEnd = app.indexOf('// — 图片样式预设 —', resizeStart);
  const resize = app.slice(resizeStart, resizeEnd);
  assert.match(resize, /selectedImg\.style\.width\s*=\s*scale\s*\+\s*['"]%['"]/);
  assert.match(resize, /selectedImg\.style\.height\s*=\s*['"]auto['"]/);
  assert.match(resize, /this\.app\.debouncedUpdate\(\)/);
  assert.doesNotMatch(resize, /objectFit|objectPosition|crop|clipPath/);
  assert.match(css, /\.rich-editor img\s*\{[\s\S]*?height:\s*auto[\s\S]*?margin:\s*8px auto/);
  assert.match(css, /\.card-body img\s*\{[\s\S]*?height:\s*auto[\s\S]*?transform-origin:\s*center center/);
});
