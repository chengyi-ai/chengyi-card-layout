import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [backupSource, appSource, workerSource, resetSource, dashboardSource, buildSource] = await Promise.all([
  readFile(new URL("../backup.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../sw.js", import.meta.url), "utf8"),
  readFile(new URL("../card-layout-reset.html", import.meta.url), "utf8"),
  readFile(new URL("../dashboard.js", import.meta.url), "utf8"),
  readFile(new URL("../build.mjs", import.meta.url), "utf8"),
]);

const context = {
  window: {},
  document: { getElementById: () => null },
  localStorage: { getItem: () => null },
  location: { href: "https://example.com/" },
  URL,
  Date,
  console,
};
vm.runInNewContext(backupSource, context, { filename: "backup.js" });

const merge = context.window.mergeDraftBackupStores;
assert.equal(typeof merge, "function");

const current = {
  schemaVersion: 2,
  activeId: "same-id",
  drafts: [{
    id: "same-id",
    title: "当前草稿",
    updatedAt: 10,
    data: { content: "<div>当前内容</div>" },
  }],
};
const backup = {
  schemaVersion: 2,
  activeId: "same-id",
  drafts: [
    {
      id: "same-id",
      title: "历史草稿",
      updatedAt: 5,
      data: { content: "<div>历史内容</div>" },
    },
    {
      id: "unique-id",
      title: "图片草稿",
      updatedAt: 6,
      data: { content: "<img src=\"data:image/png;base64,AA==\">" },
    },
  ],
};

const merged = merge(current, backup, 1000);
assert.equal(merged.drafts.length, 3);
assert.equal(merged.drafts.at(-1).data.content, "<div>当前内容</div>", "restore must preserve the current draft");
assert.notEqual(merged.drafts[0].id, "same-id", "ID collisions must become a separate restored copy");
assert.match(merged.drafts[0].title, /恢复副本/);
assert.equal(merged.drafts[0].data.content, "<div>历史内容</div>");
assert.equal(merged.activeId, merged.drafts[0].id, "the first restored draft should open immediately");

const blankFirstBackup = {
  schemaVersion: 2,
  activeId: "blank-id",
  drafts: [
    {
      id: "blank-id",
      title: "空白草稿",
      data: { content: "<div>&nbsp;&#160;\u200B<br></div>" },
    },
    {
      id: "content-id",
      title: "有效草稿",
      data: { content: "<div>真正需要恢复的正文</div>" },
    },
  ],
};
const blankFirstMerged = merge(current, blankFirstBackup, 2000);
assert.equal(
  blankFirstMerged.activeId,
  blankFirstMerged.drafts[1].id,
  "an empty first/active draft must not hide a later restored draft with content",
);
assert.equal(blankFirstMerged.drafts[1].data.content, "<div>真正需要恢复的正文</div>");

const selectedContentBackup = {
  ...blankFirstBackup,
  activeId: "content-id",
};
const selectedContentMerged = merge(current, selectedContentBackup, 3000);
assert.equal(
  selectedContentMerged.activeId,
  selectedContentMerged.drafts[1].id,
  "the backup's meaningful active draft should remain active after ID remapping",
);

const mergedAgain = merge(selectedContentMerged, selectedContentBackup, 4000);
assert.equal(new Set(mergedAgain.drafts.map((draft) => draft.id)).size, mergedAgain.drafts.length);
assert.equal(
  mergedAgain.drafts.filter((draft) => draft.data.content === "<div>真正需要恢复的正文</div>").length,
  2,
  "restoring the same backup twice should create two independent copies",
);

const imageOnlyMerged = merge(current, {
  schemaVersion: 2,
  activeId: "image-only",
  drafts: [{
    id: "image-only",
    title: "纯图片草稿",
    data: { content: "<div><img src=\"data:image/png;base64,AA==\"></div>" },
  }],
}, 5000);
assert.equal(imageOnlyMerged.activeId, imageOnlyMerged.drafts[0].id);

