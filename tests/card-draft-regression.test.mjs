import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [appSource, backupSource] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../backup.js", import.meta.url), "utf8"),
]);

/**
 * Extract a function or class-method body without adding a browser DOM test
 * dependency. The scanner deliberately understands comments and strings so
 * braces inside templates, regex-like strings, and comments do not truncate
 * the inspected method.
 */
function extractBlock(source, signature, label) {
  const match = signature.exec(source);
  assert.ok(match, `找不到 ${label}`);

  const open = source.indexOf("{", match.index);
  assert.notEqual(open, -1, `${label} 缺少函数体`);

  let depth = 0;
  let state = "code";
  let escaped = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote" || state === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single-quote" && char === "'") ||
        (state === "double-quote" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }

  assert.fail(`${label} 函数体未闭合`);
}

test("草稿保存持久化 defaultImageFrame，并移除 selected 瞬时 class", () => {
  const collectData = extractBlock(
    appSource,
    /\b_collectData\s*\(\s*\)\s*\{/,
    "ArticleCardApp._collectData",
  );

  assert.match(
    collectData,
    /\bdefaultImageFrame\s*:/,
    "_collectData 必须将 defaultImageFrame 写入草稿",
  );
  assert.match(
    collectData,
    /\bschemaVersion\s*:\s*CARD_DRAFT_SCHEMA_VERSION/,
    "_collectData 必须标记当前版本，避免新选择被当作旧草稿重置",
  );

  const removesSelectedInline =
    /querySelectorAll\s*\([^)]*selected[^)]*\)[\s\S]*classList\.remove\s*\(\s*['"]selected['"]\s*\)/.test(
      collectData,
    );
  const serializerCall = collectData.match(
    /\.(\w*(?:serializ|sanitiz|clean)\w*)\s*\(/i,
  );

  let removesSelectedInHelper = false;
  if (serializerCall) {
    const helperName = serializerCall[1];
    const helper = extractBlock(
      appSource,
      new RegExp(`\\b${helperName}\\s*\\([^)]*\\)\\s*\\{`),
      `ArticleCardApp.${helperName}`,
    );
    removesSelectedInHelper =
      /querySelectorAll\s*\([^)]*selected[^)]*\)[\s\S]*classList\.remove\s*\(\s*['"]selected['"]\s*\)/.test(
        helper,
      );
  }

  assert.ok(
    removesSelectedInline || removesSelectedInHelper,
    "保存草稿前必须从克隆内容中移除图片的 selected 瞬时 class",
  );
  assert.match(
    collectData,
    /cloneNode|serializ|sanitiz|clean/i,
    "清理 selected 时必须处理克隆/序列化结果，不能改变用户当前的选中状态",
  );
});

