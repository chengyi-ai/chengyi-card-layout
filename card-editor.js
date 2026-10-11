// ===== 编辑器管理 =====
class EditorManager {
  constructor(app) {
    this.app = app;
    this.editor = document.getElementById('contentEditor');
    this.selectedImg = null;
    this.avatarDataURL = '';
    this.defaultImageFrame = '';
    this.timelineSession = 0;
    this.timelineMediaKey = '';
    this.timelineObjectURL = '';
    this.timelineSourceDuration = 0;
    this.timelineSelection = null;
    this.timelineDrag = null;
    this.timelinePreviewFrame = 0;
    this.timelineHelpersPromise = null;
    this.timelineFrameCache = new Map();
    this.collageDrag = null;
    this.collageHydrationFrame = 0;
    this.imageSelectionOwnsKeyboard = false;
    this.suppressCollageClickItem = null;
    this.pendingCollageId = '';
    this.pendingCollageContext = null;
    this.savedInsertionRange = null;
    this.fallbackDeleteTxn = null;
    this._bindEvents();
  }

  _bindEvents() {
    this.editor.addEventListener('paste', (e) => this._onPaste(e));
    this.editor.addEventListener('dragover', (e) => e.preventDefault());
    this.editor.addEventListener('drop', (e) => this._onDrop(e));
    this.editor.addEventListener('click', (e) => this._onClick(e));
    this.editor.addEventListener('focusin', (e) => this._onFocusIn(e));
    this.editor.addEventListener('keydown', (e) => this._onKeydown(e));
    this.editor.addEventListener('pointerdown', (e) => this._onCollagePointerDown(e));
    this.editor.addEventListener('pointermove', (e) => this._onCollagePointerMove(e));
    this.editor.addEventListener('pointerup', (e) => this._onCollagePointerEnd(e));
    this.editor.addEventListener('pointercancel', (e) => this._onCollagePointerEnd(e));
    this.editor.addEventListener('lostpointercapture', (e) => this._onCollagePointerEnd(e));
    window.addEventListener('pointerup', (e) => this._onCollagePointerEnd(e));
    window.addEventListener('pointercancel', (e) => this._onCollagePointerEnd(e));
    this.editor.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') {
        this._clearFallbackDeleteTransaction();
      }
    });
    this.editor.addEventListener('input', () => {
      if (this.selectedImg && !this.imageSelectionOwnsKeyboard) this._deselectImage();
      window.CreatorHighlight?.normalize(this.editor);
      this._scheduleCollageHydration();
      this.app.debouncedUpdate();
    });

    const widthSlider = document.getElementById('imgWidthSlider');
    const heightSlider = document.getElementById('collageHeightSlider');
    widthSlider.addEventListener('change', () => this.app.updatePreview());
    widthSlider.addEventListener('pointercancel', () => this.app.updatePreview());
    heightSlider?.addEventListener('change', () => this.app.updatePreview());
    heightSlider?.addEventListener('pointercancel', () => this.app.updatePreview());

    const timelineTrack = document.getElementById('mediaTimelineTrack');
    if (timelineTrack) {
      timelineTrack.addEventListener('pointerdown', (event) => this._onTimelinePointerDown(event));
      timelineTrack.addEventListener('pointermove', (event) => this._onTimelinePointerMove(event));
      timelineTrack.addEventListener('pointerup', (event) => this._onTimelinePointerEnd(event));
      timelineTrack.addEventListener('pointercancel', (event) => this._onTimelinePointerEnd(event));
      timelineTrack.addEventListener('keydown', (event) => this._onTimelineKeydown(event));
    }
  }

  // — 头像 —
  // 头像在卡片上最大 72px（导出 2 倍即 144px），压到 256px 足够
  async handleAvatar(input) {
    const file = input.files[0];
    if (!file) return;
    const dataURL = await compressImageFile(file, 256, 0.85);
    this.avatarDataURL = dataURL;
    document.getElementById('avatarImg').src = dataURL;
    this.app.updatePreview();
  }

  // — 粘贴：清洗格式，只保留纯文本+换行+图片 —
  _onPaste(e) {
    e.preventDefault();
    const clipData = e.clipboardData;

    // 优先检查图片。选中自由拼贴内的图片时，把剪贴板图片直接加入该拼贴区。
    const imageFiles = Array.from(clipData.items || [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (imageFiles.length > 0) {
      const targetCollage = this.selectedImg?.closest?.('.image-collage');
      if (targetCollage) {
        const requestContext = { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
        void this._insertCollageFiles(imageFiles, targetCollage.dataset.collageId, requestContext);
      } else {
        void this._insertImageFile(imageFiles[0]);
      }
      return;
    }

    // 纯文本
    const text = clipData.getData('text/plain');
    if (text) {
      const cleaned = escapeHTML(text).replace(/\n/g, '<br>');
      document.execCommand('insertHTML', false, cleaned);
    }
  }


  // — 拖拽图片或视频 —
  _onDrop(e) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && (files[0].type.startsWith('image/') || isSupportedVideoFile(files[0]))) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (isSupportedVideoFile(files[0])) void this._insertVideoFile(files[0]);
      else void this._insertImageFile(files[0]);
    }
  }

  // — 点击图片选中 —
  _onClick(e) {
    const deleteHandle = e.target.closest?.('[data-collage-delete="1"]');
    if (deleteHandle) {
      e.preventDefault();
      e.stopPropagation();
      const img = deleteHandle.closest?.('.collage-item')?.querySelector(':scope > img');
      if (img && this.editor.contains(img)) {
        this._selectImage(img);
        this.removeSelectedCollageImage();
      }
      return;
    }
    const collageItem = e.target.closest?.('.collage-item');
    if (collageItem && collageItem === this.suppressCollageClickItem) {
      this.suppressCollageClickItem = null;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const collageImg = collageItem?.querySelector('img');
    if (collageImg && this.editor.contains(collageImg)) {
      this._selectImage(collageImg);
    } else if (e.target.tagName === 'IMG' && this.editor.contains(e.target)) {
      this._selectImage(e.target);
    } else {
      this._deselectImage();
    }
  }

  _onFocusIn(e) {
    const item = e.target.closest?.('.collage-item');
    const img = item?.querySelector(':scope > img');
    if (img && this.editor.contains(img) && this.collageDrag?.item !== item) this._selectImage(img);
  }

  // — 键盘事件：Ctrl+B 加粗 / Ctrl+Enter 分页 / Delete 删除图片 —
  _onKeydown(e) {
    const historyShortcut = (e.metaKey || e.ctrlKey) && !e.altKey && String(e.key || '').toLowerCase() === 'z';
    if (historyShortcut) {
      const direction = e.shiftKey ? 'redo' : 'undo';
      if (this._applyFallbackDeleteHistory(direction)) {
        e.preventDefault();
        return;
      }
      requestAnimationFrame(() => this.rehydrateAfterHistory());
      return;
    }

    const focusedCollageItem = e.target.closest?.('.collage-item');
    const focusedCollageImg = focusedCollageItem?.querySelector(':scope > img');
    if (focusedCollageImg && this.selectedImg !== focusedCollageImg) this._selectImage(focusedCollageImg);

    if (e.key === 'Escape' && this.selectedImg) {
      e.preventDefault();
      this._deselectImage();
      return;
    }

    const selectedCollageItem = this.selectedImg?.closest?.('.collage-item');
    if (this.imageSelectionOwnsKeyboard && selectedCollageItem && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const collage = selectedCollageItem.closest('.image-collage');
      const api = collageLayoutAPI();
      const step = e.shiftKey ? 500 : 100;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const containerRect = collage.getBoundingClientRect();
      const itemRect = selectedCollageItem.getBoundingClientRect();
      const itemHeightBasis = containerRect.height ? itemRect.height / containerRect.height * api.BASE : 0;
      const next = api.moveByKeyboard(this._collageItemModel(selectedCollageItem), dx, dy, itemHeightBasis);
      this._writeCollageItemModel(selectedCollageItem, next);
      this.app.updatePreview();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      this.toggleBold();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      this.insertPageBreak();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      this.toggleHighlight();
      return;
    }

    if (this.imageSelectionOwnsKeyboard && this.selectedImg && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      if (selectedCollageItem) this.removeSelectedCollageImage();
      else {
        this._removeImageUndoable(this.selectedImg);
        this._deselectImage();
        this.app.updatePreview();
      }
      return;
    }

    // 光标紧挨图片时的删除处理
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const node = range.startContainer;
    const offset = range.startOffset;
    const adjacentCollage = e.key === 'Backspace'
      ? this._adjacentTopLevelNodeFromCaret(range, 'backward')
      : e.key === 'Delete'
        ? this._adjacentTopLevelNodeFromCaret(range, 'forward')
        : null;
    if (this._removeAdjacentCollageUndoable(e, adjacentCollage)) return;

    if (e.key === 'Backspace' && node.nodeType === Node.ELEMENT_NODE) {
      const prev = node.childNodes[offset - 1];
      if (prev && prev.tagName === 'IMG') {
        e.preventDefault();
        this._removeImageUndoable(prev);
        this.app.updatePreview();
      }
    }
    if (e.key === 'Delete' && node.nodeType === Node.ELEMENT_NODE) {
      const next = node.childNodes[offset];
      if (next && next.tagName === 'IMG') {
        e.preventDefault();
        this._removeImageUndoable(next);
        this.app.updatePreview();
      }
    }
  }

  // 通过选区 + execCommand 删除图片，保留在撤销历史中（Ctrl+Z 可恢复）
  _removeImageUndoable(img) {
    if (img?.closest?.('.collage-item')) {
      this._selectImage(img);
      this.removeSelectedCollageImage();
      return;
    }
    this._removeNodeWithFallback(img);
  }

  _removeAdjacentCollageUndoable(event, collage) {
    if (!collage?.matches?.('.image-collage')) return false;
    event.preventDefault();
    this._deselectImage();
    this._removeNodeWithFallback(collage);
    this.app.updatePreview();
    return true;
  }

  _removeNodeUndoable(node) {
    if (!node?.parentNode) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
  }

  _clearFallbackDeleteTransaction() {
    this.fallbackDeleteTxn = null;
  }

  _captureFallbackDelete(node) {
    this._clearFallbackDeleteTransaction();
    if (!node?.parentNode) return null;
    return {
      node,
      parent: node.parentNode,
      nextSibling: node.nextSibling,
      accountId: cardAccountId(),
      draftId: this.app.getActiveDraftId(),
    };
  }

  _finishFallbackDelete(anchor) {
    if (!anchor || anchor.node.parentNode !== anchor.parent) return false;
    anchor.node.remove();
    this.fallbackDeleteTxn = { ...anchor, state: 'deleted' };
    return true;
  }

  _removeNodeWithFallback(node) {
    const anchor = this._captureFallbackDelete(node);
    if (!anchor) return false;
    try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
    this._removeNodeUndoable(node);
    return this._finishFallbackDelete(anchor);
  }

  _applyFallbackDeleteHistory(direction) {
    const txn = this.fallbackDeleteTxn;
    if (!txn) return false;
    const sameContext = txn.accountId === cardAccountId() && txn.draftId === this.app.getActiveDraftId();
    if (!sameContext || !txn.parent?.isConnected) {
      this._clearFallbackDeleteTransaction();
      return false;
    }

    if (direction === 'undo') {
      if (txn.state !== 'deleted' || txn.node.isConnected) {
        this._clearFallbackDeleteTransaction();
        return false;
      }
      const anchor = txn.nextSibling?.parentNode === txn.parent ? txn.nextSibling : null;
      txn.parent.insertBefore(txn.node, anchor);
      txn.state = 'restored';
    } else if (direction === 'redo') {
      if (txn.state !== 'restored' || txn.node.parentNode !== txn.parent) {
        this._clearFallbackDeleteTransaction();
        return false;
      }
      txn.node.remove();
      txn.state = 'deleted';
    } else {
      this._clearFallbackDeleteTransaction();
      return false;
    }

    try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
    this.rehydrateAfterHistory();
    return true;
  }

  toggleBold() {
    this.editor.focus();
    document.execCommand('bold');
    this.app.updatePreview();
  }

  // — 荧光笔标记：选中文字加浅黄底色，已标记的再点一次取消 —
  toggleHighlight() {
    this.editor.focus();
    if (window.CreatorHighlight?.toggleSelection(this.editor)) this.app.updatePreview();
  }

  _selectionHighlighted() {
    return window.CreatorHighlight?.selectionIsHighlighted(this.editor) || false;
  }

  // 在光标处插入分页符（execCommand 保证可撤销）
  insertPageBreak() {
    this.editor.focus();
    document.execCommand('insertHTML', false, '<div class="page-break-marker" contenteditable="false"></div><br>');
    this.app.updatePreview();
  }

  // — 图片选择 / 缩放 —
  _selectImage(img, options = {}) {
    if (!img || !this.editor.contains(img)) return;
    if (this.selectedImg !== img) {
      if (options.deferControls) {
        this.selectedImg?.classList.remove('selected');
        this.selectedImg?.closest?.('.collage-item')?.classList.remove('selected');
      } else {
        this._deselectImage();
      }
      this.selectedImg = img;
      img.classList.add('selected');
      img.closest?.('.collage-item')?.classList.add('selected');
    }
    this.imageSelectionOwnsKeyboard = true;
    if (options.deferControls) return;
    this._showSelectedImageControls(img);
  }

  _showSelectedImageControls(img = this.selectedImg) {
    if (!img || !this.editor.contains(img)) return;
    const collageItem = img.closest?.('.collage-item');
    const bar = document.getElementById('imgResizeBar');
    bar.classList.add('active');
    const widthSlider = document.getElementById('imgWidthSlider');
    if (collageItem) {
      const api = collageLayoutAPI();
      widthSlider.min = String(api.MIN_ITEM_WIDTH / 100);
      widthSlider.max = String(api.MAX_ITEM_WIDTH / 100);
    } else {
      widthSlider.min = '20';
      widthSlider.max = '100';
    }
    const pct = collageItem
      ? Math.round(collageLayoutAPI().normalizeItem(this._collageItemModel(collageItem)).width / 100)
      : Math.round((img.offsetWidth / (this.editor.clientWidth - 24)) * 100);
    widthSlider.value = String(pct);
    document.getElementById('imgWidthLabel').textContent = pct + '%';
    document.getElementById('imgScaleLabel').textContent = collageItem ? '拼贴内宽度：' : '整体缩放：';
    document.getElementById('imgScaleHint').textContent = collageItem
      ? '调整当前图片在拼贴中的占比，拖动右下角圆点也可以缩放。'
      : '以图片中心为基准等比缩放，内部文字和图表一起缩小，不裁切。';
    this._syncFrameButtons(normalizeImageFrame(img.dataset.frame));
    this._syncVideoSettings(img);
    this._syncCollageSettings(img);
  }

  _deselectImage() {
    this.imageSelectionOwnsKeyboard = false;
    if (this.selectedImg) {
      this.selectedImg.classList.remove('selected');
      this.selectedImg.closest?.('.collage-item')?.classList.remove('selected');
      this.selectedImg = null;
    }
    document.getElementById('imgResizeBar').classList.remove('active');
    const videoSettings = document.getElementById('videoSettings');
    if (videoSettings) videoSettings.hidden = true;
    const collageSettings = document.getElementById('collageSettings');
    if (collageSettings) collageSettings.hidden = true;
    this._cleanupVideoTimeline();
  }

  resizeSelectedImage(pct) {
    if (!this.selectedImg) return;
    this._clearFallbackDeleteTransaction();
    const collageItem = this.selectedImg.closest?.('.collage-item');
    if (collageItem) {
      const api = collageLayoutAPI();
      const current = this._collageItemModel(collageItem);
      const next = api.normalizeItem({ ...current, width: Number(pct) * 100 });
      this._writeCollageItemModel(collageItem, next);
      this._clampCollageItem(collageItem);
      const applied = this._collageItemModel(collageItem);
      document.getElementById('imgWidthSlider').value = String(Math.round(applied.width / 100));
      document.getElementById('imgWidthLabel').textContent = Math.round(applied.width / 100) + '%';
      this.app.debouncedUpdate();
      return;
    }
    const scale = Math.max(20, Math.min(100, Number(pct) || 100));
    // 图片始终作为一个完整对象居中等比缩放：只改变宽度，高度由原始比例自动计算。
    this.selectedImg.style.width = scale + '%';
    this.selectedImg.style.height = 'auto';
    document.getElementById('imgWidthLabel').textContent = scale + '%';
    this.app.debouncedUpdate();
  }

  // — 图片样式预设 —
  setImageFrame(frame) {
    if (!this.selectedImg) return;
    this._clearFallbackDeleteTransaction();
    const normalized = normalizeImageFrame(frame);
    if (normalized) {
      this.selectedImg.dataset.frame = normalized;
    } else if (this.defaultImageFrame) {
      // 默认样式不是正常版时，用显式 normal 记住这张图片仍需保持正常版。
      this.selectedImg.dataset.frame = 'normal';
    } else {
      delete this.selectedImg.dataset.frame;
    }
    this._syncFrameButtons(normalized);
    this.app.updatePreview();
  }

  _syncFrameButtons(frame) {
    document.querySelectorAll('.img-frame-btn').forEach((btn) => {
      btn.classList.toggle('active', normalizeImageFrame(btn.dataset.frame) === normalizeImageFrame(frame));
    });
  }

  _editableAnchorAfterNode(node) {
    if (!node?.parentNode) return null;
    const next = node.nextSibling;
    const nextIsEmptyText = next?.nodeType === Node.TEXT_NODE && !next.textContent;
    const nextIsNonEditable = next?.nodeType === Node.ELEMENT_NODE && (
      next.getAttribute('contenteditable') === 'false'
      || next.matches?.('.image-collage, .page-break-marker, img')
    );
    if (next && !nextIsNonEditable && !nextIsEmptyText) return next;
    const anchor = document.createElement('br');
    anchor.dataset.collageCaret = '1';
    node.parentNode.insertBefore(anchor, next || null);
    return anchor;
  }

  _adjacentTopLevelNodeFromCaret(range, direction) {
    if (!range?.collapsed) return null;
    const backward = direction === 'backward';
    let current = range.startContainer;
    const offset = range.startOffset;
    if (current === this.editor) {
      return this.editor.childNodes[backward ? offset - 1 : offset] || null;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      const boundary = backward ? offset === 0 : offset === current.textContent.length;
      if (!boundary) return null;
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      const boundary = backward ? offset === 0 : offset === current.childNodes.length;
      if (!boundary) return null;
    } else {
      return null;
    }
    while (current?.parentNode && current.parentNode !== this.editor) {
      if (backward ? current.previousSibling : current.nextSibling) return null;
      current = current.parentNode;
    }
    if (current?.parentNode !== this.editor) return null;
    return backward ? current.previousSibling : current.nextSibling;
  }

  _placeCaretAfterNode(node) {
    if (!node?.isConnected || !this.editor.contains(node)) return;
    const anchor = this._editableAnchorAfterNode(node);
    if (!anchor) return;
    this.editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    if (anchor.nodeType === Node.TEXT_NODE) range.setStart(anchor, 0);
    else if (anchor.tagName === 'BR') range.setStartBefore(anchor);
    else {
      range.selectNodeContents(anchor);
      range.collapse(true);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    this.imageSelectionOwnsKeyboard = false;
  }

  rehydrateAfterHistory() {
    this._deselectImage();
    this._scheduleCollageHydration();
    requestAnimationFrame(() => this.app.updatePreview());
  }

  setDefaultImageFrame(frame) {
    this.defaultImageFrame = normalizeImageFrame(frame);
    this._syncDefaultFrameButtons(this.defaultImageFrame);
    this.app.updatePreview();
  }

  _syncDefaultFrameButtons(frame) {
    document.querySelectorAll('.default-frame-btn').forEach((btn) => {
      btn.classList.toggle('active', normalizeImageFrame(btn.dataset.defaultFrame) === normalizeImageFrame(frame));
    });
  }

  setDefaultImageFrameFromDraft(frame) {
    this.defaultImageFrame = normalizeImageFrame(frame);
    this._syncDefaultFrameButtons(this.defaultImageFrame);
    this._syncFrameButtons('');
  }

  getSerializableHTML() {
    const clone = this.editor.cloneNode(true);
    window.CreatorHighlight?.normalize(clone);
    clone.querySelectorAll('br[data-collage-caret="1"]').forEach((node) => node.remove());
    clone.querySelectorAll('.selected').forEach((node) => node.classList.remove('selected'));
    clone.querySelectorAll('.collage-resize-handle, .collage-delete-handle').forEach((node) => node.remove());
    clone.querySelectorAll('.image-collage[data-card-collage="1"]').forEach((collage) => {
      collage.removeAttribute('style');
      collage.removeAttribute('tabindex');
      collage.querySelectorAll(':scope > .collage-item').forEach((item) => {
        item.removeAttribute('style');
        item.removeAttribute('tabindex');
        item.removeAttribute('role');
        item.removeAttribute('aria-label');
        const img = item.querySelector(':scope > img');
        if (img) {
          img.removeAttribute('style');
          img.removeAttribute('draggable');
        }
      });
    });
    clone.querySelectorAll('img').forEach((img) => {
      const rawFrame = img.getAttribute('data-frame');
      if (rawFrame !== null) {
        const frame = normalizeImageFrame(rawFrame);
        img.dataset.frame = frame || 'normal';
      } else if (this.defaultImageFrame) {
        // 缺少属性代表这张旧图片是正常版，显式标记后就不会被默认投影覆盖。
        img.dataset.frame = 'normal';
      }
    });
    return clone.innerHTML;
  }

  // — 图片插入 —
  insertImageFromFile() {
    document.getElementById('imageInput').click();
  }

  _rememberInsertionRange() {
    const selection = window.getSelection();
    this.savedInsertionRange = selection?.rangeCount && this.editor.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange()
      : null;
  }

  _restoreInsertionRange() {
    if (!this.savedInsertionRange) return;
    const selection = window.getSelection();
    const range = this.savedInsertionRange;
    this.savedInsertionRange = null;
    try {
      if (!this.editor.contains(range.commonAncestorContainer)) throw new Error('插入位置已失效');
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {
      const fallback = document.createRange();
      fallback.selectNodeContents(this.editor);
      fallback.collapse(false);
      selection.removeAllRanges();
      selection.addRange(fallback);
    }
  }

  _topLevelEditorNode(node) {
    let current = node;
    while (current?.parentNode && current.parentNode !== this.editor) current = current.parentNode;
    return current?.parentNode === this.editor ? current : null;
  }

  handleImageFile(input) {
    const file = input.files[0];
    if (!file) return;
    this._insertImageFile(file);
    input.value = '';
  }

  copyTextOnly() {
    const text = this.editor.innerText.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copyTextBtn');
      const orig = btn.textContent;
      btn.textContent = '\u2705 \u5df2\u590d\u5236';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  }

  // 压到 1500px 宽（导出图 2 倍分辨率正好是 1500，画质无感知损失）
  async _insertImageFile(file) {
    const dataURL = await compressImageFile(file, 1500, 0.85);
    this.editor.focus();
    const img = document.createElement('img');
    img.src = dataURL;
    img.style.width = '100%';
    if (this.defaultImageFrame) img.dataset.frame = this.defaultImageFrame;
    document.execCommand('insertHTML', false, '<br>' + img.outerHTML + '<br>');
    this.app.updatePreview();
  }
}
