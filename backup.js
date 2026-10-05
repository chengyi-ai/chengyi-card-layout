const DRAFT_BACKUP_KEY = 'article-card-drafts';
const DRAFT_BACKUP_TIME_KEY = 'article-card-last-backup';
const DRAFT_BACKUP_APP = 'ChengYi Card Layout';
const DRAFT_BACKUP_MEDIA_VERSION = 3;
const DRAFT_BACKUP_MAX_ZIP_BYTES = 500 * 1024 * 1024;
const hasDraftAccount = () => Boolean(localStorage.getItem('creator-toolkit-active-account-v1'));
const draftAccountId = () => String(localStorage.getItem('creator-toolkit-active-account-v1') || '').trim();
const draftAccountKey = (base) => window.cardAppStorageKey
  ? window.cardAppStorageKey(base)
  : (window.cardStorageKey ? window.cardStorageKey(base) : base);

function updateDraftBackupStatus() {
  const target = document.getElementById('draftBackupStatus');
  if (!target) return;
  if (target && !hasDraftAccount()) {
    target.textContent = '登录后可备份当前账户草稿';
    return;
  }
  const value = localStorage.getItem(draftAccountKey(DRAFT_BACKUP_TIME_KEY));
  target.textContent = value
    ? '上次备份 ' + new Date(value).toLocaleDateString('zh-CN')
    : '尚未备份当前账户草稿';
}

function draftHasContent(draft) {
  const html = String(draft?.data?.content || '');
  return /<img\b/i.test(html)
    || html
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;|&#160;|&#x0*a0;/gi, '')
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, '')
      .trim().length > 0;
}

function mergeDraftBackupStores(currentStore, backupStore, restoredAt = Date.now()) {
  return planDraftBackupRestore(currentStore, backupStore, restoredAt).store;
}

function planDraftBackupRestore(currentStore, backupStore, restoredAt = Date.now()) {
  const current = currentStore && Array.isArray(currentStore.drafts)
    ? currentStore
    : { schemaVersion: 2, drafts: [], activeId: null };
  const incoming = backupStore && Array.isArray(backupStore.drafts)
    ? backupStore
    : { schemaVersion: 2, drafts: [], activeId: null };
  const existingIds = new Set(current.drafts.map((draft) => String(draft.id || '')));
  const restoredIdBySourceId = new Map();
  const restoredDrafts = incoming.drafts.map((draft, index) => {
    const baseId = String(draft.id || `restored-${restoredAt}-${index + 1}`);
    let id = baseId;
    let suffix = 1;
    while (existingIds.has(id)) id = `${baseId}-restored-${restoredAt}-${suffix++}`;
    existingIds.add(id);
    if (!restoredIdBySourceId.has(baseId)) restoredIdBySourceId.set(baseId, id);
    return {
      ...draft,
      id,
      title: `${String(draft.title || '未命名草稿').replace(/（恢复副本）$/, '')}（恢复副本）`,
      updatedAt: restoredAt + index,
    };
  });
  const requestedActiveId = restoredIdBySourceId.get(String(incoming.activeId || ''));
  const requestedActiveDraft = restoredDrafts.find((draft) => (
    draft.id === requestedActiveId && draftHasContent(draft)
  ));
  const firstContentDraft = restoredDrafts.find(draftHasContent);
  return {
    store: {
      schemaVersion: Math.max(Number(current.schemaVersion) || 2, Number(incoming.schemaVersion) || 2),
      drafts: [...restoredDrafts, ...current.drafts],
      activeId: requestedActiveDraft?.id
        || firstContentDraft?.id
        || restoredDrafts[0]?.id
        || current.activeId
        || current.drafts[0]?.id
        || null,
      deletedDrafts: { ...(current.deletedDrafts || {}) },
    },
    draftIdMap: Object.fromEntries(restoredIdBySourceId),
  };
}