const restoredStorage = new Map([
  ["creator-toolkit-active-account-v1", "qa-account"],
  ["article-card-drafts", JSON.stringify(current)],
]);
let flushCalled = false;
let reloadCalled = false;
const restoreContext = {
  window: {
    normalizeCardDraftStore: (store) => store,
    flushCardDrafts: () => {
      flushCalled = true;
      restoredStorage.set("article-card-drafts", JSON.stringify({
        ...current,
        drafts: [{
          ...current.drafts[0],
          data: { content: "<div>点击恢复前刚编辑的内容</div>" },
        }],
      }));
      return true;
    },
    reloadCardDrafts: () => {
      reloadCalled = true;
      return true;
    },
  },
  document: { getElementById: () => null },
  localStorage: {
    getItem: (key) => restoredStorage.get(key) ?? null,
    setItem: (key, value) => restoredStorage.set(key, value),
  },
  location: { href: "https://example.com/", replace: () => {} },
  URL,
  Date,
  console,
  confirm: () => true,
  alert: (message) => {
    throw new Error(`unexpected alert: ${message}`);
  },
};
vm.runInNewContext(backupSource, restoreContext, { filename: "backup-restore-flow.js" });
const restoreInput = {
  files: [{
    size: 1024,
    text: async () => JSON.stringify({
      app: "ChengYi Card Layout",
      version: 2,
      drafts: {
        schemaVersion: 2,
        activeId: "content-id",
        drafts: [blankFirstBackup.drafts[1]],
      },
    }),
  }],
  value: "selected",
};
await restoreContext.importDraftBackup(restoreInput);
assert.equal(flushCalled, true, "restore must flush unsaved editor changes before reading current storage");
assert.equal(reloadCalled, true, "restore should refresh drafts in the same page");
const restoredAfterImport = JSON.parse(restoredStorage.get("article-card-drafts"));
assert.equal(
  restoredAfterImport.drafts.at(-1).data.content,
  "<div>点击恢复前刚编辑的内容</div>",
  "restore must preserve current edits that were still waiting for autosave",
);
assert.equal(
  restoredAfterImport.drafts[0].data.content,
  "<div>真正需要恢复的正文</div>",
  "restore must add the backup as a separate restored copy",
);

class FakeZipBuilder {
  static latest = null;

  constructor() {
    this.files = new Map();
    FakeZipBuilder.latest = this;
  }

  file(path, value) {
    this.files.set(path, value);
    return this;
  }

  async generateAsync() {
    return new Blob(["zip-content"], { type: "application/zip" });
  }
}

const exportStorage = new Map([
  ["creator-toolkit-active-account-v1", "qa-account"],
  ["article-card-drafts", JSON.stringify({
    schemaVersion: 3,
    activeId: "media-draft",
    drafts: [{
      id: "media-draft",
      title: "视频草稿",
      data: { content: '<div><img data-media-id="clip-1" data-media-kind="video"></div>' },
    }],
  })],
]);
let exportedFilename = "";
const exportContext = {
  window: {
    JSZip: FakeZipBuilder,
    flushCardDrafts: () => true,
    normalizeCardDraftStore: (store) => store,
    cardMediaStore: {
      listDraft: async ({ accountId, draftId }) => {
        assert.equal(accountId, "qa-account");
        assert.equal(draftId, "media-draft");
        return [
          {
            accountId,
            draftId,
            mediaId: "clip-1",
            role: "source",
            blob: new Blob(["video"], { type: "video/mp4" }),
            mimeType: "video/mp4",
            size: 5,
            metadata: { duration: 5 },
          },
          {
            accountId,
            draftId,
            mediaId: "clip-1",
            role: "poster",
            blob: new Blob(["poster"], { type: "image/jpeg" }),
            mimeType: "image/jpeg",
            size: 6,
          },
        ];
      },
    },
  },
  document: {
    getElementById: () => null,
    createElement: () => ({
      href: "",
      download: "",
      click() { exportedFilename = this.download; },
    }),
  },
  localStorage: {
    getItem: (key) => exportStorage.get(key) ?? null,
    setItem: (key, value) => exportStorage.set(key, value),
  },
  URL: {
    createObjectURL: () => "blob:backup",
    revokeObjectURL: () => {},
  },
  Date,
  Blob,
  console,
  alert: (message) => { throw new Error(`unexpected alert: ${message}`); },
};
vm.runInNewContext(backupSource, exportContext, { filename: "backup-v3-export.js" });
await exportContext.exportDraftBackup();
assert.match(exportedFilename, /\.zip$/);
const exportedManifest = JSON.parse(FakeZipBuilder.latest.files.get("manifest.json"));
assert.equal(exportedManifest.version, 3);
assert.equal(exportedManifest.drafts.schemaVersion, 3);
assert.deepEqual(
  Array.from(exportedManifest.media, (asset) => asset.path),
  ["assets/media-draft/clip-1/source", "assets/media-draft/clip-1/poster"],
);
assert.ok(FakeZipBuilder.latest.files.get("assets/media-draft/clip-1/source") instanceof Blob);

function fakeLoadedZip(manifest, assetBlobs) {
  return {
    file(path) {
      if (path === "manifest.json") {
        return { async: async (type) => {
          assert.equal(type, "string");
          return JSON.stringify(manifest);
        } };
      }
      if (!assetBlobs.has(path)) return null;
      return { async: async (type) => {
        assert.equal(type, "blob");
        return assetBlobs.get(path);
      } };
    },
  };
}

