// ===== 常量 =====
const CARD_W = 750;
const CARD_H = 1000;
const CARD_PADDING_X = 24;
const CARD_PADDING_Y = 36;
const CREATOR_ACTIVE_ACCOUNT_KEY = 'creator-toolkit-active-account-v1';
const CREATOR_LEGACY_OWNER_KEY = 'creator-toolkit-legacy-owner-v1';
const CARD_DRAFT_SCHEMA_VERSION = 9;
const CARD_NORMAL_IMAGE_DEFAULT_MIGRATION_VERSION = 8;
const CARD_DRAFT_CONTENT_LIMIT = 12_000_000;
const IMAGE_SHADOW_INSETS = Object.freeze({ left: 40, top: 20, right: 40, bottom: 56 });
const COLLAGE_GLOW_INSET = 20;
const CARD_MEDIA_SOURCE_ROLE = 'source';
const CARD_MEDIA_POSTER_ROLE = 'poster';
const CARD_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
const CARD_VIDEO_EXTENSIONS = /\.(?:mp4|mov)$/i;
const CARD_VIDEO_MODES = new Set(['video', 'live-photo']);
const CARD_VIDEO_DURATIONS = new Set([3, 5]);
const CARD_VIDEO_TIMELINE_URL = './video-timeline.js?v=20260915-draft-autosave-v1';

let cardMediaStorePromise = null;
let livePhotoEnginePromise = null;

async function getCardMediaStore() {
  if (!cardMediaStorePromise) {
    cardMediaStorePromise = import('./media-store.js').then(async (module) => {
      const Store = module.CardMediaStore || module.default || window.CardMediaStore;
      if (typeof Store !== 'function') throw new Error('媒体存储模块未正确加载');
      const store = new Store();
      await store.open();
      return store;
    }).catch((error) => {
      cardMediaStorePromise = null;
      throw new Error(`无法打开本机媒体存储：${error.message || '未知错误'}`);
    });
  }
  return cardMediaStorePromise;
}

async function getLivePhotoEngine() {
  if (window.ChengYiLivePhotoEngine) return window.ChengYiLivePhotoEngine;
  if (!livePhotoEnginePromise) {
    livePhotoEnginePromise = import('./live-photo-engine.js').then((module) => {
      const engine = module.default || module.ChengYiLivePhotoEngine || window.ChengYiLivePhotoEngine;
      if (!engine || typeof engine.composeCardVideo !== 'function' || typeof engine.createLivePhotoPackage !== 'function') {
        throw new Error('Live Photo 引擎 API 不完整');
      }
      return engine;
    }).catch((error) => {
      livePhotoEnginePromise = null;
      throw new Error(`Live Photo 引擎未就绪：${error.message || '未知错误'}`);
    });
  }
  return livePhotoEnginePromise;
}

function cardAccountId() {
  return localStorage.getItem(CREATOR_ACTIVE_ACCOUNT_KEY) || '';
}

function cardStorageKey(base, accountOverride) {
  const accountId = accountOverride === undefined ? cardAccountId() : String(accountOverride || '');
  return accountId ? `${base}:${accountId}` : base;
}

window.cardStorageKey = cardStorageKey;

function normalizeImageFrame(value) {
  const frame = String(value || '').trim().toLowerCase();
  if (!frame || frame === 'normal' || frame === 'default' || frame === '正常' || frame === '正常版') return '';
  if (frame === 'shadow' || frame === '投影' || frame === '阴影') return 'shadow';
  if (frame === 'polaroid' || frame === '相框') return 'polaroid';
  if (frame === 'outline' || frame === '描边') return 'outline';
  if (frame === 'blue-border' || frame === 'blue' || frame === '蓝边' || frame === '蓝色描边') return 'blue-border';
  return '';
}

function safeDraftText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback || '').slice(0, maxLength);
}

function safeDraftId(value, fallback) {
  const raw = safeDraftText(value, fallback, 120);
  const normalized = raw
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || fallback;
}

function isSupportedVideoFile(file) {
  if (!file) return false;
  return CARD_VIDEO_MIME_TYPES.has(String(file.type || '').toLowerCase())
    || CARD_VIDEO_EXTENSIONS.test(String(file.name || ''));
}

function normalizeVideoMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return CARD_VIDEO_MODES.has(mode) ? mode : 'video';
}

function normalizeVideoDuration(value) {
  const duration = Number(value);
  return CARD_VIDEO_DURATIONS.has(duration) ? duration : 5;
}

function normalizeVideoStart(value) {
  const start = Number(value);
  if (!Number.isFinite(start)) return 0;
  return Math.round(Math.max(0, Math.min(86_400, start)) * 10) / 10;
}

function supportsFiveSecondSelection(sourceDuration) {
  const duration = Number(sourceDuration);
  return Number.isFinite(duration) && duration + 0.05 >= 5;
}

function normalizeVideoSound(value) {
  return value === true || String(value || '').toLowerCase() === 'true' || String(value) === '1';
}

function safeMediaLabel(value, fallback = '', maxLength = 160) {
  return String(value || fallback || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function mediaMetadataFromNode(node) {
  if (!node || node.tagName !== 'IMG' || node.dataset.mediaKind !== 'video') return null;
  const mediaId = safeDraftId(node.dataset.mediaId, '');
  if (!mediaId) return null;
  const sourceDuration = Math.max(0, Number(node.dataset.mediaSourceDuration) || 0);
  let durationSeconds = normalizeVideoDuration(node.dataset.mediaDuration);
  const timelineSourceDuration = sourceDuration < 5 && supportsFiveSecondSelection(sourceDuration)
    ? 5
    : Math.floor(sourceDuration * 10) / 10;
  if (sourceDuration >= 3 && !supportsFiveSecondSelection(sourceDuration) && durationSeconds === 5) durationSeconds = 3;
  const maximumStart = sourceDuration ? Math.max(0, timelineSourceDuration - durationSeconds) : 86_400;
  return {
    id: mediaId,
    kind: 'video',
    mode: normalizeVideoMode(node.dataset.mediaMode),
    durationSeconds,
    startSeconds: Math.min(normalizeVideoStart(node.dataset.mediaStart), maximumStart),
    keepSound: normalizeVideoSound(node.dataset.mediaSound),
    name: safeMediaLabel(node.dataset.mediaName, '视频素材'),
    mimeType: safeMediaLabel(node.dataset.mediaMime, 'video/mp4', 80),
    sourceDuration,
    sourceDraftId: safeDraftId(node.dataset.mediaDraftId, ''),
  };
}

function applyMediaMetadataToImage(img, metadata) {
  if (!img || !metadata || metadata.kind !== 'video') return;
  const sourceDuration = Math.max(0, Number(metadata.sourceDuration) || 0);
  let durationSeconds = normalizeVideoDuration(metadata.durationSeconds);
  const timelineSourceDuration = sourceDuration < 5 && supportsFiveSecondSelection(sourceDuration)
    ? 5
    : Math.floor(sourceDuration * 10) / 10;
  if (sourceDuration >= 3 && !supportsFiveSecondSelection(sourceDuration) && durationSeconds === 5) durationSeconds = 3;
  const maximumStart = sourceDuration ? Math.max(0, timelineSourceDuration - durationSeconds) : 86_400;
  const startSeconds = Math.min(normalizeVideoStart(metadata.startSeconds), maximumStart);
  img.dataset.mediaId = safeDraftId(metadata.id, '');
  img.dataset.mediaKind = 'video';
  img.dataset.mediaMode = normalizeVideoMode(metadata.mode);
  img.dataset.mediaDuration = String(durationSeconds);
  img.dataset.mediaStart = String(startSeconds);
  img.dataset.mediaSound = String(normalizeVideoSound(metadata.keepSound));
  img.dataset.mediaName = safeMediaLabel(metadata.name, '视频素材');
  img.dataset.mediaMime = safeMediaLabel(metadata.mimeType, 'video/mp4', 80);
  img.dataset.mediaSourceDuration = String(sourceDuration);
  const sourceDraftId = safeDraftId(metadata.sourceDraftId, '');
  if (sourceDraftId) img.dataset.mediaDraftId = sourceDraftId;
}

function isSafeDraftImageSource(value) {
  const src = String(value || '').trim();
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(src)
    || /^https:\/\//i.test(src)
    || /^(?![a-z][a-z0-9+.-]*:)(?!\/\/)[^:]+$/i.test(src);
}

function isUnsafeDraftURL(value) {
  return /^\s*(?:javascript|vbscript|data:text\/html)\s*:/i.test(String(value || ''));
}

function safeDraftImageWidth(value) {
  const match = String(value || '').trim().match(/^(\d{1,3}(?:\.\d+)?)%$/);
  if (!match) return '';
  const width = Number(match[1]);
  return width >= 5 && width <= 100 ? `${width}%` : '';
}

function safeDraftHighlight(value) {
  const color = String(value || '').toLowerCase().replace(/\s+/g, '');
  if (color === '#fae985' || color === 'rgb(250,233,133)' || color === 'rgba(250,233,133,1)') return '#FAE985';
  if (color === 'transparent' || color === 'rgba(0,0,0,0)') return 'transparent';
  return '';
}

function hasUnsafeDraftStyle(value) {
  const style = String(value || '');
  return /(?:url\s*\(|expression\s*\(|(?:^|;)\s*position\s*:|z-index\s*:|behavior\s*:|-moz-binding\s*:)/i.test(style);
}

function collageLayoutAPI() {
  const api = window.ChengYiCollageLayout;
  if (!api?.normalizeHeight || !api?.normalizeItems) throw new Error('自由拼贴组件未正确加载');
  return api;
}

function safeCollageId(value, fallback) {
  return safeDraftId(value, fallback).slice(0, 80);
}

function normalizeCollageDOMEntries(itemNodes) {
  const api = collageLayoutAPI();
  const seen = new Set();
  const entries = Array.from(itemNodes || []).slice(0, api.MAX_ITEMS).map((node, index) => {
    const raw = api.normalizeItem({
      id: node.dataset.collageItemId || `item-${index + 1}`,
      x: node.dataset.collageX,
      y: node.dataset.collageY,
      width: node.dataset.collageWidth,
      z: node.dataset.collageZ,
    }, index);
    let id = raw.id;
    let suffix = 2;
    while (seen.has(id)) id = `${raw.id}-${suffix++}`;
    seen.add(id);
    return { node, index, model: { ...raw, id } };
  });
  [...entries]
    .sort((a, b) => a.model.z - b.model.z || a.index - b.index)
    .forEach((entry, index) => { entry.model.z = index + 1; });
  return entries;
}

function rebuildDraftCollages(root) {
  const api = collageLayoutAPI();
  const collages = Array.from(root.querySelectorAll('div[data-card-collage="1"], div.image-collage'));
  collages.forEach((source, collageIndex) => {
    const sourceItems = Array.from(source.children).filter((child) => child.matches?.('div.collage-item'));
    const containsVideo = sourceItems.some((item) => item.querySelector('img')?.dataset.mediaKind === 'video');
    const invalidStructure = sourceItems.length === 0 || sourceItems.length > api.MAX_ITEMS;

    // 首版自由拼贴只支持静态图。异常结构按普通图片顺序降级，避免草稿恢复时丢图。
    if (containsVideo || invalidStructure) {
      const fragment = document.createDocumentFragment();
      Array.from(source.querySelectorAll('img')).forEach((img, index) => {
        if (index > 0) fragment.appendChild(document.createElement('br'));
        fragment.appendChild(img.cloneNode(false));
      });
      source.replaceWith(fragment);
      return;
    }

    const entries = normalizeCollageDOMEntries(sourceItems);
    const collage = document.createElement('div');
    collage.className = 'image-collage';
    collage.dataset.cardCollage = '1';
    collage.dataset.collageId = safeCollageId(source.dataset.collageId, `collage-${collageIndex + 1}`);
    collage.dataset.collageHeight = String(api.normalizeHeight(source.dataset.collageHeight));
    collage.setAttribute('contenteditable', 'false');

    entries.forEach(({ node: sourceItem, model }) => {
      const sourceImg = sourceItem.querySelector('img');
      const src = sourceImg?.getAttribute('src') || '';
      if (!sourceImg || !isSafeDraftImageSource(src) || sourceImg.dataset.mediaKind === 'video') return;
      const item = document.createElement('div');
      item.className = 'collage-item';
      item.dataset.collageItemId = model.id;
      item.dataset.collageX = String(model.x);
      item.dataset.collageY = String(model.y);
      item.dataset.collageWidth = String(model.width);
      item.dataset.collageZ = String(model.z);
      item.setAttribute('contenteditable', 'false');

      const img = document.createElement('img');
      img.src = src;
      const rawFrame = sourceImg.getAttribute('data-frame');
      if (rawFrame !== null) img.dataset.frame = normalizeImageFrame(rawFrame) || 'normal';
      item.appendChild(img);
      collage.appendChild(item);
    });

    if (collage.children.length > 0) source.replaceWith(collage);
    else source.remove();
  });
}

function normalizeDraftContent(html, explicitDefaultFrame) {
  const template = document.createElement('template');
  const source = typeof html === 'string' ? html : '';
  if (source.length > CARD_DRAFT_CONTENT_LIMIT) {
    throw new Error('草稿内容过大，已停止恢复以避免图片或文字被截断');
  }
  template.innerHTML = source;
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button').forEach((node) => node.remove());
  rebuildDraftCollages(template.content);

  const allowedTags = new Set(['BR', 'DIV', 'P', 'B', 'STRONG', 'SPAN', 'IMG']);
  Array.from(template.content.querySelectorAll('*')).forEach((node) => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }

    const rawStyle = node.getAttribute('style') || '';
    // 版本 27 曾写入 object-position 作为裁剪取景位置。裁剪功能移除后，
    // 旧值不再恢复，但不能把 object-position 误判为 position 并连带丢掉图片宽度。
    const unsafeStyle = hasUnsafeDraftStyle(rawStyle);
    const width = unsafeStyle ? '' : safeDraftImageWidth(node.style.width);
    const semanticHighlight = node.getAttribute('data-card-highlight') === 'true';
    const highlight = semanticHighlight ? '#FAE985' : unsafeStyle ? '' : safeDraftHighlight(node.style.backgroundColor);
    const src = node.tagName === 'IMG' ? node.getAttribute('src') : '';
    const rawFrame = node.tagName === 'IMG' ? node.getAttribute('data-frame') : null;
    const rawMedia = node.tagName === 'IMG' ? {
      id: node.getAttribute('data-media-id'),
      kind: node.getAttribute('data-media-kind'),
      mode: node.getAttribute('data-media-mode'),
      durationSeconds: node.getAttribute('data-media-duration'),
      startSeconds: node.getAttribute('data-media-start'),
      keepSound: node.getAttribute('data-media-sound'),
      name: node.getAttribute('data-media-name'),
      mimeType: node.getAttribute('data-media-mime'),
      sourceDuration: node.getAttribute('data-media-source-duration'),
      sourceDraftId: node.getAttribute('data-media-draft-id'),
    } : null;
    const isPageBreak = node.tagName === 'DIV' && node.classList.contains('page-break-marker');
    const isCollage = node.tagName === 'DIV' && node.dataset.cardCollage === '1' && node.classList.contains('image-collage');
    const isCollageItem = node.tagName === 'DIV' && node.classList.contains('collage-item') && node.parentElement?.dataset.cardCollage === '1';
    const rawCollage = isCollage ? {
      id: node.dataset.collageId,
      height: node.dataset.collageHeight,
    } : null;
    const rawCollageItem = isCollageItem ? {
      id: node.dataset.collageItemId,
      x: node.dataset.collageX,
      y: node.dataset.collageY,
      width: node.dataset.collageWidth,
      z: node.dataset.collageZ,
    } : null;

    for (const attr of Array.from(node.attributes || [])) {
      // 备份内容一律按白名单重建属性；显式识别 javascript: 等危险 URL，
      // 避免旧草稿中的链接或样式借 innerHTML 影响整个工具页面。
      if ((attr.name === 'href' || attr.name === 'src') && isUnsafeDraftURL(attr.value)) node.removeAttribute(attr.name);
      else node.removeAttribute(attr.name);
    }

    if (node.tagName === 'IMG') {
      if (!isSafeDraftImageSource(src)) {
        node.remove();
        return;
      }
      node.setAttribute('src', src);
      if (width) node.style.width = width;
      if (rawFrame !== null) {
        const normalized = normalizeImageFrame(rawFrame);
        if (normalized) node.dataset.frame = normalized;
        else if (String(rawFrame).trim()) node.dataset.frame = 'normal';
      }
      if (rawMedia?.kind === 'video' && safeDraftId(rawMedia.id, '')) {
        applyMediaMetadataToImage(node, {
          ...rawMedia,
          durationSeconds: rawMedia.durationSeconds,
          startSeconds: rawMedia.startSeconds,
          keepSound: rawMedia.keepSound,
        });
      }
    } else if (isCollage) {
      const api = collageLayoutAPI();
      node.className = 'image-collage';
      node.dataset.cardCollage = '1';
      node.dataset.collageId = safeCollageId(rawCollage.id, 'collage');
      node.dataset.collageHeight = String(api.normalizeHeight(rawCollage.height));
      node.setAttribute('contenteditable', 'false');
    } else if (isCollageItem) {
      const model = collageLayoutAPI().normalizeItem(rawCollageItem);
      node.className = 'collage-item';
      node.dataset.collageItemId = model.id;
      node.dataset.collageX = String(model.x);
      node.dataset.collageY = String(model.y);
      node.dataset.collageWidth = String(model.width);
      node.dataset.collageZ = String(model.z);
      node.setAttribute('contenteditable', 'false');
    } else if (isPageBreak) {
      node.className = 'page-break-marker';
      node.setAttribute('contenteditable', 'false');
    } else if ((node.tagName === 'SPAN' || node.tagName === 'B' || node.tagName === 'STRONG') && highlight === '#FAE985') {
      node.setAttribute('data-card-highlight', 'true');
      node.classList.add('editor-highlight');
    }
  });

  const hasExplicitDefault = explicitDefaultFrame !== undefined;
  const defaultFrame = normalizeImageFrame(explicitDefaultFrame);
  template.content.querySelectorAll('img').forEach((img) => {
    const rawFrame = img.getAttribute('data-frame');
    if (rawFrame !== null) {
      const normalized = normalizeImageFrame(rawFrame);
      if (normalized) img.dataset.frame = normalized;
      else if (String(rawFrame).trim()) img.dataset.frame = 'normal';
      else img.removeAttribute('data-frame');
    } else if (hasExplicitDefault && defaultFrame) {
      img.dataset.frame = defaultFrame;
    }
  });
  return template.innerHTML;
}

function normalizeDraftData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('草稿内容格式不正确');
  }
  const data = input;
  const sourceSchemaVersion = Number(data.schemaVersion) || 0;
  const frameKeys = ['defaultImageFrame', 'imageFrame', 'frame', 'mode'];
  const explicitKey = frameKeys.find((key) => typeof data[key] === 'string');
  const explicitFrame = explicitKey ? normalizeImageFrame(data[explicitKey]) : undefined;
  const content = normalizeDraftContent(data.content, explicitFrame);
  // v8 起默认样式固定从“正常”开始。旧草稿可能曾由已有图片反推为蓝边或投影，
  // 迁移时只重置“以后新加图片”的默认值，不改已有图片各自保存的 data-frame。
  const defaultImageFrame = sourceSchemaVersion < CARD_NORMAL_IMAGE_DEFAULT_MIGRATION_VERSION
    ? ''
    : (explicitFrame || '');
  const avatar = isSafeDraftImageSource(data.avatar) ? String(data.avatar || '') : '';
  return {
    schemaVersion: CARD_DRAFT_SCHEMA_VERSION,
    content,
    authorName: safeDraftText(data.authorName, '程意', 80),
    pubDate: safeDraftText(data.pubDate, '', 40),
    avatar,
    filename: safeDraftText(data.filename, 'article-card', 120),
    defaultImageFrame,
  };
}

