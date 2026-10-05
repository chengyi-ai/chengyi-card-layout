import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, htmlSource, backupSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../backup.js', import.meta.url), 'utf8'),
]);

function extractBlock(source, signature, label) {
  const match = signature.exec(source);
  assert.ok(match, `找不到 ${label}`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`${label} 函数体未闭合`);
}

test('视频入口、设置和本机存储说明完整', () => {
  assert.match(htmlSource, /onclick="insertVideoFromFile\(\)"/);
  assert.match(htmlSource, /id="videoInput"[^>]+video\/mp4[^>]+video\/quicktime/);
  assert.match(htmlSource, /id="mediaOutputMode"[\s\S]*value="video"[\s\S]*value="live-photo"/);
  assert.match(htmlSource, /id="mediaDuration"[\s\S]*value="3"[\s\S]*value="5"/);
  assert.match(htmlSource, /素材仅保存在当前设备/);
  assert.match(htmlSource, /Live Photo（Beta）/);
  assert.match(htmlSource, /在“照片”中导入 \.pvt/);
  assert.ok(htmlSource.indexOf('vendor/mp4box.all.min.js') < htmlSource.indexOf('app.js?'));
  assert.ok(htmlSource.indexOf('vendor/mp4-muxer.js') < htmlSource.indexOf('app.js?'));
});

test('视频插入在草稿中只放封面和白名单元数据', () => {
  const insert = extractBlock(appSource, /\basync\s+_insertVideoFile\s*\([^)]*\)\s*\{/, 'EditorManager._insertVideoFile');
  assert.match(appSource, /const\s+CARD_DRAFT_SCHEMA_VERSION\s*=\s*9/);
  assert.match(insert, /sourceDuration\s*<\s*3/);
  assert.ok(insert.indexOf('sourceDuration < 3') < insert.indexOf('getCardMediaStore()'), '过短视频必须在落盘前拒绝');
  assert.match(insert, /role:\s*CARD_MEDIA_SOURCE_ROLE/);
  assert.match(insert, /role:\s*CARD_MEDIA_POSTER_ROLE/);
  assert.match(insert, /document\.createElement\(['"]img['"]\)/);
  assert.doesNotMatch(insert, /document\.createElement\(['"]video['"]\)/);

  for (const attr of [
    'data-media-id', 'data-media-kind', 'data-media-mode', 'data-media-duration',
    'data-media-start', 'data-media-sound', 'data-media-name', 'data-media-mime',
    'data-media-source-duration', 'data-media-draft-id',
  ]) assert.ok(appSource.includes(attr), `草稿清洗必须保留 ${attr}`);

  assert.match(appSource, /if\s*\(el\.media\)\s*applyMediaMetadataToImage\(img,\s*el\.media\)/);
  assert.match(backupSource, /const\s+DRAFT_BACKUP_MEDIA_VERSION\s*=\s*3/);
});

test('视频导出保持 1500x2000，混合页面打包且失败不降级', () => {
  const exporter = extractBlock(appSource, /class\s+Exporter\s*\{/, 'Exporter');
  const appExport = extractBlock(appSource, /\basync\s+exportImage\s*\(\s*\)\s*\{/, 'ArticleCardApp.exportImage');
  assert.match(exporter, /outputWidth:\s*CARD_W\s*\*\s*2/);
  assert.match(exporter, /outputHeight:\s*CARD_H\s*\*\s*2/);
  assert.match(exporter, /result\.media\.length\s*>\s*1/);
  assert.match(exporter, /composeCardVideo\(commonOptions\)/);
  assert.match(exporter, /createLivePhotoPackage\s*\(/);
  assert.match(exporter, /`\$\{prefix\}-视频\.mp4`/);
  assert.match(exporter, /`\$\{prefix\}-实况\.pvt\//);
  assert.match(exporter, /JSZip\.loadAsync\(blob\)/);
  assert.match(exporter, /throw new Error\(`第 \$\{pageNumber\} 页的视频素材不在当前设备/);
  assert.match(appExport, /accountId:\s*this\.accountId/);
  assert.match(appExport, /draftId:\s*this\.getActiveDraftId\(\)/);
});

test('删除已保存草稿时同步清理该草稿的 IndexedDB 素材', () => {
  const removeStart = appSource.indexOf('  async deleteDraft() {');
  const removeEnd = appSource.indexOf('\n  buildAuthorHTML() {', removeStart);
  assert.ok(removeStart >= 0 && removeEnd > removeStart, '找不到 ArticleCardApp.deleteDraft');
  const remove = appSource.slice(removeStart, removeEnd);
  assert.match(remove, /const\s+saved\s*=\s*(?:await\s+)?this\._saveStore\(\)/);
  assert.match(remove, /saved\s*&&\s*deletedDraftHasMedia\s*&&\s*this\.accountId/);
  assert.match(remove, /await\s+mediaStore\.deleteDraft\(\{\s*accountId:\s*this\.accountId,\s*draftId:\s*deletedDraftId\s*\}\)/);
  assert.match(remove, /本机视频素材清理失败/);
});
