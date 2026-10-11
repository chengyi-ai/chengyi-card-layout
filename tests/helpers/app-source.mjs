import { readFile } from "node:fs/promises";

// app.js 已按职责拆成多个普通脚本，按此顺序加载并共享全局作用域。
export const APP_SCRIPTS = [
  "card-core.js",
  "card-editor.js",
  "card-editor-collage.js",
  "card-editor-video.js",
  "card-pagination.js",
  "card-renderer.js",
  "card-exporter.js",
  "app.js",
];

// 源码断言针对整个应用，拼接全部脚本，保持与拆分前 app.js 一致的检查范围。
export async function readAppSource() {
  const parts = await Promise.all(APP_SCRIPTS.map((file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8")));
  return parts.join("\n");
}
