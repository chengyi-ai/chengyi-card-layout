import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, sep } from "node:path";

const vendorHashes = new Map([
  ["vendor/supabase.js", "7e94b62086deecef8c0ba3b38f514e2a1944ff6c81d92fb3ff967828c406c38f"],
  ["vendor/LICENSE.supabase-js.txt", "334dd6820e2eaeab2064e7c59001b810566728a28a41a7c1dbf69bbee17d0936"],
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
  "card-layout-reset.html",
  "cloud-config.js",
  "app.js",
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
  "sw.js",
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
await cp("supabase", "dist/supabase", { recursive: true });
await verifyVendorFiles("dist");

const cardHtml = await readFile("dist/index.html", "utf8");
const cardDraftHandler = await readFile("worker/card-draft-handler.mjs", "utf8");
if (!cardHtml.includes("图文排版工具") || !cardHtml.includes("draft-storage.js") || !cardHtml.includes("vendor/supabase.js?v=20260816-local-vendor-v1")) throw new Error("图文工具入口校验失败");
if (!cardDraftHandler.includes("handleCardDraftRequest") || !cardDraftHandler.includes("CARD_DRAFTS") || !cardDraftHandler.includes("/auth/v1/user")) throw new Error("图文草稿持久化服务校验失败");
if (cardHtml.includes("../../") || cardHtml.includes("/tools/card-layout/") || cardHtml.includes("cdn.jsdelivr.net")) throw new Error("独立项目路径校验失败");
await writeFile("dist/build-info.json", JSON.stringify({ builtAt: new Date().toISOString(), source: "chengyi-creator-toolkit@4b6c9cc", mode: "static-worker" }, null, 2));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

const assets = {};
for (const file of await collectFiles("dist")) {
  const urlPath = "/" + relative("dist", file).split(sep).join("/");
  assets[urlPath] = {
    type: mimeTypes[extname(file).toLowerCase()] || "application/octet-stream",
    body: (await readFile(file)).toString("base64")
  };
}

const workerSource = `import { handleCardDraftRequest } from "./card-draft-handler.mjs";
const assets=${JSON.stringify(assets)};
function decode(base64){const binary=atob(base64);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes}
function resolvePath(pathname){let path;try{path=decodeURIComponent(pathname)}catch{return null}if(path==="/")path="/index.html";else if(path.endsWith("/"))path+="index.html";return assets[path]?path:null}
export default{async fetch(request,env){const pathname=new URL(request.url).pathname;if(pathname==="/api/card-drafts")return handleCardDraftRequest(request,env);if(request.method!=="GET"&&request.method!=="HEAD")return new Response("Method not allowed",{status:405,headers:{allow:"GET, HEAD"}});const path=resolvePath(pathname);if(!path)return new Response("Not found",{status:404,headers:{"content-type":"text/plain; charset=utf-8"}});const asset=assets[path];const noStore=path.endsWith(".html")||path.endsWith("/sw.js") || path.endsWith("sw.js");const revalidate=path.endsWith(".js")||path.endsWith(".css")||path.endsWith(".json");const headers={"content-type":asset.type,"cache-control":noStore?"no-store":revalidate?"no-cache":"public, max-age=3600","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","x-frame-options":"DENY","permissions-policy":"camera=(), microphone=(), geolocation=()","content-security-policy":"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"};return new Response(request.method==="HEAD"?null:decode(asset.body),{status:200,headers})}};
`;
await mkdir("dist/server", { recursive: true });
await cp("worker/card-draft-handler.mjs", "dist/server/card-draft-handler.mjs");
await writeFile("dist/server/index.js", workerSource);
console.log("Build complete: dist/");
