// ===== 主应用 =====
class ArticleCardApp {
  constructor() {
    this.editorManager = new EditorManager(this);
    this.parser = new ContentParser(this.editorManager);
    this.pagination = new PaginationEngine(document.getElementById('measureContainer'));
    this.previewArea = document.getElementById('previewArea');
    this.accountId = cardAccountId();
    this.storageWriteBlocked = false;
    this.storageLoadError = '';
    this.lastSaveFailed = false;
    this.saveFailureAlerted = false;
    this.localSavePending = false;
    this.pendingStoreSnapshot = null;
    this.localSavePromise = null;
    this.lastLocalSavedAt = 0;
    this.initialized = false;
    this.exporting = false;
    this.debouncedUpdate = debounce(() => this.updatePreview(), 100);
    const storageAPI = window.CardDraftStorage;
    if (!storageAPI?.CardDraftRepository) {
      throw new Error('草稿存储组件未正确加载');
    }
    this.draftRepository = new storageAPI.CardDraftRepository();
    this.unsubscribeDraftUpdates = this.draftRepository.subscribe((message) => {
      if (message.accountId === this.accountId) this._reloadExternalDraftStore();
    });

    // 防抖：手机弹出键盘也会触发 resize，避免每次都全量重排
    window.addEventListener('resize', debounce(() => this.updatePreview(), 200));
    window.addEventListener('pagehide', () => {
      if (!window.cardDraftRestoreInProgress) this.saveDraft();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && !window.cardDraftRestoreInProgress) this.saveDraft();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!this.lastSaveFailed && !this.localSavePending) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  async initialize() {
    this.editorManager.editor.setAttribute('contenteditable', 'false');
    this._setDraftStatus('正在读取草稿…', 'saving');
    this.store = await this._loadStore();
    this._restoreLoadedStore();
    try { await getCardMediaStore(); } catch (error) {
      this._setDraftStatus(`⚠ ${error.message}，请保留旧素材并稍后重试`, 'error');
    }
    this._initDate();
    this.initialized = true;
    this.editorManager.editor.setAttribute('contenteditable', 'true');
    this.updatePreview();
    this.editorManager.editor.focus();
  }

  _initDate() {
    const input = document.getElementById('pubDate');
    if (input.value) return;
    const now = new Date();
    const y = String(now.getFullYear()).slice(2);
    const m = now.getMonth() + 1;
    const d = now.getDate();
    input.value = `${y}/${m}/${d}`;
  }

  // ===== 多草稿管理 =====
  // 存储结构：{ drafts: [{id, title, updatedAt, data:{content,...}}], activeId }

  _collectData() {
    return normalizeDraftData({
      schemaVersion: CARD_DRAFT_SCHEMA_VERSION,
      content: this.editorManager.getSerializableHTML(),
      authorName: document.getElementById('authorName').value,
      pubDate: document.getElementById('pubDate').value,
      avatar: this.editorManager.avatarDataURL,
      filename: document.getElementById('exportFilename').value,
      defaultImageFrame: this.editorManager.defaultImageFrame,
    });
  }

  _applyData(data) {
    const normalized = normalizeDraftData(data);
    this.editorManager._clearFallbackDeleteTransaction();
    this.editorManager._deselectImage();
    this.editorManager.editor.innerHTML = normalized.content;
    window.CreatorHighlight?.normalize(this.editorManager.editor);
    this.editorManager._hydrateCollages();
    document.getElementById('authorName').value = normalized.authorName || '程意';
    document.getElementById('pubDate').value = normalized.pubDate;
    this.editorManager.avatarDataURL = normalized.avatar;
    const avatarImg = document.getElementById('avatarImg');
    if (normalized.avatar) avatarImg.src = normalized.avatar;
    else avatarImg.removeAttribute('src');
    document.getElementById('exportFilename').value = normalized.filename || 'article-card';
    this.editorManager.setDefaultImageFrameFromDraft(normalized.defaultImageFrame);
  }

  async _loadStore() {
    const emptyStore = { schemaVersion: CARD_DRAFT_SCHEMA_VERSION, drafts: [], activeId: null, deletedDrafts: {} };
    this.storageWriteBlocked = false;
    this.storageLoadError = '';
    const accountId = this.accountId;

    let localStore = null;
    const migrationKey = 'article-card-local-migration-v1';
    const scopedKey = cardStorageKey('article-card-drafts', accountId);
    try {
      const keys = [scopedKey];
      if (!localStorage.getItem(migrationKey)) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key === 'article-card-drafts' || key?.startsWith('article-card-drafts:')) keys.push(key);
        }
      }
      for (const key of new Set(keys)) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const candidate = normalizeCardDraftStore(JSON.parse(raw));
          localStore = localStore ? mergeCardDraftStores(localStore, candidate) : candidate;
        } catch (error) { this.storageLoadError = error.message || '旧草稿读取失败'; }
      }
      if (!localStorage.getItem(migrationKey)) {
        const legacy = localStorage.getItem('article-card-draft');
        if (legacy) {
          const draft = { id: 'legacy-single-draft', title: '旧草稿', updatedAt: 1, data: JSON.parse(legacy) };
          const candidate = normalizeCardDraftStore({ ...emptyStore, drafts: [draft], activeId: draft.id });
          localStore = localStore ? mergeCardDraftStores(localStore, candidate) : candidate;
        }
      }
    } catch (error) {
      this.storageLoadError = error.message || '草稿读取失败';
    }

    let indexedStore = null;
    try {
      indexedStore = await this.draftRepository.load(accountId);
      if (indexedStore) indexedStore = normalizeCardDraftStore(indexedStore);
    } catch (error) {
      this.storageLoadError = error instanceof Error ? error.message : '大容量草稿读取失败';
    }

    if (!indexedStore && !localStore && this.storageLoadError) {
      // 原数据可能损坏且没有可用副本。保留原 key，禁止空草稿覆盖。
      this.storageWriteBlocked = true;
      return emptyStore;
    }

    const selected = indexedStore && localStore
      ? mergeCardDraftStores(indexedStore, localStore)
      : (indexedStore || localStore || emptyStore);
    if (localStore) {
      try {
        await this.draftRepository.save(accountId, selected);
        if (!this.storageLoadError) localStorage.setItem(migrationKey, '1');
      } catch (error) {
        this.storageLoadError = `旧草稿已读取，但迁移失败：${error.message || '未知错误'}`;
      }
    }
    return normalizeCardDraftStore(selected);
  }

  _makeDraft(data) {
    const normalized = normalizeDraftData(data);
    return {
      id: 'd' + Date.now() + Math.random().toString(36).slice(2, 6),
      title: this._titleFrom(normalized.content),
      updatedAt: Date.now(),
      data: normalized,
    };
  }

  _titleFrom(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const text = div.textContent.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 14) : '未命名草稿';
  }

  _saveStore() {
    if (this.storageWriteBlocked) {
      this.lastSaveFailed = true;
      this._setDraftStatus(`⚠ ${this.storageLoadError || '草稿读取失败'}，已停止自动保存`, 'error');
      return Promise.resolve(false);
    }
    this.store.schemaVersion = CARD_DRAFT_SCHEMA_VERSION;
    this.store.deletedDrafts ||= {};
    this.pendingStoreSnapshot = JSON.parse(JSON.stringify(this.store));
    this.localSavePending = true;
    this._setDraftStatus('正在保存…', 'saving');
    if (this.localSavePromise) return this.localSavePromise;

    this.localSavePromise = (async () => {
      let success = true;
      while (this.pendingStoreSnapshot) {
        const snapshot = this.pendingStoreSnapshot;
        this.pendingStoreSnapshot = null;
        try {
          await this.draftRepository.save(this.accountId, snapshot);
          // 大容量存储成功后移除旧 localStorage 正文，避免再次撞到 5–10MB 配额。
          localStorage.removeItem(cardStorageKey('article-card-drafts', this.accountId));
          this.lastSaveFailed = false;
          this.saveFailureAlerted = false;
          this.lastLocalSavedAt = Date.now();
        } catch (indexedError) {
          // 极少数不支持 IndexedDB 的浏览器仍允许用旧缓存临时兜底。
          try {
            localStorage.setItem(cardStorageKey('article-card-drafts', this.accountId), JSON.stringify(snapshot));
            this.lastSaveFailed = false;
            this.lastLocalSavedAt = Date.now();
            this._setDraftStatus('本机已保存（兼容模式）', 'saved');
          } catch (_) {
            success = false;
            this.lastSaveFailed = true;
            this._setDraftStatus('⚠ 草稿未保存，请立即导出备份', 'error');
            if (!this.saveFailureAlerted) {
              this.saveFailureAlerted = true;
              setTimeout(() => alert(`草稿保存失败：${indexedError.message || '浏览器存储不可用'}。请保持页面打开并立即导出备份。`), 0);
            }
          }
        }
      }
      return success;
    })().finally(() => {
      this.localSavePending = false;
      this.localSavePromise = null;
      if (!this.lastSaveFailed) this._renderSaveStatus();
      if (this.pendingStoreSnapshot) this._saveStore();
    });
    return this.localSavePromise;
  }

  _setDraftStatus(msg, state = '') {
    const el = document.getElementById('draftSaveStatus');
    if (!el) return;
    el.textContent = msg || '';
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
  }

  _timeLabel(value = Date.now()) {
    return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  _renderSaveStatus() {
    if (this.lastSaveFailed) return;
    if (this.localSavePending) return this._setDraftStatus('正在保存…', 'saving');
    const suffix = this.lastLocalSavedAt ? ` ${this._timeLabel(this.lastLocalSavedAt)}` : '';
    return this._setDraftStatus(`本机已保存${suffix}`, 'saved');
  }

  _activeDraft() {
    return this.store?.drafts?.find((d) => d.id === this.store.activeId) || null;
  }

  getActiveDraftId() {
    return this._activeDraft()?.id || '';
  }

  _writeActiveDraft() {
    const draft = this._activeDraft();
    if (!draft) return true;
    draft.data = this._collectData();
    draft.title = this._titleFrom(draft.data.content);
    draft.updatedAt = Date.now();
    const saved = this._saveStore();
    // 只更新当前选项文字，避免重建下拉打断交互
    const select = document.getElementById('draftSelect');
    const opt = select && Array.from(select.options).find((option) => option.value === draft.id);
    if (opt) opt.textContent = this._draftLabel(draft);
    return saved;
  }

  saveDraft() {
    return this._writeActiveDraft();
  }

  async _mergeExternalDraftStore(raw) {
    if (!raw || this.storageWriteBlocked) return this.store;
    try {
      const before = JSON.stringify(this.store);
      const remote = normalizeCardDraftStore(typeof raw === 'string' ? JSON.parse(raw) : raw);
      const localById = new Map(this.store.drafts.map((draft) => [draft.id, draft]));
      remote.drafts.forEach((draft) => {
        const local = localById.get(draft.id);
        if (!local) {
          localById.set(draft.id, draft);
        } else if (Number(draft.updatedAt) > Number(local.updatedAt)) {
          if (draft.id === this.store.activeId) {
            // 当前标签也正在编辑同一草稿时保留两个版本，绝不静默覆盖用户眼前内容。
            const conflictId = safeDraftId(`${draft.id}-external-${draft.updatedAt}`, `external-${Date.now()}`);
            if (!localById.has(conflictId)) {
              localById.set(conflictId, {...draft,id:conflictId,title:`${draft.title}（其他标签页）`});
            }
          } else {
            localById.set(draft.id, draft);
          }
        }
      });
      const activeId = this.store.activeId;
      this.store = {
        schemaVersion: CARD_DRAFT_SCHEMA_VERSION,
        drafts: [...localById.values()],
        activeId: localById.has(activeId) ? activeId : remote.activeId,
        deletedDrafts: { ...(remote.deletedDrafts || {}), ...(this.store.deletedDrafts || {}) },
      };
      this.store = normalizeCardDraftStore(this.store);
      if (JSON.stringify(this.store) !== before) await this._saveStore();
      this._renderDraftSelect();
      this._setDraftStatus('已合并其他标签页的草稿更新', 'saved');
      return this.store;
    } catch (_) {
      this._setDraftStatus('⚠ 其他标签页的草稿更新格式异常，已忽略', 'error');
      return this.store;
    }
  }

  async _reloadExternalDraftStore() {
    if (!this.accountId || this.localSavePending) return;
    try {
      const remote = await this.draftRepository.load(this.accountId);
      if (remote) await this._mergeExternalDraftStore(remote);
    } catch (_) {}
  }

  _restoreLoadedStore() {
    if (this.store.drafts.length === 0) {
      const data = this._collectData();
      const draft = this._makeDraft(data);
      this.store.drafts.push(draft);
      this.store.activeId = draft.id;
    }
    if (!this._activeDraft()) this.store.activeId = this.store.drafts[0].id;
    this._applyData(this._activeDraft().data);
    this._renderDraftSelect();
  }

  _draftLabel(draft) {
    const d = new Date(draft.updatedAt);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${draft.title}（${time}）`;
  }

  _renderDraftSelect() {
    const select = document.getElementById('draftSelect');
    if (!select) return;
    select.innerHTML = '';
    // 最近更新的排前面
    const sorted = [...this.store.drafts].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const draft of sorted) {
      const opt = document.createElement('option');
      opt.value = draft.id;
      opt.textContent = this._draftLabel(draft);
      opt.selected = draft.id === this.store.activeId;
      select.appendChild(opt);
    }
  }

  async switchDraft(id) {
    if (id === this.store.activeId) return;
    if (!await this.saveDraft()) return;  // 先保存当前；失败时不能丢下当前草稿
    this.store.activeId = id;
    const draft = this._activeDraft();
    if (!draft) return;
    this._applyData(draft.data);
    await this._saveStore();
    this.updatePreview();
  }

  async newDraft() {
    if (!await this.saveDraft()) return;  // 先保存当前
    // 新草稿：保留作者身份，清空内容
    const data = this._collectData();
    data.content = '';
    data.filename = 'article-card';
    const now = new Date();
    data.pubDate = `${String(now.getFullYear()).slice(2)}/${now.getMonth() + 1}/${now.getDate()}`;
    const draft = this._makeDraft(data);
    this.store.drafts.push(draft);
    this.store.activeId = draft.id;
    this._applyData(data);
    await this._saveStore();
    this._renderDraftSelect();
    this.updatePreview();
    this.editorManager.editor.focus();
  }

  async deleteDraft() {
    const draft = this._activeDraft();
    if (!draft) return;
    if (!confirm(`确定删除草稿「${draft.title}」吗？`)) return;
    const deletedDraftId = draft.id;
    const deletedAt = Date.now();
    const deletedDraftHasMedia = /\bdata-media-id\s*=|\bdata-media-kind\s*=\s*(["'])video\1/i.test(String(draft.data?.content || ''));
    this.store.drafts = this.store.drafts.filter((d) => d.id !== draft.id);
    this.store.deletedDrafts ||= {};
    this.store.deletedDrafts[deletedDraftId] = deletedAt;
    if (this.store.drafts.length === 0) {
      // 删光了就建一个空的
      const data = this._collectData();
      data.content = '';
      const fresh = this._makeDraft(data);
      this.store.drafts.push(fresh);
    }
    this.store.activeId = this.store.drafts[0].id;
    this._applyData(this._activeDraft().data);
    const saved = await this._saveStore();
    this._renderDraftSelect();
    this.updatePreview();
    if (saved && deletedDraftHasMedia && this.accountId) {
      try {
        const mediaStore = await getCardMediaStore();
        await mediaStore.deleteDraft({ accountId: this.accountId, draftId: deletedDraftId });
      } catch (error) {
        const message = `草稿已删除，但本机视频素材清理失败：${error.message || '未知错误'}`;
        this._setDraftStatus(`⚠ ${message}`);
        alert(message);
      }
    }
  }

  buildAuthorHTML() {
    const name = document.getElementById('authorName').value || '\u4f5c\u8005';
    const date = document.getElementById('pubDate').value || '';
    const avatarSrc = this.editorManager.avatarDataURL;

    const author = document.createElement('div');
    author.className = 'card-author';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'card-avatar';
    if (avatarSrc) {
      const avatarImg = document.createElement('img');
      avatarImg.src = avatarSrc;
      avatarImg.alt = '';
      avatarWrap.appendChild(avatarImg);
    }

    const info = document.createElement('div');
    info.className = 'card-author-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'card-author-name';
    nameSpan.textContent = name;

    // 认证徽标 SVG
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'verified-badge');
    svg.setAttribute('viewBox', '0 0 22 22');
    const path1 = document.createElementNS(svgNS, 'path');
    path1.setAttribute('d', 'M11 1L14.1 3.6 18.1 3.9 18.4 7.9 21 11 18.4 14.1 18.1 18.1 14.1 18.4 11 21 7.9 18.4 3.9 18.1 3.6 14.1 1 11 3.6 7.9 3.9 3.9 7.9 3.6Z');
    path1.setAttribute('fill', '#4A90D9');
    const path2 = document.createElementNS(svgNS, 'path');
    path2.setAttribute('d', 'M9.7 14.8L6.3 11.4 7.7 10 9.7 12 13.7 8 15.1 9.4Z');
    path2.setAttribute('fill', 'white');
    svg.appendChild(path1);
    svg.appendChild(path2);

    const dateSpan = document.createElement('span');
    dateSpan.className = 'card-author-date';
    dateSpan.textContent = date;

    info.appendChild(nameSpan);
    info.appendChild(svg);
    info.appendChild(dateSpan);
    author.appendChild(avatarWrap);
    author.appendChild(info);

    return author.outerHTML;
  }

  updatePreview() {
    if (!this.initialized) return;
    const elements = this.parser.parse();
    const pages = this.pagination.paginate(elements, () => this.buildAuthorHTML());
    Renderer.renderPreview(pages, this.previewArea, () => this.buildAuthorHTML());
    // 同步页数到移动预览按钮角标
    const countEl = document.getElementById('mobilePreviewCount');
    if (countEl) countEl.textContent = pages.length;
    // 字数统计（不含空白字符）
    const wordEl = document.getElementById('wordCount');
    if (wordEl) {
      const chars = this.editorManager.editor.innerText.replace(/\s/g, '').length;
      wordEl.textContent = `${chars} 字 · ${pages.length} 页`;
    }
    this.saveDraft().catch((error) => {
      this.lastSaveFailed = true;
      this._setDraftStatus(`⚠ ${error.message || '草稿保存失败'}`, 'error');
    });
  }

  async exportImage() {
    const progressEl = document.getElementById('exportProgress');
    const button = document.querySelector('.export-btn');
    if (this.exporting) {
      progressEl.style.display = 'block';
      progressEl.textContent = '已有导出任务正在进行，请稍候';
      return;
    }
    this.exporting = true;
    if (button) button.disabled = true;
    progressEl.style.display = 'block';

    try {
      // 时间轴只用于静帧预览；导出前明确暂停，避免后台解码与正式合成争用资源。
      document.getElementById('mediaTimelineVideo')?.pause();
      const elements = this.parser.parse();
      const authorHTML = this.buildAuthorHTML();
      const pages = this.pagination.paginate(elements, () => authorHTML);
      const baseName = document.getElementById('exportFilename').value.trim() || 'article-card';
      await Exporter.exportImage(
        JSON.parse(JSON.stringify(pages)),
        () => authorHTML,
        baseName,
        progressEl,
        { accountId: this.accountId, draftId: this.getActiveDraftId() },
      );
    } catch (error) {
      progressEl.textContent = `导出失败：${error.message||"未知错误"}`;
      alert(`导出失败：${error.message||"未知错误"}`);
    } finally {
      this.exporting = false;
      if (button) button.disabled = false;
    }
  }

  async flushDrafts() {
    const saved = await this.saveDraft();
    if (this.localSavePromise) await this.localSavePromise;
    return saved !== false && !this.lastSaveFailed;
  }

  async replaceDraftStore(nextStore) {
    this.store = normalizeCardDraftStore(nextStore);
    if (!await this._saveStore()) throw new Error('恢复草稿保存失败');
    this._restoreLoadedStore();
    this.updatePreview();
    return this.store;
  }
}

// ===== 初始化 =====
let app;
window.cardAppStorageKey = (base) => cardStorageKey(base, app ? app.accountId : cardAccountId());
window.flushCardDrafts = async () => {
  return app ? app.flushDrafts() : true;
};
window.getCardDraftStore = async () => {
  if (!app) return null;
  if (!await app.flushDrafts()) return null;
  return JSON.parse(JSON.stringify(app.store));
};
window.replaceCardDraftStore = async (store) => {
  if (!app) return false;
  await app.replaceDraftStore(store);
  return true;
};
window.reloadCardDrafts = async () => {
  if (!app) return false;
  else {
    app.store = await app._loadStore();
    if (app.storageWriteBlocked) return false;
    app._restoreLoadedStore();
    app.updatePreview();
  }
  return true;
};

window.addEventListener('DOMContentLoaded', async () => {
  app = new ArticleCardApp();
  registerServiceWorker();
  try {
    await app.initialize();
  } catch (error) {
    app.lastSaveFailed = true;
    app._setDraftStatus(`⚠ ${error.message || '草稿初始化失败'}`, 'error');
    app.editorManager.editor.setAttribute('contenteditable', 'true');
  }
});

// ===== Service Worker（PWA 离线支持）=====
function registerServiceWorker() {
  // 图文工具内容和排版逻辑更新频繁。主动清理旧版缓存优先 Service Worker，
  // 但绝不触碰 localStorage 中的用户草稿。
  navigator.serviceWorker?.getRegistrations?.().then((registrations) => {
    registrations
      .filter((registration) => new URL(registration.scope).origin === location.origin)
      .forEach((registration) => registration.unregister());
  }).catch(() => {});
  window.caches?.keys?.().then((keys) => {
    keys.filter((key) => key.startsWith('card-tool-')).forEach((key) => window.caches.delete(key));
  }).catch(() => {});
}

// ===== 移动端预览开关 =====
let mobilePreviewScrollY = 0;
function openMobilePreview() {
  const previewArea = document.getElementById('previewArea');
  const body = document.body;
  if (!body.classList.contains('preview-open')) {
    mobilePreviewScrollY = window.scrollY;
    body.style.top = `-${mobilePreviewScrollY}px`;
  }
  previewArea.classList.add('mobile-active');
  body.classList.add('preview-open');
  document.querySelectorAll('.command-preview-button, .mobile-preview-btn').forEach((button) => button.setAttribute('aria-expanded', 'true'));
  requestAnimationFrame(() => {
    app?.updatePreview();
    document.querySelector('.mobile-close-btn')?.focus();
  });
}
function closeMobilePreview() {
  const previewArea = document.getElementById('previewArea');
  const body = document.body;
  previewArea.classList.remove('mobile-active');
  body.classList.remove('preview-open');
  body.style.top = '';
  window.scrollTo(0, mobilePreviewScrollY);
  document.querySelectorAll('.command-preview-button, .mobile-preview-btn').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  document.querySelector('.command-preview-button')?.focus();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('preview-open')) closeMobilePreview();
});

// HTML 中 onclick 调用的全局入口
function handleAvatar(input) { app.editorManager.handleAvatar(input); }
function handleImageFile(input) { app.editorManager.handleImageFile(input); }
function handleCollageFiles(input) { app.editorManager.handleCollageFiles(input); }
function handleVideoFile(input) { app.editorManager.handleVideoFile(input); }
function insertImageFromFile() { app.editorManager.insertImageFromFile(); }
function createImageCollage() { app.editorManager.createImageCollage(); }
function addImagesToCollage() { app.editorManager.addImagesToCollage(); }
function insertVideoFromFile() { app.editorManager.insertVideoFromFile(); }
function toggleBold() { app.editorManager.toggleBold(); }
function toggleHighlight() { app.editorManager.toggleHighlight(); }
function resizeSelectedImage(pct) { app.editorManager.resizeSelectedImage(pct); }
function setImageFrame(frame) { app.editorManager.setImageFrame(frame); }
function setSelectedCollageHeight(value) { app.editorManager.setSelectedCollageHeight(value); }
function moveCollageItemLayer(direction) { app.editorManager.moveCollageItemLayer(direction); }
function removeSelectedCollageImage() { app.editorManager.removeSelectedCollageImage(); }
function removeSelectedCollage() { app.editorManager.removeSelectedCollage(); }
function setDefaultImageFrame(frame) { app.editorManager.setDefaultImageFrame(frame); }
function updateSelectedVideoSettings() { app.editorManager.updateSelectedVideoSettings(); }
function updatePreview() { app.updatePreview(); }
function exportImage() { app.exportImage(); }
function copyTextOnly() { app.editorManager.copyTextOnly(); }
function clearContent() {
  if (!confirm('确定要清空所有内容吗？')) return;
  app.editorManager._clearFallbackDeleteTransaction();
  app.editorManager._deselectImage();
  app.editorManager.editor.innerHTML = '';
  app.updatePreview();
}

// ===== 分页符 =====
function insertPageBreak() { app.editorManager.insertPageBreak(); }

// ===== 草稿管理入口 =====
function switchDraft(id) { app.switchDraft(id); }
function newDraft() { app.newDraft(); }
function deleteDraft() { app.deleteDraft(); }

// ===== 撤销 / 重做 =====
function undoEdit() {
  app.editorManager.editor.focus();
  if (app.editorManager._applyFallbackDeleteHistory('undo')) return;
  document.execCommand('undo');
  app.editorManager.rehydrateAfterHistory();
}
function redoEdit() {
  app.editorManager.editor.focus();
  if (app.editorManager._applyFallbackDeleteHistory('redo')) return;
  document.execCommand('redo');
  app.editorManager.rehydrateAfterHistory();
}

// ===== 全局快捷键：Ctrl+E 导出 =====
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    if (app) app.exportImage();
  }
});