test("旧草稿保留单图样式，但新图片默认样式重置为正常", () => {
  const normalizeFrame = extractBlock(
    appSource,
    /\bfunction\s+normalizeImageFrame\s*\([^)]*\)\s*\{/,
    "normalizeImageFrame",
  );
  const normalizeDraft = extractBlock(
    appSource,
    /\bfunction\s+normalizeDraftData\s*\([^)]*\)\s*\{/,
    "normalizeDraftData",
  );
  const applyData = extractBlock(
    appSource,
    /\b_applyData\s*\([^)]*\)\s*\{/,
    "ArticleCardApp._applyData",
  );

  for (const frame of ["shadow", "polaroid", "outline", "blue-border"]) {
    assert.match(
      normalizeFrame,
      new RegExp(`['"]${frame}['"]`),
      `normalizeImageFrame 必须允许 ${frame}`,
    );
  }
  const normalizeImageFrame = new Function("value", normalizeFrame);
  assert.equal(normalizeImageFrame("投影"), "shadow");
  assert.equal(normalizeImageFrame("相框"), "polaroid");
  assert.equal(normalizeImageFrame("描边"), "outline");
  assert.equal(normalizeImageFrame("蓝边"), "blue-border");
  assert.equal(normalizeImageFrame("正常版"), "");
  assert.equal(normalizeImageFrame("javascript:alert(1)"), "");

  assert.match(
    normalizeDraft,
    /\bnormalizeImageFrame\s*\(/,
    "normalizeDraftData 必须通过 normalizeImageFrame 清洗模式值",
  );
  assert.match(
    normalizeDraft,
    /\[\s*['"]defaultImageFrame['"]\s*,(?:\s*['"]imageFrame['"]\s*,)?\s*['"]frame['"]\s*,\s*['"]mode['"]\s*\]/,
    "normalizeDraftData 的兼容优先级应为 defaultImageFrame → frame → mode",
  );
  assert.match(
    normalizeDraft,
    /sourceSchemaVersion\s*<\s*CARD_NORMAL_IMAGE_DEFAULT_MIGRATION_VERSION/,
    "旧草稿迁移时必须把新图片默认样式重置为正常",
  );
  assert.doesNotMatch(
    normalizeDraft,
    /inferDefaultImageFrame/,
    "不能再根据已有蓝边或投影图片反推新图片默认样式",
  );
  assert.match(
    applyData,
    /\bnormalizeDraftData\s*\(/,
    "_applyData 必须先调用 normalizeDraftData，不能直接信任旧草稿",
  );
  assert.match(
    applyData,
    /(?:this\.defaultImageFrame\s*=|setDefaultImageFrameFromDraft\s*\()\s*[\s\S]*\.defaultImageFrame/,
    "_applyData 必须恢复规范化后的 defaultImageFrame",
  );
});

test("新粘贴、拖入或文件选择的图片继承当前默认样式", () => {
  const insertImage = extractBlock(
    appSource,
    /\basync\s+_insertImageFile\s*\([^)]*\)\s*\{/,
    "EditorManager._insertImageFile",
  );

  assert.match(
    insertImage,
    /\bdefaultImageFrame\b/,
    "_insertImageFile 必须读取当前 defaultImageFrame",
  );
  assert.match(
    insertImage,
    /img\.dataset\.frame\s*=/,
    "_insertImageFile 必须把默认样式写入图片 data-frame",
  );
});

test("草稿存储固定到页面打开时的账户，并监听账户切换", () => {
  const articleCardClassIndex = appSource.indexOf("class ArticleCardApp");
  assert.ok(articleCardClassIndex >= 0, "找不到 ArticleCardApp");
  const articleCardSource = appSource.slice(articleCardClassIndex);
  const articleConstructor = extractBlock(
    articleCardSource,
    /\bconstructor\s*\(\s*\)\s*\{/,
    "ArticleCardApp.constructor",
  );
  const loadStore = extractBlock(
    articleCardSource,
    /\b_loadStore\s*\(\s*\)\s*\{/,
    "ArticleCardApp._loadStore",
  );
  const saveStore = extractBlock(
    articleCardSource,
    /\b_saveStore\s*\(\s*\)\s*\{/,
    "ArticleCardApp._saveStore",
  );
  const switchAccount = extractBlock(
    articleCardSource,
    /\b_switchAccount\s*\([^)]*\)\s*\{/,
    "ArticleCardApp._switchAccount",
  );

  assert.match(
    articleConstructor,
    /this\.accountId\s*=\s*cardAccountId\s*\(\s*\)/,
    "ArticleCardApp 必须在初始化时固定 accountId",
  );
  assert.match(
    articleConstructor,
    /new storageAPI\.CardDraftRepository\s*\(/,
    "ArticleCardApp 必须初始化 IndexedDB 草稿仓库",
  );
  assert.match(
    articleConstructor,
    /new storageAPI\.CardDraftCloudSync\s*\(/,
    "ArticleCardApp 必须初始化云端草稿同步",
  );
  assert.match(
    loadStore,
    /cardStorageKey\s*\(\s*['"]article-card-drafts['"]\s*,\s*(?:this\.)?accountId\s*\)/,
    "_loadStore 必须使用页面初始化时固定的 accountId",
  );
  if (/cardStorageKey\s*\(\s*['"]article-card-drafts['"]\s*,\s*accountId\s*\)/.test(loadStore)) {
    assert.match(
      loadStore,
      /const\s+accountId\s*=\s*this\.accountId/,
      "_loadStore 的局部 accountId 必须来自页面初始化时固定的 this.accountId",
    );
  }
  assert.match(
    saveStore,
    /cardStorageKey\s*\(\s*['"]article-card-drafts['"]\s*,\s*this\.accountId\s*\)/,
    "_saveStore 必须使用页面初始化时固定的 accountId",
  );
  assert.match(
    articleCardSource,
    /addEventListener\s*\(\s*['"]storage['"]/,
    "ArticleCardApp 必须监听跨标签页账户切换",
  );
  assert.match(
    articleCardSource,
    /CREATOR_ACTIVE_ACCOUNT_KEY/,
    "storage 监听必须只响应活动账户键",
  );
  assert.match(
    switchAccount,
    /this\.accountId/,
    "_switchAccount 必须比较或更新固定 accountId",
  );
  const flushIndex = switchAccount.indexOf("_writeActiveDraft");
  const rebindIndex = switchAccount.indexOf("this.accountId =");
  assert.ok(
    flushIndex >= 0 && rebindIndex > flushIndex,
    "切换账户时必须先把当前草稿保存回旧账户，再绑定新 accountId",
  );
});

test("备份导入复用产品草稿清洗/迁移入口", () => {
  assert.match(
    appSource,
    /window\.normalizeCardDraftStore\s*=\s*normalizeCardDraftStore/,
    "app.js 必须向备份脚本公开 normalizeCardDraftStore",
  );

  const importBackup = extractBlock(
    backupSource,
    /\basync\s+function\s+importDraftBackup\s*\([^)]*\)\s*\{/,
    "importDraftBackup",
  );
  assert.match(
    importBackup,
    /window\.normalizeCardDraftStore\s*\(\s*payload\.drafts\s*\)/,
    "备份恢复必须调用 window.normalizeCardDraftStore(payload.drafts)",
  );
  assert.doesNotMatch(
    importBackup,
    /JSON\.stringify\s*\(\s*payload\.drafts\s*\)/,
    "备份恢复不能绕过规范化入口直接保存 payload.drafts",
  );
});

test("损坏的草稿 store 会阻止后续自动保存，不能被空 store 覆盖", () => {
  const articleCardClassIndex = appSource.indexOf("class ArticleCardApp");
  assert.ok(articleCardClassIndex >= 0, "找不到 ArticleCardApp");
  const articleCardSource = appSource.slice(articleCardClassIndex);
  const constructor = extractBlock(
    articleCardSource,
    /\bconstructor\s*\(\s*\)\s*\{/,
    "ArticleCardApp.constructor",
  );
  const loadStore = extractBlock(
    articleCardSource,
    /\b_loadStore\s*\(\s*\)\s*\{/,
    "ArticleCardApp._loadStore",
  );
  const saveStore = extractBlock(
    articleCardSource,
    /\b_saveStore\s*\(\s*\)\s*\{/,
    "ArticleCardApp._saveStore",
  );

  assert.match(
    constructor,
    /this\.storageWriteBlocked\s*=\s*false/,
    "初始化时必须显式记录 storageWriteBlocked 状态",
  );
  assert.match(
    constructor,
    /this\.(?:storageLoadError|loadError)\s*=/,
    "初始化时必须保留 store 加载错误状态",
  );
  assert.match(
    loadStore,
    /this\.draftRepository\.load\s*\(\s*accountId\s*\)/,
    "_loadStore 必须优先从 IndexedDB 读取当前账户草稿",
  );
  assert.match(
    loadStore,
    /catch\s*\([^)]*\)\s*\{[\s\S]*this\.(?:storageLoadError|loadError)\s*=/,
    "_loadStore 解析损坏数据时必须缓存错误",
  );
  assert.match(
    loadStore,
    /if\s*\(\s*!indexedStore\s*&&\s*!localStore\s*&&\s*this\.storageLoadError\s*\)[\s\S]*this\.storageWriteBlocked\s*=\s*true/,
    "IndexedDB 与 localStorage 都不可用时必须阻止后续空草稿覆盖",
  );
  const blockGuardIndex = saveStore.indexOf("this.storageWriteBlocked");
  const writeIndex = saveStore.indexOf("localStorage.setItem");
  assert.ok(
    blockGuardIndex >= 0 && writeIndex > blockGuardIndex,
    "_saveStore 必须先检查 storageWriteBlocked，再尝试 localStorage.setItem",
  );
  assert.match(
    saveStore,
    /this\.draftRepository\.save\s*\(\s*this\.accountId/,
    "_saveStore 必须把当前账户草稿写入 IndexedDB",
  );
  assert.match(
    saveStore,
    /if\s*\(\s*this\.storageWriteBlocked\s*\)[\s\S]*return\s+(?:Promise\.resolve\(false\)|false)/,
    "storageWriteBlocked 时 _saveStore 必须明确返回失败 Promise",
  );
});

test("退出账户后不会读取已迁移的无账户旧草稿", () => {
  const articleCardClassIndex = appSource.indexOf("class ArticleCardApp");
  assert.ok(articleCardClassIndex >= 0, "找不到 ArticleCardApp");
  const loadStore = extractBlock(
    appSource.slice(articleCardClassIndex),
    /\b_loadStore\s*\(\s*\)\s*\{/,
    "ArticleCardApp._loadStore",
  );

  assert.doesNotMatch(
    loadStore,
    /!accountId\s*\|\|/,
    "退出账户时不能再把无账户状态视为旧草稿迁移资格",
  );
  const ownedMigrationChecks =
    loadStore.match(/accountId\s*&&\s*legacyOwner\s*===\s*accountId/g) || [];
  assert.ok(
    ownedMigrationChecks.length >= 2,
    "无论旧 store 还是旧单草稿，迁移都必须显式要求非空 accountId 且 owner 一致",
  );

  const firstBaseRead = loadStore.indexOf("localStorage.getItem(scopedKey)");
  const loggedOutGuard = loadStore.match(
    /if\s*\(\s*!\s*(?:this\.)?accountId\s*\)\s*(?:\{[\s\S]{0,500}?return\b|return\b)/,
  );
  const gatedRead = loadStore.match(
    /(?:let|const)\s+raw\s*=\s*(?:this\.)?accountId\s*\?\s*localStorage\.getItem\s*\(\s*scopedKey\s*\)/,
  );
  const guardedReadBlock = loadStore.match(
    /if\s*\(\s*(?:this\.)?accountId\s*\)\s*\{[\s\S]{0,500}?localStorage\.getItem\s*\(\s*scopedKey\s*\)/,
  );
  const guardBeforeRead =
    loggedOutGuard && (firstBaseRead < 0 || loggedOutGuard.index < firstBaseRead);

  assert.ok(
    guardBeforeRead || gatedRead || guardedReadBlock,
    "accountId 为空时不得读取 base article-card-drafts；必须早退或对读取进行 accountId 门控",
  );
});

test("单图 setImageFrame 只修改选中图片，不改变新图片默认样式", () => {
  const setImageFrame = extractBlock(
    appSource,
    /\bsetImageFrame\s*\([^)]*\)\s*\{/,
    "EditorManager.setImageFrame",
  );

  assert.match(
    setImageFrame,
    /this\.selectedImg\.dataset\.frame|delete\s+this\.selectedImg\.dataset\.frame/,
    "setImageFrame 必须修改当前选中图片",
  );
  assert.doesNotMatch(
    setImageFrame,
    /this\.defaultImageFrame\s*=/,
    "单图样式操作不得改写 defaultImageFrame",
  );
  assert.doesNotMatch(
    setImageFrame,
    /_syncDefaultFrameButtons\s*\(/,
    "单图样式操作不得同步或改变默认样式按钮",
  );
});

test("草稿和备份清洗拒绝数组 data，并移除危险 href、id 与 style", () => {
  const normalizeStore = extractBlock(
    appSource,
    /\bfunction\s+normalizeCardDraftStore\s*\([^)]*\)\s*\{/,
    "normalizeCardDraftStore",
  );
  const normalizeContent = extractBlock(
    appSource,
    /\bfunction\s+normalizeDraftContent\s*\([^)]*\)\s*\{/,
    "normalizeDraftContent",
  );

  assert.match(
    normalizeStore,
    /Array\.isArray\s*\(\s*draft\.data\s*\)/,
    "normalizeCardDraftStore 必须拒绝数组形式的 draft.data",
  );
  assert.match(
    normalizeContent,
    /removeAttribute\s*\(\s*['"]id['"]\s*\)|for\s*\(\s*const\s+attr[\s\S]*removeAttribute\s*\(\s*attr\.name\s*\)/,
    "导入内容必须显式移除 id，或先移除全部属性再按白名单重建",
  );
  assert.match(
    normalizeContent,
    /\bhref\b/i,
    "导入内容必须检查链接 href",
  );
  assert.match(
    appSource,
    /javascript\s*:/i,
    "链接清洗必须显式拒绝 javascript: 协议",
  );
  assert.match(
    appSource,
    /removeAttribute\s*\(\s*['"]href['"]\s*\)|isSafeDraftHref|isUnsafeDraftURL|sanitizeDraftHref/i,
    "不安全 href 必须被移除或通过专用安全函数清洗",
  );
  assert.match(
    normalizeContent,
    /\bstyle\b/i,
    "导入内容必须处理内联 style",
  );
  assert.match(
    appSource,
    /expression|url\s*\(|position|z-index|behavior|-moz-binding/i,
    "style 清洗必须覆盖可加载资源、执行表达式或脱离文档流的危险声明",
  );
  assert.match(
    appSource,
    /removeAttribute\s*\(\s*['"]style['"]\s*\)|removeAttribute\s*\(\s*attr\.name\s*\)|setAttribute\s*\(\s*['"]style['"]|sanitizeDraftStyle|safeDraftImageWidth|safeDraftHighlight/i,
    "危险 style 必须被移除或经专用白名单函数重建",
  );
});

test("草稿 ID 只保留安全字符，更新下拉时不拼接进 querySelector", () => {
  const safeDraftId = extractBlock(
    appSource,
    /\bfunction\s+safeDraftId\s*\([^)]*\)\s*\{/,
    "safeDraftId",
  );
  const safeDraftText = extractBlock(
    appSource,
    /\bfunction\s+safeDraftText\s*\([^)]*\)\s*\{/,
    "safeDraftText",
  );
  const normalizeStore = extractBlock(
    appSource,
    /\bfunction\s+normalizeCardDraftStore\s*\([^)]*\)\s*\{/,
    "normalizeCardDraftStore",
  );
  const articleCardClassIndex = appSource.indexOf("class ArticleCardApp");
  assert.ok(articleCardClassIndex >= 0, "找不到 ArticleCardApp");
  const writeActiveDraft = extractBlock(
    appSource.slice(articleCardClassIndex),
    /\b_writeActiveDraft\s*\(\s*\)\s*\{/,
    "ArticleCardApp._writeActiveDraft",
  );

  const safeDraftTextFn = new Function("value", "fallback", "maxLength", safeDraftText);
  const safeDraftIdFn = new Function(
    "safeDraftText",
    `return function safeDraftId(value, fallback) {${safeDraftId}}`,
  )(safeDraftTextFn);
  for (const unsafeId of [
    `draft'"][value="other`,
    "draft space/slash",
    "中文草稿<script>",
  ]) {
    const normalized = safeDraftIdFn(unsafeId, "fallback-id");
    assert.match(
      normalized,
      /^[A-Za-z0-9_-]+$/,
      `safeDraftId 输出仍含不安全字符：${normalized}`,
    );
  }
  assert.ok(
    safeDraftIdFn(`draft'"]`, "fallback-id").length <= 120,
    "safeDraftId 必须限制 ID 长度",
  );
  assert.match(
    normalizeStore,
    /\bsafeDraftId\s*\(\s*draft\.id\b/,
    "normalizeCardDraftStore 必须通过 safeDraftId 清洗每个 draft.id",
  );
  assert.doesNotMatch(
    writeActiveDraft,
    /querySelector\s*\(\s*`[^`]*\$\{\s*draft\.id\s*\}[^`]*`|querySelector\s*\([^)]*\+\s*draft\.id/,
    "不得把未转义的 draft.id 直接拼接进 querySelector",
  );
  assert.match(
    writeActiveDraft,
    /select\.options|querySelectorAll\s*\(\s*['"]option['"]\s*\)|CSS\.escape\s*\(\s*draft\.id\s*\)/,
    "更新草稿下拉应遍历 option.value，或先用 CSS.escape 转义 draft.id",
  );
});

test("跨设备合并保留较新草稿，删除墓碑不会让旧稿复活", () => {
  const merge = extractBlock(
    appSource,
    /\bfunction\s+mergeCardDraftStores\s*\([^)]*\)\s*\{/,
    "mergeCardDraftStores",
  );
  const normalizeStore = extractBlock(
    appSource,
    /\bfunction\s+normalizeCardDraftStore\s*\([^)]*\)\s*\{/,
    "normalizeCardDraftStore",
  );
  assert.match(merge, /deletedDrafts/);
  assert.match(merge, /Number\(draft\.updatedAt\)\s*>=\s*Number\(existing\.updatedAt\)/);
  assert.match(merge, /deletedDrafts\[id\]\s*=\s*Math\.max/);
  assert.match(
    normalizeStore,
    /Number\(deletedDrafts\[draft\.id\]\s*\|\|\s*0\)\s*<\s*Number\(draft\.updatedAt/,
    "normalizeCardDraftStore 必须按删除时间隐藏已删草稿",
  );
  assert.match(
    appSource,
    /this\.store\.deletedDrafts\[deletedDraftId\]\s*=\s*deletedAt/,
    "删除草稿必须写入墓碑，供云端合并抑制复活",
  );
});
