import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readAppSource } from "./helpers/app-source.mjs";

const [app, style, toolHtml, build] = await Promise.all([
  readAppSource(),
  readFile("style.css", "utf8"),
  readFile("index.html", "utf8"),
  readFile("build.mjs", "utf8"),
]);

assert.match(app, /function fragmentHighlights\(root\)/);
assert.match(app, /glyph\.className = 'hl-glyph'/);
assert.match(app, /fragmentHighlights\(p\)/);
assert.match(app, /function decorateHighlightStrokes\(card\)/);
assert.match(app, /stroke\.className = `hl-stroke hl-stroke-v\$\{variantIndex\}`/);
assert.match(app, /const card = wrapper\.querySelector\('\.card-page'\)/);
assert.match(app, /decorateHighlightStrokes\(card\)/);
assert.match(style, /\.card-body \.hl\s*\{[\s\S]*background: transparent !important/);
assert.match(style, /\.card-body \.hl-glyph\s*\{[\s\S]*background-color: transparent !important/);
assert.match(style, /\.hl-stroke-layer\s*\{[\s\S]*position: absolute/);
assert.match(style, /\.hl-stroke\s*\{[\s\S]*linear-gradient\(179deg/);
assert.match(style, /\.hl-stroke-v0\s*\{[\s\S]*rotate\(-0\.18deg\)/);
assert.match(style, /\.hl-stroke-v1\s*\{[\s\S]*rotate\(0\.22deg\)/);
assert.match(style, /\.hl-stroke-v2\s*\{[\s\S]*rotate\(-0\.11deg\)/);
assert.match(style, /\.hl-stroke-v3\s*\{[\s\S]*rotate\(0\.15deg\)/);
const styleVersion = toolHtml.match(/style\.css\?v=([^"']+)/)?.[1];
const appVersion = toolHtml.match(/app\.js\?v=([^"']+)/)?.[1];
assert.ok(styleVersion, "card-layout style.css must have a cache-busting version");
assert.equal(appVersion, styleVersion, "card-layout CSS and JS cache versions must stay aligned");
assert.match(build, /Cache-Control: no-cache/);
assert.doesNotMatch(build, /dist\/server|handleCardDraftRequest/);

console.log("card highlight export safeguards passed");