function normalizeCardDraftStore(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.drafts)) {
    throw new Error('草稿数据结构不正确');
  }
  const seen = new Set();
  const drafts = input.drafts.map((draft, index) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !draft.data || typeof draft.data !== 'object' || Array.isArray(draft.data)) {
      throw new Error(`第 ${index + 1} 个草稿格式不正确`);
    }
    let id = safeDraftId(draft.id, `d${Date.now()}${index}`);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const data = normalizeDraftData(draft.data);
    return {
      id,
      title: safeDraftText(draft.title, '', 80) || '未命名草稿',
      updatedAt: Number.isFinite(Number(draft.updatedAt)) ? Number(draft.updatedAt) : Date.now(),
      data,
    };
  });
  const requestedActiveId = typeof input.activeId === 'string' ? input.activeId : '';
  const deletedDrafts = {};
  if (input.deletedDrafts && typeof input.deletedDrafts === 'object' && !Array.isArray(input.deletedDrafts)) {
    Object.entries(input.deletedDrafts).slice(0, 500).forEach(([rawId, rawDeletedAt]) => {
      const id = safeDraftId(rawId, '');
      const deletedAt = Number(rawDeletedAt);
      if (id && Number.isFinite(deletedAt) && deletedAt > 0) deletedDrafts[id] = deletedAt;
    });
  }
  const visibleDrafts = drafts.filter((draft) => Number(deletedDrafts[draft.id] || 0) < Number(draft.updatedAt || 0));
  return {
    schemaVersion: CARD_DRAFT_SCHEMA_VERSION,
    drafts: visibleDrafts,
    activeId: visibleDrafts.some((draft) => draft.id === requestedActiveId) ? requestedActiveId : (visibleDrafts[0]?.id || null),
    deletedDrafts,
  };
}

function mergeCardDraftStores(localInput, remoteInput) {
  const local = normalizeCardDraftStore(localInput);
  const remote = normalizeCardDraftStore(remoteInput);
  const deletedDrafts = { ...remote.deletedDrafts };
  Object.entries(local.deletedDrafts || {}).forEach(([id, deletedAt]) => {
    deletedDrafts[id] = Math.max(Number(deletedDrafts[id] || 0), Number(deletedAt || 0));
  });
  const byId = new Map();
  [...remote.drafts, ...local.drafts].forEach((draft) => {
    const existing = byId.get(draft.id);
    if (!existing || Number(draft.updatedAt) >= Number(existing.updatedAt)) byId.set(draft.id, draft);
  });
  const drafts = [...byId.values()]
    .filter((draft) => Number(deletedDrafts[draft.id] || 0) < Number(draft.updatedAt || 0))
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  const localActive = drafts.find((draft) => draft.id === local.activeId);
  const remoteActive = drafts.find((draft) => draft.id === remote.activeId);
  return normalizeCardDraftStore({
    schemaVersion: CARD_DRAFT_SCHEMA_VERSION,
    drafts,
    activeId: localActive?.id || remoteActive?.id || drafts[0]?.id || null,
    deletedDrafts,
  });
}

window.normalizeImageFrame = normalizeImageFrame;
window.normalizeDraftData = normalizeDraftData;
window.normalizeCardDraftStore = normalizeCardDraftStore;
window.mergeCardDraftStores = mergeCardDraftStores;
window.cardMediaMetadataFromNode = mediaMetadataFromNode;

const STYLES = {
  fontSize: 30,
  lineHeight: 1.6,
  paddingX: CARD_PADDING_X,
  paddingY: CARD_PADDING_Y,
  imageMargin: 8,
  bgColor: '#ffffff',
  textColor: '#111111',
};

// ===== 工具函数 =====
function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// html2canvas 会把跨行 inline 背景错误地画成整块矩形。
// 将高亮文本拆成不会跨行的最小字形单元，预览、分页测量和导出共用同一 DOM。
function fragmentHighlights(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('.hl').forEach((mark) => {
    if (mark.dataset.fragmented === 'true') return;
    const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    textNodes.forEach((textNode) => {
      const fragment = document.createDocumentFragment();
      Array.from(textNode.textContent || '').forEach((character) => {
        const glyph = document.createElement('span');
        glyph.className = 'hl-glyph';
        glyph.textContent = character;
        fragment.appendChild(glyph);
      });
      textNode.replaceWith(fragment);
    });
    mark.dataset.fragmented = 'true';
  });
}

// 在字体和换行已经确定后，按真实物理行画独立笔触。
// 文字只负责定位，黄色背景不再挂在 inline 元素上，因此不会跨行拉成大矩形。
function decorateHighlightStrokes(card) {
  if (!card || !card.querySelector) return;
  const body = card.querySelector('.card-body');
  if (!body) return;

  body.querySelectorAll(':scope > .hl-stroke-layer').forEach((layer) => layer.remove());
  const bodyRect = body.getBoundingClientRect();
  if (!bodyRect.width || !bodyRect.height) return;

  const layer = document.createElement('div');
  layer.className = 'hl-stroke-layer';
  layer.setAttribute('aria-hidden', 'true');
  const variants = [
    { top: 0.38, height: 0.58, left: 3.4, right: 4.6 },
    { top: 0.42, height: 0.55, left: 4.2, right: 3.5 },
    { top: 0.36, height: 0.60, left: 3.0, right: 4.0 },
    { top: 0.41, height: 0.57, left: 3.8, right: 4.4 },
  ];
  let strokeCount = 0;

  body.querySelectorAll('.hl').forEach((mark, markIndex) => {
    const lines = [];
    mark.querySelectorAll('.hl-glyph').forEach((glyph) => {
      const rect = glyph.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      let line = lines[lines.length - 1];
      if (!line || Math.abs(rect.top - line.top) > 2) {
        line = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        lines.push(line);
      } else {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      }
    });

    lines.forEach((line, lineIndex) => {
      const variantIndex = (markIndex * 3 + lineIndex) % variants.length;
      const variant = variants[variantIndex];
      const glyphHeight = line.bottom - line.top;
      const stroke = document.createElement('span');
      stroke.className = `hl-stroke hl-stroke-v${variantIndex}`;
      stroke.style.left = `${line.left - bodyRect.left - variant.left}px`;
      stroke.style.top = `${line.top - bodyRect.top + glyphHeight * variant.top}px`;
      stroke.style.width = `${line.right - line.left + variant.left + variant.right}px`;
      stroke.style.height = `${glyphHeight * variant.height}px`;
      layer.appendChild(stroke);
      strokeCount += 1;
    });
  });

  if (strokeCount > 0) body.prepend(layer);
}

