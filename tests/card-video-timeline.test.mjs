import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  clampTimelineSelection,
  formatTime,
  selectionFromHandlePosition,
} from '../video-timeline.js';

const [appSource, htmlSource, styleSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
]);

function approximately(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

function extractBlock(source, signature, label) {
  const match = signature.exec(source);
  assert.ok(match, `找不到 ${label}`);
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`${label} 函数体未闭合`);
}

test('不足 3 秒的源视频不能建立时间选择区间', () => {
  for (const sourceDuration of [0, 0.1, 2.9, Number.NaN]) {
    assert.throws(
      () => clampTimelineSelection({ sourceDuration, startSeconds: 0, durationSeconds: 3 }),
      RangeError,
      `sourceDuration=${sourceDuration} 应被拒绝`,
    );
  }
});

test('3 秒和不足 5 秒的源视频会得到可导出的合法区间', () => {
  assert.deepEqual(
    clampTimelineSelection({ sourceDuration: 3, startSeconds: 12, durationSeconds: 5 }),
    { startSeconds: 0, endSeconds: 3, durationSeconds: 3, maxStart: 0 },
  );

  assert.deepEqual(
    clampTimelineSelection({ sourceDuration: 4.9, startSeconds: 1.9, durationSeconds: 5 }),
    { startSeconds: 1.9, endSeconds: 4.9, durationSeconds: 3, maxStart: 1.9 },
    '恢复旧草稿时，源视频不足 5 秒必须把 5 秒选择自动降为 3 秒',
  );

  assert.deepEqual(
    clampTimelineSelection({ sourceDuration: 5, startSeconds: 2, durationSeconds: 5 }),
    { startSeconds: 0, endSeconds: 5, durationSeconds: 5, maxStart: 0 },
  );

  for (const sourceDuration of [4.999, 5.001]) {
    const selection = clampTimelineSelection({ sourceDuration, startSeconds: 0, durationSeconds: 5 });
    assert.equal(
      selection.durationSeconds,
      5,
      `${sourceDuration} 秒是常见解码浮点误差，不能误降成 3 秒`,
    );
    assert.equal(selection.startSeconds, 0);
    assert.equal(selection.endSeconds, 5);
  }
});