function draftMediaIds(draft) {
  const ids = new Set();
  const html = String(draft?.data?.content || '');
  const pattern = /\bdata-media-id\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const id = String(match[2] || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

function safeZipSegment(value, name) {
  const segment = String(value || '').trim();
  if (!segment) throw new Error(`${name} 不能为空`);
  return encodeURIComponent(segment).replace(/\*/g, '%2A');
}

function mediaAssetPath(asset) {
  return `assets/${safeZipSegment(asset.draftId, 'draftId')}/${safeZipSegment(asset.mediaId, 'mediaId')}/${safeZipSegment(asset.role, 'role')}`;
}

function rewriteDraftMediaIds(html, mediaIdMap, targetDraftId = '') {
  if (!mediaIdMap || !Object.keys(mediaIdMap).length) return String(html || '');
  const rewrittenIds = String(html || '').replace(/(\bdata-media-id\s*=\s*)(["'])(.*?)\2/gi, (whole, prefix, quote, mediaId) => {
    const mapped = mediaIdMap[mediaId];
    return mapped ? `${prefix}${quote}${mapped}${quote}` : whole;
  });
  if (!targetDraftId) return rewrittenIds;
  return rewrittenIds.replace(
    /(\bdata-media-draft-id\s*=\s*)(["'])(.*?)\2/gi,
    (_whole, prefix, quote) => `${prefix}${quote}${targetDraftId}${quote}`,
  );
}

function restoredMediaId(sourceMediaId, restoredAt, index) {
  const base = String(sourceMediaId || 'media')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'media';
  return `${base}-restored-${restoredAt}-${index + 1}`;
}

let mediaStorePromise = null;
async function getDraftMediaStore() {
  if (window.cardMediaStore) return window.cardMediaStore;
  if (!mediaStorePromise) {
    mediaStorePromise = import('./media-store.js').then((module) => {
      const Store = module.CardMediaStore || module.default;
      const instance = new Store();
      window.cardMediaStore = instance;
      return instance;
    }).catch((error) => {
      mediaStorePromise = null;
      throw error;
    });
  }
  return mediaStorePromise;
}

async function collectDraftMedia(drafts, accountId) {
  const referencedByDraft = new Map();
  drafts.forEach((draft) => {
    const ids = draftMediaIds(draft);
    if (ids.size) referencedByDraft.set(String(draft.id || ''), ids);
  });
  if (!referencedByDraft.size) return [];
  if (!globalThis.indexedDB && !window.cardMediaStore) {
    throw new Error('当前草稿包含视频，但浏览器媒体存储不可用，不能生成不完整备份');
  }
  const store = await getDraftMediaStore();
  const collected = [];
  for (const draft of drafts) {
    const referencedIds = referencedByDraft.get(String(draft.id || '')) || new Set();
    if (!referencedIds.size) continue;
    const assets = await store.listDraft({ accountId, draftId: String(draft.id || '') });
    const storedIds = new Set(assets.map((asset) => asset.mediaId));
    const missingIds = Array.from(referencedIds).filter((mediaId) => !storedIds.has(mediaId));
    if (missingIds.length) {
      throw new Error(`草稿“${draft.title || '未命名草稿'}”有媒体尚未保存完成，请稍后重试`);
    }
    for (const asset of assets) {
      if (referencedIds.has(asset.mediaId)) collected.push(asset);
    }
  }
  return collected;
}

function downloadDraftBackup(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  if (link.style) link.style.display = 'none';
  document.body?.appendChild?.(link);
  link.click();
  link.remove?.();
  // Safari / Chromium 可能在 click 返回后才开始读取大 ZIP，不能立即撤销。
  if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 60_000);
  else URL.revokeObjectURL(url);
}

async function exportDraftBackup() {
  try {
    if (!hasDraftAccount()) {
      throw new Error('请先登录账户，再备份当前账户的草稿');
    }
    if (window.flushCardDrafts && await window.flushCardDrafts() === false) {
      throw new Error('当前草稿尚未保存，请先缩小图片或释放浏览器存储空间');
    }
    const drafts = window.getCardDraftStore
      ? await window.getCardDraftStore()
      : JSON.parse(localStorage.getItem(draftAccountKey(DRAFT_BACKUP_KEY)) || '{}');
    if (!drafts) throw new Error('当前草稿尚未保存，请保持页面打开后重试');
    const normalizedDrafts = window.normalizeCardDraftStore
      ? window.normalizeCardDraftStore(drafts)
      : drafts;
    const exportedAt = new Date().toISOString();
    const accountId = draftAccountId();
    const media = await collectDraftMedia(normalizedDrafts.drafts || [], accountId);
    if (media.length) {
      if (typeof window.JSZip !== 'function') throw new Error('媒体备份组件尚未加载，请刷新页面后重试');
      const zip = new window.JSZip();
      const draftsV3 = { ...normalizedDrafts, schemaVersion: DRAFT_BACKUP_MEDIA_VERSION };
      const manifestMedia = media.map((asset) => ({
        draftId: asset.draftId,
        mediaId: asset.mediaId,
        role: asset.role,
        path: mediaAssetPath(asset),
        mimeType: asset.mimeType || asset.blob?.type || '',
        size: Number(asset.size || asset.blob?.size || 0),
        metadata: asset.metadata ?? null,
      }));
      const payload = {
        app: DRAFT_BACKUP_APP,
        version: DRAFT_BACKUP_MEDIA_VERSION,
        exportedAt,
        drafts: draftsV3,
        media: manifestMedia,
      };
      zip.file('manifest.json', JSON.stringify(payload, null, 2));
      media.forEach((asset, index) => zip.file(manifestMedia[index].path, asset.blob));
      // 视频本身已压缩，STORE 可避免导出 ZIP 时无收益地重复压缩数百 MB 素材。
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      downloadDraftBackup(blob, `chengyi-card-drafts-${exportedAt.slice(0, 10)}.zip`);
    } else {
      const payload = { app: DRAFT_BACKUP_APP, version: 2, exportedAt, drafts: normalizedDrafts };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      downloadDraftBackup(blob, `chengyi-card-drafts-${exportedAt.slice(0, 10)}.json`);
    }
    localStorage.setItem(draftAccountKey(DRAFT_BACKUP_TIME_KEY), exportedAt);
    updateDraftBackupStatus();
  } catch (error) {
    alert('草稿备份失败：' + error.message);
  }
}

async function readDraftBackup(file) {
  const looksLikeZip = /\.zip$/i.test(String(file.name || ''))
    || String(file.type || '').toLowerCase().includes('zip');
  if (!looksLikeZip) {
    const payload = JSON.parse(await file.text());
    return { payload, zip: null };
  }
  if (!window.JSZip || typeof window.JSZip.loadAsync !== 'function') {
    throw new Error('媒体备份组件尚未加载，请刷新页面后重试');
  }
  const zip = await window.JSZip.loadAsync(file, { checkCRC32: true });
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('ZIP 备份缺少 manifest.json');
  const payload = JSON.parse(await manifestFile.async('string'));
  return { payload, zip };
}

function validateMediaManifest(payload, zip) {
  if (!payload || payload.app !== DRAFT_BACKUP_APP || payload.version !== DRAFT_BACKUP_MEDIA_VERSION
    || !payload.drafts || typeof payload.drafts !== 'object' || !Array.isArray(payload.media) || !zip) {
    throw new Error('备份格式不正确');
  }
  const seen = new Set();
  const draftsById = new Map((payload.drafts.drafts || []).map((draft) => [String(draft.id || ''), draft]));
  const manifestIdsByDraft = new Map();
  payload.media.forEach((asset) => {
    const expectedPath = mediaAssetPath(asset);
    const sourceDraft = draftsById.get(String(asset.draftId || ''));
    if (!sourceDraft || !draftMediaIds(sourceDraft).has(String(asset.mediaId || ''))
      || asset.path !== expectedPath || seen.has(asset.path) || !zip.file(asset.path)) {
      throw new Error('ZIP 备份中的媒体清单不完整或路径不安全');
    }
    seen.add(asset.path);
    const draftId = String(asset.draftId || '');
    if (!manifestIdsByDraft.has(draftId)) manifestIdsByDraft.set(draftId, new Set());
    manifestIdsByDraft.get(draftId).add(String(asset.mediaId || ''));
  });
  draftsById.forEach((draft, draftId) => {
    const manifestIds = manifestIdsByDraft.get(draftId) || new Set();
    const missing = Array.from(draftMediaIds(draft)).some((mediaId) => !manifestIds.has(mediaId));
    if (missing) throw new Error('ZIP 备份中的媒体清单不完整或路径不安全');
  });
}

function prepareMediaRestore(mergePlan, manifestMedia, restoredAt) {
  const mediaIdMaps = Object.create(null);
  const prepared = manifestMedia.map((asset, index) => {
    const sourceDraftId = String(asset.draftId || '');
    const targetDraftId = mergePlan.draftIdMap[sourceDraftId];
    if (!targetDraftId) throw new Error(`媒体对应的草稿不存在：${sourceDraftId}`);
    if (!mediaIdMaps[sourceDraftId]) mediaIdMaps[sourceDraftId] = Object.create(null);
    const sourceMediaId = String(asset.mediaId || '');
    if (!mediaIdMaps[sourceDraftId][sourceMediaId]) {
      mediaIdMaps[sourceDraftId][sourceMediaId] = restoredMediaId(sourceMediaId, restoredAt, index);
    }
    return {
      ...asset,
      sourceDraftId,
      targetDraftId,
      targetMediaId: mediaIdMaps[sourceDraftId][sourceMediaId],
    };
  });

  Object.entries(mergePlan.draftIdMap).forEach(([sourceDraftId, targetDraftId]) => {
    const draft = mergePlan.store.drafts.find((candidate) => candidate.id === targetDraftId);
    if (!draft?.data || !mediaIdMaps[sourceDraftId]) return;
    draft.data = {
      ...draft.data,
      content: rewriteDraftMediaIds(draft.data.content, mediaIdMaps[sourceDraftId], targetDraftId),
    };
  });
  return prepared;
}

async function restoreMediaAssets({ zip, assets, accountId, mediaStore }) {
  const writtenDraftIds = new Set();
  try {
    for (const asset of assets) {
      const zippedAsset = zip.file(asset.path);
      if (!zippedAsset) throw new Error(`媒体文件缺失：${asset.path}`);
      let blob = await zippedAsset.async('blob');
      if (asset.mimeType && blob.type !== asset.mimeType) blob = new Blob([blob], { type: asset.mimeType });
      if (Number.isFinite(Number(asset.size)) && Number(asset.size) >= 0 && blob.size !== Number(asset.size)) {
        throw new Error(`媒体文件大小校验失败：${asset.path}`);
      }
      await mediaStore.put({
        accountId,
        draftId: asset.targetDraftId,
        mediaId: asset.targetMediaId,
        role: String(asset.role || ''),
        blob,
        metadata: asset.metadata ?? null,
      });
      writtenDraftIds.add(asset.targetDraftId);
    }
    return writtenDraftIds;
  } catch (error) {
    await Promise.allSettled(Array.from(writtenDraftIds, (draftId) => mediaStore.deleteDraft({ accountId, draftId })));
    throw error;
  }
}

async function importDraftBackup(input) {
  try {
    if (!hasDraftAccount()) {
      throw new Error('请先登录账户，再恢复到当前账户');
    }
    const restoreAccountId = draftAccountId();
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > DRAFT_BACKUP_MAX_ZIP_BYTES) throw new Error('备份文件超过 500MB，请拆分草稿后再恢复');
    const { payload, zip } = await readDraftBackup(file);
    const isMediaBackup = payload?.version === DRAFT_BACKUP_MEDIA_VERSION;
    if (isMediaBackup) validateMediaManifest(payload, zip);
    if (!payload || payload.app !== DRAFT_BACKUP_APP || ![1, 2, 3].includes(payload.version) || !payload.drafts || typeof payload.drafts !== 'object') {
      throw new Error('备份格式不正确');
    }
    const normalizedDrafts = window.normalizeCardDraftStore
      ? window.normalizeCardDraftStore(payload.drafts)
      : payload.drafts;
    if (!normalizedDrafts.drafts.length) throw new Error('备份文件中没有草稿');
    const contentCount = normalizedDrafts.drafts.filter(draftHasContent).length;
    if (!contentCount) throw new Error('备份文件中的草稿均为空，没有可恢复内容');
    if (window.flushCardDrafts && await window.flushCardDrafts() === false) {
      throw new Error('当前草稿尚未保存，请先缩小图片或释放浏览器存储空间');
    }
    const currentStored = window.getCardDraftStore
      ? await window.getCardDraftStore()
      : JSON.parse(localStorage.getItem(draftAccountKey(DRAFT_BACKUP_KEY)) || 'null');
    const currentStore = currentStored
      ? (window.normalizeCardDraftStore ? window.normalizeCardDraftStore(currentStored) : currentStored)
      : { schemaVersion: 2, drafts: [], activeId: null, deletedDrafts: {} };
    const restoredAt = Date.now();
    const mergePlan = planDraftBackupRestore(currentStore, normalizedDrafts, restoredAt);
    let preparedMedia = [];
    if (isMediaBackup) preparedMedia = prepareMediaRestore(mergePlan, payload.media, restoredAt);
    if (!confirm(`识别到 ${normalizedDrafts.drafts.length} 个草稿，其中 ${contentCount} 个有内容。\n\n恢复后会作为“恢复副本”加入，不会覆盖现有草稿。是否继续？`)) return;
    window.cardDraftRestoreInProgress = true;
    let mediaStore = null;
    let writtenDraftIds = new Set();
    if (preparedMedia.length) {
      mediaStore = await getDraftMediaStore();
      writtenDraftIds = await restoreMediaAssets({
        zip,
        assets: preparedMedia,
        accountId: restoreAccountId,
        mediaStore,
      });
    }
    try {
      if (draftAccountId() !== restoreAccountId) {
        throw new Error('恢复期间登录账户已切换，为避免草稿串号，本次恢复已取消');
      }
      if (window.replaceCardDraftStore) await window.replaceCardDraftStore(mergePlan.store);
      else localStorage.setItem(draftAccountKey(DRAFT_BACKUP_KEY), JSON.stringify(mergePlan.store));
    } catch (error) {
      if (mediaStore) {
        await Promise.allSettled(Array.from(writtenDraftIds, (draftId) => (
          mediaStore.deleteDraft({ accountId: restoreAccountId, draftId })
        )));
      }
      throw error;
    }
    try {
      localStorage.setItem(draftAccountKey(DRAFT_BACKUP_TIME_KEY), new Date().toISOString());
    } catch {}
    const reloaded = window.reloadCardDrafts ? await window.reloadCardDrafts() : false;
    if (!reloaded) {
      const next = new URL(location.href);
      next.searchParams.set('restore', String(Date.now()));
      location.replace(next.href);
      return;
    }
    window.cardDraftRestoreInProgress = false;
    const status = document.getElementById('draftBackupStatus');
    if (status) status.textContent = `已恢复 ${normalizedDrafts.drafts.length} 个草稿，原草稿仍保留`;
  } catch (error) {
    window.cardDraftRestoreInProgress = false;
    alert('草稿恢复失败：' + error.message);
  } finally {
    input.value = '';
  }
}

window.mergeDraftBackupStores = mergeDraftBackupStores;
window.planDraftBackupRestore = planDraftBackupRestore;
window.rewriteDraftMediaIds = rewriteDraftMediaIds;
updateDraftBackupStatus();