// 压缩图片：超过 maxWidth 的等比缩小，重编码为 JPEG
// 小图（宽度够小且文件 <300KB）直接用原图，避免无谓的画质损失
function compressImageFile(file, maxWidth, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataURL = e.target.result;
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth <= maxWidth && file.size < 300 * 1024) {
          resolve(dataURL);
          return;
        }
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        // JPEG 没有透明通道，先铺白底（卡片本身是白底，视觉一致）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataURL);  // 解码失败退回原图
      img.src = dataURL;
    };
    reader.readAsDataURL(file);
  });
}

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

  _collageItemModel(item) {
    return collageLayoutAPI().normalizeItem({
      id: item?.dataset.collageItemId,
      x: item?.dataset.collageX,
      y: item?.dataset.collageY,
      width: item?.dataset.collageWidth,
      z: item?.dataset.collageZ,
    });
  }

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
  }

  _applyCollageHeight(collage) {
    if (!collage) return;
    const height = collageLayoutAPI().normalizeHeight(collage.dataset.collageHeight);
    collage.dataset.collageHeight = String(height);
    collage.style.aspectRatio = `${CARD_W - CARD_PADDING_X * 2} / ${height}`;
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
  }

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
  }

  rehydrateAfterHistory() {
    this._deselectImage();
    this._scheduleCollageHydration();
    requestAnimationFrame(() => this.app.updatePreview());
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  removeSelectedCollage() {
    const collage = this.selectedImg?.closest?.('.image-collage');
    if (!collage) return;
    this._deselectImage();
    this._removeNodeWithFallback(collage);
    this.app.updatePreview();
  }

  async _getTimelineHelpers() {
    if (window.ChengYiVideoTimeline) return window.ChengYiVideoTimeline;
    if (!this.timelineHelpersPromise) {
      this.timelineHelpersPromise = import(CARD_VIDEO_TIMELINE_URL).then((module) => {
        const helpers = module.default || window.ChengYiVideoTimeline;
        if (!helpers?.clampTimelineSelection || !helpers?.selectionFromHandlePosition) {
          throw new Error('视频时间轴组件不完整');
        }
        return helpers;
      }).catch((error) => {
        this.timelineHelpersPromise = null;
        throw error;
      });
    }
    return this.timelineHelpersPromise;
  }

  _clampTimelineSelection(metadata, overrides = {}) {
    const input = {
      sourceDuration: metadata.sourceDuration,
      startSeconds: overrides.startSeconds ?? metadata.startSeconds,
      durationSeconds: overrides.durationSeconds ?? metadata.durationSeconds,
    };
    const helpers = window.ChengYiVideoTimeline;
    if (helpers?.clampTimelineSelection) return helpers.clampTimelineSelection(input);

    // module script 尚未完成时的短暂回退；保持旧草稿与 3/5 秒快捷值可用。
    const rawSourceDuration = Math.max(0, Number(input.sourceDuration) || 0);
    const sourceDuration = supportsFiveSecondSelection(rawSourceDuration)
      ? Math.max(5, Math.floor(rawSourceDuration * 10) / 10)
      : Math.floor(rawSourceDuration * 10) / 10;
    if (sourceDuration < 3) throw new RangeError('源视频不足 3 秒，无法选择有效片段');
    let durationSeconds = normalizeVideoDuration(input.durationSeconds);
    if (!supportsFiveSecondSelection(rawSourceDuration) && durationSeconds === 5) durationSeconds = 3;
    durationSeconds = Math.min(sourceDuration, durationSeconds);
    const maxStart = Math.floor(Math.max(0, sourceDuration - durationSeconds) * 10) / 10;
    const startSeconds = Math.min(normalizeVideoStart(input.startSeconds), maxStart);
    return {
      startSeconds,
      endSeconds: Math.round((startSeconds + durationSeconds) * 10) / 10,
      durationSeconds,
      maxStart,
    };
  }

  _formatTimelineTime(seconds) {
    if (window.ChengYiVideoTimeline?.formatTime) return window.ChengYiVideoTimeline.formatTime(seconds);
    const value = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10);
    return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
  }

  _syncDurationSelect(durationSeconds, sourceDuration) {
    const select = document.getElementById('mediaDuration');
    if (!select) return;
    const fiveSecondOption = select.querySelector('option[value="5"]');
    if (fiveSecondOption) fiveSecondOption.disabled = sourceDuration > 0 && !supportsFiveSecondSelection(sourceDuration);
    select.value = String(durationSeconds);
  }

  _renderTimelineSelection(selection, sourceDuration = this.timelineSourceDuration) {
    if (!selection || !(sourceDuration > 0)) return;
    this.timelineSelection = selection;
    this.timelineSourceDuration = sourceDuration;
    const startRatio = Math.max(0, Math.min(1, selection.startSeconds / sourceDuration));
    const endRatio = Math.max(startRatio, Math.min(1, selection.endSeconds / sourceDuration));
    const startPercent = startRatio * 100;
    const endPercent = endRatio * 100;
    const selectionEl = document.getElementById('mediaTimelineSelection');
    const timelineTrack = document.getElementById('mediaTimelineTrack');
    const shadeStart = document.getElementById('mediaTimelineShadeStart');
    const shadeEnd = document.getElementById('mediaTimelineShadeEnd');
    if (selectionEl) {
      // 命中区至少 44px；::before 仍按准确起止位置绘制，不改变视觉时长。
      const trackWidth = timelineTrack?.clientWidth || 320;
      const visualWidth = trackWidth * (endRatio - startRatio);
      const extraWidth = Math.max(16, 44 - visualWidth);
      const visualLeft = trackWidth * startRatio;
      const visualRightSpace = trackWidth * (1 - endRatio);
      let hitLeft = Math.min(extraWidth / 2, visualLeft);
      let hitRight = Math.min(extraWidth - hitLeft, visualRightSpace);
      hitLeft = Math.min(extraWidth - hitRight, visualLeft);
      selectionEl.style.setProperty('--timeline-hit-left', `${hitLeft}px`);
      selectionEl.style.setProperty('--timeline-hit-right', `${hitRight}px`);
      selectionEl.style.left = `calc(${startPercent}% - ${hitLeft}px)`;
      selectionEl.style.width = `calc(${Math.max(0, endPercent - startPercent)}% + ${hitLeft + hitRight}px)`;
      selectionEl.setAttribute('aria-valuemin', '0');
      selectionEl.setAttribute('aria-valuemax', String(selection.maxStart));
      selectionEl.setAttribute('aria-valuenow', String(selection.startSeconds));
      selectionEl.setAttribute(
        'aria-valuetext',
        `${this._formatTimelineTime(selection.startSeconds)} 到 ${this._formatTimelineTime(selection.endSeconds)}`,
      );
    }
    if (shadeStart) shadeStart.style.width = `${startPercent}%`;
    if (shadeEnd) shadeEnd.style.width = `${Math.max(0, 100 - endPercent)}%`;

    const startLabel = document.getElementById('mediaTimelineStartLabel');
    const endLabel = document.getElementById('mediaTimelineEndLabel');
    const durationLabel = document.getElementById('mediaTimelineDurationLabel');
    if (startLabel) startLabel.textContent = this._formatTimelineTime(selection.startSeconds);
    if (endLabel) endLabel.textContent = this._formatTimelineTime(selection.endSeconds);
    if (durationLabel) durationLabel.textContent = `${selection.durationSeconds.toFixed(1)} 秒`;
    const startInput = document.getElementById('mediaStart');
    if (startInput) {
      startInput.value = String(selection.startSeconds);
      startInput.max = String(selection.maxStart);
    }
    this._syncDurationSelect(selection.durationSeconds, sourceDuration);

  }

  _setTimelineLoading(message = '', hidden = false) {
    const loading = document.getElementById('mediaTimelineLoading');
    if (!loading) return;
    loading.textContent = message;
    loading.hidden = hidden;
  }

  _cleanupVideoTimeline(options = {}) {
    this.timelineSession += 1;
    this.timelineDrag = null;
    this.timelineSelection = null;
    this.timelineSourceDuration = 0;
    this.timelineMediaKey = '';
    if (this.timelinePreviewFrame) cancelAnimationFrame(this.timelinePreviewFrame);
    this.timelinePreviewFrame = 0;
    const video = document.getElementById('mediaTimelineVideo');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('poster');
      video.load();
    }
    if (this.timelineObjectURL) URL.revokeObjectURL(this.timelineObjectURL);
    this.timelineObjectURL = '';
    const frames = document.getElementById('mediaTimelineFrames');
    if (frames) {
      frames.replaceChildren();
      frames.classList.remove('ready');
    }
    const timeline = document.getElementById('mediaTimeline');
    if (timeline && options.hide !== false) timeline.hidden = true;
  }

  _waitForTimelineVideo(video, eventName, timeoutMessage) {
    if ((eventName === 'loadedmetadata' && video.readyState >= 1)
      || (eventName === 'loadeddata' && video.readyState >= 2)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(timeoutMessage)), 12_000);
      const onReady = () => finish();
      const onError = () => finish(new Error('视频画面无法解码'));
      const finish = (error) => {
        clearTimeout(timeout);
        video.removeEventListener(eventName, onReady);
        video.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener(eventName, onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  }

  _seekTimelineVideo(video, seconds) {
    const duration = Math.max(0, Number(video.duration) || this.timelineSourceDuration);
    const target = Math.max(0, Math.min(Math.max(0, duration - 0.04), Number(seconds) || 0));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.035) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('定位视频画面超时')), 5_000);
      const onSeeked = () => finish();
      const onError = () => finish(new Error('定位视频画面失败'));
      const finish = (error) => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = target;
    });
  }

  _renderTimelineFrames(frameSources) {
    const frames = document.getElementById('mediaTimelineFrames');
    if (!frames) return;
    const fragment = document.createDocumentFragment();
    frameSources.forEach((source) => {
      const img = document.createElement('img');
      img.src = source;
      img.alt = '';
      img.draggable = false;
      fragment.appendChild(img);
    });
    frames.replaceChildren(fragment);
    frames.classList.toggle('ready', frameSources.length > 0);
  }

  async _generateTimelineFrames(cacheKey, session) {
    const cached = this.timelineFrameCache.get(cacheKey);
    if (cached?.length) {
      this._renderTimelineFrames(cached);
      return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = this.timelineObjectURL;
    video.load();
    try {
      await this._waitForTimelineVideo(video, 'loadeddata', '读取视频画面超时');
      const frameCount = 8;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法生成视频缩略图');
      const sources = [];
      for (let index = 0; index < frameCount; index += 1) {
        if (session !== this.timelineSession) return;
        const time = frameCount === 1 ? 0 : (index / (frameCount - 1)) * this.timelineSourceDuration;
        await this._seekTimelineVideo(video, time);
        const sourceWidth = Math.max(1, video.videoWidth);
        const sourceHeight = Math.max(1, video.videoHeight);
        const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
        sources.push(canvas.toDataURL('image/jpeg', 0.7));
      }
      if (session !== this.timelineSession) return;
      this.timelineFrameCache.set(cacheKey, sources);
      while (this.timelineFrameCache.size > 6) this.timelineFrameCache.delete(this.timelineFrameCache.keys().next().value);
      this._renderTimelineFrames(sources);
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  _previewTimelineAt(seconds) {
    const sourceDuration = this.timelineSourceDuration;
    if (!(sourceDuration > 0)) return;
    const requestedTime = Math.max(0, Math.min(sourceDuration, Number(seconds) || 0));
    const label = document.getElementById('mediaTimelinePreviewTime');
    if (label) label.textContent = this._formatTimelineTime(requestedTime);
    const playhead = document.getElementById('mediaTimelinePlayhead');
    if (playhead) playhead.style.left = `${(requestedTime / sourceDuration) * 100}%`;
    const video = document.getElementById('mediaTimelineVideo');
    if (!video?.src || video.readyState < 1) return;
    if (this.timelinePreviewFrame) cancelAnimationFrame(this.timelinePreviewFrame);
    this.timelinePreviewFrame = requestAnimationFrame(() => {
      this.timelinePreviewFrame = 0;
      const target = Math.min(Math.max(0, sourceDuration - 0.04), requestedTime);
      if (Math.abs(video.currentTime - target) > 0.035) video.currentTime = target;
    });
  }

  async _prepareVideoTimeline(img, metadata) {
    const timeline = document.getElementById('mediaTimeline');
    if (!timeline) return;
    timeline.hidden = false;
    const accountId = this.app.accountId;
    const draftId = metadata.sourceDraftId || this.app.getActiveDraftId();
    const cacheKey = `${accountId}/${draftId}/${metadata.id}/${metadata.sourceDuration}`;
    if (cacheKey === this.timelineMediaKey && this.timelineObjectURL) {
      const selection = this._clampTimelineSelection(metadata);
      this._renderTimelineSelection(selection, metadata.sourceDuration);
      this._previewTimelineAt(selection.startSeconds);
      return;
    }

    this._cleanupVideoTimeline({ hide: false });
    const session = this.timelineSession;
    this.timelineMediaKey = cacheKey;
    this.timelineSourceDuration = metadata.sourceDuration;
    this._setTimelineLoading('正在读取视频画面…');
    try {
      await this._getTimelineHelpers();
      const store = await getCardMediaStore();
      const asset = await store.get({ accountId, draftId, mediaId: metadata.id, role: CARD_MEDIA_SOURCE_ROLE });
      if (session !== this.timelineSession) return;
      if (!asset?.blob) throw new Error('原视频不在当前设备，请恢复包含素材的备份');
      const video = document.getElementById('mediaTimelineVideo');
      if (!video) return;
      this.timelineObjectURL = URL.createObjectURL(asset.blob);
      video.poster = img.currentSrc || img.src;
      video.src = this.timelineObjectURL;
      video.load();
      await this._waitForTimelineVideo(video, 'loadedmetadata', '读取视频信息超时');
      await this._waitForTimelineVideo(video, 'loadeddata', '读取视频画面超时');
      if (session !== this.timelineSession) return;
      const decodedDuration = Number(video.duration) || metadata.sourceDuration;
      this.timelineSourceDuration = Math.min(metadata.sourceDuration || decodedDuration, decodedDuration);
      const timelineMetadata = { ...metadata, sourceDuration: this.timelineSourceDuration };
      const selection = this._clampTimelineSelection(timelineMetadata);
      const repaired = selection.startSeconds !== metadata.startSeconds
        || selection.durationSeconds !== metadata.durationSeconds;
      if (repaired) {
        applyMediaMetadataToImage(img, {
          ...metadata,
          startSeconds: selection.startSeconds,
          durationSeconds: selection.durationSeconds,
        });
        this.app.saveDraft();
      }
      this._renderTimelineSelection(selection, this.timelineSourceDuration);
      this._previewTimelineAt(selection.startSeconds);
      await this._generateTimelineFrames(cacheKey, session);
      if (session !== this.timelineSession) return;
      this._previewTimelineAt(selection.startSeconds);
      this._setTimelineLoading('', true);
    } catch (error) {
      if (session !== this.timelineSession) return;
      // 失败不能把旧 Object URL 与 cache key 留在“已加载”状态，否则下一次无法重试。
      this._cleanupVideoTimeline({ hide: false });
      this.timelineSourceDuration = metadata.sourceDuration;
      try {
        this._renderTimelineSelection(this._clampTimelineSelection(metadata), metadata.sourceDuration);
      } catch (_) {
        // 插入流程已拒绝不足 3 秒的视频；这里只保留原始错误提示。
      }
      this._setTimelineLoading(`${error.message || '无法读取视频时间轴'} · 再次点击视频可重试`);
    }
  }

  _timelineRatioFromEvent(event) {
    const track = document.getElementById('mediaTimelineTrack');
    const rect = track?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  _selectionForTimelinePointer(mode, ratio) {
    if (!this.timelineSelection || !(this.timelineSourceDuration > 0)) return null;
    const helpers = window.ChengYiVideoTimeline;
    if (!helpers) return null;
    if (mode === 'start' || mode === 'end') {
      return helpers.selectionFromHandlePosition({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds,
        durationSeconds: this.timelineSelection.durationSeconds,
        handle: mode,
        positionRatio: ratio,
      });
    }
    if (mode === 'move' && this.timelineDrag) {
      const delta = (ratio - this.timelineDrag.startRatio) * this.timelineSourceDuration;
      return helpers.clampTimelineSelection({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineDrag.initial.startSeconds + delta,
        durationSeconds: this.timelineDrag.initial.durationSeconds,
      });
    }
    return null;
  }

  _onTimelinePointerDown(event) {
    if (event.button !== 0 || !this.timelineSelection || !(this.timelineSourceDuration > 0)) return;
    const track = document.getElementById('mediaTimelineTrack');
    const control = event.target.closest('[data-timeline-handle]');
    const mode = control?.dataset.timelineHandle || 'preview';
    const ratio = this._timelineRatioFromEvent(event);
    if (mode === 'preview') {
      this._previewTimelineAt(ratio * this.timelineSourceDuration);
      // 触控背景保留浏览器的纵向滚动；鼠标仍可按住胶片条连续查看画面。
      if (event.pointerType !== 'mouse') return;
    }
    this.timelineDrag = {
      pointerId: event.pointerId,
      mode,
      startRatio: ratio,
      initial: { ...this.timelineSelection },
      moved: false,
      active: event.pointerType === 'mouse',
      pointerType: event.pointerType,
      originX: event.clientX,
      originY: event.clientY,
    };
    if (this.timelineDrag.active) track.setPointerCapture?.(event.pointerId);
    if (mode !== 'preview' && this.timelineDrag.active) event.preventDefault();
    if (mode !== 'preview') this._previewTimelineAt(this.timelineSelection.startSeconds);
  }

  _onTimelinePointerMove(event) {
    const drag = this.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const deltaX = Math.abs(event.clientX - drag.originX);
      const deltaY = Math.abs(event.clientY - drag.originY);
      if (Math.max(deltaX, deltaY) < 6) return;
      if (deltaY > deltaX) {
        this.timelineDrag = null;
        return;
      }
      drag.active = true;
      document.getElementById('mediaTimelineTrack')?.setPointerCapture?.(event.pointerId);
    }
    const ratio = this._timelineRatioFromEvent(event);
    drag.moved = drag.moved || Math.abs(ratio - drag.startRatio) > 0.002;
    if (drag.mode === 'preview') {
      this._previewTimelineAt(ratio * this.timelineSourceDuration);
      return;
    }
    event.preventDefault();
    const selection = this._selectionForTimelinePointer(drag.mode, ratio);
    if (!selection) return;
    this._renderTimelineSelection(selection);
    this._previewTimelineAt(drag.mode === 'end' ? selection.endSeconds : selection.startSeconds);
  }

  _onTimelinePointerEnd(event) {
    const drag = this.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const track = document.getElementById('mediaTimelineTrack');
    if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
    this.timelineDrag = null;
    if (drag.active && drag.mode !== 'preview' && this.timelineSelection) this._commitTimelineSelection(this.timelineSelection);
  }

  _onTimelineKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !this.timelineSelection) return;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = (event.shiftKey ? 1 : 0.1) * direction;
    const mode = event.target.closest('[data-timeline-handle]')?.dataset.timelineHandle || 'move';
    const helpers = window.ChengYiVideoTimeline;
    if (!helpers) return;
    let selection;
    if (mode === 'start' || mode === 'end') {
      const seconds = (mode === 'start' ? this.timelineSelection.startSeconds : this.timelineSelection.endSeconds) + step;
      selection = helpers.selectionFromHandlePosition({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds,
        durationSeconds: this.timelineSelection.durationSeconds,
        handle: mode,
        positionRatio: seconds / this.timelineSourceDuration,
      });
    } else {
      selection = helpers.clampTimelineSelection({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds + step,
        durationSeconds: this.timelineSelection.durationSeconds,
      });
    }
    event.preventDefault();
    this._renderTimelineSelection(selection);
    this._previewTimelineAt(mode === 'end' ? selection.endSeconds : selection.startSeconds);
    this._commitTimelineSelection(selection);
  }

  _commitTimelineSelection(selection) {
    if (!this.selectedImg || !selection) return;
    const metadata = mediaMetadataFromNode(this.selectedImg);
    if (!metadata) return;
    applyMediaMetadataToImage(this.selectedImg, {
      ...metadata,
      startSeconds: selection.startSeconds,
      durationSeconds: selection.durationSeconds,
    });
    this._renderTimelineSelection(selection);
    this.app.updatePreview();
  }

  _syncVideoSettings(img) {
    const panel = document.getElementById('videoSettings');
    if (!panel) return;
    let metadata = mediaMetadataFromNode(img);
    panel.hidden = !metadata;
    if (!metadata) return;
    const selection = this._clampTimelineSelection(metadata);
    const storedStart = normalizeVideoStart(img.dataset.mediaStart);
    const storedDuration = normalizeVideoDuration(img.dataset.mediaDuration);
    if (selection.startSeconds !== storedStart || selection.durationSeconds !== storedDuration) {
      applyMediaMetadataToImage(img, {
        ...metadata,
        startSeconds: selection.startSeconds,
        durationSeconds: selection.durationSeconds,
      });
      metadata = mediaMetadataFromNode(img);
      this.app.saveDraft();
    }
    document.getElementById('mediaOutputMode').value = metadata.mode;
    this._syncDurationSelect(metadata.durationSeconds, metadata.sourceDuration);
    const startInput = document.getElementById('mediaStart');
    startInput.value = String(metadata.startSeconds);
    startInput.max = String(selection.maxStart);
    document.getElementById('mediaSound').checked = metadata.keepSound;
    const status = document.getElementById('mediaLocalStatus');
    if (status) {
      const durationLabel = metadata.sourceDuration ? `源视频 ${metadata.sourceDuration.toFixed(1)} 秒` : '源视频时长未知';
      status.textContent = `${durationLabel} · 素材仅保存在当前设备，备份草稿时会一并带走`;
    }
    const liveHint = document.getElementById('mediaLiveHint');
    if (liveHint) liveHint.hidden = metadata.mode !== 'live-photo';
    this._renderTimelineSelection(selection, metadata.sourceDuration);
    void this._prepareVideoTimeline(img, metadata);
  }

  updateSelectedVideoSettings() {
    if (!this.selectedImg) return;
    const metadata = mediaMetadataFromNode(this.selectedImg);
    if (!metadata) return;
    const mode = normalizeVideoMode(document.getElementById('mediaOutputMode').value);
    const durationSeconds = normalizeVideoDuration(document.getElementById('mediaDuration').value);
    const requestedStart = normalizeVideoStart(document.getElementById('mediaStart').value);
    const maximumStart = metadata.sourceDuration
      ? Math.max(0, metadata.sourceDuration - durationSeconds)
      : requestedStart;
    const startSeconds = Math.min(requestedStart, maximumStart);
    const keepSound = document.getElementById('mediaSound').checked;
    applyMediaMetadataToImage(this.selectedImg, {
      ...metadata,
      mode,
      durationSeconds,
      startSeconds,
      keepSound,
    });
    document.getElementById('mediaStart').value = String(startSeconds);
    this._syncVideoSettings(this.selectedImg);
    this.app.updatePreview();
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

  _isStaticCollageImage(img) {
    return img?.tagName === 'IMG' && img.dataset.mediaKind !== 'video' && !img.closest('.image-collage');
  }

  _topLevelEditorNode(node) {
    let current = node;
    while (current?.parentNode && current.parentNode !== this.editor) current = current.parentNode;
    return current?.parentNode === this.editor ? current : null;
  }

  _collageCandidate(node) {
    if (this._isStaticCollageImage(node)) return { node, img: node };
    if (!node?.matches?.('div, p') || node.matches('.page-break-marker, .image-collage')) return null;
    const images = Array.from(node.querySelectorAll('img'));
    if (images.length !== 1 || !this._isStaticCollageImage(images[0]) || node.textContent.trim()) return null;
    const hasUnsupportedElement = Array.from(node.querySelectorAll('*')).some((child) => !child.matches('div, p, span, img, br'));
    return hasUnsupportedElement ? null : { node, img: images[0] };
  }

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
  }

  _newCollageId() {
    return safeCollageId(`c${Date.now()}${Math.random().toString(36).slice(2, 7)}`, `c${Date.now()}`);
  }

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
  }

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
  }

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
  }

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
  }

  addImagesToCollage() {
    const collage = this.selectedImg?.closest?.('.image-collage');
    if (!collage) return;
    this.pendingCollageId = collage.dataset.collageId;
    this.pendingCollageContext = { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
    document.getElementById('collageInput').click();
  }

  async handleCollageFiles(input) {
    const files = Array.from(input.files || []).filter((file) => file.type.startsWith('image/'));
    input.value = '';
    const requestedCollageId = this.pendingCollageId;
    const requestContext = this.pendingCollageContext || { accountId: cardAccountId(), draftId: this.app.getActiveDraftId() };
    this.pendingCollageId = '';
    this.pendingCollageContext = null;
    await this._insertCollageFiles(files, requestedCollageId, requestContext);
  }

  async _insertCollageFiles(files, requestedCollageId, requestContext) {
    if (files.length === 0) return;
    const api = collageLayoutAPI();
    if (requestContext.accountId !== cardAccountId() || requestContext.draftId !== this.app.getActiveDraftId()) {
      alert('当前账户或草稿已经切换，本次图片未加入。请在目标草稿中重新选择。');
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
      alert('图片处理期间账户、草稿或拼贴区发生了变化，本次图片未加入。请重新选择。');
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
  }

  handleImageFile(input) {
    const file = input.files[0];
    if (!file) return;
    this._insertImageFile(file);
    input.value = '';
  }

  insertVideoFromFile() {
    document.getElementById('videoInput').click();
  }

  handleVideoFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    void this._insertVideoFile(file);
  }

  async _createVideoPoster(file) {
    const objectURL = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectURL;
    const waitFor = (eventName, timeoutMessage) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, 15_000);
      const onSuccess = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('视频无法解码，请改用 H.264 MP4 或兼容的 MOV')); };
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener(eventName, onSuccess);
        video.removeEventListener('error', onError);
      };
      video.addEventListener(eventName, onSuccess, { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    try {
      const metadataReady = waitFor('loadedmetadata', '读取视频信息超时');
      video.load();
      await metadataReady;
      const sourceWidth = Number(video.videoWidth) || 0;
      const sourceHeight = Number(video.videoHeight) || 0;
      const sourceDuration = Number(video.duration) || 0;
      if (!(sourceWidth > 0 && sourceHeight > 0 && sourceDuration > 0)) {
        throw new Error('视频尺寸或时长无法读取');
      }
      const posterTime = Math.min(0.2, Math.max(0, sourceDuration - 0.05));
      if (posterTime > 0.01) {
        const frameReady = waitFor('seeked', '生成视频封面超时');
        video.currentTime = posterTime;
        await frameReady;
      } else if (video.readyState < 2) {
        await waitFor('loadeddata', '视频首帧加载超时');
      }
      const scale = Math.min(1, 1500 / sourceWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(sourceWidth * scale));
      canvas.height = Math.max(2, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建视频封面');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('视频封面生成失败')), 'image/jpeg', 0.9);
      });
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('视频封面读取失败'));
        reader.readAsDataURL(blob);
      });
      return { blob, dataURL, sourceWidth, sourceHeight, sourceDuration, posterTime };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectURL);
    }
  }

  async _insertVideoFile(file) {
    if (!isSupportedVideoFile(file)) {
      alert('目前只支持 MP4 或 MOV 视频');
      return;
    }
    const accountId = this.app.accountId;
    const draftId = this.app.getActiveDraftId();
    if (!accountId || !draftId) {
      alert('请先登录账户再插入视频；素材会保存在当前设备，备份草稿时会一并导出。');
      return;
    }
    this.app._setDraftStatus('正在读取视频并保存到本机…');
    const mediaId = safeDraftId(`m${Date.now()}${Math.random().toString(36).slice(2, 8)}`, `m${Date.now()}`);
    let store = null;
    try {
      const poster = await this._createVideoPoster(file);
      if (poster.sourceDuration < 3) {
        throw new Error('源视频不足 3 秒，请选择时长不少于 3 秒的 MP4 或 MOV');
      }
      store = await getCardMediaStore();
      const scope = { accountId, draftId, mediaId };
      const metadata = {
        name: safeMediaLabel(file.name, '视频素材'),
        mimeType: safeMediaLabel(file.type, CARD_VIDEO_EXTENSIONS.test(file.name || '') && /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4', 80),
        sourceWidth: poster.sourceWidth,
        sourceHeight: poster.sourceHeight,
        sourceDuration: poster.sourceDuration,
        posterTime: poster.posterTime,
      };
      await store.put({ ...scope, role: CARD_MEDIA_SOURCE_ROLE, blob: file, metadata });
      try {
        await store.put({ ...scope, role: CARD_MEDIA_POSTER_ROLE, blob: poster.blob, metadata });
      } catch (error) {
        await store.delete({ ...scope, role: CARD_MEDIA_SOURCE_ROLE }).catch(() => {});
        throw error;
      }

      const img = document.createElement('img');
      img.src = poster.dataURL;
      img.style.width = '100%';
      if (this.defaultImageFrame) img.dataset.frame = this.defaultImageFrame;
      applyMediaMetadataToImage(img, {
        id: mediaId,
        kind: 'video',
        mode: 'video',
        durationSeconds: supportsFiveSecondSelection(poster.sourceDuration) ? 5 : 3,
        startSeconds: 0,
        keepSound: true,
        name: metadata.name,
        mimeType: metadata.mimeType,
        sourceDuration: poster.sourceDuration,
        sourceDraftId: draftId,
      });
      this.editor.focus();
      document.execCommand('insertHTML', false, '<br>' + img.outerHTML + '<br>');
      this.app.updatePreview();
      const inserted = this.editor.querySelector(`img[data-media-id="${mediaId}"]`);
      if (inserted) this._selectImage(inserted);
      this.app._setDraftStatus('视频已保存到当前设备；请在图片设置下方选择视频或 Live Photo');
    } catch (error) {
      if (store) {
        const scope = { accountId, draftId, mediaId };
        await Promise.allSettled([
          store.delete({ ...scope, role: CARD_MEDIA_SOURCE_ROLE }),
          store.delete({ ...scope, role: CARD_MEDIA_POSTER_ROLE }),
        ]);
      }
      this.app._setDraftStatus(`⚠ 视频插入失败：${error.message || '未知错误'}`);
      alert(`视频插入失败：${error.message || '未知错误'}`);
    }
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

// ===== 内容解析器 =====
class ContentParser {
  constructor(editor) {
    this.editor = editor;
  }

  parse() {
    const elements = [];
    const editorEl = this.editor.editor;

    for (const child of editorEl.childNodes) {
      this._walk(child, elements);
    }

    const merged = this._mergeAdjacentText(elements);
    return this._deduplicateEmptyLines(merged);
  }

  _walk(node, elements) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (/[\r\n]/.test(text)) {
        text.split(/\r\n?|\n/).forEach((line) => {
          if (line.trim()) {
            elements.push({ type: 'p', html: this._textToHTML(node, line) });
            elements.push({ type: 'blockbreak' });
          } else {
            elements.push({ type: 'empty' });
          }
        });
      } else if (text.trim()) {
        elements.push({ type: 'p', html: this._textToHTML(node) });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (node.classList && node.classList.contains('page-break-marker')) {
        elements.push({ type: 'pagebreak' });
      } else if (tag === 'div' && node.dataset.cardCollage === '1' && node.classList.contains('image-collage')) {
        const api = collageLayoutAPI();
        const itemNodes = Array.from(node.children).filter((child) => child.classList.contains('collage-item'));
        const items = normalizeCollageDOMEntries(itemNodes).map(({ node: itemNode, model }) => {
          const img = itemNode?.querySelector(':scope > img');
          if (!img || img.dataset.mediaKind === 'video') return null;
          return {
            ...model,
            src: img.src,
            frame: normalizeImageFrame(img.dataset.frame),
          };
        }).filter(Boolean);
        if (items.length > 0) {
          elements.push({ type: 'collage', height: api.normalizeHeight(node.dataset.collageHeight), items });
        }
      } else if (tag === 'img') {
        elements.push({
          type: 'img',
          src: node.src,
          width: node.style.width || '100%',
          frame: normalizeImageFrame(node.dataset.frame),
          media: mediaMetadataFromNode(node),
        });
      } else if (tag === 'br' && node.dataset.collageCaret === '1') {
        return;
      } else if (tag === 'br') {
        elements.push({ type: 'empty' });
      } else if (tag === 'div' || tag === 'p') {
        if (node.childNodes.length === 0 || (node.childNodes.length === 1 && node.firstChild.tagName === 'BR')) {
          elements.push({ type: 'empty' });
        } else {
          elements.push({ type: 'blockbreak' });
          for (const child of node.childNodes) this._walk(child, elements);
          elements.push({ type: 'blockbreak' });
        }
      } else {
        for (const child of node.childNodes) this._walk(child, elements);
      }
    }
  }

  // 向上扫描祖先，还原加粗 / 荧光标记（两者可叠加）
  _textToHTML(textNode, textOverride) {
    let bold = false;
    let highlight = false;
    const root = this.editor.editor;
    let node = textNode.parentElement;
    while (node && node !== root) {
      if (node.tagName === 'B' || node.tagName === 'STRONG') bold = true;
      if (window.CreatorHighlight?.isMarked(node)
        || window.CreatorHighlight?.isLegacyHighlightColor(node.style?.backgroundColor)) highlight = true;
      node = node.parentElement;
    }
    let html = escapeHTML(textOverride ?? textNode.textContent);
    if (bold) html = '<b>' + html + '</b>';
    if (highlight) html = '<span class="hl">' + html + '</span>';
    return html;
  }

  _mergeAdjacentText(elements) {
    const merged = [];
    let textBuffer = '';
    for (const el of elements) {
      if (el.type === 'p') {
        textBuffer += el.html;
      } else if (el.type === 'blockbreak') {
        if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
        textBuffer = '';
      } else {
        if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
        textBuffer = '';
        merged.push(el);
      }
    }
    if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
    return merged;
  }

  _deduplicateEmptyLines(elements) {
    const deduped = [];
    for (const el of elements) {
      if (el.type === 'empty' && deduped.length > 0 && deduped[deduped.length - 1].type === 'empty') {
        continue;
      }
      deduped.push(el);
    }
    while (deduped.length > 0 && deduped[0].type === 'empty') deduped.shift();
    while (deduped.length > 0 && deduped[deduped.length - 1].type === 'empty') deduped.pop();
    return deduped;
  }
}

function shouldCenterPageContent(elements, usedRatio) {
  const containsCollage = Array.isArray(elements)
    && elements.some((element) => element?.type === 'collage');
  return Number(usedRatio) < 0.85 && !containsCollage;
}

// ===== 分页引擎 =====
class PaginationEngine {
  constructor(renderContainer) {
    this.container = renderContainer;
  }

  paginate(elements, buildAuthorHTML) {
    this.container.innerHTML = '';
    const pages = [];
    let currentPageEls = [];
    let isFirstPage = true;

    let { card: mc, body: mb } = this._createMeasureCard(true, buildAuthorHTML);

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      // 手动分页符：强制结束当前页，剩余空白保留
      if (el.type === 'pagebreak') {
        if (currentPageEls.length > 0) {
          pages.push({ elements: [...currentPageEls], isFirst: isFirstPage, centerContent: false });
          currentPageEls = [];
          isFirstPage = false;
          this.container.removeChild(mc);
          ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));
        }
        continue;
      }

      // 每页开头不放空行
      if (el.type === 'empty' && currentPageEls.length === 0) continue;

      const domEl = Renderer.createDomElement(el);
      mb.appendChild(domEl);
      const available = this._getAvailable(mc, mb);

      if (mb.scrollHeight > available) {
        mb.removeChild(domEl);

        // 尝试拆分长段落
        if (el.type === 'p') {
          const split = this._splitParagraph(el.html, mc, mb);
          if (split && split.first.trim()) {
            const firstP = document.createElement('p');
            firstP.innerHTML = split.first;
            mb.appendChild(firstP);
            currentPageEls.push({ type: 'p', html: split.first });

            pages.push({ elements: [...currentPageEls], isFirst: isFirstPage, centerContent: false });
            currentPageEls = [];
            isFirstPage = false;
            this.container.removeChild(mc);
            ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));

            if (split.rest.trim()) {
              elements.splice(i + 1, 0, { type: 'p', html: split.rest });
            }
            continue;
          }
        }

        // 无法拆分：整个推到下一页，计算当前页留白比例
        if (currentPageEls.length > 0) {
          const available = this._getAvailable(mc, mb);
          const usedRatio = this._getContentHeight(mb) / available;
          pages.push({
            elements: [...currentPageEls],
            isFirst: isFirstPage,
            centerContent: shouldCenterPageContent(currentPageEls, usedRatio),
          });
          currentPageEls = [];
          isFirstPage = false;
          this.container.removeChild(mc);
          ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));
        }
        mb.appendChild(Renderer.createDomElement(el));
        currentPageEls.push(el);
      } else {
        currentPageEls.push(el);
      }
    }

    if (currentPageEls.length > 0) {
      const available = this._getAvailable(mc, mb);
      const usedRatio = this._getContentHeight(mb) / available;
      pages.push({
        elements: [...currentPageEls],
        isFirst: isFirstPage,
        centerContent: shouldCenterPageContent(currentPageEls, usedRatio),
      });
    }
    this.container.innerHTML = '';
    if (pages.length === 0) pages.push({ elements: [], isFirst: true, centerContent: false });

    // 后处理：把每页开头的"不能行首"标点移到上一页结尾
    this._fixLeadingPunctuation(pages);
    return pages;
  }

  // 把每页开头的不能行首标点移到上一页结尾
  _fixLeadingPunctuation(pages) {
    // 中文 + 英文常见的不能行首标点
    const noLineStart = /^[。，、；：？！」』）】》〉…—.,?!:;)\]}'"]+/;

    for (let i = 1; i < pages.length; i++) {
      const page = pages[i];
      if (!page.elements || page.elements.length === 0) continue;
      const first = page.elements[0];
      if (first.type !== 'p') continue;

      // 提取段落开头的纯文本
      const div = document.createElement('div');
      div.innerHTML = first.html;
      const text = div.textContent;
      const match = text.match(noLineStart);
      if (!match) continue;

      const punctLen = match[0].length;

      // 找上一页最后一个 p 元素
      const prevPage = pages[i - 1];
      let lastPIdx = -1;
      for (let j = prevPage.elements.length - 1; j >= 0; j--) {
        if (prevPage.elements[j].type === 'p') { lastPIdx = j; break; }
      }
      if (lastPIdx === -1) continue;

      // 把开头标点剪切到上一页末尾
      const punctHtml = this._truncateHTML(first.html, punctLen);
      const restHtml = this._truncateHTMLAfter(first.html, punctLen);

      prevPage.elements[lastPIdx] = {
        type: 'p',
        html: prevPage.elements[lastPIdx].html + punctHtml,
      };
      first.html = restHtml;

      // 如果当前段落变空，移除它
      if (!first.html.trim()) {
        page.elements.shift();
      }
    }
  }

  _createMeasureCard(withAuthor, buildAuthorHTML) {
    const S = STYLES;
    const card = document.createElement('div');
    card.className = 'card-page';
    card.style.cssText = `width:${CARD_W}px;height:${CARD_H}px;padding:${S.paddingY}px ${S.paddingX}px;background:${S.bgColor};position:absolute;left:0;top:0;`;
    if (withAuthor) card.innerHTML = buildAuthorHTML();
    const body = document.createElement('div');
    body.className = 'card-body';
    body.style.cssText = `font-size:${S.fontSize}px;line-height:${S.lineHeight};color:${S.textColor};`;
    card.appendChild(body);
    this.container.appendChild(card);
    return { card, body };
  }

  _getAvailable(card, body) {
    const cardStyle = getComputedStyle(card);
    const paddingTop = parseFloat(cardStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(cardStyle.paddingBottom) || 0;
    const leadingContent = body.offsetTop - card.offsetTop - paddingTop;
    return CARD_H - paddingTop - paddingBottom - leadingContent;
  }

  // 计算 body 内子元素的实际内容高度（不受 flex:1 撑满影响）
  _getContentHeight(body) {
    let height = 0;
    for (const child of body.children) {
      const style = getComputedStyle(child);
      height += child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    }
    return height;
  }

  _splitParagraph(html, card, body) {
    const testP = document.createElement('p');
    testP.innerHTML = html;
    body.appendChild(testP);
    const available = this._getAvailable(card, body);

    if (body.scrollHeight <= available) {
      body.removeChild(testP);
      return null;
    }

    const plainText = testP.textContent;
    body.removeChild(testP);

    // 二分查找能放下的最大字符数
    let lo = 1, hi = plainText.length, bestSplit = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      testP.innerHTML = this._truncateHTML(html, mid);
      body.appendChild(testP);
      if (body.scrollHeight <= available) {
        bestSplit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
      body.removeChild(testP);
    }

    if (bestSplit === 0) return null;

    const remaining = plainText.substring(bestSplit);

    // 英文单词/数字中间断开：回退到上一个单词边界（空格或标点）
    const before = plainText.substring(0, bestSplit);
    const lastChar = before[before.length - 1];
    const nextChar = remaining[0];
    if (lastChar && nextChar && /[a-zA-Z0-9]/.test(lastChar) && /[a-zA-Z0-9]/.test(nextChar)) {
      const boundary = before.search(/[\s\p{P}\p{S}](?=[^\s\p{P}\p{S}]*$)/u);
      if (boundary > 0) {
        bestSplit = boundary + 1;
      }
    }

    return {
      first: this._truncateHTML(html, bestSplit),
      rest: this._truncateHTMLAfter(html, bestSplit),
    };
  }

  // 截取 HTML 的前 N 个纯文本字符（保留标签结构）
  _truncateHTML(html, maxChars) {
    const div = document.createElement('div');
    div.innerHTML = html;
    let count = 0;
    function walk(node) {
      if (count >= maxChars) { node.textContent = ''; return; }
      if (node.nodeType === Node.TEXT_NODE) {
        const remaining = maxChars - count;
        if (node.textContent.length > remaining) {
          node.textContent = node.textContent.substring(0, remaining);
          count = maxChars;
        } else {
          count += node.textContent.length;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
    walk(div);
    return div.innerHTML;
  }

  // 截取 HTML 的第 N 个纯文本字符之后的部分
  _truncateHTMLAfter(html, skipChars) {
    const div = document.createElement('div');
    div.innerHTML = html;
    let count = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const remaining = skipChars - count;
        if (remaining >= node.textContent.length) {
          count += node.textContent.length;
          node.textContent = '';
        } else if (remaining > 0) {
          node.textContent = node.textContent.substring(remaining);
          count = skipChars;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
    walk(div);
    return div.innerHTML.replace(/<b><\/b>/g, '').replace(/<strong><\/strong>/g, '').replace(/<span[^>]*><\/span>/g, '');
  }
}

// ===== 渲染器 =====
class Renderer {
  static _createImageElement(el, inCollage = false) {
      const S = STYLES;
      const img = document.createElement('img');
      img.src = el.src;
      img.style.width = inCollage ? '100%' : el.width;
      img.style.height = 'auto';
      img.style.maxWidth = inCollage ? 'none' : '100%';
      // 轻微圆角更接近常见截图排版，也和拼贴图片保持一致。
      img.style.borderRadius = '4px';
      img.style.margin = inCollage ? '0' : `${S.imageMargin}px auto`;
      img.style.display = 'block';
      if (el.media) applyMediaMetadataToImage(img, el.media);
      // 图片样式预设（分页测量与导出共用此函数，高度自动一致）
      if (el.frame === 'shadow') {
        // html2canvas 1.4.1 不支持 CSS box-shadow。投影必须先画进真实
        // Canvas 像素层，否则网页预览有投影、导出的 PNG/ZIP 却会变回普通版。
        const frame = document.createElement('div');
        frame.className = 'card-image-frame card-image-frame-shadow';
        frame.dataset.frame = 'shadow';
        frame.style.width = inCollage ? '100%' : el.width;

        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.className = 'card-image-shadow-canvas';
        shadowCanvas.setAttribute('aria-hidden', 'true');
        shadowCanvas.style.left = `-${IMAGE_SHADOW_INSETS.left}px`;
        shadowCanvas.style.top = `-${IMAGE_SHADOW_INSETS.top}px`;
        shadowCanvas.style.width = `calc(100% + ${IMAGE_SHADOW_INSETS.left + IMAGE_SHADOW_INSETS.right}px)`;
        shadowCanvas.style.height = `calc(100% + ${IMAGE_SHADOW_INSETS.top + IMAGE_SHADOW_INSETS.bottom}px)`;

        img.style.width = '100%';
        img.style.margin = '0';
        img.dataset.frame = 'shadow';
        frame.appendChild(shadowCanvas);
        frame.appendChild(img);
        return frame;
      } else if (el.frame === 'polaroid') {
        img.style.border = '12px solid #fff';
        img.style.borderRadius = '4px';
        img.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.18)';
      } else if (el.frame === 'outline') {
        img.style.border = '1px solid #ddd';
      } else if (el.frame === 'blue-border' && !inCollage) {
        // 单图蓝边直接复用自由拼贴的 Canvas 蓝色柔光，避免维护另一套近似颜色。
        const frame = document.createElement('div');
        frame.className = 'card-image-frame card-image-frame-blue-border';
        frame.dataset.frame = 'blue-border';
        frame.style.width = el.width;

        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.className = 'card-image-shadow-canvas card-image-blue-shadow-canvas';
        shadowCanvas.setAttribute('aria-hidden', 'true');
        shadowCanvas.style.left = `-${IMAGE_SHADOW_INSETS.left}px`;
        shadowCanvas.style.top = `-${IMAGE_SHADOW_INSETS.top}px`;
        shadowCanvas.style.width = `calc(100% + ${IMAGE_SHADOW_INSETS.left + IMAGE_SHADOW_INSETS.right}px)`;
        shadowCanvas.style.height = `calc(100% + ${IMAGE_SHADOW_INSETS.top + IMAGE_SHADOW_INSETS.bottom}px)`;

        const glowCanvas = document.createElement('canvas');
        glowCanvas.className = 'card-collage-glow-canvas card-image-blue-glow-canvas';
        glowCanvas.setAttribute('aria-hidden', 'true');
        glowCanvas.style.left = `-${COLLAGE_GLOW_INSET}px`;
        glowCanvas.style.top = `-${COLLAGE_GLOW_INSET}px`;
        glowCanvas.style.width = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
        glowCanvas.style.height = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;

        img.style.width = '100%';
        img.style.margin = '0';
        img.dataset.frame = 'blue-border';
        frame.appendChild(shadowCanvas);
        frame.appendChild(glowCanvas);
        frame.appendChild(img);
        return frame;
      }
      return img;
  }

  static createDomElement(el) {
    if (el.type === 'img') {
      return Renderer._createImageElement(el, false);
    } else if (el.type === 'collage') {
      const api = collageLayoutAPI();
      const collage = document.createElement('div');
      collage.className = 'card-image-collage';
      collage.style.height = `${api.normalizeHeight(el.height)}px`;
      collage.style.margin = `${STYLES.imageMargin}px auto`;
      api.normalizeItems(el.items).forEach((model) => {
        const source = el.items.find((item) => item.id === model.id) || model;
        if (!source.src) return;
        const normalizedFrame = normalizeImageFrame(source.frame);
        const item = document.createElement('div');
        item.className = 'card-collage-item';
        item.style.left = `${model.x / 100}%`;
        item.style.top = `${model.y / 100}%`;
        item.style.width = `${model.width / 100}%`;
        item.style.zIndex = String(model.z);
        if (normalizedFrame === 'blue-border') {
          const glowCanvas = document.createElement('canvas');
          glowCanvas.className = 'card-collage-glow-canvas';
          glowCanvas.setAttribute('aria-hidden', 'true');
          glowCanvas.style.left = `-${COLLAGE_GLOW_INSET}px`;
          glowCanvas.style.top = `-${COLLAGE_GLOW_INSET}px`;
          glowCanvas.style.width = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
          glowCanvas.style.height = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
          item.appendChild(glowCanvas);
        }
        item.appendChild(Renderer._createImageElement({
          src: source.src,
          width: '100%',
          frame: normalizedFrame,
          media: null,
        }, true));
        collage.appendChild(item);
      });
      return collage;
    } else if (el.type === 'empty') {
      const p = document.createElement('p');
      p.className = 'empty-line';
      return p;
    } else {
      const p = document.createElement('p');
      p.innerHTML = el.html;
      fragmentHighlights(p);
      return p;
    }
  }

  static _roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  static _paintShadowFrame(frame) {
    const img = frame.querySelector('img');
    const canvas = frame.querySelector('.card-image-shadow-canvas');
    if (!img || !canvas) return false;

    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!frameRect.width || !frameRect.height || !canvasRect.width || !canvasRect.height) return false;

    // 预览用较高像素密度避免模糊；导出时 html2canvas 还会再按 2 倍采样。
    const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(canvasRect.width * density));
    const pixelHeight = Math.max(1, Math.round(canvasRect.height * density));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, canvasRect.width, canvasRect.height);

    const x = frameRect.left - canvasRect.left;
    const y = frameRect.top - canvasRect.top;
    const drawShadow = (color, blur, offsetY) => {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = offsetY;
      // Canvas 阴影透明度还会乘以投射源透明度，因此投射源必须不透明；
      // 白色底板会被前景图片覆盖，并与当前白色卡片背景保持一致。
      ctx.fillStyle = STYLES.bgColor;
      Renderer._roundedRect(ctx, x, y, frameRect.width, frameRect.height, 10);
      ctx.fill();
      ctx.restore();
    };

    // 一层近距离接触阴影 + 一层更柔和的环境阴影，避免“硬直黑框”。
    drawShadow('rgba(20, 24, 28, 0.11)', 10, 6);
    drawShadow('rgba(20, 24, 28, 0.17)', 28, 14);
    canvas.dataset.shadowReady = 'true';
    return true;
  }

  static _paintCollageGlow(canvas) {
    const item = canvas?.closest?.('.card-collage-item, .card-image-frame-blue-border');
    if (!item) return false;
    // 使用布局尺寸而不是 getBoundingClientRect，避免桌面预览缩放后把光晕再缩一次。
    const itemWidth = item.offsetWidth;
    const itemHeight = item.offsetHeight;
    const canvasWidth = canvas.offsetWidth;
    const canvasHeight = canvas.offsetHeight;
    if (!itemWidth || !itemHeight || !canvasWidth || !canvasHeight) return false;

    const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(canvasWidth * density));
    const pixelHeight = Math.max(1, Math.round(canvasHeight * density));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const x = (canvasWidth - itemWidth) / 2 + 0.75;
    const y = (canvasHeight - itemHeight) / 2 + 0.75;
    const width = Math.max(1, itemWidth - 1.5);
    const height = Math.max(1, itemHeight - 1.5);
    const glowLayers = [
      { spread: 12, lineWidth: 7, color: 'rgba(64, 137, 255, 0.055)' },
      { spread: 9, lineWidth: 6, color: 'rgba(64, 137, 255, 0.08)' },
      { spread: 6, lineWidth: 5, color: 'rgba(64, 137, 255, 0.12)' },
      { spread: 3.5, lineWidth: 3.5, color: 'rgba(68, 141, 255, 0.18)' },
      { spread: 1.5, lineWidth: 2.4, color: 'rgba(72, 145, 250, 0.3)' },
      { spread: 0, lineWidth: 1.4, color: 'rgba(72, 139, 245, 0.82)' },
    ];

    // 真实的多层半透明外环不会依赖浏览器对 Canvas 阴影的实现；
    // 即使右侧预览再缩小，仍会保留一圈可见、渐弱的蓝色柔光。
    glowLayers.forEach(({ spread, lineWidth, color }) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      Renderer._roundedRect(
        ctx,
        x - spread,
        y - spread,
        width + spread * 2,
        height + spread * 2,
        5 + spread,
      );
      ctx.stroke();
      ctx.restore();
    });

    // 再补一层按 DPR 校正的环境光。投射源不透明，避免 alpha 被二次相乘后看不见。
    ctx.save();
    ctx.strokeStyle = 'rgba(68, 141, 255, 1)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(58, 131, 247, 0.32)';
    ctx.shadowBlur = 9 * density;
    Renderer._roundedRect(ctx, x, y, width, height, 5);
    ctx.stroke();
    ctx.restore();
    canvas.dataset.glowReady = 'true';
    return true;
  }

  static async prepareImageEffects(root) {
    if (!root || !root.querySelectorAll) return;
    const frames = Array.from(root.querySelectorAll('.card-image-frame-shadow, .card-image-frame-blue-border'));
    const glowCanvases = Array.from(root.querySelectorAll('.card-collage-glow-canvas'));
    if (frames.length === 0 && glowCanvases.length === 0) return;

    const images = Array.from(new Set([
      ...frames.map((frame) => frame.querySelector('img')),
      ...glowCanvases.map((canvas) => canvas.closest('.card-collage-item, .card-image-frame-blue-border')?.querySelector('img')),
    ].filter(Boolean)));
    await Promise.all(images.map((img) => {
      if (!img || img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    frames.forEach((frame) => Renderer._paintShadowFrame(frame));
    glowCanvases.forEach((canvas) => Renderer._paintCollageGlow(canvas));
  }

  static renderPreview(pages, previewArea, buildAuthorHTML) {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      Renderer._renderMobile(pages, previewArea, buildAuthorHTML);
    } else {
      Renderer._renderDesktop(pages, previewArea, buildAuthorHTML);
    }
  }

  // \u684c\u9762\u7aef\uff1a\u7ad6\u5411\u5806\u53e0\uff0c\u7b49\u6bd4\u7f29\u653e
  static _renderDesktop(pages, previewArea, buildAuthorHTML) {
    const S = STYLES;
    const scrollTop = previewArea.scrollTop;
    previewArea.innerHTML = '';

    const previewStyles = getComputedStyle(previewArea);
    const horizontalPadding = (parseFloat(previewStyles.paddingLeft) || 0) + (parseFloat(previewStyles.paddingRight) || 0);
    const availW = Math.max(1, previewArea.clientWidth - horizontalPadding);
    const scale = Math.min(1, availW / CARD_W);

    const hint = document.createElement('div');
    hint.className = 'preview-scale-hint';
    hint.textContent = `\u9884\u89c8\uff08\u5171 ${pages.length} \u9875\uff0c\u6bcf\u9875 750\u00d71000\uff09`;
    previewArea.appendChild(hint);

    pages.forEach((page, idx) => {
      if (idx > 0) {
        const div = document.createElement('div');
        div.className = 'page-divider';
        div.style.width = (CARD_W * scale) + 'px';
        div.textContent = `\u2014 \u7b2c ${idx + 1} \u9875 \u2014`;
        previewArea.appendChild(div);
      }
      const wrapper = Renderer._buildWrapper(page, buildAuthorHTML);
      wrapper.style.width = CARD_W + 'px';
      wrapper.style.marginBottom = (-(1 - scale) * CARD_H) + 'px';
      previewArea.appendChild(wrapper);
      const card = wrapper.querySelector('.card-page');
      decorateHighlightStrokes(card);
      void Renderer.prepareImageEffects(card);
      wrapper.style.transform = `scale(${scale})`;
    });
    previewArea.scrollTop = scrollTop;
  }

  // \u79fb\u52a8\u7aef\uff1a\u6a2a\u5411\u6ed1\u52a8\u8f6e\u64ad\uff0c\u6bcf\u5f20\u5360\u6ee1\u5c4f\u5e55
  static _renderMobile(pages, previewArea, buildAuthorHTML) {
    const scrollLeft = previewArea.scrollLeft;
    previewArea.innerHTML = '';

    // \u89c6\u53e3\u5c3a\u5bf8
    const vw = previewArea.clientWidth || window.innerWidth;
    const vh = previewArea.clientHeight || window.innerHeight;
    const safeTop = 56;     // \u9876\u90e8\u9884\u7559\u7ed9\u5173\u95ed\u6309\u94ae
    const safeBottom = 70;  // \u5e95\u90e8\u9884\u7559\u7ed9\u6307\u793a\u5668
    const padX = 16;
    const availW = vw - padX * 2;
    const availH = vh - safeTop - safeBottom;
    // \u53d6\u5bbd\u9ad8\u4e24\u4e2a\u7ea6\u675f\u7684\u8f83\u5c0f\u8005\uff0c\u4fdd\u6301 3:4
    const scale = Math.min(availW / CARD_W, availH / CARD_H);

    pages.forEach((page) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview-wrapper';

      const card = Renderer._buildCard(page, buildAuthorHTML);
      wrapper.appendChild(card);
      previewArea.appendChild(wrapper);
      decorateHighlightStrokes(card);
      void Renderer.prepareImageEffects(card);
      card.style.transform = `scale(${scale})`;
      card.style.transformOrigin = 'center center';
      // \u7528 margin \u62b5\u6d88\u7f29\u653e\u540e\u7a7a\u767d\uff0c\u8ba9 flex \u5c45\u4e2d\u6b63\u786e
      const shrinkX = (CARD_W * (1 - scale)) / 2;
      const shrinkY = (CARD_H * (1 - scale)) / 2;
      card.style.margin = `-${shrinkY}px -${shrinkX}px`;
    });

    // \u6e32\u67d3\u9875\u7801\u6307\u793a\u5668
    Renderer._renderIndicator(pages.length);

    // \u8fd8\u539f\u6eda\u52a8\u4f4d\u7f6e
    previewArea.scrollLeft = scrollLeft;
    Renderer._bindMobileScroll(previewArea);
  }

  // \u6784\u5efa\u9884\u89c8\u5305\u88c5\u5668\uff08\u684c\u9762\u7528\uff09
  static _buildWrapper(page, buildAuthorHTML) {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-wrapper';
    const card = Renderer._buildCard(page, buildAuthorHTML);
    wrapper.appendChild(card);
    return wrapper;
  }

  // \u6784\u5efa\u5361\u7247 DOM
  static _buildCard(page, buildAuthorHTML) {
    const S = STYLES;
    const card = document.createElement('div');
    card.className = 'card-page';
    card.style.paddingTop = S.paddingY + 'px';
    card.style.paddingBottom = S.paddingY + 'px';
    card.style.paddingLeft = S.paddingX + 'px';
    card.style.paddingRight = S.paddingX + 'px';
    card.style.background = S.bgColor;
    if (page.isFirst) card.innerHTML = buildAuthorHTML();

    const body = document.createElement('div');
    body.className = 'card-body';
    if (page.centerContent) body.classList.add('card-body-center');
    body.style.fontSize = S.fontSize + 'px';
    body.style.lineHeight = S.lineHeight;
    body.style.color = S.textColor;
    page.elements.forEach((el) => body.appendChild(Renderer.createDomElement(el)));
    card.appendChild(body);
    return card;
  }

  static _renderIndicator(count) {
    const indicator = document.getElementById('previewIndicator');
    if (!indicator) return;
    indicator.innerHTML = '';
    if (count <= 1) {
      indicator.classList.remove('active');
      return;
    }
    indicator.classList.add('active');
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('div');
      dot.className = 'preview-indicator-dot' + (i === 0 ? ' current' : '');
      indicator.appendChild(dot);
    }
  }

  static _bindMobileScroll(previewArea) {
    if (previewArea._scrollBound) return;
    previewArea._scrollBound = true;
    previewArea.addEventListener('scroll', () => {
      const pageWidth = previewArea.clientWidth || window.innerWidth;
      const idx = Math.round(previewArea.scrollLeft / pageWidth);
      const dots = document.querySelectorAll('#previewIndicator .preview-indicator-dot');
      dots.forEach((d, i) => d.classList.toggle('current', i === idx));
    }, { passive: true });
  }
}