const v3Manifest = {
  app: "ChengYi Card Layout",
  version: 3,
  exportedAt: "2026-08-03T00:00:00.000Z",
  drafts: {
    schemaVersion: 3,
    activeId: "same-id",
    drafts: [{
      id: "same-id",
      title: "带视频的历史草稿",
      data: {
        content: '<div><img data-media-id="clip-1" data-media-draft-id="same-id" data-media-kind="video" data-media-mode="live-photo"></div>',
      },
    }],
  },
  media: [
    {
      draftId: "same-id",
      mediaId: "clip-1",
      role: "source",
      path: "assets/same-id/clip-1/source",
      mimeType: "video/mp4",
      size: 5,
      metadata: { duration: 5 },
    },
    {
      draftId: "same-id",
      mediaId: "clip-1",
      role: "poster",
      path: "assets/same-id/clip-1/poster",
      mimeType: "image/jpeg",
      size: 6,
      metadata: null,
    },
  ],
};
const v3AssetBlobs = new Map([
  ["assets/same-id/clip-1/source", new Blob(["video"], { type: "video/mp4" })],
  ["assets/same-id/clip-1/poster", new Blob(["poster"], { type: "image/jpeg" })],
]);

const v3Storage = new Map([
  ["creator-toolkit-active-account-v1", "qa-account"],
  ["article-card-drafts", JSON.stringify(current)],
]);
const restoreEvents = [];
const restoredMedia = [];
const v3MediaStore = {
  async put(asset) {
    restoreEvents.push(`media:${asset.role}`);
    restoredMedia.push(asset);
  },
  async deleteDraft(scope) {
    restoreEvents.push(`rollback:${scope.draftId}`);
  },
};
const v3RestoreContext = {
  window: {
    normalizeCardDraftStore: (store) => store,
    flushCardDrafts: () => true,
    reloadCardDrafts: () => true,
    cardMediaStore: v3MediaStore,
    JSZip: { loadAsync: async () => fakeLoadedZip(v3Manifest, v3AssetBlobs) },
  },
  document: { getElementById: () => null },
  localStorage: {
    getItem: (key) => v3Storage.get(key) ?? null,
    setItem: (key, value) => {
      if (key === "article-card-drafts") restoreEvents.push("localStorage");
      v3Storage.set(key, value);
    },
  },
  location: { href: "https://example.com/", replace: () => {} },
  URL,
  Date,
  Blob,
  console,
  confirm: () => true,
  alert: (message) => { throw new Error(`unexpected alert: ${message}`); },
};
vm.runInNewContext(backupSource, v3RestoreContext, { filename: "backup-v3-restore.js" });
await v3RestoreContext.importDraftBackup({
  files: [{ name: "drafts.zip", type: "application/zip", size: 2048 }],
  value: "selected",
});
assert.equal(restoredMedia.length, 2);
assert.equal(restoredMedia[0].draftId, restoredMedia[1].draftId);
assert.equal(restoredMedia[0].mediaId, restoredMedia[1].mediaId);
assert.notEqual(restoredMedia[0].draftId, "same-id");
assert.notEqual(restoredMedia[0].mediaId, "clip-1");
assert.deepEqual(restoreEvents.slice(0, 3), ["media:source", "media:poster", "localStorage"]);
const v3RestoredStore = JSON.parse(v3Storage.get("article-card-drafts"));
assert.match(v3RestoredStore.drafts[0].data.content, new RegExp(`data-media-id="${restoredMedia[0].mediaId}"`));
assert.match(v3RestoredStore.drafts[0].data.content, new RegExp(`data-media-draft-id="${restoredMedia[0].draftId}"`));
assert.equal(v3RestoredStore.drafts.at(-1).data.content, "<div>当前内容</div>");

const failedStorage = new Map([
  ["creator-toolkit-active-account-v1", "qa-account"],
  ["article-card-drafts", JSON.stringify(current)],
]);
let putAttempt = 0;
const rolledBackDrafts = [];
let failureAlert = "";
const failedRestoreContext = {
  window: {
    normalizeCardDraftStore: (store) => store,
    flushCardDrafts: () => true,
    reloadCardDrafts: () => true,
    cardMediaStore: {
      async put(asset) {
        putAttempt += 1;
        if (putAttempt === 2) throw new Error("模拟素材写入失败");
        restoredMedia.push(asset);
      },
      async deleteDraft({ draftId }) { rolledBackDrafts.push(draftId); },
    },
    JSZip: { loadAsync: async () => fakeLoadedZip(v3Manifest, v3AssetBlobs) },
  },
  document: { getElementById: () => null },
  localStorage: {
    getItem: (key) => failedStorage.get(key) ?? null,
    setItem: (key, value) => failedStorage.set(key, value),
  },
  location: { href: "https://example.com/", replace: () => {} },
  URL,
  Date,
  Blob,
  console,
  confirm: () => true,
  alert: (message) => { failureAlert = message; },
};
vm.runInNewContext(backupSource, failedRestoreContext, { filename: "backup-v3-rollback.js" });
const beforeFailedRestore = failedStorage.get("article-card-drafts");
await failedRestoreContext.importDraftBackup({
  files: [{ name: "drafts.zip", type: "application/zip", size: 2048 }],
  value: "selected",
});
assert.equal(failedStorage.get("article-card-drafts"), beforeFailedRestore, "media failure must not commit drafts");
assert.equal(rolledBackDrafts.length, 1, "already written media must be rolled back");
assert.match(failureAlert, /草稿恢复失败：模拟素材写入失败/);

