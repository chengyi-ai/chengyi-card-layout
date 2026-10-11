'use strict';

// ===== 编辑器：自由拼贴 =====
// 拼贴的生成、拖拽、层级与尺寸调整，挂到 EditorManager 原型上。
Object.assign(EditorManager.prototype, {
  _collageItemModel(item) {
    return collageLayoutAPI().normalizeItem({
      id: item?.dataset.collageItemId,
      x: item?.dataset.collageX,
      y: item?.dataset.collageY,
      width: item?.dataset.collageWidth,
      z: item?.dataset.collageZ,
    });
  },

  _writeCollageItemModel(item, model) {
    if (!item) return;
    const normalized = collageLayoutAPI().normalizeItem(model);
    item.dataset.collageItemId = normalized.id;
    item.dataset.collageX = String(normalized.x);
    item.dataset.collageY = String(normalized.y);
    item.dataset.collageWidth = String(normalized.width);
    item.dataset.collageZ = String(normalized.z);
    item.style.left = `${normalized.x / 100}%`;
    item.style.top = `${normalized.y / 100}%`;
    item.style.width = `${normalized.width / 100}%`;
    item.style.zIndex = String(normalized.z);
  },

  _applyCollageHeight(collage) {
    if (!collage) return;
    const height = collageLayoutAPI().normalizeHeight(collage.dataset.collageHeight);
    collage.dataset.collageHeight = String(height);
    collage.style.aspectRatio = `${CARD_W - CARD_PADDING_X * 2} / ${height}`;
  },

  _hydrateCollages(root = this.editor) {
    const seenCollageIds = new Set();
    root.querySelectorAll?.('.image-collage[data-card-collage="1"]').forEach((collage, collageIndex) => {
      const baseId = safeCollageId(collage.dataset.collageId, `collage-${collageIndex + 1}`);
      let collageId = baseId;
      let suffix = 2;
      while (seenCollageIds.has(collageId)) collageId = `${baseId}-${suffix++}`;
      seenCollageIds.add(collageId);
      collage.dataset.collageId = collageId;
      collage.setAttribute('contenteditable', 'false');
      this._applyCollageHeight(collage);
      const items = Array.from(collage.children).filter((child) => child.classList.contains('collage-item'));
      normalizeCollageDOMEntries(items).forEach(({ node: item, index, model }) => {
        const keepSelected = Boolean(this.selectedImg && item.contains(this.selectedImg));
        item.className = 'collage-item';
        if (keepSelected) item.classList.add('selected');
        item.setAttribute('contenteditable', 'false');
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'group');
        item.setAttribute('aria-label', `拼贴图片 ${index + 1}`);
        this._writeCollageItemModel(item, model);
        const img = item.querySelector(':scope > img');
        if (img) {
          img.draggable = false;
          img.style.width = '100%';
          const clampAfterLoad = () => {
            this._clampCollageItem(item);
            this.app.debouncedUpdate?.();
          };
          if (img.complete) requestAnimationFrame(clampAfterLoad);
          else img.addEventListener('load', clampAfterLoad, { once: true });
        }
        if (!item.querySelector(':scope > .collage-resize-handle')) {
          const handle = document.createElement('span');
          handle.className = 'collage-resize-handle';
          handle.dataset.collageResize = '1';
          handle.setAttribute('aria-hidden', 'true');
          item.appendChild(handle);
        }
        if (!item.querySelector(':scope > .collage-delete-handle')) {
          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.className = 'collage-delete-handle';
          deleteButton.dataset.collageDelete = '1';
          deleteButton.setAttribute('aria-label', `删除拼贴图片 ${index + 1}`);
          deleteButton.title = '删除这张图片';
          deleteButton.textContent = '×';
          item.appendChild(deleteButton);
        }
      });
      this._editableAnchorAfterNode(collage);
    });
  },

  _scheduleCollageHydration() {
    if (this.collageHydrationFrame) return;
    this.collageHydrationFrame = requestAnimationFrame(() => {
      this.collageHydrationFrame = 0;
      if (this.selectedImg && !this.editor.contains(this.selectedImg)) this._deselectImage();
      const needsHydration = Array.from(this.editor.querySelectorAll('.image-collage[data-card-collage="1"]')).some((collage) => (
        !collage.style.aspectRatio
        || Array.from(collage.querySelectorAll(':scope > .collage-item')).some((item) => (
          !item.style.width
          || !item.querySelector(':scope > .collage-resize-handle')
          || !item.querySelector(':scope > .collage-delete-handle')
        ))
      ));
      if (needsHydration) this._hydrateCollages();
    });
  },

  _clampCollageItem(item) {
    const collage = item?.closest?.('.image-collage');
    if (!collage) return;
    const containerRect = collage.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height || !itemRect.width || !itemRect.height) return;
    const api = collageLayoutAPI();
    let model = this._collageItemModel(item);
    let itemWidth = itemRect.width;
    let itemHeight = itemRect.height;
    if (itemHeight > containerRect.height && model.width > api.MIN_ITEM_WIDTH) {
      const fittedWidth = Math.max(api.MIN_ITEM_WIDTH, Math.floor(model.width * containerRect.height / itemHeight));
      const scale = fittedWidth / model.width;
      model = { ...model, width: fittedWidth };
      itemWidth *= scale;
      itemHeight *= scale;
    }
    const next = api.moveItem(model, {
      deltaX: 0,
      deltaY: 0,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      itemWidth,
      itemHeight,
    });
    this._writeCollageItemModel(item, next);
  },

  _syncCollageSettings(img) {
    const item = img?.closest?.('.collage-item');
    const settings = document.getElementById('collageSettings');
    if (!settings) return;
    settings.hidden = !item;
    if (!item) return;
    const collage = item.closest('.image-collage');
    const height = collageLayoutAPI().normalizeHeight(collage?.dataset.collageHeight);
    document.getElementById('collageHeightSlider').value = String(height);
    document.getElementById('collageHeightLabel').textContent = `${height} px`;
    const ordered = Array.from(collage.querySelectorAll(':scope > .collage-item'))
      .map((entry) => this._collageItemModel(entry))
      .sort((a, b) => a.z - b.z);
    const position = ordered.findIndex((model) => model.id === item.dataset.collageItemId);
    const backwardButton = document.getElementById('collageLayerBackward');
    const forwardButton = document.getElementById('collageLayerForward');
    if (backwardButton) backwardButton.disabled = position <= 0;
    if (forwardButton) forwardButton.disabled = position < 0 || position >= ordered.length - 1;
  },

  _onCollagePointerDown(event) {
    if (event.target.closest?.('[data-collage-delete="1"]')) return;
    const item = event.target.closest?.('.collage-item');
    if (!item || !this.editor.contains(item)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const collage = item.closest('.image-collage');
    const img = item.querySelector(':scope > img');
    if (!collage || !img) return;
    const containerRect = collage.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const controlsWereActive = document.getElementById('imgResizeBar').classList.contains('active');
    const deferControls = this.selectedImg !== img || !controlsWereActive;
    this._selectImage(img, { deferControls });
    this.collageDrag = {
      pointerId: event.pointerId,
      mode: event.target.closest?.('[data-collage-resize="1"]') ? 'resize' : 'move',
      item,
      startX: event.clientX,
      startY: event.clientY,
      startModel: this._collageItemModel(item),
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      itemWidth: itemRect.width,
      itemHeight: itemRect.height,
      deferControls,
      moved: false,
      controlsWereActive,
    };
    try { item.setPointerCapture?.(event.pointerId); } catch (_) { /* window 级 pointerup 仍会收尾 */ }
    event.preventDefault();
  },

  _onCollagePointerMove(event) {
    const drag = this.collageDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const api = collageLayoutAPI();
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2)) {
      drag.moved = true;
      this._clearFallbackDeleteTransaction();
    }
    const next = drag.mode === 'resize'
      ? api.resizeItem(drag.startModel, { deltaX, containerWidth: drag.containerWidth })
      : api.moveItem(drag.startModel, {
        deltaX,
        deltaY,
        containerWidth: drag.containerWidth,
        containerHeight: drag.containerHeight,
        itemWidth: drag.itemWidth,
        itemHeight: drag.itemHeight,
      });
    this._writeCollageItemModel(drag.item, next);
    document.getElementById('imgWidthSlider').value = String(Math.round(next.width / 100));
    document.getElementById('imgWidthLabel').textContent = `${Math.round(next.width / 100)}%`;
    this.app.debouncedUpdate();
    event.preventDefault();
  },

  _onCollagePointerEnd(event) {
    const drag = this.collageDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.collageDrag = null;
    try {
      if (event.type !== 'lostpointercapture' && drag.item.hasPointerCapture?.(event.pointerId)) {
        drag.item.releasePointerCapture(event.pointerId);
      }
    } catch (_) {
      // iOS 或元素被移除时释放捕获可能抛错；清状态和保存仍必须继续。
    } finally {
      if (drag.item.isConnected) {
        this._clampCollageItem(drag.item);
        const collage = drag.item.closest('.image-collage');
        this._cleanupVideoTimeline();
        const keepControlsDeferred = drag.deferControls && drag.moved && !drag.controlsWereActive;
        const img = drag.item.querySelector(':scope > img');
        if (drag.moved) {
          this.suppressCollageClickItem = drag.item;
          requestAnimationFrame(() => {
            if (this.suppressCollageClickItem === drag.item) this.suppressCollageClickItem = null;
            if (collage?.isConnected) this._placeCaretAfterNode(collage);
          });
        } else if (img && !keepControlsDeferred) {
          this._showSelectedImageControls(img);
          try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
          this.imageSelectionOwnsKeyboard = true;
        }
      }
      this.app.updatePreview();
      if (event.cancelable) event.preventDefault();
    }
  },

  setSelectedCollageHeight(value) {
    const collage = this.selectedImg?.closest?.('.image-collage');
    if (!collage) return;
    this._clearFallbackDeleteTransaction();
    const height = collageLayoutAPI().normalizeHeight(value);
    collage.dataset.collageHeight = String(height);
    document.getElementById('collageHeightSlider').value = String(height);
    document.getElementById('collageHeightLabel').textContent = `${height} px`;
    this._applyCollageHeight(collage);
    collage.querySelectorAll(':scope > .collage-item').forEach((item) => this._clampCollageItem(item));
    this.app.debouncedUpdate();
  },

  moveCollageItemLayer(direction) {
    const selectedItem = this.selectedImg?.closest?.('.collage-item');
    const collage = selectedItem?.closest?.('.image-collage');
    if (!selectedItem || !collage) return;
    this._clearFallbackDeleteTransaction();
    const items = Array.from(collage.querySelectorAll(':scope > .collage-item'));
    const models = items.map((item) => this._collageItemModel(item));
    const updated = collageLayoutAPI().stepLayer(models, selectedItem.dataset.collageItemId, direction);
    const byId = new Map(updated.map((model) => [model.id, model]));
    items.forEach((item) => this._writeCollageItemModel(item, byId.get(item.dataset.collageItemId) || this._collageItemModel(item)));
    this._syncCollageSettings(this.selectedImg);
    this.app.updatePreview();
  },

  removeSelectedCollageImage() {
    const item = this.selectedImg?.closest?.('.collage-item');
    const collage = item?.closest?.('.image-collage');
    if (!item || !collage) return;
    this._deselectImage();
    const remaining = collage.querySelectorAll(':scope > .collage-item').length - 1;
    if (remaining <= 0) {
      this._removeNodeWithFallback(collage);
    } else {
      // Chrome 对 contenteditable=false 容器里的子节点可能静默忽略 execCommand。
      // 临时把容器变成可编辑宿主以争取保留原生撤销；节点仍在时再直接删除。
      const deleteAnchor = this._captureFallbackDelete(item);
      const previousEditable = collage.getAttribute('contenteditable');
      collage.setAttribute('contenteditable', 'true');
      try {
        try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
        this._removeNodeUndoable(item);
      } finally {
        if (previousEditable === null) collage.removeAttribute('contenteditable');
        else collage.setAttribute('contenteditable', previousEditable);
      }
      this._finishFallbackDelete(deleteAnchor);
      if (collage.isConnected) {
        this._hydrateCollages();
        const nextImg = collage.querySelector(':scope > .collage-item:last-of-type > img');
        if (nextImg) this._selectImage(nextImg);
      }
    }
    this.app.updatePreview();
  },

  removeSelectedCollage() {
    const collage = this.selectedImg?.closest?.('.image-collage');
    if (!collage) return;
    this._deselectImage();
    this._removeNodeWithFallback(collage);
    this.app.updatePreview();
  },

  _isStaticCollageImage(img) {
    return img?.tagName === 'IMG' && img.dataset.mediaKind !== 'video' && !img.closest('.image-collage');
  },

  _collageCandidate(node) {
    if (this._isStaticCollageImage(node)) return { node, img: node };
    if (!node?.matches?.('div, p') || node.matches('.page-break-marker, .image-collage')) return null;
    const images = Array.from(node.querySelectorAll('img'));
    if (images.length !== 1 || !this._isStaticCollageImage(images[0]) || node.textContent.trim()) return null;
    const hasUnsupportedElement = Array.from(node.querySelectorAll('*')).some((child) => !child.matches('div, p, span, img, br'));
    return hasUnsupportedElement ? null : { node, img: images[0] };
  },

  _collectAdjacentStaticImages(img) {
    if (!this._isStaticCollageImage(img)) return { images: [], firstNode: null, lastNode: null };
    const anchorNode = this._topLevelEditorNode(img);
    const anchor = this._collageCandidate(anchorNode);
    if (!anchor) return { images: [], firstNode: null, lastNode: null, mixedContent: true };
    const isGap = (node) => node && (
      (node.nodeType === Node.TEXT_NODE && !node.textContent.trim())
      || node.tagName === 'BR'
      || (node.matches?.('div, p') && !node.textContent.trim() && node.querySelectorAll('img').length === 0)
    );
    const findCandidate = (start, direction) => {
      let cursor = start?.[direction] || null;
      while (cursor && isGap(cursor)) cursor = cursor[direction];
      return this._collageCandidate(cursor);
    };
    const entries = [anchor];
    let cursor = anchor.node;
    while (entries.length < collageLayoutAPI().MAX_ITEMS) {
      const previous = findCandidate(cursor, 'previousSibling');
      if (!previous) break;
      entries.unshift(previous);
      cursor = previous.node;
    }
    cursor = anchor.node;
    while (entries.length < collageLayoutAPI().MAX_ITEMS) {
      const next = findCandidate(cursor, 'nextSibling');
      if (!next) break;
      entries.push(next);
      cursor = next.node;
    }
    return {
      images: entries.map((entry) => entry.img),
      firstNode: entries[0].node,
      lastNode: entries[entries.length - 1].node,
    };
  },

  _newCollageId() {
    return safeCollageId(`c${Date.now()}${Math.random().toString(36).slice(2, 7)}`, `c${Date.now()}`);
  },

  _buildCollageNode(images) {
    const api = collageLayoutAPI();
    const collage = document.createElement('div');
    collage.className = 'image-collage';
    collage.dataset.cardCollage = '1';
    collage.dataset.collageId = this._newCollageId();
    collage.dataset.collageHeight = String(api.DEFAULT_HEIGHT);
    collage.setAttribute('contenteditable', 'false');
    const models = api.defaultItems(images.length);
    images.slice(0, api.MAX_ITEMS).forEach((source, index) => {
      const model = { ...models[index], id: `i${Date.now()}${index}${Math.random().toString(36).slice(2, 5)}` };
      const item = document.createElement('div');
      item.className = 'collage-item';
      item.dataset.collageItemId = model.id;
      item.dataset.collageX = String(model.x);
      item.dataset.collageY = String(model.y);
      item.dataset.collageWidth = String(model.width);
      item.dataset.collageZ = String(model.z);
      item.setAttribute('contenteditable', 'false');
      const img = document.createElement('img');
      img.src = source.src;
      const rawFrame = source.getAttribute('data-frame');
      if (rawFrame !== null) img.dataset.frame = normalizeImageFrame(rawFrame) || 'normal';
      item.appendChild(img);
      collage.appendChild(item);
    });
    return collage;
  },

  _insertCollageNode(collage) {
    this.editor.focus();
    this._restoreInsertionRange();
    document.execCommand('insertHTML', false, `<br>${collage.outerHTML}<br>`);
    const inserted = this.editor.querySelector(`.image-collage[data-collage-id="${collage.dataset.collageId}"]`);
    if (!inserted) return null;
    this._editableAnchorAfterNode(inserted);
    this._hydrateCollages(inserted.parentElement || this.editor);
    const firstImg = inserted.querySelector('.collage-item > img');
    if (firstImg) this._selectImage(firstImg);
    this.app.updatePreview();
    return inserted;
  },

  _convertImagesToCollage(group) {
    const images = Array.isArray(group) ? group : group?.images || [];
    const eligible = images.filter((img) => this._isStaticCollageImage(img));
    if (eligible.length === 0) return;
    const collage = this._buildCollageNode(eligible);
    const range = document.createRange();
    range.setStartBefore(group?.firstNode || eligible[0]);
    range.setEndAfter(group?.lastNode || eligible[eligible.length - 1]);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertHTML', false, collage.outerHTML);
    const inserted = this.editor.querySelector(`.image-collage[data-collage-id="${collage.dataset.collageId}"]`);
    if (inserted) {
      this._editableAnchorAfterNode(inserted);
      this._hydrateCollages(inserted.parentElement || this.editor);
      const firstImg = inserted.querySelector('.collage-item > img');
      if (firstImg) this._selectImage(firstImg);
    }
    this.app.updatePreview();
  },

  createImageCollage() {
    if (this.selectedImg?.dataset.mediaKind === 'video') {
      alert('自由拼贴首版只支持静态图片，视频和 Live Photo 请继续使用普通排版。');
      return;
    }
    if (this.selectedImg?.closest('.collage-item')) {
      this.addImagesToCollage();
      return;
    }
    if (this._isStaticCollageImage(this.selectedImg)) {
      const group = this._collectAdjacentStaticImages(this.selectedImg);
      if (group.mixedContent) {
        alert('这张图片和文字位于同一个段落中，不能安全转换。请先让图片单独成行，或取消选中后点击“自由拼贴”重新多选图片。');
        return;
      }
      this._convertImagesToCollage(group);
      return;
    }
    this.pendingCollageId = '';
    this.pendingCollageContext = { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
    this._rememberInsertionRange();
    document.getElementById('collageInput').click();
  },

  addImagesToCollage() {
    const collage = this.selectedImg?.closest?.('.image-collage');
    if (!collage) return;
    this.pendingCollageId = collage.dataset.collageId;
    this.pendingCollageContext = { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
    document.getElementById('collageInput').click();
  },

  async handleCollageFiles(input) {
    const files = Array.from(input.files || []).filter((file) => file.type.startsWith('image/'));
    input.value = '';
    const requestedCollageId = this.pendingCollageId;
    const requestContext = this.pendingCollageContext || { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
    this.pendingCollageId = '';
    this.pendingCollageContext = null;
    await this._insertCollageFiles(files, requestedCollageId, requestContext);
  },

  async _insertCollageFiles(files, requestedCollageId, requestContext) {
    if (files.length === 0) return;
    const api = collageLayoutAPI();
    if (requestContext.accountId !== cardAccountId() || requestContext.draftId !== this.app.getActiveDraftId()) {
      alert('当前草稿已经切换，本次图片未加入。请在目标草稿中重新选择。');
      return;
    }
    const target = requestedCollageId
      ? this.editor.querySelector(`.image-collage[data-collage-id="${requestedCollageId}"]`)
      : null;
    if (requestedCollageId && !target) {
      alert('目标拼贴区已被删除或替换，本次图片未加入。请重新选择目标拼贴区。');
      return;
    }
    const currentCount = target ? target.querySelectorAll(':scope > .collage-item').length : 0;
    const available = Math.max(0, api.MAX_ITEMS - currentCount);
    if (available === 0) {
      alert(`每个自由拼贴区最多放 ${api.MAX_ITEMS} 张图片`);
      return;
    }
    const selectedFiles = files.slice(0, available);
    if (files.length > available) alert(`本次只加入前 ${available} 张；每个拼贴区最多 ${api.MAX_ITEMS} 张图片。`);
    const dataURLs = await Promise.all(selectedFiles.map((file) => compressImageFile(file, 1500, 0.85)));
    if (requestContext.accountId !== cardAccountId() || requestContext.draftId !== this.app.getActiveDraftId()
      || (target && (!target.isConnected || !this.editor.contains(target)))) {
      alert('图片处理期间草稿或拼贴区发生了变化，本次图片未加入。请重新选择。');
      return;
    }
    const liveCount = target ? target.querySelectorAll(':scope > .collage-item').length : 0;
    const liveAvailable = Math.max(0, api.MAX_ITEMS - liveCount);
    if (target && liveAvailable === 0) {
      alert(`图片处理期间该拼贴区已达到 ${api.MAX_ITEMS} 张，本次图片未加入。`);
      return;
    }
    const acceptedDataURLs = dataURLs.slice(0, liveAvailable || api.MAX_ITEMS);
    if (acceptedDataURLs.length < dataURLs.length) {
      alert(`拼贴区内容已变化，本次只加入前 ${acceptedDataURLs.length} 张，确保总数不超过 ${api.MAX_ITEMS} 张。`);
    }
    const images = acceptedDataURLs.map((src) => {
      const img = document.createElement('img');
      img.src = src;
      return img;
    });

    if (!target) {
      this._insertCollageNode(this._buildCollageNode(images));
      return;
    }

    this._clearFallbackDeleteTransaction();
    const defaults = api.defaultItems(liveCount + images.length).slice(liveCount);
    images.forEach((img, index) => {
      const model = { ...defaults[index], id: `i${Date.now()}${index}${Math.random().toString(36).slice(2, 5)}` };
      const item = document.createElement('div');
      item.className = 'collage-item';
      item.dataset.collageItemId = model.id;
      item.dataset.collageX = String(model.x);
      item.dataset.collageY = String(model.y);
      item.dataset.collageWidth = String(model.width);
      item.dataset.collageZ = String(liveCount + index + 1);
      item.setAttribute('contenteditable', 'false');
      item.appendChild(img);
      target.appendChild(item);
    });
    this._hydrateCollages(target.parentElement || this.editor);
    const lastImg = target.querySelector(':scope > .collage-item:last-of-type > img');
    if (lastImg) this._selectImage(lastImg);
    this._editableAnchorAfterNode(target);
    this.app.updatePreview();
  },
});
