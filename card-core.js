// ===== 常量 =====
const CARD_W = 750;
const CARD_H = 1000;
const CARD_PADDING_X = 24;
const CARD_PADDING_Y = 36;
const CARD_LOCAL_PARTITION = 'local';
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
const CARD_VIDEO_TIMELINE_URL = './video-timeline.js?v=20261005-local-drafts-v1';

let cardMediaStorePromise = null;
let livePhotoEnginePromise = null;

async function getCardMediaStore() {
  if (!cardMediaStorePromise) {
    cardMediaStorePromise = import('./media-store.js').then(async (module) => {
      const Store = module.CardMediaStore || module.default || window.CardMediaStore;
      if (typeof Store !== 'function') throw new Error('媒体存储模块未正确加载');
      const store = new Store();
      await store.open();
      await store.migrateLegacy();
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
  return CARD_LOCAL_PARTITION;
}

function cardStorageKey(base) {
  return `${base}:${CARD_LOCAL_PARTITION}`;
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
