import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readAppSource } from "./helpers/app-source.mjs";

const [app, style, html] = await Promise.all([
  readAppSource(),
  readFile(new URL("../style.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
]);

const shadowBranch = app.match(/if \(el\.frame === 'shadow'\) \{([\s\S]*?)\n\s*\} else if \(el\.frame === 'polaroid'\)/)?.[1] || "";
const shadowStyleRule = style.match(/\.card-image-frame-shadow\s*\{([^}]*)\}/)?.[1] || "";
assert.match(shadowBranch, /document\.createElement\('canvas'\)/, "投影图片必须创建真实 Canvas 像素层");
assert.match(shadowBranch, /card-image-shadow-canvas/, "投影 Canvas 必须带稳定的样式钩子");
assert.doesNotMatch(shadowBranch, /boxShadow/, "投影导出不能再依赖 html2canvas 不支持的 box-shadow");

assert.match(app, /static _paintShadowFrame\(frame\)/, "必须有独立、可复用的投影绘制函数");
assert.match(app, /ctx\.shadowBlur = blur/, "投影必须绘制成 Canvas 像素");
assert.match(app, /ctx\.fillStyle = STYLES\.bgColor/, "投射源必须不透明，否则 Canvas 会把投影透明度乘没");
assert.match(app, /canvas\.dataset\.shadowReady = 'true'/, "绘制完成后必须留下可验证标记");
assert.match(app, /await Renderer\.prepareImageEffects\(card\);\s*decorateHighlightStrokes\(card\);[\s\S]*html2canvas\(card/, "导出截图前必须等待投影像素完成");
assert.match(app, /void Renderer\.prepareImageEffects\(card\)/, "网页预览与导出必须共用同一投影绘制逻辑");
assert.match(app, /document\.body\.appendChild\(link\);[\s\S]*link\.click\(\);[\s\S]*link\.remove\(\)/, "ZIP 下载链接必须进入文档后再触发");
assert.match(app, /setTimeout\(\(\) => URL\.revokeObjectURL\(downloadURL\), 60_000\)/, "ZIP Blob 不能在浏览器接管下载前立即撤销");

assert.match(shadowStyleRule, /margin:\s*12px auto 14px/, "投影应固定使用紧凑的上下间距");
assert.doesNotMatch(shadowStyleRule, /margin:\s*20px auto 24px/, "不能恢复已取消的宽松间距");
assert.doesNotMatch(shadowStyleRule, /margin:\s*[^;]*56px/, "Canvas 的 56px 透明外扩不能再全部占用正文流");
assert.match(app, /IMAGE_SHADOW_INSETS\s*=\s*Object\.freeze\(\{[^}]*bottom:\s*56\s*\}\)/, "Canvas 仍需保留 56px 底部绘制缓冲，避免导出投影被裁掉");
assert.match(shadowBranch, /IMAGE_SHADOW_INSETS\.top \+ IMAGE_SHADOW_INSETS\.bottom/, "投影 Canvas 高度必须继续包含上下绘制缓冲");
assert.match(style, /\.card-image-shadow-canvas\s*\{[\s\S]*position:\s*absolute/, "Canvas 投影层必须定位在图片后方");
assert.match(html, /data-frame="" onclick="setImageFrame\(''\)">正常</, "单图普通样式不能再误称为默认");

assert.match(html, /data-frame="blue-border" onclick="setImageFrame\('blue-border'\)">蓝边</, "单图工具栏必须提供蓝边样式");
assert.match(html, /data-default-frame="blue-border" onclick="setDefaultImageFrame\('blue-border'\)">蓝边</, "新图片默认样式必须提供蓝边选项");
assert.match(style, /\.rich-editor img\[data-frame="blue-border"\]\s*\{[\s\S]*?border:\s*1px solid rgba\(74, 139, 247, \.78\)/, "编辑区蓝边必须复用拼贴描边数据");
assert.match(style, /\.rich-editor img\[data-frame="blue-border"\]\s*\{[\s\S]*?rgba\(58, 131, 247, \.34\)/, "编辑区蓝边必须复用拼贴柔光数据");
assert.match(app, /el\.frame === 'blue-border'[\s\S]*?card-image-frame-blue-border[\s\S]*?card-collage-glow-canvas card-image-blue-glow-canvas/, "单图蓝边必须复用拼贴 Canvas 柔光层");
assert.match(app, /el\.frame === 'blue-border'[\s\S]*?card-image-shadow-canvas card-image-blue-shadow-canvas/, "单图蓝边必须复用现有方向性投影层");
assert.match(app, /querySelectorAll\('\.card-image-frame-shadow, \.card-image-frame-blue-border'\)/, "蓝边与投影样式必须共用同一投影绘制函数");
assert.doesNotMatch(app, /#5aa7ee|90, 167, 238/, "单图蓝边不能保留上一版猜测的近似蓝色");
assert.match(app, /img\.style\.borderRadius = '4px'/, "普通图片圆角应缩小到 4px");

console.log("card shadow pixel export safeguards passed");