test('5 秒浮点容差在草稿、控件和新视频默认值中使用同一判断', () => {
  const toleranceBody = extractBlock(
    appSource,
    /\bfunction\s+supportsFiveSecondSelection\s*\([^)]*\)\s*\{/,
    'supportsFiveSecondSelection',
  );
  const supportsFiveSecondSelection = new Function('sourceDuration', toleranceBody);
  assert.equal(supportsFiveSecondSelection(4.999), true);
  assert.equal(supportsFiveSecondSelection(5.001), true);
  assert.equal(supportsFiveSecondSelection(4.94), false);

  for (const [signature, label] of [
    [/\bfunction\s+mediaMetadataFromNode\s*\([^)]*\)\s*\{/, 'mediaMetadataFromNode'],
    [/\bfunction\s+applyMediaMetadataToImage\s*\([^)]*\)\s*\{/, 'applyMediaMetadataToImage'],
    [/\b_clampTimelineSelection\s*\([^)]*\)\s*\{/, 'EditorManager._clampTimelineSelection'],
    [/\b_syncDurationSelect\s*\([^)]*\)\s*\{/, 'EditorManager._syncDurationSelect'],
    [/\basync\s+_insertVideoFile\s*\([^)]*\)\s*\{/, 'EditorManager._insertVideoFile'],
  ]) {
    assert.match(
      extractBlock(appSource, signature, label),
      /supportsFiveSecondSelection\s*\(/,
      `${label} 必须复用统一的 5 秒容差`,
    );
  }
});

test('开始时间靠近尾部时会夹在源视频内，切换 3/5 秒也保持合法', () => {
  assert.deepEqual(
    clampTimelineSelection({ sourceDuration: 25, startSeconds: 24, durationSeconds: 3 }),
    { startSeconds: 22, endSeconds: 25, durationSeconds: 3, maxStart: 22 },
  );

  assert.deepEqual(
    clampTimelineSelection({ sourceDuration: 25, startSeconds: 22, durationSeconds: 5 }),
    { startSeconds: 20, endSeconds: 25, durationSeconds: 5, maxStart: 20 },
    '片段由 3 秒切成 5 秒时，开始时间必须同步向前夹取',
  );

  const decimalBoundary = clampTimelineSelection({
    sourceDuration: 25.05,
    startSeconds: 25,
    durationSeconds: 5,
  });
  assert.ok(
    decimalBoundary.endSeconds <= 25.05,
    '0.1 秒步进的舍入不能让片段终点越过真实源时长',
  );
});

test('左右手柄按同一时间轴平移固定的 3/5 秒选区', () => {
  const movedStart = selectionFromHandlePosition({
    sourceDuration: 20,
    startSeconds: 10,
    durationSeconds: 5,
    handle: 'start',
    positionRatio: 0.6,
  });
  assert.deepEqual(movedStart, {
    startSeconds: 12,
    endSeconds: 17,
    durationSeconds: 5,
    maxStart: 15,
  });

  const movedEnd = selectionFromHandlePosition({
    sourceDuration: 20,
    startSeconds: 10,
    durationSeconds: 3,
    handle: 'end',
    positionRatio: 0.7,
  });
  assert.deepEqual(movedEnd, {
    startSeconds: 11,
    endSeconds: 14,
    durationSeconds: 3,
    maxStart: 17,
  });

  const startTooFar = selectionFromHandlePosition({
    sourceDuration: 20,
    startSeconds: 10,
    durationSeconds: 5,
    handle: 'start',
    positionRatio: 0.99,
  });
  approximately(startTooFar.startSeconds, 15, '左手柄不得让固定 5 秒选区越过片尾');
  approximately(startTooFar.endSeconds, 20, '左手柄移动时右边界应保持同步');
  approximately(startTooFar.durationSeconds, 5, '拖动左手柄不能偷偷改变时长预设');

  const endTooFar = selectionFromHandlePosition({
    sourceDuration: 20,
    startSeconds: 10,
    durationSeconds: 3,
    handle: 'end',
    positionRatio: 1,
  });
  approximately(endTooFar.startSeconds, 17, '右手柄移动时左边界应同步平移');
  approximately(endTooFar.endSeconds, 20, '右手柄不得让固定 3 秒选区越过片尾');
  approximately(endTooFar.durationSeconds, 3, '拖动右手柄不能偷偷改变时长预设');

  const decimalTail = selectionFromHandlePosition({
    sourceDuration: 25.05,
    startSeconds: 20,
    durationSeconds: 5,
    handle: 'end',
    positionRatio: 1,
  });
  assert.ok(decimalTail.endSeconds <= 25.05, '手柄拖到尾部时也不能因四舍五入越过真实源时长');

  assert.throws(
    () => selectionFromHandlePosition({
      sourceDuration: 20,
      startSeconds: 0,
      durationSeconds: 3,
      handle: 'unknown',
      positionRatio: 0.5,
    }),
    /handle|手柄/i,
  );
});

test('时间标签始终使用便于核对的 m:ss.s 格式', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(3), '0:03.0');
  assert.equal(formatTime(65.24), '1:05.2');
  assert.equal(formatTime(-2), '0:00.0');
});

