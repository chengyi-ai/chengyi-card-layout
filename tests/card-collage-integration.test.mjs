import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, html, css, reset] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
  readFile(new URL('../card-layout-reset.html', import.meta.url), 'utf8'),
]);

function extractBlock(source, signature, label) {
  const match = signature.exec(source);
  assert.ok(match, `没有找到 ${label}`);
  const start = match.index;
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${label} 缺少闭合花括号`);
}

test('自由拼贴入口和缓存版本完整接入', () => {
  assert.match(html, /onclick="createImageCollage\(\)"/);
  assert.match(html, /id="collageInput"[^>]*multiple/);
  assert.match(html, /collage-layout\.js\?v=20261005-local-drafts-v1/);
  assert.match(html, /app\.js\?v=20261005-local-drafts-v1/);
  assert.match(reset, /20261005-local-drafts-v1/g);
});

test('选中自由拼贴图片后，剪贴板图片直接加入当前拼贴', () => {
  assert.match(html, /复制新图并按 Command\+V 可直接加入/);
  const source = extractBlock(app, /_onPaste\s*\(e\)\s*\{/, 'EditorManager._onPaste');
  const onPaste = Function(
    'cardAccountId',
    'escapeHTML',
    `return ({${source}})._onPaste;`,
  )(() => 'account-1', (value) => value);
  const imageFile = { type: 'image/png', name: 'clipboard.png' };
  const collage = { dataset: { collageId: 'collage-1' } };
  const calls = [];
  const manager = {
    selectedImg: { closest: (selector) => selector === '.image-collage' ? collage : null },
    app: { getActiveDraftId: () => 'draft-1' },
    _insertCollageFiles(files, collageId, context) { calls.push(['collage', files, collageId, context]); },
    _insertImageFile(file) { calls.push(['single', file]); },
  };
  const event = {
    preventDefault() { calls.push('prevent'); },
    clipboardData: {
      items: [{ type: 'image/png', getAsFile: () => imageFile }],
      getData: () => '',
    },
  };

  onPaste.call(manager, event);

  assert.deepEqual(calls, [
    'prevent',
    ['collage', [imageFile], 'collage-1', { accountId: 'account-1', draftId: 'draft-1' }],
  ]);
});

test('草稿只保存拼贴白名单数据，不放宽危险定位样式', () => {
  assert.match(app, /CARD_DRAFT_SCHEMA_VERSION\s*=\s*9/);
  assert.match(app, /data-card-collage/);
  assert.match(app, /dataset\.collageX/);
  assert.match(app, /dataset\.collageY/);
  assert.match(app, /dataset\.collageWidth/);
  assert.match(app, /dataset\.collageZ/);
  assert.ok(app.includes('(?:^|;)\\s*position\\s*:'), '仍须拦截 position 样式');
  assert.ok(app.includes('z-index\\s*:'), '仍须拦截 z-index 样式');
  assert.match(app, /clone\.querySelectorAll\('\.collage-resize-handle, \.collage-delete-handle'\)[\s\S]*?node\.remove\(\)/);
  assert.match(app, /collage\.removeAttribute\('style'\)/);
  assert.match(app, /item\.removeAttribute\('style'\)/);
});

test('解析、分页测量、预览和导出共用同一拼贴渲染真源', () => {
  const collageBranch = app.indexOf("type: 'collage'");
  const ordinaryImageBranch = app.indexOf("type: 'img'", collageBranch);
  assert.ok(collageBranch > 0 && ordinaryImageBranch > collageBranch, 'ContentParser 必须先识别拼贴再识别普通图片');
  assert.match(app, /else if \(el\.type === 'collage'\)/);
  assert.match(app, /collage\.style\.height = `\$\{api\.normalizeHeight\(el\.height\)\}px`/);
  assert.match(app, /const domEl = Renderer\.createDomElement\(el\)/);
  assert.match(app, /page\.elements\.forEach\(\(el\) => body\.appendChild\(Renderer\.createDomElement\(el\)\)\)/);
  assert.match(app, /const card = Renderer\._buildCard\(page, buildAuthorHTML\)/);
  assert.match(css, /\.card-image-collage\s*\{[\s\S]*?position:\s*relative[\s\S]*?overflow:\s*visible/);
  assert.match(css, /\.card-collage-item\s*\{[\s\S]*?position:\s*absolute/);
});

test('自由拼贴默认正常，只有显式选择蓝边才绘制柔光', () => {
  assert.match(html, /自由拼贴新增图片固定为正常样式/);
  const editorGlow = css.match(/\.rich-editor \.collage-item:has\(> img\[data-frame="blue-border"\]\)::after\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(css, /\.rich-editor \.image-collage\s*\{[\s\S]*?overflow:\s*visible/);
  assert.doesNotMatch(css, /\.rich-editor \.collage-item::after/);
  assert.match(editorGlow, /border:\s*1px solid rgba\(74, 139, 247, \.78\)/);
  assert.match(editorGlow, /box-shadow:[\s\S]*?rgba\(58, 131, 247, \.34\)/);
  assert.match(editorGlow, /border-radius:\s*5px/);
  assert.match(editorGlow, /pointer-events:\s*none/);
  assert.match(css, /\.rich-editor \.collage-item > img\s*\{[\s\S]*?border-radius:\s*4px/);
  const canvasRule = css.match(/\.card-collage-glow-canvas\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(canvasRule, /position:\s*absolute/);
  assert.match(canvasRule, /z-index:\s*0/, '柔光画布应位于图片后方，只露出外圈渐变');
  assert.match(canvasRule, /left:\s*-20px/);
  assert.match(canvasRule, /width:\s*calc\(100% \+ 40px\)/);
  assert.match(canvasRule, /pointer-events:\s*none/);
  assert.match(css, /\.card-collage-item > img,[\s\S]*?position:\s*relative[\s\S]*?z-index:\s*1/);
  const collageBranch = app.slice(
    app.indexOf("} else if (el.type === 'collage')"),
    app.indexOf("} else if (el.type === 'empty')"),
  );
  const blueGlowStart = collageBranch.indexOf("if (normalizedFrame === 'blue-border')");
  const glowCanvasStart = collageBranch.indexOf("document.createElement('canvas')");
  assert.ok(blueGlowStart >= 0 && glowCanvasStart > blueGlowStart, '拼贴蓝边画布必须受显式 blue-border 条件约束');
  assert.match(collageBranch, /document\.createElement\('canvas'\)/);
  assert.match(collageBranch, /glowCanvas\.className = 'card-collage-glow-canvas'/);
  assert.match(collageBranch, /item\.appendChild\(glowCanvas\)/);
  const ordinaryImageBranch = app.slice(
    app.indexOf("if (el.type === 'img')"),
    app.indexOf("} else if (el.type === 'collage')"),
  );
  assert.doesNotMatch(ordinaryImageBranch, /card-collage-glow-canvas/);
  assert.match(app, /img\.style\.borderRadius = '4px'/);
  const insertCollageFiles = extractBlock(app, /async\s+_insertCollageFiles\s*\([^)]*\)\s*\{/, 'EditorManager._insertCollageFiles');
  assert.doesNotMatch(insertCollageFiles, /defaultImageFrame|dataset\.frame/, '新增拼贴图片必须固定从正常样式开始');
  assert.match(app, /static _paintCollageGlow\(canvas\)/);
  const glowPainter = extractBlock(app, /static _paintCollageGlow\s*\(canvas\)\s*\{/, 'Renderer._paintCollageGlow');
  assert.match(glowPainter, /item\.offsetWidth/);
  assert.match(glowPainter, /canvas\.offsetWidth/);
  assert.doesNotMatch(glowPainter, /\.getBoundingClientRect\(/, '缩放预览下不能按变换后的矩形二次缩小光晕');
  assert.match(glowPainter, /const glowLayers = \[/);
  assert.ok((glowPainter.match(/spread:/g) || []).length >= 6, '右侧预览至少需要六层真实渐弱外环');
  assert.match(glowPainter, /x - spread/);
  assert.match(glowPainter, /width \+ spread \* 2/);
  assert.match(glowPainter, /ctx\.shadowColor = 'rgba\(58, 131, 247, 0\.32\)'/);
  assert.match(glowPainter, /ctx\.shadowBlur = 9 \* density/, 'Retina 下的环境光必须按像素密度补偿');
  assert.match(glowPainter, /ctx\.strokeStyle = 'rgba\(68, 141, 255, 1\)'/, '阴影投射源必须不透明');
  assert.match(app, /canvas\.dataset\.glowReady = 'true'/);
  assert.match(app, /const glowCanvases = Array\.from\(root\.querySelectorAll\('\.card-collage-glow-canvas'\)\)/);
  assert.match(app, /glowCanvases\.forEach\(\(canvas\) => Renderer\._paintCollageGlow\(canvas\)\)/);
  assert.match(app, /canvas\?\.closest\?\.\('\.card-collage-item, \.card-image-frame-blue-border'\)/, '单图蓝边与拼贴必须使用同一个 Canvas 绘制函数');
  assert.match(app, /card-collage-glow-canvas card-image-blue-glow-canvas/, '单图蓝边必须进入拼贴柔光准备队列');
  assert.match(app, /card-image-shadow-canvas card-image-blue-shadow-canvas/, '单图蓝边必须叠加项目原有的方向性投影，而不是再猜一套阴影');
  const desktopPreview = extractBlock(app, /static _renderDesktop\s*\(pages, previewArea, buildAuthorHTML\)\s*\{/, 'Renderer._renderDesktop');
  const mobilePreview = extractBlock(app, /static _renderMobile\s*\(pages, previewArea, buildAuthorHTML\)\s*\{/, 'Renderer._renderMobile');
  assert.match(desktopPreview, /void Renderer\.prepareImageEffects\(card\)/, '桌面右侧预览必须绘制柔光');
  assert.match(mobilePreview, /void Renderer\.prepareImageEffects\(card\)/, '移动预览必须绘制柔光');
  assert.match(app, /await Renderer\.prepareImageEffects\(card\)[\s\S]*?html2canvas/, '导出前必须等待同一柔光绘制完成');

  const roundedRects = [];
  const strokes = [];
  const transforms = [];
  const ctx = {
    setTransform(...args) { transforms.push(args); },
    clearRect() {},
    save() {},
    restore() {},
    stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth, blur: this.shadowBlur || 0 }); },
  };
  const canvas = {
    width: 0,
    height: 0,
    offsetWidth: 240,
    offsetHeight: 160,
    dataset: {},
    closest: () => ({ offsetWidth: 200, offsetHeight: 120 }),
    getContext: () => ctx,
  };
  const paintGlow = Function(
    'window',
    'Renderer',
    `return ({${glowPainter.replace(/^static\s+/, '')}})._paintCollageGlow;`,
  )(
    { devicePixelRatio: 2 },
    { _roundedRect(_ctx, ...args) { roundedRects.push(args); } },
  );
  assert.equal(paintGlow(canvas), true);
  assert.deepEqual(transforms[0], [2, 0, 0, 2, 0, 0]);
  assert.equal(canvas.width, 480);
  assert.equal(canvas.height, 320);
  assert.equal(strokes.length, 7, '六层真实外环和一层环境光都必须实际绘制');
  assert.ok(roundedRects[0][0] < roundedRects.at(-1)[0], '最外层路径必须向图片边缘外扩');
  assert.equal(strokes.at(-1).blur, 18, 'DPR=2 时环境光模糊半径应翻倍');
  assert.equal(canvas.dataset.glowReady, 'true');
});

test('首版禁止视频进入拼贴，同时保留投影绘制链路', () => {
  assert.match(app, /containsVideo[\s\S]*?按普通图片顺序降级/);
  assert.match(app, /自由拼贴首版只支持静态图片/);
  assert.match(app, /Renderer\._createImageElement\([\s\S]*?card-image-frame-shadow/);
  assert.match(app, /Renderer\.prepareImageEffects\(card\)/);
});

test('撤销、键盘和指针异常结束后仍能恢复可编辑拼贴', () => {
  assert.match(app, /addEventListener\('focusin',[\s\S]*?_onFocusIn/);
  assert.match(app, /addEventListener\('lostpointercapture',[\s\S]*?_onCollagePointerEnd/);
  assert.match(app, /window\.addEventListener\('pointerup',[\s\S]*?_onCollagePointerEnd/);
  assert.match(app, /_scheduleCollageHydration\(\)/);
  assert.match(app, /function undoEdit\(\)[\s\S]*?rehydrateAfterHistory\(\)/);
  assert.match(app, /function redoEdit\(\)[\s\S]*?rehydrateAfterHistory\(\)/);
  assert.match(app, /this\._removeNodeUndoable\(item\)/, '删除单张拼贴图应先尝试进入原生撤销栈');
  assert.match(app, /const deleteAnchor = this\._captureFallbackDelete\(item\)/);
  assert.match(app, /this\._finishFallbackDelete\(deleteAnchor\)/, '原生删除静默失败时必须可靠兜底');
  assert.match(app, /this\.fallbackDeleteTxn = \{ \.\.\.anchor, state: 'deleted' \}/, '兜底删除必须登记可撤回事务');
  assert.match(app, /app\.editorManager\._applyFallbackDeleteHistory\('undo'\)/, '工具栏撤销应优先恢复兜底删除');
  assert.match(app, /app\.editorManager\._applyFallbackDeleteHistory\('redo'\)/, '工具栏重做应优先重放兜底删除');
  assert.match(app, /const historyShortcut = \(e\.metaKey \|\| e\.ctrlKey\)/, 'Command+Z 必须接入同一删除历史');
  assert.doesNotMatch(app, /_commitCollageMutation/, '拖动结束不得通过 insertHTML 重插整个拼贴区');
  assert.doesNotMatch(app, /document\.execCommand\('insertHTML', false, afterHTML\)/);
  assert.match(app, /imageSelectionOwnsKeyboard\s*=\s*false/);
  assert.match(app, /this\.imageSelectionOwnsKeyboard && selectedCollageItem/);
  assert.match(app, /this\.imageSelectionOwnsKeyboard && this\.selectedImg/);
  assert.match(app, /const collage = selectedCollageItem\.closest\('\.image-collage'\)/);
  assert.match(app, /_selectImage\(img, options = \{\}\)[\s\S]*?this\.selectedImg = img[\s\S]*?this\.imageSelectionOwnsKeyboard = true/);
  assert.match(app, /_editableAnchorAfterNode\(node\)/);
  assert.match(app, /anchor\.dataset\.collageCaret = '1'/);
  assert.match(app, /_placeCaretAfterNode\(node\)/);
  assert.match(app, /range\.setStartBefore\(anchor\)/);
  assert.match(app, /range\.collapse\(true\)/);
  assert.match(app, /_onCollagePointerEnd\(event\)[\s\S]*?if \(drag\.moved\)[\s\S]*?requestAnimationFrame[\s\S]*?this\._placeCaretAfterNode\(collage\)/);
  assert.doesNotMatch(app, /moveByKeyboard[\s\S]{0,500}?_placeCaretAfterNode/, '方向键连续微调时不能把焦点移回文字区');
  assert.match(app, /addEventListener\('input',[\s\S]*?this\.selectedImg && !this\.imageSelectionOwnsKeyboard[\s\S]*?this\._deselectImage\(\)/);
  assert.match(app, /_adjacentTopLevelNodeFromCaret\(range, 'backward'\)/, '文字节点起始位置退格时也必须识别前方拼贴');
  assert.match(app, /this\._removeAdjacentCollageUndoable\(e, adjacentCollage\)/);
  assert.match(app, /clone\.querySelectorAll\('br\[data-collage-caret="1"\]'\)[\s\S]*?node\.remove\(\)/, '运行时光标锚点不能写入草稿');
  assert.match(app, /tag === 'br' && node\.dataset\.collageCaret === '1'[\s\S]*?return/, '运行时光标锚点不能进入预览和导出');
  assert.match(app, /suppressCollageClickItem[\s\S]*?requestAnimationFrame/, '拖动后的合成 click 不能重新夺走文字键盘模式');
  assert.match(app, /this\.editor\.focus\(\{ preventScroll: true \}\)/, '单击拼贴图时必须主动聚焦编辑器，方向键和删除键才能工作');
});

test('每张拼贴图都有独立删除按钮，点击不会触发拖动且不会写入草稿', () => {
  assert.match(html, /选中图片后点右上角 × 可单独删除/);
  assert.match(app, /deleteButton\.type = 'button'/);
  assert.match(app, /deleteButton\.className = 'collage-delete-handle'/);
  assert.match(app, /deleteButton\.dataset\.collageDelete = '1'/);
  assert.match(app, /deleteButton\.setAttribute\('aria-label', `删除拼贴图片 \$\{index \+ 1\}`\)/);
  assert.match(app, /_onCollagePointerDown\(event\) \{[\s\S]*?\[data-collage-delete="1"\][\s\S]*?return/);
  assert.match(app, /!item\.querySelector\(':scope > \.collage-delete-handle'\)/, '历史恢复后也必须补回删除按钮');
  assert.match(app, /clone\.querySelectorAll\('\.collage-resize-handle, \.collage-delete-handle'\)/, '运行时按钮不能写入草稿');
  assert.match(css, /\.collage-delete-handle\s*\{[\s\S]*?z-index:\s*120[\s\S]*?display:\s*none/);
  assert.match(css, /\.rich-editor \.collage-item\.selected > \.collage-delete-handle\s*\{\s*display:\s*flex/);

  const source = extractBlock(app, /_onClick\s*\(e\)\s*\{/, 'EditorManager._onClick');
  const onClick = Function(`return ({${source}})._onClick;`)();
  const img = {};
  const item = { querySelector: () => img };
  const handle = { closest: (selector) => selector === '.collage-item' ? item : null };
  const calls = [];
  const event = {
    target: { closest: (selector) => selector === '[data-collage-delete="1"]' ? handle : null },
    preventDefault() { calls.push('prevent'); },
    stopPropagation() { calls.push('stop'); },
  };
  onClick.call({
    editor: { contains: (node) => node === img },
    _selectImage(node) { calls.push(['select', node]); },
    removeSelectedCollageImage() { calls.push('remove'); },
  }, event);
  assert.deepEqual(calls, ['prevent', 'stop', ['select', img], 'remove']);
});

test('单张拼贴图在原生删除失效时可靠兜底，原生成功与最后一张不重复删除', () => {
  const source = extractBlock(
    app,
    /removeSelectedCollageImage\s*\(\)\s*\{/,
    'EditorManager.removeSelectedCollageImage',
  );
  const removeImage = Function(`return ({${source}}).removeSelectedCollageImage;`)();

  const run = ({ count, nativeRemoves }) => {
    const calls = [];
    let itemConnected = true;
    let collageConnected = true;
    let directRemovals = 0;
    let directCollageRemovals = 0;
    const nextImg = {};
    const collage = {
      get isConnected() { return collageConnected; },
      getAttribute: () => 'false',
      setAttribute(name, value) { calls.push(['attr', name, value]); },
      removeAttribute(name) { calls.push(['remove-attr', name]); },
      remove() { directCollageRemovals++; collageConnected = false; calls.push('direct-remove-collage'); },
      contains: () => itemConnected,
      querySelectorAll: () => Array.from({ length: count }),
      querySelector: () => nextImg,
    };
    const item = {
      closest: (selector) => selector === '.image-collage' ? collage : null,
      get isConnected() { return itemConnected; },
      remove() { directRemovals++; itemConnected = false; calls.push('direct-remove'); },
    };
    const manager = {
      selectedImg: { closest: (selector) => selector === '.collage-item' ? item : null },
      _deselectImage() { calls.push('deselect'); },
      _captureFallbackDelete(node) {
        calls.push(['capture', node]);
        return { node };
      },
      _finishFallbackDelete(anchor) {
        calls.push(['finish', anchor.node]);
        if (anchor.node === item && itemConnected) item.remove();
        if (anchor.node === collage && collageConnected) collage.remove();
      },
      _removeNodeWithFallback(node) {
        calls.push(['fallback-remove', node]);
        this._removeNodeUndoable(node);
        if (node === item && itemConnected) item.remove();
        if (node === collage && collageConnected) collage.remove();
      },
      _removeNodeUndoable(node) {
        calls.push(['native-remove', node]);
        if (nativeRemoves && node === item) itemConnected = false;
        if (nativeRemoves && node === collage) collageConnected = false;
      },
      _hydrateCollages() { calls.push('hydrate'); },
      _selectImage(node) { calls.push(['select', node]); },
      editor: {
        focus(options) { calls.push(['focus', options]); },
        contains(node) { return node === collage && collageConnected; },
      },
      app: { updatePreview() { calls.push('preview'); } },
    };
    removeImage.call(manager);
    return { calls, item, collage, nextImg, directRemovals, directCollageRemovals };
  };

  const fallback = run({ count: 2, nativeRemoves: false });
  assert.equal(fallback.directRemovals, 1, '原生命令静默失败时必须直接删除一次');
  assert.ok(fallback.calls.some((entry) => Array.isArray(entry) && entry[0] === 'native-remove' && entry[1] === fallback.item));
  assert.ok(fallback.calls.some((entry) => Array.isArray(entry) && entry[0] === 'select' && entry[1] === fallback.nextImg));
  assert.equal(fallback.calls.at(-1), 'preview');

  const native = run({ count: 2, nativeRemoves: true });
  assert.equal(native.directRemovals, 0, '原生删除成功后不得再直接删除');

  const last = run({ count: 1, nativeRemoves: false });
  assert.equal(last.directRemovals, 0, '最后一张应删除整个拼贴区');
  assert.equal(last.directCollageRemovals, 1, '最后一张原生命令失效时也必须可靠删除整块');
  assert.ok(last.calls.some((entry) => Array.isArray(entry) && entry[0] === 'fallback-remove' && entry[1] === last.collage));
  assert.equal(last.calls.includes('hydrate'), false);
  assert.equal(last.calls.some((entry) => Array.isArray(entry) && entry[0] === 'select'), false);

  const lastNative = run({ count: 1, nativeRemoves: true });
  assert.equal(lastNative.directCollageRemovals, 0, '最后一张原生删除成功后不得重复删除整块');
});

test('兜底删除支持 Command+Z 原位恢复和 Command+Shift+Z 重做', () => {
  const finishSource = extractBlock(app, /_finishFallbackDelete\s*\(anchor\)\s*\{/, 'EditorManager._finishFallbackDelete');
  const historySource = extractBlock(app, /_applyFallbackDeleteHistory\s*\(direction\)\s*\{/, 'EditorManager._applyFallbackDeleteHistory');
  const finish = Function(`return ({${finishSource}})._finishFallbackDelete;`)();
  const applyHistory = Function('cardAccountId', `return ({${historySource}})._applyFallbackDeleteHistory;`)(() => 'account-a');

  const nextSibling = { parentNode: null };
  const parent = {
    isConnected: true,
    children: [],
    insertBefore(node, anchor) {
      const index = anchor ? this.children.indexOf(anchor) : -1;
      if (index >= 0) this.children.splice(index, 0, node);
      else this.children.push(node);
      node.parentNode = this;
      node.isConnected = true;
    },
  };
  const node = {
    parentNode: parent,
    isConnected: true,
    remove() {
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentNode = null;
      this.isConnected = false;
    },
  };
  parent.children.push(node, nextSibling);
  nextSibling.parentNode = parent;
  const manager = {
    fallbackDeleteTxn: null,
    app: { getActiveDraftId: () => 'draft-a' },
    editor: { focus() {} },
    _clearFallbackDeleteTransaction() { this.fallbackDeleteTxn = null; },
    rehydrateAfterHistoryCalls: 0,
    rehydrateAfterHistory() { this.rehydrateAfterHistoryCalls++; },
  };

  assert.equal(finish.call(manager, {
    node,
    parent,
    nextSibling,
    accountId: 'account-a',
    draftId: 'draft-a',
  }), true);
  assert.equal(node.isConnected, false);
  assert.equal(manager.fallbackDeleteTxn.state, 'deleted');

  assert.equal(applyHistory.call(manager, 'undo'), true);
  assert.deepEqual(parent.children, [node, nextSibling], '撤销后必须恢复到原来的兄弟节点位置');
  assert.equal(manager.fallbackDeleteTxn.state, 'restored');

  assert.equal(applyHistory.call(manager, 'redo'), true);
  assert.deepEqual(parent.children, [nextSibling]);
  assert.equal(manager.fallbackDeleteTxn.state, 'deleted');
  assert.equal(applyHistory.call(manager, 'undo'), true, '重做后应仍可再次撤销');
  assert.equal(manager.rehydrateAfterHistoryCalls, 3);

  assert.equal(applyHistory.call(manager, 'undo'), false, '连续第二次撤销应放行浏览器原生文字历史');
  assert.equal(manager.fallbackDeleteTxn, null);

  const keydownSource = extractBlock(app, /_onKeydown\s*\(e\)\s*\{/, 'EditorManager._onKeydown');
  const scheduled = [];
  const onKeydown = Function(
    'requestAnimationFrame',
    `return ({${keydownSource}})._onKeydown;`,
  )((callback) => scheduled.push(callback));
  const shortcutCalls = [];
  const shortcutManager = {
    _applyFallbackDeleteHistory(direction) { shortcutCalls.push(direction); return true; },
  };
  const undoEvent = {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'z',
    preventDefault() { shortcutCalls.push('prevent'); },
  };
  onKeydown.call(shortcutManager, undoEvent);
  assert.deepEqual(shortcutCalls, ['undo', 'prevent']);

  shortcutCalls.length = 0;
  onKeydown.call(shortcutManager, { ...undoEvent, shiftKey: true });
  assert.deepEqual(shortcutCalls, ['redo', 'prevent']);

  const nativeCalls = [];
  onKeydown.call({
    _applyFallbackDeleteHistory() { return false; },
    rehydrateAfterHistory() { nativeCalls.push('rehydrate'); },
  }, { ...undoEvent, preventDefault() { nativeCalls.push('prevent'); } });
  assert.deepEqual(nativeCalls, [], '没有兜底事务时不能阻止浏览器原生 Command+Z');
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(nativeCalls, ['rehydrate']);

  assert.match(app, /addEventListener\('beforeinput',[\s\S]*?historyUndo[\s\S]*?historyRedo[\s\S]*?_clearFallbackDeleteTransaction\(\)/);
  assert.match(app, /_applyData\(data\)[\s\S]*?this\.editorManager\._clearFallbackDeleteTransaction\(\)/, '切换草稿时不能恢复旧页面节点');
});

test('光标紧挨自由拼贴时会执行一次可撤销整块删除，而不是只吞按键', () => {
  const source = extractBlock(
    app,
    /_removeAdjacentCollageUndoable\s*\(event, collage\)\s*\{/,
    'EditorManager._removeAdjacentCollageUndoable',
  );
  const removeAdjacent = Function(`return ({${source}})._removeAdjacentCollageUndoable;`)();
  const calls = [];
  const manager = {
    _deselectImage() { calls.push('deselect'); },
    _removeNodeWithFallback(node) { calls.push(['remove', node]); },
    app: { updatePreview() { calls.push('preview'); } },
  };
  const collage = { matches: (selector) => selector === '.image-collage' };
  const event = { preventDefault() { calls.push('prevent'); } };
  assert.equal(removeAdjacent.call(manager, event, collage), true);
  assert.deepEqual(calls, ['prevent', 'deselect', ['remove', collage], 'preview']);

  calls.length = 0;
  assert.equal(removeAdjacent.call(manager, event, null), false);
  assert.deepEqual(calls, []);
});

test('连续图片兼容直接 IMG 与只含单图的 DIV/P 嵌套包装', () => {
  assert.match(app, /_topLevelEditorNode\(node\)/);
  assert.match(app, /_collageCandidate\(node\)/);
  assert.match(app, /node\?\.matches\?\.\('div, p'\)/);
  assert.match(app, /child\.matches\('div, p, span, img, br'\)/);
  assert.match(app, /range\.setStartBefore\(group\?\.firstNode \|\| eligible\[0\]\)/);
  assert.match(app, /range\.setEndAfter\(group\?\.lastNode \|\| eligible\[eligible\.length - 1\]\)/);
  assert.match(app, /if \(!anchor\) return \{ images: \[\], firstNode: null, lastNode: null, mixedContent: true \}/);
  assert.match(app, /这张图片和文字位于同一个段落中，不能安全转换/);
});

test('拼贴设置显示真实范围、单位和层级边界', () => {
  assert.match(app, /widthSlider\.min = String\(api\.MIN_ITEM_WIDTH \/ 100\)/);
  assert.match(app, /widthSlider\.max = String\(api\.MAX_ITEM_WIDTH \/ 100\)/);
  assert.match(html, /id="collageHeightLabel">440 px</);
  assert.match(html, /id="collageLayerBackward"/);
  assert.match(html, /id="collageLayerForward"/);
  assert.match(html, /onclick="removeSelectedCollage\(\)"[^>]*>删除整个拼贴区</);
  const removeSource = extractBlock(app, /removeSelectedCollage\s*\(\)\s*\{/, 'EditorManager.removeSelectedCollage');
  const removeCollage = Function(`return ({${removeSource}}).removeSelectedCollage;`)();
  const collage = {};
  const calls = [];
  const manager = {
    selectedImg: { closest: (selector) => selector === '.image-collage' ? collage : null },
    _deselectImage() { calls.push('deselect'); },
    _removeNodeWithFallback(node) { calls.push(['remove', node]); },
    editor: { focus(options) { calls.push(['focus', options]); } },
    app: { updatePreview() { calls.push('preview'); } },
  };
  removeCollage.call(manager);
  assert.deepEqual(calls, ['deselect', ['remove', collage], 'preview']);

  const fallbackCalls = [];
  removeCollage.call({
    ...manager,
    _deselectImage() { fallbackCalls.push('deselect'); },
    _removeNodeWithFallback(node) { fallbackCalls.push(['remove', node]); },
    editor: {
      focus(options) {
        fallbackCalls.push(options ? 'focus-options' : 'focus-plain');
        if (options) throw new Error('focus options unsupported');
      },
    },
    app: { updatePreview() { fallbackCalls.push('preview'); } },
  });
  assert.deepEqual(fallbackCalls, ['deselect', ['remove', collage], 'preview']);

  const noSelectionCalls = [];
  removeCollage.call({
    ...manager,
    selectedImg: null,
    _deselectImage() { noSelectionCalls.push('deselect'); },
    _removeNodeWithFallback() { noSelectionCalls.push('remove'); },
    editor: { focus() { noSelectionCalls.push('focus'); } },
    app: { updatePreview() { noSelectionCalls.push('preview'); } },
  });
  assert.deepEqual(noSelectionCalls, []);
  assert.match(app, /function removeSelectedCollage\(\) \{ app\.editorManager\.removeSelectedCollage\(\); \}/);
  assert.match(css, /\.collage-action-row button:disabled/);
});

test('含自由拼贴的稀疏页面从顶部排版，短文字页仍可垂直居中', () => {
  const source = app.match(/function shouldCenterPageContent\(elements, usedRatio\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, '必须提供统一的页面居中判定');
  const shouldCenter = Function(`${source}; return shouldCenterPageContent;`)();
  assert.equal(shouldCenter([{ type: 'collage' }], 0.6), false);
  assert.equal(shouldCenter([{ type: 'p' }, { type: 'collage' }], 0.6), false);
  assert.equal(shouldCenter([{ type: 'p' }], 0.6), true);
  assert.equal(shouldCenter([{ type: 'img' }], 0.6), true, '普通图片页必须保持旧版垂直居中行为');
  assert.equal(shouldCenter([{ type: 'p' }], 0.85), false, '85% 边界不应垂直居中');
  assert.equal(shouldCenter([{ type: 'p' }], 0.9), false);
  assert.equal((app.match(/centerContent: shouldCenterPageContent\(currentPageEls, usedRatio\)/g) || []).length, 2);

  const paginateSource = extractBlock(app, /paginate\s*\(elements, buildAuthorHTML\)\s*\{/, 'PaginationEngine.paginate');
  const renderer = { createDomElement: (element) => ({ height: element.type === 'collage' ? 600 : 100 }) };
  const paginate = Function(
    'Renderer',
    'shouldCenterPageContent',
    `return ({${paginateSource}}).paginate;`,
  )(renderer, shouldCenter);
  const createEngine = () => ({
    container: { innerHTML: '', removeChild() {} },
    _createMeasureCard() {
      const body = {
        children: [],
        scrollHeight: 0,
        appendChild(node) {
          this.children.push(node);
          this.scrollHeight += node.height;
        },
        removeChild(node) {
          const index = this.children.indexOf(node);
          if (index >= 0) this.children.splice(index, 1);
          this.scrollHeight -= node.height;
        },
      };
      return { card: {}, body };
    },
    _getAvailable: () => 1000,
    _getContentHeight: (body) => body.children.reduce((sum, child) => sum + child.height, 0),
    _fixLeadingPunctuation() {},
    _splitParagraph: () => null,
  });
  assert.equal(paginate.call(createEngine(), [{ type: 'collage' }], () => '')[0].centerContent, false);
  assert.equal(paginate.call(createEngine(), [{ type: 'p' }], () => '')[0].centerContent, true);
});

test('异步压图期间切换草稿不会写入失效目标', () => {
  assert.match(app, /pendingCollageContext/);
  assert.match(app, /requestContext\.accountId !== cardAccountId\(\)/);
  assert.match(app, /target && \(!target\.isConnected \|\| !this\.editor\.contains\(target\)\)/);
  assert.match(app, /if \(!this\.editor\.contains\(range\.commonAncestorContainer\)\) throw new Error/);
  assert.match(app, /const liveCount = target \? target\.querySelectorAll/);
  assert.match(app, /const liveAvailable = Math\.max\(0, api\.MAX_ITEMS - liveCount\)/);
  assert.match(app, /const acceptedDataURLs = dataURLs\.slice\(0, liveAvailable \|\| api\.MAX_ITEMS\)/);
});

test('异常拼贴降级时不会截断第九张之后的图片', () => {
  const fallbackStart = app.indexOf('异常结构按普通图片顺序降级');
  const fallbackEnd = app.indexOf('const entries = normalizeCollageDOMEntries', fallbackStart);
  const fallback = app.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /Array\.from\(source\.querySelectorAll\('img'\)\)\.forEach/);
  assert.doesNotMatch(fallback, /slice\(0, api\.MAX_ITEMS\)/);
});