// ===== 导出器 =====
class Exporter {
  static async exportImage(pages, buildAuthorHTML, baseName, progressEl, mediaContext = {}) {
    const container = document.getElementById('exportContainer');
    container.innerHTML = '';
    const pageResults = [];

    try {
      for (let i = 0; i < pages.length; i++) {
        progressEl.textContent = `\u6b63\u5728\u6e32\u67d3\u7b2c ${i + 1}/${pages.length} \u9875...`;
        const page = pages[i];
        const card = Renderer._buildCard(page, buildAuthorHTML);
        card.style.position = 'absolute';
        card.style.left = '0';
        card.style.top = '0';
        card.style.transform = 'none';
        card.style.margin = '0';
        container.appendChild(card);

        // 等待所有图片加载完成
        await Promise.all(
          Array.from(card.querySelectorAll('img')).map((img) =>
            img.complete ? Promise.resolve() : Promise.race([
              new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('图片加载超时，请检查图片后重试')), 12000)),
            ])
          )
        );
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await Renderer.prepareImageEffects(card);
        decorateHighlightStrokes(card);
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const canvas = await html2canvas(card, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: null,
          width: CARD_W,
          height: CARD_H,
        });
        pageResults.push({
          canvas,
          media: Exporter._collectPageMedia(card, canvas),
        });
        container.removeChild(card);
      }
    } catch (err) {
      container.innerHTML = '';
      throw err;
    }

    container.innerHTML = '';

    if (pageResults.length === 0) {
      progressEl.style.display = 'none';
      return;
    }

    const canvasResults = pageResults.map((result) => result.canvas);
    const hasVideo = pageResults.some((result) => result.media.length > 0);

    if (hasVideo) {
      progressEl.textContent = '正在生成视频 / Live Photo…';
      const blob = await Exporter._buildMixedMediaZip(pageResults, baseName, progressEl, mediaContext);
      Exporter._downloadBlob(blob, `${baseName}.zip`);
      progressEl.textContent = `导出完成！共 ${pageResults.length} 页，已按原页序打包`;
      setTimeout(() => { progressEl.style.display = 'none'; }, 3000);
      return;
    }

    // 移动端优先走系统分享（iOS PWA 里 <a download> 经常无效，分享面板可存相册/文件）
    const shared = await Exporter._tryMobileShare(canvasResults, baseName, progressEl);
    if (!shared) {
      // 桌面 / 不支持分享的环境：单页下载 PNG，多页打包 ZIP
      if (canvasResults.length === 1) {
        progressEl.textContent = '正在导出...';
        const link = document.createElement('a');
        link.download = `${baseName}.png`;
        link.href = canvasResults[0].toDataURL('image/png');
        link.click();
      } else {
        progressEl.textContent = '正在打包 ZIP...';
        const zip = new JSZip();
        for (let i = 0; i < canvasResults.length; i++) {
          const dataURL = canvasResults[i].toDataURL('image/png');
          const base64 = dataURL.split(',')[1];
          zip.file(`${baseName}-${i + 1}.png`, base64, { base64: true });
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        Exporter._downloadBlob(blob, `${baseName}.zip`);
      }
    }

    progressEl.textContent = `导出完成！共 ${canvasResults.length} 张图片`;
    setTimeout(() => { progressEl.style.display = 'none'; }, 3000);
  }

  static _collectPageMedia(card, canvas) {
    const cardRect = card.getBoundingClientRect();
    if (!cardRect.width || !cardRect.height) throw new Error('导出卡片尺寸无效');
    const scaleX = canvas.width / cardRect.width;
    const scaleY = canvas.height / cardRect.height;
    return Array.from(card.querySelectorAll('img[data-media-kind="video"][data-media-id]')).map((img) => {
      const metadata = mediaMetadataFromNode(img);
      if (!metadata) throw new Error('视频块元数据不完整，请删除后重新插入');
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle ? window.getComputedStyle(img) : null;
      const borderLeft = Math.max(0, parseFloat(style?.borderLeftWidth) || 0);
      const borderTop = Math.max(0, parseFloat(style?.borderTopWidth) || 0);
      const borderRight = Math.max(0, parseFloat(style?.borderRightWidth) || 0);
      const borderBottom = Math.max(0, parseFloat(style?.borderBottomWidth) || 0);
      const contentWidth = Math.max(1, rect.width - borderLeft - borderRight);
      const contentHeight = Math.max(1, rect.height - borderTop - borderBottom);
      return {
        ...metadata,
        rect: {
          // 视频只覆盖图片内容区，保留相框/描边样式在视频上层。
          x: Math.max(0, Math.round((rect.left - cardRect.left + borderLeft) * scaleX)),
          y: Math.max(0, Math.round((rect.top - cardRect.top + borderTop) * scaleY)),
          width: Math.max(1, Math.round(contentWidth * scaleX)),
          height: Math.max(1, Math.round(contentHeight * scaleY)),
        },
      };
    });
  }

  static async _buildMixedMediaZip(pageResults, baseName, progressEl, mediaContext) {
    if (!window.JSZip) throw new Error('JSZip 未加载，无法打包视频内容');
    const accountId = String(mediaContext.accountId || '');
    const activeDraftId = String(mediaContext.draftId || '');
    if (!accountId || !activeDraftId) throw new Error('当前草稿账户信息不完整，无法读取视频素材');
    const store = await getCardMediaStore();
    const engine = await getLivePhotoEngine();
    const capability = engine.checkCapability?.();
    if (capability && !capability.supported) throw new Error(capability.message || '当前环境不支持视频合成');

    const zip = new window.JSZip();
    const expectedPaths = [];
    for (let index = 0; index < pageResults.length; index += 1) {
      const result = pageResults[index];
      const pageNumber = index + 1;
      const prefix = String(pageNumber).padStart(2, '0');
      if (result.media.length === 0) {
        const path = `${prefix}-图片.png`;
        const blob = await Exporter._canvasToBlob(result.canvas);
        zip.file(path, blob);
        expectedPaths.push(path);
        continue;
      }
      if (result.media.length > 1) {
        throw new Error(`第 ${pageNumber} 页包含 ${result.media.length} 个视频，当前每页只能生成一个视频或 Live Photo`);
      }
      const media = result.media[0];
      const sourceDraftId = media.sourceDraftId || activeDraftId;
      const asset = await store.get({
        accountId,
        draftId: sourceDraftId,
        mediaId: media.id,
        role: CARD_MEDIA_SOURCE_ROLE,
      });
      if (!asset?.blob) {
        throw new Error(`第 ${pageNumber} 页的视频素材不在当前设备，请删除该块后重新插入原视频`);
      }
      if (media.sourceDuration && media.startSeconds + media.durationSeconds > media.sourceDuration + 0.05) {
        throw new Error(`第 ${pageNumber} 页所选片段超出源视频时长，请调整开始时间或时长`);
      }
      const progress = ({ detail, progress: value }) => {
        const pct = Number.isFinite(Number(value)) ? ` ${Math.round(Number(value))}%` : '';
        progressEl.textContent = `第 ${pageNumber}/${pageResults.length} 页${pct} · ${detail || '正在处理视频…'}`;
      };
      const commonOptions = {
        videoBlob: asset.blob,
        cardCanvas: result.canvas,
        mediaRect: media.rect,
        rectSpace: 'output',
        startSeconds: media.startSeconds,
        durationSeconds: media.durationSeconds,
        coverOffsetSeconds: Math.min(0.2, media.durationSeconds / 2),
        keepSound: media.keepSound,
        outputWidth: CARD_W * 2,
        outputHeight: CARD_H * 2,
        clipRadius: 16,
        title: `${baseName}-${prefix}`,
        onProgress: progress,
      };

      if (media.mode === 'video') {
        const composed = await engine.composeCardVideo(commonOptions);
        if (!composed?.movieBytes?.byteLength) throw new Error(`第 ${pageNumber} 页视频生成结果为空`);
        const path = `${prefix}-视频.mp4`;
        zip.file(path, composed.movieBytes, { binary: true });
        expectedPaths.push(path);
      } else if (media.mode === 'live-photo') {
        const live = await engine.createLivePhotoPackage({
          ...commonOptions,
          platform: media.durationSeconds === 3 ? 'wechat' : 'xhs',
          zipOutputType: 'blob',
        });
        if (!Array.isArray(live?.parts) || live.parts.length === 0) {
          throw new Error(`第 ${pageNumber} 页 Live Photo 结果不完整`);
        }
        for (const part of live.parts) {
          const sourcePath = String(part.path || '');
          const marker = sourcePath.toLowerCase().indexOf('.pvt/');
          if (marker < 0 || !part.bytes) throw new Error(`第 ${pageNumber} 页 Live Photo 文件清单无效`);
          const relative = sourcePath.slice(marker + 5);
          const path = `${prefix}-实况.pvt/${relative}`;
          zip.file(path, part.bytes, { binary: true });
          expectedPaths.push(path);
        }
      } else {
        throw new Error(`第 ${pageNumber} 页视频输出模式无效`);
      }
    }

    progressEl.textContent = '正在校验导出包…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
    const reopened = await window.JSZip.loadAsync(blob);
    const missing = expectedPaths.filter((path) => !reopened.file(path));
    if (missing.length) throw new Error(`导出 ZIP 校验失败，缺少：${missing.join('、')}`);
    return blob;
  }

  static _canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png');
    });
  }

  static _downloadBlob(blob, filename) {
    const downloadURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = downloadURL;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 不能在 click 后立即 revoke：Safari / Chromium 可能尚未开始读取 Blob。
    setTimeout(() => URL.revokeObjectURL(downloadURL), 60_000);
  }

  // 移动端用 Web Share API 分享图片文件；不适用时返回 false 走下载逻辑
  static async _tryMobileShare(canvasResults, baseName, progressEl) {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile || !navigator.canShare) return false;

    progressEl.textContent = '正在准备分享...';
    const files = [];
    for (let i = 0; i < canvasResults.length; i++) {
      const blob = await new Promise((r) => canvasResults[i].toBlob(r, 'image/png'));
      if (!blob) return false;
      const suffix = canvasResults.length > 1 ? `-${i + 1}` : '';
      files.push(new File([blob], `${baseName}${suffix}.png`, { type: 'image/png' }));
    }

    if (!navigator.canShare({ files })) return false;
    try {
      await navigator.share({ files });
      return true;
    } catch (err) {
      // 用户取消分享也算处理完成，不再重复触发下载
      return err.name === 'AbortError';
    }
  }
}