test('时长只允许 3 秒或 5 秒两个产品预设', () => {
  assert.equal(
    clampTimelineSelection({ sourceDuration: 20, startSeconds: 0, durationSeconds: 3 }).durationSeconds,
    3,
  );
  assert.equal(
    clampTimelineSelection({ sourceDuration: 20, startSeconds: 0, durationSeconds: 5 }).durationSeconds,
    5,
  );
  assert.equal(
    clampTimelineSelection({ sourceDuration: 20, startSeconds: 0, durationSeconds: 4 }).durationSeconds,
    5,
    '异常或旧数据不能新增任意时长，必须回到既有 3/5 秒预设',
  );
  assert.doesNotMatch(htmlSource, /id=["']mediaDurationCustom["']/i, '设置面板不能暴露任意时长');
});

test('时间轴与草稿恢复、媒体切换、无视频状态完成集成', () => {
  assert.match(htmlSource, /id=["']mediaTimeline["']/i, '视频设置里必须有可视化时间轴');
  assert.match(htmlSource, /data-timeline-handle=["']start["']/i, '时间轴必须提供开始手柄');
  assert.match(htmlSource, /data-timeline-handle=["']end["']/i, '时间轴必须提供结束手柄');
  assert.match(htmlSource, /id=["']mediaTimelineVideo["']/i, '时间轴必须有当前片段的视频预览');

  const sync = extractBlock(appSource, /\b_syncVideoSettings\s*\([^)]*\)\s*\{/, 'EditorManager._syncVideoSettings');
  const deselect = extractBlock(appSource, /\b_deselectImage\s*\([^)]*\)\s*\{/, 'EditorManager._deselectImage');
  const normalizeContent = extractBlock(
    appSource,
    /\bfunction\s+normalizeDraftContent\s*\([^)]*\)\s*\{/,
    'normalizeDraftContent',
  );
  const prepare = extractBlock(appSource, /\basync\s+_prepareVideoTimeline\s*\([^)]*\)\s*\{/, 'EditorManager._prepareVideoTimeline');
  const cleanup = extractBlock(appSource, /\b_cleanupVideoTimeline\s*\([^)]*\)\s*\{/, 'EditorManager._cleanupVideoTimeline');
  const pointerMove = extractBlock(appSource, /\b_onTimelinePointerMove\s*\([^)]*\)\s*\{/, 'EditorManager._onTimelinePointerMove');
  const pointerEnd = extractBlock(appSource, /\b_onTimelinePointerEnd\s*\([^)]*\)\s*\{/, 'EditorManager._onTimelinePointerEnd');
  const update = extractBlock(
    appSource,
    /\bupdateSelectedVideoSettings\s*\([^)]*\)\s*\{/,
    'EditorManager.updateSelectedVideoSettings',
  );

  assert.match(sync, /mediaMetadataFromNode\s*\(/, '选择或恢复媒体时必须读取草稿视频元数据');
  assert.match(sync, /panel\.hidden\s*=\s*!metadata/, '切换到普通图片或无视频状态时必须隐藏视频设置');
  assert.match(sync, /_prepareVideoTimeline\s*\(/, '媒体切换后必须主动刷新可视化时间轴');
  assert.match(sync, /applyMediaMetadataToImage\s*\([\s\S]*?saveDraft\s*\(/, '旧草稿的越界时间必须修复并保存');
  assert.match(normalizeContent, /applyMediaMetadataToImage\s*\(/, '恢复草稿时必须保留并规范化视频元数据');

  assert.match(deselect, /videoSettings[\s\S]*?hidden\s*=\s*true/, '取消选择时必须隐藏视频设置');
  assert.match(deselect, /_cleanupVideoTimeline\s*\(/, '切换到普通图片或无媒体时必须清理上一条时间轴');
  assert.match(cleanup, /timelineSession\s*\+=\s*1/, '媒体切换必须让旧异步读取任务失效');
  assert.match(cleanup, /URL\.revokeObjectURL\s*\(/, '媒体切换必须释放上一条视频 Object URL');
  assert.match(prepare, /accountId[\s\S]*?draftId[\s\S]*?metadata\.id/, '异步时间轴必须绑定本机分区、草稿和媒体 ID');
  assert.match(prepare, /session\s*!==\s*this\.timelineSession/, '异步读取完成前必须校验当前媒体会话');

  assert.doesNotMatch(pointerMove, /updatePreview\s*\(/, '拖动过程不能反复重排并保存整篇草稿');
  assert.match(pointerMove, /_renderTimelineSelection\s*\(/, '拖动过程应即时更新可视选区');
  assert.match(pointerEnd, /_commitTimelineSelection\s*\(/, '松开手柄后必须提交一次选区');
  assert.match(update, /applyMediaMetadataToImage\s*\(/, '数字输入和时长切换必须回写草稿媒体元数据');
});

test('时间轴模块和主程序使用同一缓存版本', () => {
  const timelineVersion = htmlSource.match(/video-timeline\.js\?v=([^"']+)/)?.[1];
  const appVersion = htmlSource.match(/app\.js\?v=([^"']+)/)?.[1];
  const dynamicTimelineVersion = appSource.match(/CARD_VIDEO_TIMELINE_URL\s*=\s*['"]\.\/video-timeline\.js\?v=([^"']+)/)?.[1];
  assert.ok(timelineVersion, '时间轴模块必须带缓存版本');
  assert.equal(timelineVersion, appVersion, '时间轴模块和主程序缓存版本必须保持一致');
  assert.equal(dynamicTimelineVersion, appVersion, '动态加载的时间轴模块也必须使用当前缓存版本');
});

test('导出前暂停时间轴预览，避免与编码器争用解码资源', () => {
  const appExport = extractBlock(
    appSource,
    /\basync\s+exportImage\s*\(\s*\)\s*\{/,
    'ArticleCardApp.exportImage',
  );
  assert.match(appExport, /mediaTimelineVideo[\s\S]*?\.pause\s*\(/);
});

test('浏览器预览时长只用于显示，不能覆盖草稿的原始 sourceDuration', () => {
  const prepare = extractBlock(
    appSource,
    /\basync\s+_prepareVideoTimeline\s*\([^)]*\)\s*\{/,
    'EditorManager._prepareVideoTimeline',
  );
  assert.doesNotMatch(
    prepare,
    /timelineSourceDuration\s*!==\s*metadata\.sourceDuration/,
    '浏览器报告的解码时长差异不能触发草稿写回',
  );
  assert.doesNotMatch(
    prepare,
    /applyMediaMetadataToImage\s*\(\s*img\s*,\s*\{[\s\S]{0,320}?sourceDuration\s*:/,
    '预览修复起止时间时不能重写原始素材时长',
  );
});

test('时间轴加载失败会释放临时 URL，并清空命中条件以允许重试', () => {
  const prepare = extractBlock(
    appSource,
    /\basync\s+_prepareVideoTimeline\s*\([^)]*\)\s*\{/,
    'EditorManager._prepareVideoTimeline',
  );
  const catchIndex = prepare.lastIndexOf('catch (error)');
  assert.ok(catchIndex >= 0, '时间轴准备流程必须处理加载失败');
  const failurePath = prepare.slice(catchIndex);
  assert.match(
    failurePath,
    /(?:URL\.revokeObjectURL|_cleanupVideoTimeline|_resetTimelineFailure|_releaseTimelineObjectURL)\s*\(/,
    '加载失败必须释放 Object URL',
  );
  assert.match(
    failurePath,
    /timelineMediaKey\s*=\s*['"]['"]|_cleanupVideoTimeline|_resetTimelineFailure/,
    '加载失败必须清空媒体命中键，下一次点击才能重新读取',
  );
  assert.match(
    failurePath,
    /timelineObjectURL\s*=\s*['"]['"]|_cleanupVideoTimeline|_resetTimelineFailure|_releaseTimelineObjectURL/,
    '加载失败后不能继续保留失效 URL',
  );
});

test('移动端时间轴允许纵向滚动页面', () => {
  for (const selector of ['.media-timeline-track', '.media-timeline-selection']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(styleSource);
    assert.ok(match, `找不到 ${selector} 样式`);
    assert.match(match[1], /touch-action\s*:\s*pan-y\b/, `${selector} 不能阻断页面纵向滚动`);
  }
});

test('25 秒视频的 3 秒选区只有一个拖动命中区，抓取时按偏移平移而不跳动', () => {
  const selectionTag = htmlSource.match(/<[^>]+id=["']mediaTimelineSelection["'][^>]*>/i)?.[0] || '';
  assert.match(selectionTag, /role=["']slider["']/i, '固定时长选区应使用一个滑块语义');
  assert.match(selectionTag, /tabindex=["']0["']/i, '唯一滑块必须可用键盘操作');
  assert.match(selectionTag, /data-timeline-handle=["']move["']/i, '选区本身必须是唯一拖动命中区');
  assert.doesNotMatch(
    htmlSource,
    /<button[^>]+data-timeline-handle=["'](?:start|end)["']/i,
    '3 秒短选区不能再叠放两个 44px 可点击手柄',
  );

  const handleStyle = /\.media-timeline-handle\s*\{([^}]*)\}/.exec(styleSource)?.[1] || '';
  assert.match(handleStyle, /pointer-events\s*:\s*none\b/, '两端黄色抓手只能作为视觉标记');
  const selectionVisual = /\.media-timeline-selection::before\s*\{([^}]*)\}/.exec(styleSource)?.[1] || '';
  assert.match(
    selectionVisual,
    /inset\s*:\s*0\s+var\(--timeline-hit-right\)\s+0\s+var\(--timeline-hit-left\)/,
    '扩大命中区后，黄色窗口仍须按动态抓取边距绘制真实起止位置',
  );

  const render = extractBlock(
    appSource,
    /\b_renderTimelineSelection\s*\([^)]*\)\s*\{/,
    'EditorManager._renderTimelineSelection',
  );
  assert.match(render, /visualWidth\s*=\s*trackWidth\s*\*\s*\(endRatio\s*-\s*startRatio\)/, '命中区必须先计算 25 秒/3 秒的真实可视宽度');
  assert.match(render, /Math\.max\s*\(\s*16\s*,\s*44\s*-\s*visualWidth\s*\)/, '短选区命中区必须补足至少 44px');
  assert.match(render, /--timeline-hit-left/, '选区左侧扩展必须写入绘制契约');
  assert.match(render, /--timeline-hit-right/, '选区右侧扩展必须写入绘制契约');
  assert.match(render, /startPercent[\s\S]*?-\s*\$\{hitLeft\}px/, '命中区左侧必须按可用空间扩展');
  assert.match(render, /endPercent\s*-\s*startPercent[\s\S]*?hitLeft\s*\+\s*hitRight/, '命中区宽度必须包含两侧扩展');

  const pointerDown = extractBlock(
    appSource,
    /\b_onTimelinePointerDown\s*\([^)]*\)\s*\{/,
    'EditorManager._onTimelinePointerDown',
  );
  const selectionForPointer = extractBlock(
    appSource,
    /\b_selectionForTimelinePointer\s*\([^)]*\)\s*\{/,
    'EditorManager._selectionForTimelinePointer',
  );
  assert.match(pointerDown, /startRatio\s*:\s*ratio/, '按下时必须记住抓取点在 25 秒时间轴上的位置');
  assert.match(pointerDown, /initial\s*:\s*\{\s*\.\.\.this\.timelineSelection\s*\}/, '按下时必须记住原 3 秒选区');
  assert.match(selectionForPointer, /ratio\s*-\s*this\.timelineDrag\.startRatio/, '拖动位移必须减去抓取偏移，不能瞬移');
  assert.match(selectionForPointer, /initial\.startSeconds\s*\+\s*delta/, '3 秒窗口应整体平移，不改变时长');
});
