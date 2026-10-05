import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL(".", import.meta.url));

const ALLOWED_FILES = new Set([
  "index.html",
  "card-layout-reset.html",
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
  "vendor/html2canvas.min.js",
  "vendor/jszip.min.js",
  "vendor/mp4-muxer.js",
  "vendor/mp4box.all.min.js",
]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

export function resolveServerConfig(env = process.env) {
  const parsedPort = Number(env.PORT || 4173);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
    ? parsedPort
    : 4173;
  return {
    host: String(env.HOST || "127.0.0.1").trim() || "127.0.0.1",
    port,
  };
}

function resolveAllowedPath(rawUrl = "/") {
  const rawPath = String(rawUrl).split("?", 1)[0] || "/";
  if (!rawPath.startsWith("/") || /%(?:00|2f|5c)/i.test(rawPath)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded === "/") decoded = "/index.html";

  const relativePath = decoded.replace(/^\/+/, "");
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    segments.some(segment =>
      !segment || segment === "." || segment === ".." || segment.startsWith(".")
    )
  ) return null;
  return ALLOWED_FILES.has(relativePath) ? relativePath : null;
}

function isInsideRoot(rootPath, filePath) {
  const pathFromRoot = relative(rootPath, filePath);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !pathFromRoot.startsWith("/")
  );
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

export function createCardLayoutServer({
  rootDir = DEFAULT_ROOT,
} = {}) {
  const configuredRoot = resolve(rootDir);
  const rootRealPromise = realpath(configuredRoot).catch(() => null);

  return createServer(async (req, res) => {
    try {
      const relativePath = resolveAllowedPath(req.url || "/");
      if (!relativePath) {
        sendText(res, 404, "Not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed", { allow: "GET, HEAD" });
        return;
      }

      const rootReal = await rootRealPromise;
      if (!rootReal) {
        sendText(res, 404, "Not found");
        return;
      }
      const candidate = resolve(rootReal, relativePath);
      const fileReal = await realpath(candidate);
      if (fileReal !== candidate || !isInsideRoot(rootReal, fileReal)) {
        sendText(res, 404, "Not found");
        return;
      }
      const info = await stat(fileReal);
      if (!info.isFile()) {
        sendText(res, 404, "Not found");
        return;
      }

      const headers = {
        "content-type": MIME_TYPES[extname(fileReal).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
        "content-length": String(info.size),
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "content-security-policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      };
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(await readFile(fileReal));
      }
    } catch {
      if (!res.headersSent) sendText(res, 404, "Not found");
      else res.destroy();
    }
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const config = resolveServerConfig();
  const server = createCardLayoutServer();
  server.listen(config.port, config.host, () => {
    console.log(`Local: http://${config.host}:${config.port}`);
  });
}
