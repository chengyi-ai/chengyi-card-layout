import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';

const [app, html, style] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
]);

function extractFunctionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name} 函数体未闭合`);
}

test('裁剪比例和拖动取景功能已从产品入口与渲染链路移除', async () => {
  assert.doesNotMatch(html, /image-crop\.js|图片裁剪比例|裁剪比例：|按住图片拖动取景/);
  assert.doesNotMatch(app, /ChengYiImageCrop|_onCropPointer|setImageCropRatio|resetSelectedImageCropPosition|_paintCropFrame|data-crop-/);
  assert.doesNotMatch(style, /data-crop-ratio|crop-dragging|card-image-crop-|img-crop-ratio|img-crop-position/);
  await assert.rejects(access(new URL('../image-crop.js', import.meta.url)));
});

test('旧版 object-position 不会被误判为危险 position 并连带丢失图片宽度', () => {
  const body = extractFunctionBody(app, 'hasUnsafeDraftStyle');
  const hasUnsafeDraftStyle = new Function('value', body);
  assert.equal(hasUnsafeDraftStyle('width:47%;object-position:82% 18%'), false);
  assert.equal(hasUnsafeDraftStyle('width:47%;position:fixed'), true);
  assert.equal(hasUnsafeDraftStyle('background:url(https://bad.example/x.png)'), true);
});

test('旧裁剪草稿仍按白名单恢复图片宽度、样式与视频元数据', () => {
  const body = extractFunctionBody(app, 'normalizeDraftContent');
  assert.match(body, /safeDraftImageWidth\(node\.style\.width\)/);
  assert.match(body, /if \(width\) node\.style\.width = width/);
  assert.match(body, /normalizeImageFrame\(rawFrame\)/);
  assert.match(body, /applyMediaMetadataToImage\(node/);
  assert.doesNotMatch(body, /rawCrop|cropRatio|cropFocus|objectPosition/);
});

test('删除裁剪后保留图片宽度、样式选择和删除图片能力', () => {
  assert.match(app, /resizeSelectedImage\(pct\)/);
  assert.match(app, /setImageFrame\(frame\)/);
  assert.match(app, /_removeImageUndoable\(img\)/);
  assert.match(app, /CARD_DRAFT_SCHEMA_VERSION = 9/);
  assert.match(html, /20260915-draft-autosave-v1/g);
});
