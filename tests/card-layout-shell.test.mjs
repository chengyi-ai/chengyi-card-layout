import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readAppSource } from './helpers/app-source.mjs';

const [html, css, app, reset] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
  readAppSource(),
  readFile(new URL('../card-layout-reset.html', import.meta.url), 'utf8'),
]);

const countMatches = (source, pattern) => (source.match(pattern) || []).length;
const workspaceMarker = css.indexOf('/* ===== Workspace v2');
const firstWorkspaceMedia = css.indexOf('@media (min-width: 769px)', workspaceMarker);
const desktopCss = css.slice(workspaceMarker, firstWorkspaceMedia);
const mobileCss = css.slice(css.lastIndexOf('@media (max-width: 768px)'));

function extractRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `没有找到 ${selector} 规则`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${selector} 规则没有闭合`);
}

function pxValue(rule, property) {
  const match = rule.match(new RegExp(`${property}:\\s*([0-9.]+)px`));
  assert.ok(match, `${property} 应使用明确的 px 尺寸`);
  return Number(match[1]);
}

function verticalPadding(rule) {
  const match = rule.match(/padding:\s*([^;]+)/);
  assert.ok(match, '规则应声明 padding');
  const values = [...match[1].matchAll(/([0-9.]+)px/g)].map((item) => Number(item[1]));
  assert.ok(values.length > 0, 'padding 应使用 px 尺寸');
  if (values.length === 1) return values[0] * 2;
  if (values.length === 2) return values[0] * 2;
  return values[0] + values[2];
}

test('顶部命令栏位于双栏工作区之前，常用命令仍各有唯一入口', () => {
  const topbarIndex = html.indexOf('class="workspace-topbar"');
  const workspaceIndex = html.indexOf('<main class="app">');
  assert.ok(topbarIndex >= 0 && workspaceIndex > topbarIndex, '顶部工具栏必须位于主工作区之前');

  [
    'undoEdit',
    'redoEdit',
    'toggleBold',
    'toggleHighlight',
    'insertImageFromFile',
    'createImageCollage',
    'insertVideoFromFile',
    'insertPageBreak',
    'copyTextOnly',
    'clearContent',
  ].forEach((handler) => {
    assert.equal(countMatches(html, new RegExp(`onclick="${handler}\\(\\)"`, 'g')), 1, `${handler} 入口必须唯一`);
  });

  assert.equal(countMatches(html, /class="export-btn"/g), 1, '导出按钮必须唯一，避免 app.js 控制错节点');
  assert.equal(countMatches(html, /onclick="exportImage\(\)"/g), 1);
  assert.match(html, /class="toolbar"[\s\S]*?class="command-group"/);
});

test('动态属性栏移动到顶部且继续保留图片、拼贴和视频设置', () => {
  const topbar = html.slice(html.indexOf('<header class="workspace-topbar"'), html.indexOf('</header>') + 9);
  assert.match(topbar, /class="property-deck"/);
  assert.match(topbar, /id="imgResizeBar"/);
  assert.match(topbar, /id="collageSettings" hidden/);
  assert.match(topbar, /id="videoSettings" hidden/);
  assert.equal(countMatches(html, /id="imgResizeBar"/g), 1);
  const activeRule = extractRule(desktopCss, '.workspace-topbar .img-resize-bar.active');
  assert.match(activeRule, /position:\s*static/);
  assert.match(activeRule, /display:\s*flex/);
});

test('作品信息默认折叠，写作与草稿主入口不被折叠', () => {
  const detailsStart = html.indexOf('<details class="work-meta-panel">');
  const detailsEnd = html.indexOf('</details>', detailsStart);
  const details = html.slice(detailsStart, detailsEnd);
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart);
  assert.doesNotMatch(html.slice(detailsStart, detailsStart + 80), /\sopen(?:\s|>)/, '作品信息应默认折叠');
  ['avatarImg', 'avatarInput', 'authorName', 'pubDate'].forEach((id) => {
    assert.match(details, new RegExp(`id="${id}"`), `${id} 应放在作品信息面板内`);
  });
  assert.ok(html.indexOf('id="draftBackupInput"') < detailsStart);
  assert.ok(html.indexOf('id="draftBackupStatus"') < detailsStart);
  assert.ok(html.indexOf('id="draftSelect"') < detailsStart, '草稿切换必须留在顶部');
  assert.ok(html.indexOf('id="contentEditor"') > detailsEnd, '写作画布不能被作品信息面板折叠');
});

test('桌面采用 58/42 双栏和单层滚动，右侧预览独立滚动', () => {
  const shellRule = extractRule(desktopCss, '.workspace-shell');
  const appRule = extractRule(desktopCss, '.app');
  const editorRule = extractRule(desktopCss, '.editor');
  const richEditorRule = extractRule(desktopCss, '.rich-editor');
  const previewRule = extractRule(desktopCss, '.preview-pane .preview-area');
  assert.match(shellRule, /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(appRule, /grid-template-columns:\s*minmax\(0, 58fr\) minmax\(360px, 42fr\)/);
  assert.match(editorRule, /width:\s*auto/);
  assert.match(editorRule, /min-width:\s*0/);
  assert.match(editorRule, /overflow-y:\s*auto/);
  assert.match(richEditorRule, /max-height:\s*none/);
  assert.match(richEditorRule, /overflow:\s*visible/);
  assert.match(previewRule, /min-width:\s*0/);
  assert.match(previewRule, /overflow-y:\s*auto/);
});

test('移动端命令栏横向滚动且按钮达到可触控尺寸', () => {
  assert.match(extractRule(desktopCss, '.command-bar-shell'), /overflow-x:\s*auto/);
  assert.match(extractRule(desktopCss, '.workspace-topbar .toolbar'), /flex-wrap:\s*nowrap/);
  assert.match(extractRule(mobileCss, '.workspace-topbar .toolbar button'), /min-height:\s*44px/);
  assert.match(extractRule(mobileCss, '.command-preview-button'), /display:\s*inline-flex/);
  assert.match(extractRule(mobileCss, '.preview-pane .preview-area.mobile-active'), /display:\s*flex/);
});

test('桌面顶部栏压缩高度，同时保留手机端 44px 触控尺寸', () => {
  const titlebar = extractRule(desktopCss, '.workspace-titlebar');
  const draftSelect = extractRule(desktopCss, '.workspace-titlebar .draft-bar select');
  const draftButton = extractRule(desktopCss, '.workspace-titlebar .draft-bar button');
  const exportButton = extractRule(desktopCss, '.workspace-export .export-btn');
  const commandBar = extractRule(desktopCss, '.workspace-topbar .toolbar');
  const commandButton = extractRule(desktopCss, '.workspace-topbar .toolbar button');
  const previewHeading = extractRule(desktopCss, '.preview-pane-heading');

  assert.ok(verticalPadding(titlebar) <= 12, '标题栏上下留白应控制在 12px 内');
  assert.ok(pxValue(draftSelect, 'min-height') <= 34);
  assert.ok(pxValue(draftButton, 'min-height') <= 34);
  assert.ok(pxValue(exportButton, 'min-height') <= 34);
  assert.ok(verticalPadding(commandBar) <= 8, '命令栏上下留白应控制在 8px 内');
  assert.ok(pxValue(commandButton, 'min-height') <= 34);
  assert.ok(pxValue(previewHeading, 'min-height') <= 44);
  assert.ok(verticalPadding(previewHeading) <= 12);

  const mobileSelect = extractRule(mobileCss, '.workspace-titlebar .draft-bar select');
  const mobileDraftButton = extractRule(mobileCss, '.workspace-titlebar .draft-bar button');
  const mobileExportButton = extractRule(mobileCss, '.workspace-export .export-btn');
  const mobileCommandButton = extractRule(mobileCss, '.workspace-topbar .toolbar button');
  const mobileVideoSelect = extractRule(mobileCss, '.workspace-topbar .video-settings-row select,\n  .workspace-topbar .video-settings-row input[type="number"]');
  assert.ok(pxValue(mobileSelect, 'min-height') >= 44);
  assert.ok(pxValue(mobileSelect, 'font-size') >= 16);
  assert.ok(pxValue(mobileDraftButton, 'min-height') >= 44);
  assert.ok(pxValue(mobileExportButton, 'min-height') >= 44);
  assert.ok(pxValue(mobileCommandButton, 'min-height') >= 44);
  assert.ok(pxValue(mobileVideoSelect, 'min-height') >= 44);
  assert.ok(pxValue(mobileVideoSelect, 'font-size') >= 16);
});

test('导出进度以状态浮层显示，不会重新撑高紧凑顶栏', () => {
  assert.match(html, /id="exportProgress" role="status" aria-live="polite"/);
  const desktopProgressMedia = css.slice(css.indexOf('@media (min-width: 769px)', workspaceMarker));
  const progressRule = extractRule(desktopProgressMedia, '.workspace-export .export-progress');
  assert.match(progressRule, /position:\s*fixed/);
  assert.match(progressRule, /pointer-events:\s*none/);
});

test('缓存版本在入口、动态模块和重置链接中保持一致', () => {
  const localAssets = /(?:manifest\.json|style\.css|backup\.css|readability\.css|draft-storage\.js|video-timeline\.js|editor-highlight\.js|collage-layout\.js|app\.js|backup\.js)\?v=([^"']+)/g;
  const versions = [...html.matchAll(localAssets)].map((match) => match[1]);
  assert.equal(versions.length, 10, '入口应包含 10 个本地版本化资产');
  assert.equal(new Set(versions).size, 1, '入口资产必须使用同一缓存版本');
  const [version] = versions;
  assert.match(app, new RegExp(`video-timeline\\.js\\?v=${version}`));
  assert.equal(countMatches(reset, new RegExp(version, 'g')), 2, '重置页的两处版本必须同步');
});

test('手机预览控件只在预览打开时显示，并恢复原滚动位置', () => {
  assert.match(extractRule(mobileCss, '.mobile-close-btn'), /display:\s*none\s*!important/);
  assert.match(extractRule(mobileCss, '.preview-indicator.active'), /display:\s*none/);
  assert.match(extractRule(mobileCss, 'body.preview-open .mobile-close-btn'), /display:\s*flex\s*!important/);
  assert.match(extractRule(mobileCss, 'body.preview-open .preview-indicator.active'), /display:\s*flex/);
  assert.match(app, /mobilePreviewScrollY = window\.scrollY/);
  assert.match(app, /body\.style\.top = `-\$\{mobilePreviewScrollY\}px`/);
  assert.match(app, /body\.style\.top = ''[\s\S]*?window\.scrollTo\(0, mobilePreviewScrollY\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => \{[\s\S]*?app\?\.updatePreview\(\)[\s\S]*?mobile-close-btn/);
  assert.match(app, /event\.key === 'Escape'[\s\S]*?closeMobilePreview\(\)/);
});

test('业务固定 ID 在重排后仍然各出现一次', () => {
  [
    'contentEditor', 'previewArea', 'draftSelect', 'draftSaveStatus', 'draftBackupInput', 'draftBackupStatus',
    'avatarImg', 'avatarInput', 'authorName', 'pubDate', 'imgResizeBar', 'imgWidthSlider',
    'imgWidthLabel', 'collageSettings', 'collageHeightSlider', 'collageHeightLabel',
    'videoSettings', 'mediaTimeline', 'exportFilename', 'exportProgress', 'imageInput',
    'collageInput', 'videoInput', 'measureContainer', 'exportContainer',
  ].forEach((id) => {
    assert.equal(countMatches(html, new RegExp(`id="${id}"`, 'g')), 1, `${id} 必须唯一`);
  });
});
