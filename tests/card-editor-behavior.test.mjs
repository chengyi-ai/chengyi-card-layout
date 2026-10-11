import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readAppSource } from "./helpers/app-source.mjs";
import vm from "node:vm";

const [highlightSource, appSource, styleSource, htmlSource, backupSource] = await Promise.all([
  readFile(new URL("../editor-highlight.js", import.meta.url), "utf8"),
  readAppSource(),
  readFile(new URL("../style.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../backup.js", import.meta.url), "utf8"),
]);

const context = {
  window: {},
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  document: {},
};
vm.runInNewContext(highlightSource, context, { filename: "editor-highlight.js" });
const highlight = context.window.CreatorHighlight;

assert.equal(highlight.isTransparentColor("rgba(0, 0, 0, 0)"), true);
assert.equal(highlight.isTransparentColor("transparent"), true);
assert.equal(highlight.isLegacyHighlightColor("rgba(0, 0, 0, 0)"), false);
assert.equal(highlight.isLegacyHighlightColor("rgb(250, 233, 133)"), true);

function fakeSpan(backgroundColor) {
  const attributes = new Map();
  const classes = new Set();
  const style = {
    backgroundColor,
    removeProperty(name) {
      if (name === "background-color") this.backgroundColor = "";
    },
  };
  return {
    nodeType: 1,
    style,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) {
      if (name === "style") return style.backgroundColor ? `background-color:${style.backgroundColor}` : "";
      if (name === "class") return [...classes].join(" ");
      return attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === "class") classes.clear();
      if (name === "style") style.backgroundColor = "";
    },
  };
}

{
  const transparent = fakeSpan("rgba(0, 0, 0, 0)");
  highlight.normalize({ querySelectorAll: () => [transparent] });
  assert.equal(transparent.getAttribute("data-card-highlight"), null);
  assert.equal(transparent.classList.contains("editor-highlight"), false);
  assert.equal(transparent.style.backgroundColor, "");
}

{
  const yellow = fakeSpan("rgb(250, 233, 133)");
  highlight.normalize({ querySelectorAll: () => [yellow] });
  assert.equal(yellow.getAttribute("data-card-highlight"), "true");
  assert.equal(yellow.classList.contains("editor-highlight"), true);
  assert.equal(yellow.style.backgroundColor, "");
}

assert.doesNotMatch(
  styleSource,
  /span\[style\*=["']background-color["']\]/,
  "编辑区不能再用背景色字符串选择器判断荧光笔",
);
assert.match(styleSource, /\.editor-highlight\[data-card-highlight=["']true["']\]/);
assert.match(appSource, /getAttribute\('data-card-highlight'\) === 'true'/);
assert.match(highlightSource, /b\[\$\{HIGHLIGHT_ATTR\}\]/);
assert.match(highlightSource, /strong\[\$\{HIGHLIGHT_ATTR\}\]/);
assert.match(highlightSource, /querySelectorAll\(`\[\$\{HIGHLIGHT_ATTR\}="true"\]`\)/);
assert.match(appSource, /elements\.push\(\{ type: 'blockbreak' \}\)/);
assert.match(appSource, /else if \(el\.type === 'blockbreak'\)/);
assert.match(appSource, /document\.getElementById\('measureContainer'\)/);
assert.match(appSource, /document\.getElementById\('exportContainer'\)/);
assert.match(appSource, /if \(this\.exporting\)/);
assert.match(appSource, /addEventListener\('pagehide'/);
assert.match(appSource, /this\.draftRepository\.subscribe/);
assert.match(appSource, /_reloadExternalDraftStore/);
assert.match(appSource, /_mergeExternalDraftStore/);
assert.match(backupSource, /尚未导出本机草稿备份/);
assert.match(backupSource, /window\.flushCardDrafts\(\) === false/);

const scriptVersion = htmlSource.match(/app\.js\?v=([^"']+)/)?.[1];
assert.ok(scriptVersion);
assert.match(htmlSource, new RegExp(`editor-highlight\\.js\\?v=${scriptVersion}`));

console.log("card editor behavior tests passed");