window.CardLayoutRenderer = Renderer;

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
    this.cloudState = 'idle';
    this.initialized = false;
    this.exporting = false;
    this.debouncedUpdate = debounce(() => this.updatePreview(), 100);
    const storageAPI = window.CardDraftStorage;
    if (!storageAPI?.CardDraftRepository || !storageAPI?.CardDraftCloudSync) {
      throw new Error('草稿存储组件未正确加载');
    }
    this.draftRepository = new storageAPI.CardDraftRepository();
    this.cloudSync = new storageAPI.CardDraftCloudSync({
      onStatus: (state, detail) => this._handleCloudStatus(state, detail),
      getLocalStore: () => this.store,
      onRemoteStore: (remoteStore) => this._applyRemoteDraftStore(remoteStore),
    });
    this.unsubscribeDraftUpdates = this.draftRepository.subscribe((message) => {
      if (message.accountId === this.accountId) this._reloadExternalDraftStore();
    });

    // 防抖：手机弹出键盘也会触发 resize，避免每次都全量重排
    window.addEventListener('resize', debounce(() => this.updatePreview(), 200));
    window.addEventListener('storage', (event) => {
      if (event.key === CREATOR_ACTIVE_ACCOUNT_KEY) this._switchAccount(event.newValue || '');
    });
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
    this._initDate();
    this.initialized = true;
    this.editorManager.editor.setAttribute('contenteditable', 'true');
    this.updatePreview();
    await this.cloudSync.init(this.accountId);
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

    // 未登录时只提供临时编辑，不读取或写入历史无账户 key，避免退出账户后看到上一位用户的草稿。
    if (!accountId) return emptyStore;

    let localStore = null;
    let localKeys = [];
    try {
      const scopedKey = cardStorageKey('article-card-drafts', accountId);
      const raw = localStorage.getItem(scopedKey);
      const legacyOwner = localStorage.getItem(CREATOR_LEGACY_OWNER_KEY);
      if (raw) {
        localStore = normalizeCardDraftStore(JSON.parse(raw));
        localKeys.push(scopedKey);
      } else if (accountId && legacyOwner === accountId) {
        const legacyRaw = localStorage.getItem('article-card-drafts');
        if (legacyRaw) {
          localStore = normalizeCardDraftStore(JSON.parse(legacyRaw));
          localKeys.push('article-card-drafts');
        }
      }

      // 迁移更早期的单草稿格式；只有明确属于当前账户时才允许读取。
      if (!localStore && accountId && legacyOwner === accountId) {
        const legacy = localStorage.getItem('article-card-draft');
        if (legacy) {
          const store = { ...emptyStore, drafts: [] };
          const draft = this._makeDraft(JSON.parse(legacy));
          store.drafts.push(draft);
          store.activeId = draft.id;
          localStore = normalizeCardDraftStore(store);
          localKeys.push('article-card-draft');
        }
      }
    } catch (error) {
      this.storageLoadError = error instanceof Error ? error.message : '草稿读取失败';
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
        localKeys.forEach((key) => localStorage.removeItem(key));
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
    if (!this.accountId) {
      this._setDraftStatus('未登录 · 本页内容仅临时保留', 'error');
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
          this.cloudSync.scheduleSave(snapshot);
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
    if (!this.accountId) return this._setDraftStatus('未登录 · 本页内容仅临时保留', 'error');
    if (this.cloudState === 'syncing' || this.cloudState === 'pending' || this.cloudState === 'connecting') {
      return this._setDraftStatus('本机已保存 · 云端同步中…', 'syncing');
    }
    if (this.cloudState === 'synced' || this.cloudState === 'connected') {
      return this._setDraftStatus(`云端已同步 ${this._timeLabel()}`, 'synced');
    }
    const suffix = this.lastLocalSavedAt ? ` ${this._timeLabel(this.lastLocalSavedAt)}` : '';
    return this._setDraftStatus(`本机已保存${suffix} · 登录后可云同步`, 'saved');
  }

  _handleCloudStatus(state, detail = '') {
    this.cloudState = state;
    if (state === 'offline') {
      this._setDraftStatus(`本机已保存 · 云端稍后重试${detail ? `（${detail}）` : ''}`, 'saved');
      return;
    }
    if (state === 'temporary') {
      this._setDraftStatus('未登录 · 本页内容仅临时保留', 'error');
      return;
    }
    this._renderSaveStatus();
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
    const activeAccountId = cardAccountId();
    if (activeAccountId !== this.accountId) {
      this._switchAccount(activeAccountId);
      return Promise.resolve(false);
    }
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

  async _applyRemoteDraftStore(remoteStore) {
    if (!remoteStore || !this.accountId) return this.store;
    const merged = mergeCardDraftStores(this.store, remoteStore);
    const before = JSON.stringify(this.store);
    this.store = merged;
    if (JSON.stringify(merged) !== before) {
      this._restoreLoadedStore();
      await this._saveStore();
      this.updatePreview();
    }
    return this.store;
  }

  async _switchAccount(nextAccountId) {
    const normalizedAccountId = String(nextAccountId || '');
    if (normalizedAccountId === this.accountId) return;
    await this._writeActiveDraft();
    this.accountId = normalizedAccountId;
    this.store = await this._loadStore();
    this._restoreLoadedStore(true);
    this._initDate();
    this.updatePreview();
    window.updateDraftBackupStatus?.();
    await this.cloudSync.init(this.accountId);
  }

  _restoreLoadedStore(freshAccount = false) {
    if (this.store.drafts.length === 0) {
      const data = freshAccount
        ? normalizeDraftData({ content: '', authorName: '程意', pubDate: '', avatar: '', filename: 'article-card', defaultImageFrame: '' })
        : this._collectData();
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
    if (cardAccountId() !== this.accountId) {
      await this._switchAccount(cardAccountId());
      return;
    }
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
    if (cardAccountId() !== this.accountId) await this._switchAccount(cardAccountId());
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
    if (cardAccountId() !== this.accountId) {
      await this._switchAccount(cardAccountId());
      return;
    }
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
    if (!this.accountId) throw new Error('请先登录账户再恢复草稿');
    this.store = normalizeCardDraftStore(nextStore);
    await this._saveStore();
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
  if (cardAccountId() !== app.accountId) await app._switchAccount(cardAccountId());
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