assert.match(backupSource, /不会覆盖现有草稿/);
assert.match(backupSource, /version: DRAFT_BACKUP_MEDIA_VERSION/);
assert.match(backupSource, /manifest\.json/);
assert.match(backupSource, /await restoreMediaAssets/);
assert.match(backupSource, /备份文件中的草稿均为空/);
assert.match(backupSource, /await window\.reloadCardDrafts\(\)/);
assert.match(backupSource, /window\.cardDraftRestoreInProgress = true/);
assert.doesNotMatch(backupSource, /location\.reload\(\)/);
assert.match(appSource, /window\.reloadCardDrafts = async \(\) =>/);
assert.match(appSource, /if \(!window\.cardDraftRestoreInProgress\) this\.saveDraft\(\)/);
assert.match(workerSource, /self\.addEventListener\('fetch'/);
assert.match(workerSource, /event\.respondWith\(fetch\(event\.request\)\)/);
assert.match(workerSource, /self\.registration\.unregister\(\)/);
assert.match(resetSource, /url\.origin === location\.origin && url\.pathname\.startsWith\('\/'\)/);
assert.match(resetSource, /key\.startsWith\('card-tool-'\)/);
assert.match(resetSource, /remainingRegistrations\.some/);
assert.match(resetSource, /retryWrap\.hidden = false;\s+return;/);
assert.match(resetSource, /location\.replace\(target\.href\)/);
assert.match(resetSource, /20260915-draft-autosave-v1/g);
assert.match(dashboardSource, /card-layout-reset\.html\?v=20260915-draft-autosave-v1/g);
assert.match(buildSource, /"card-layout-reset\.html"/);
assert.match(backupSource, /window\.getCardDraftStore/);
assert.match(backupSource, /window\.replaceCardDraftStore/);
assert.match(appSource, /window\.getCardDraftStore = async \(\) =>/);
assert.match(appSource, /window\.replaceCardDraftStore = async \(store\) =>/);

const memoryStore = {
  schemaVersion: 2,
  activeId: "same-id",
  drafts: [{
    id: "same-id",
    title: "当前草稿",
    updatedAt: 10,
    data: { content: "<div>当前内容</div>" },
  }],
  deletedDrafts: {},
};
let replaced = false;
const indexedRestoreContext = {
  window: {
    normalizeCardDraftStore: (store) => store,
    flushCardDrafts: async () => true,
    getCardDraftStore: async () => JSON.parse(JSON.stringify(memoryStore)),
    replaceCardDraftStore: async (store) => {
      replaced = true;
      memoryStore.schemaVersion = store.schemaVersion;
      memoryStore.activeId = store.activeId;
      memoryStore.drafts = store.drafts;
      memoryStore.deletedDrafts = store.deletedDrafts || {};
    },
    reloadCardDrafts: async () => true,
  },
  document: { getElementById: () => null },
  localStorage: {
    getItem: (key) => key === "creator-toolkit-active-account-v1" ? "qa-account" : null,
    setItem: (key) => {
      if (key === "article-card-drafts") throw new Error("恢复不得回退写入 localStorage");
    },
  },
  location: { href: "https://example.com/", replace: () => {} },
  URL,
  Date,
  console,
  confirm: () => true,
  alert: (message) => {
    throw new Error(`unexpected alert: ${message}`);
  },
};
vm.runInNewContext(backupSource, indexedRestoreContext, { filename: "backup-indexed-restore.js" });
await indexedRestoreContext.importDraftBackup({
  files: [{
    size: 1024,
    text: async () => JSON.stringify({
      app: "ChengYi Card Layout",
      version: 2,
      drafts: {
        schemaVersion: 2,
        activeId: "content-id",
        drafts: [blankFirstBackup.drafts[1]],
      },
    }),
  }],
  value: "selected",
});
assert.equal(replaced, true, "有 IndexedDB 入口时恢复必须走 replaceCardDraftStore");
assert.equal(memoryStore.drafts.length, 2);
assert.equal(memoryStore.drafts.at(-1).data.content, "<div>当前内容</div>");
assert.equal(memoryStore.drafts[0].data.content, "<div>真正需要恢复的正文</div>");

console.log("card backup restore tests passed");
