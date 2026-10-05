const TIMELINE_STEP_SECONDS = 0.1;
const DEFAULT_MIN_DURATION_SECONDS = 3;
const DEFAULT_MAX_DURATION_SECONDS = 5;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTimelineSeconds(value) {
  return Number((Math.round(finiteNumber(value) / TIMELINE_STEP_SECONDS) * TIMELINE_STEP_SECONDS).toFixed(1));
}

function floorTimelineSeconds(value) {
  return Number((Math.floor(Math.max(0, finiteNumber(value)) / TIMELINE_STEP_SECONDS) * TIMELINE_STEP_SECONDS).toFixed(1));
}

function timelineSourceSeconds(value) {
  const source = Math.max(0, finiteNumber(value));
  // 浏览器解码得到的 duration 常会比容器标称值短几毫秒。
  // 5 秒阈值保留 0.05 秒容差，与正式导出引擎的边界一致。
  if (source < DEFAULT_MAX_DURATION_SECONDS
    && source + 0.05 >= DEFAULT_MAX_DURATION_SECONDS) return DEFAULT_MAX_DURATION_SECONDS;
  return floorTimelineSeconds(source);
}

/**
 * 把旧草稿、数字输入与拖拽结果统一到可导出的时间范围。
 * 3 秒与 5 秒仍是快捷预设；不足 5 秒的旧素材会安全降级为 3 秒。
 */
export function clampTimelineSelection({
  sourceDuration,
  startSeconds = 0,
  durationSeconds = DEFAULT_MAX_DURATION_SECONDS,
  minDurationSeconds = DEFAULT_MIN_DURATION_SECONDS,
  maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
} = {}) {
  // 选区只能精确到 0.1 秒，源时长向下取整，避免最后一帧越过真实结尾。
  const source = timelineSourceSeconds(sourceDuration);
  const requestedMin = Math.max(TIMELINE_STEP_SECONDS, roundTimelineSeconds(minDurationSeconds));
  const requestedMax = Math.max(requestedMin, roundTimelineSeconds(maxDurationSeconds));
  if (source < requestedMin) {
    throw new RangeError(`源视频不足 ${formatTime(requestedMin)}，无法选择有效片段`);
  }

  const requestedDuration = roundTimelineSeconds(durationSeconds);
  // Live Photo 的 3/5 秒分别对应既有平台包与文件命名，不能产生 4.x 秒中间态。
  // 不足 5 秒的旧素材自动回到 3 秒，避免留下导出时才失败的选项。
  const normalizedDuration = requestedDuration === requestedMin || source < requestedMax
    ? requestedMin
    : requestedMax;
  const maxStart = roundTimelineSeconds(Math.max(0, source - normalizedDuration));
  const start = roundTimelineSeconds(clamp(finiteNumber(startSeconds), 0, maxStart));

  return Object.freeze({
    startSeconds: start,
    endSeconds: roundTimelineSeconds(start + normalizedDuration),
    durationSeconds: normalizedDuration,
    maxStart,
  });
}

/**
 * 根据手柄在时间轴中的相对位置（0~1）调整选区。
 * 左右手柄都用于移动固定宽度的 3/5 秒选区：左边确定开始，右边确定结束。
 */
export function selectionFromHandlePosition({
  sourceDuration,
  startSeconds = 0,
  durationSeconds = DEFAULT_MAX_DURATION_SECONDS,
  handle,
  positionRatio = 0,
  minDurationSeconds = DEFAULT_MIN_DURATION_SECONDS,
  maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
} = {}) {
  const current = clampTimelineSelection({
    sourceDuration,
    startSeconds,
    durationSeconds,
    minDurationSeconds,
    maxDurationSeconds,
  });
  const source = timelineSourceSeconds(sourceDuration);
  const pointerSeconds = roundTimelineSeconds(clamp(finiteNumber(positionRatio), 0, 1) * source);

  if (handle === 'start') {
    return clampTimelineSelection({
      sourceDuration: source,
      startSeconds: pointerSeconds,
      durationSeconds: current.durationSeconds,
      minDurationSeconds,
      maxDurationSeconds,
    });
  }

  if (handle === 'end') {
    return clampTimelineSelection({
      sourceDuration: source,
      startSeconds: pointerSeconds - current.durationSeconds,
      durationSeconds: current.durationSeconds,
      minDurationSeconds,
      maxDurationSeconds,
    });
  }

  throw new TypeError('handle 必须是 start 或 end');
}

export function formatTime(seconds) {
  const value = Math.max(0, roundTimelineSeconds(seconds));
  const minutes = Math.floor(value / 60);
  const remainder = (value - minutes * 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${remainder}`;
}

const ChengYiVideoTimeline = Object.freeze({
  clampTimelineSelection,
  selectionFromHandlePosition,
  formatTime,
  constants: Object.freeze({
    stepSeconds: TIMELINE_STEP_SECONDS,
    minDurationSeconds: DEFAULT_MIN_DURATION_SECONDS,
    maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
  }),
});

if (typeof window !== 'undefined') window.ChengYiVideoTimeline = ChengYiVideoTimeline;

export default ChengYiVideoTimeline;
