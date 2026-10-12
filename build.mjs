import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const vendorHashes = new Map([
  ["vendor/html2canvas.min.js", "e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb"],
  ["vendor/LICENSE.html2canvas.txt", "86200ce4e92d9a22c41c8647a55f7a5fddff304ff89b4d36ecc699ed8c123d2c"],
  ["vendor/jszip.min.js", "acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e"],
  ["vendor/LICENSE.jszip.txt", "566c953c6090b1218ca6217dd7359d45dde46581968586dc607d59a78af6a9c4"],
  ["vendor/LICENSE.pako.txt", "a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539"],
  ["vendor/mp4-muxer.js", "cc4d30bd20b9ffe0b15f59cf0de3e1930626ccd46a5146e36e4d619d7fecf63d"],
  ["vendor/LICENSE.mp4-muxer.txt", "75c54aae7ef6ad652f684f9dd3b71e4dcef86ccebd88cf441ceed7f5eec037c5"],
  ["vendor/mp4box.all.min.js", "70221709a974a3ad6796935031c41565f3616cc4ed690c55dc59f97cd6d7dd1e"],
  ["vendor/LICENSE.mp4box.txt", "ebad0332150a08f37389158289d93ab2f70b0ee8717d1db9b3d002febc6c5047"],
]);

const assetFiles = [
  "index.html",
  "app.js",
  "card-core.js",
  "card-editor.js",
  "card-editor-collage.js",
  "card-editor-video.js",
  "card-pagination.js",
  "card-renderer.js",
  "card-exporter.js",
  "backup.css",
  "backup.js",
  "collage-layout.js",
  "draft-storage.js",
  "editor-highlight.js",
  "icon.png",
  "icon.svg",
  "live-photo-engine.js",
  "manifest.json",
  "media-store.js",
  "readability.css",
  "style.css",
  "video-timeline.js",
  "头像.png",
  "THIRD_PARTY_NOTICES.md",
  "vendor/README.md",
  ...vendorHashes.keys(),
];

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function verifyVendorFiles(prefix = "") {
  for (const [file, expected] of vendorHashes) {
    const target = prefix ? join(prefix, file) : file;
    const actual = await sha256(target);
    if (actual !== expected) throw new Error(`第三方依赖校验失败：${target}`);
  }
}

async function copyAsset(file) {
  await mkdir(dirname(join("dist", file)), { recursive: true });
  await cp(file, join("dist", file));
}

await verifyVendorFiles();
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const file of assetFiles) await copyAsset(file);
await verifyVendorFiles("dist");

const cardHtml = await readFile("dist/index.html", "utf8");
if (!cardHtml.includes("图文排版工具") || !cardHtml.includes("draft-storage.js")) throw new Error("图文工具入口校验失败");
if (cardHtml.includes("../../") || cardHtml.includes("/tools/card-layout/") || cardHtml.includes("cdn.jsdelivr.net")) throw new Error("独立项目路径校验失败");
await writeFile("dist/build-info.json", JSON.stringify({ builtAt: new Date().toISOString(), source: "chengyi-creator-toolkit@4b6c9cc", mode: "static" }, null, 2));

// 供支持 _headers 的静态托管读取；不生成任何 Worker 或 API。
await writeFile("dist/_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  Cache-Control: no-cache
`);
console.log("Build complete: dist/ (static)");
