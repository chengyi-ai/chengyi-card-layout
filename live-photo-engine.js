/**
 * ChengYi browser-side Live Photo engine.
 *
 * The Apple JPG/MOV pairing and .pvt packaging approach is adapted from
 * fxyadela/write-then-publish (MIT). See THIRD_PARTY_NOTICES.md.
 *
 * This module intentionally does not load its runtime dependencies. Callers
 * must provide MP4Box, DataStream, Mp4Muxer and JSZip (or expose them on the
 * browser global). Missing capabilities always produce an explicit error.
 */

const DEFAULT_OUTPUT_WIDTH = 1080;
const DEFAULT_OUTPUT_HEIGHT = 1440;
const DEFAULT_OUTPUT_FPS = 30;
const DEFAULT_VIDEO_BITRATE = 6_000_000;
const DEFAULT_CLIP_RADIUS = 26;
const VIDEO_BATCH_SIZE = 120;
const AUDIO_BATCH_SIZE = 400;
const LEVEL_4_CODEC_CANDIDATES = ["avc1.4d0028", "avc1.640028", "avc1.42e01e"];
const LEVEL_5_CODEC_CANDIDATES = ["avc1.640032", "avc1.4d0032", "avc1.420032"];
const H264_LEVEL_4_MAX_FRAME_MACROBLOCKS = 8192;
const H264_LEVEL_4_MAX_MACROBLOCKS_PER_SECOND = 245_760;
const QUICKTIME_CONTENT_IDENTIFIER = "com.apple.quicktime.content.identifier";
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const CHUNK_OFFSET_CONTAINER_TYPES = new Set(["trak", "mdia", "minf", "stbl"]);
const PVT_METADATA_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PFVideoComplementMetadataVersionKey</key>
  <string>1</string>
</dict>
</plist>
`;

class LivePhotoEngineError extends Error {
  constructor(message, code = "LIVE_PHOTO_ERROR", details = null) {
    super(message);
    this.name = "LivePhotoEngineError";
    this.code = code;
    this.details = details;
  }
}

function runtimeValue(runtime, dependencies, name) {
  return dependencies?.[name] ?? runtime?.[name];
}

function checkCapability(runtime = globalThis, dependencies = {}) {
  const VideoEncoder = runtimeValue(runtime, dependencies, "VideoEncoder");
  const OffscreenCanvas = runtimeValue(runtime, dependencies, "OffscreenCanvas");
  const Mp4Muxer = runtimeValue(runtime, dependencies, "Mp4Muxer");
  const JSZip = runtimeValue(runtime, dependencies, "JSZip");
  const checks = [
    ["VideoEncoder", typeof VideoEncoder === "function" && typeof VideoEncoder.isConfigSupported === "function"],
    ["VideoDecoder", typeof runtimeValue(runtime, dependencies, "VideoDecoder") === "function"],
    ["VideoFrame", typeof runtimeValue(runtime, dependencies, "VideoFrame") === "function"],
    ["EncodedVideoChunk", typeof runtimeValue(runtime, dependencies, "EncodedVideoChunk") === "function"],
    ["OffscreenCanvas", typeof OffscreenCanvas === "function" && typeof OffscreenCanvas.prototype?.convertToBlob === "function"],
    ["createImageBitmap", typeof runtimeValue(runtime, dependencies, "createImageBitmap") === "function"],
    ["MP4Box", typeof runtimeValue(runtime, dependencies, "MP4Box")?.createFile === "function"],
    ["DataStream", typeof runtimeValue(runtime, dependencies, "DataStream") === "function"],
    ["Mp4Muxer", typeof Mp4Muxer?.Muxer === "function" && typeof Mp4Muxer?.ArrayBufferTarget === "function"],
    ["JSZip", typeof JSZip === "function" && typeof JSZip.loadAsync === "function"],
  ];
  const missing = checks.filter(([, available]) => !available).map(([name]) => name);
  return {
    supported: missing.length === 0,
    missing,
    message: missing.length
      ? `当前环境不能生成 Live Photo，缺少：${missing.join("、")}。`
      : "当前环境支持浏览器本地生成 Live Photo。",
  };
}

function assertCapability(runtime = globalThis, dependencies = {}) {
  const result = checkCapability(runtime, dependencies);
  if (!result.supported) {
    throw new LivePhotoEngineError(result.message, "LIVE_PHOTO_UNSUPPORTED", { missing: result.missing });
  }
  return result;
}

function asUint8Array(value, label = "二进制数据") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new LivePhotoEngineError(`${label}格式无效。`, "INVALID_BINARY");
}

function copyBytes(value, label) {
  return asUint8Array(value, label).slice();
}

function concatBytes(parts) {
  const normalized = parts.map((part) => asUint8Array(part));
  const total = normalized.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

const utf8 = (value) => new TextEncoder().encode(String(value));

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function boxHeader(type, payloadLength) {
  if (!/^[\x20-\x7e]{4}$/.test(type)) {
    throw new LivePhotoEngineError(`MOV box 类型无效：${type}`, "INVALID_MOV_BOX");
  }
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, payloadLength + 8);
  for (let index = 0; index < 4; index += 1) header[index + 4] = type.charCodeAt(index);
  return header;
}

function makeBox(type, payload) {
  const body = asUint8Array(payload);
  return concatBytes([boxHeader(type, body.byteLength), body]);
}

function normalizedContentIdentifier(value, runtime = globalThis) {
  const generated = value || runtime?.crypto?.randomUUID?.();
  const identifier = String(generated || "").trim().toUpperCase();
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(identifier)) {
    throw new LivePhotoEngineError("Live Photo 配对 UUID 无效。", "INVALID_CONTENT_IDENTIFIER");
  }
  return identifier;
}

function buildQuickTimeMetadataBox(contentIdentifier) {
  const identifier = normalizedContentIdentifier(contentIdentifier);
  const keyBytes = utf8(QUICKTIME_CONTENT_IDENTIFIER);
  const handler = makeBox("hdlr", concatBytes([
    new Uint8Array(8),
    utf8("mdta"),
    new Uint8Array(13),
  ]));
  const keyEntry = concatBytes([uint32(keyBytes.byteLength + 8), utf8("mdta"), keyBytes]);
  const keys = makeBox("keys", concatBytes([new Uint8Array(4), uint32(1), keyEntry]));
  const valueBytes = utf8(identifier);
  const data = makeBox("data", concatBytes([uint32(1), new Uint8Array(4), valueBytes]));
  const item = concatBytes([uint32(data.byteLength + 8), uint32(1), data]);
  const itemList = makeBox("ilst", item);

  // QuickTime's metadata atom here is not a FullBox. Adding version/flags makes
  // ffprobe happy but can make AVFoundation ignore the Live Photo identifier.
  return makeBox("meta", concatBytes([handler, keys, itemList]));
}

function movBoxType(bytes, offset) {
  return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

function readMovBox(bytes, view, offset, parentEnd, context = "MOV") {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(parentEnd) || offset < 0 || parentEnd > bytes.byteLength) {
    throw new LivePhotoEngineError(`${context} box 范围无效。`, "INVALID_MOV_STRUCTURE");
  }
  if (offset + 8 > parentEnd) {
    throw new LivePhotoEngineError(`${context} box 头不完整。`, "INVALID_MOV_STRUCTURE");
  }

  const size32 = view.getUint32(offset);
  const type = movBoxType(bytes, offset);
  let headerSize = 8;
  let size;
  let usesLargeSize = false;

  if (size32 === 1) {
    if (offset + 16 > parentEnd) {
      throw new LivePhotoEngineError(`${context} 的 ${type} 64 位 box 头不完整。`, "INVALID_MOV_STRUCTURE");
    }
    const largeSize = view.getBigUint64(offset + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LivePhotoEngineError(`${context} 的 ${type} box 大小超出浏览器可安全处理范围。`, "MOV_BOX_SIZE_UNSAFE");
    }
    size = Number(largeSize);
    headerSize = 16;
    usesLargeSize = true;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  } else {
    size = size32;
  }

  if (type === "uuid") headerSize += 16;
  if (size < headerSize || offset + size > parentEnd) {
    throw new LivePhotoEngineError(`${context} 的 ${type} box 结构损坏。`, "INVALID_MOV_STRUCTURE");
  }

  return {
    offset,
    type,
    size,
    size32,
    usesLargeSize,
    headerSize,
    payloadStart: offset + headerSize,
    end: offset + size,
  };
}

function patchStcoBox(view, box, insertionPoint, insertedByteLength) {
  const tableStart = box.payloadStart;
  if (tableStart + 8 > box.end) {
    throw new LivePhotoEngineError("MOV stco 样本偏移表不完整。", "INVALID_MOV_CHUNK_OFFSET_TABLE");
  }
  const entryCount = view.getUint32(tableStart + 4);
  const entriesStart = tableStart + 8;
  const expectedEnd = entriesStart + entryCount * 4;
  if (!Number.isSafeInteger(expectedEnd) || expectedEnd !== box.end) {
    throw new LivePhotoEngineError("MOV stco 样本偏移表长度与条目数不匹配。", "INVALID_MOV_CHUNK_OFFSET_TABLE");
  }

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesStart + index * 4;
    const chunkOffset = view.getUint32(entryOffset);
    if (chunkOffset < insertionPoint) continue;
    const patchedOffset = chunkOffset + insertedByteLength;
    if (!Number.isSafeInteger(patchedOffset) || patchedOffset > MAX_UINT32) {
      throw new LivePhotoEngineError(
        "MOV stco 偏移加上 Live Photo 元数据后超出 32 位上限。",
        "MOV_STCO_OVERFLOW",
        { entryIndex: index, chunkOffset, insertedByteLength },
      );
    }
    view.setUint32(entryOffset, patchedOffset);
  }
}

function patchCo64Box(view, box, insertionPoint, insertedByteLength) {
  const tableStart = box.payloadStart;
  if (tableStart + 8 > box.end) {
    throw new LivePhotoEngineError("MOV co64 样本偏移表不完整。", "INVALID_MOV_CHUNK_OFFSET_TABLE");
  }
  const entryCount = view.getUint32(tableStart + 4);
  const entriesStart = tableStart + 8;
  const expectedEnd = entriesStart + entryCount * 8;
  if (!Number.isSafeInteger(expectedEnd) || expectedEnd !== box.end) {
    throw new LivePhotoEngineError("MOV co64 样本偏移表长度与条目数不匹配。", "INVALID_MOV_CHUNK_OFFSET_TABLE");
  }

  const insertionPoint64 = BigInt(insertionPoint);
  const insertedByteLength64 = BigInt(insertedByteLength);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesStart + index * 8;
    const chunkOffset = view.getBigUint64(entryOffset);
    if (chunkOffset < insertionPoint64) continue;
    const patchedOffset = chunkOffset + insertedByteLength64;
    if (patchedOffset > MAX_UINT64) {
      throw new LivePhotoEngineError(
        "MOV co64 偏移加上 Live Photo 元数据后超出 64 位上限。",
        "MOV_CO64_OVERFLOW",
        { entryIndex: index, chunkOffset: chunkOffset.toString(), insertedByteLength },
      );
    }
    view.setBigUint64(entryOffset, patchedOffset);
  }
}

function patchChunkOffsetsInRange(bytes, view, start, end, insertionPoint, insertedByteLength, context) {
  let offset = start;
  while (offset < end) {
    const box = readMovBox(bytes, view, offset, end, context);
    if (box.type === "stco") {
      patchStcoBox(view, box, insertionPoint, insertedByteLength);
    } else if (box.type === "co64") {
      patchCo64Box(view, box, insertionPoint, insertedByteLength);
    } else if (CHUNK_OFFSET_CONTAINER_TYPES.has(box.type)) {
      patchChunkOffsetsInRange(
        bytes,
        view,
        box.payloadStart,
        box.end,
        insertionPoint,
        insertedByteLength,
        `${context}/${box.type}`,
      );
    }
    offset = box.end;
  }
  if (offset !== end) {
    throw new LivePhotoEngineError(`${context} 子 box 边界无效。`, "INVALID_MOV_STRUCTURE");
  }
}

function patchMoovChunkOffsets(movie, moov, insertionPoint, insertedByteLength) {
  const view = new DataView(movie.buffer, movie.byteOffset, movie.byteLength);
  patchChunkOffsetsInRange(
    movie,
    view,
    moov.payloadStart,
    moov.end,
    insertionPoint,
    insertedByteLength,
    "moov",
  );
}

function writeExpandedMoovSize(bytes, moov, insertedByteLength) {
  if (moov.size32 === 0) return;
  const expandedSize = BigInt(moov.size) + BigInt(insertedByteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (moov.usesLargeSize) {
    if (expandedSize > MAX_UINT64) {
      throw new LivePhotoEngineError("MOV moov box 大小超出 64 位上限。", "MOV_BOX_SIZE_OVERFLOW");
    }
    view.setBigUint64(moov.offset + 8, expandedSize);
    return;
  }
  if (expandedSize > BigInt(MAX_UINT32)) {
    throw new LivePhotoEngineError("MOV moov box 大小超出 32 位上限。", "MOV_BOX_SIZE_OVERFLOW");
  }
  view.setUint32(moov.offset, Number(expandedSize));
}

function injectQuickTimeContentIdentifier(movieValue, contentIdentifier) {
  const movie = copyBytes(movieValue, "MOV 数据");
  const metadata = buildQuickTimeMetadataBox(contentIdentifier);
  const view = new DataView(movie.buffer, movie.byteOffset, movie.byteLength);
  let offset = 0;

  while (offset < movie.byteLength) {
    const topLevelBox = readMovBox(movie, view, offset, movie.byteLength, "MOV 顶层");
    if (topLevelBox.type === "moov") {
      const insertionPoint = topLevelBox.end;
      patchMoovChunkOffsets(movie, topLevelBox, insertionPoint, metadata.byteLength);
      const patched = concatBytes([
        movie.subarray(0, insertionPoint),
        metadata,
        movie.subarray(insertionPoint),
      ]);
      writeExpandedMoovSize(patched, topLevelBox, metadata.byteLength);
      return patched;
    }
    offset = topLevelBox.end;
  }
  throw new LivePhotoEngineError("MOV 中没有找到 moov，无法写入 Live Photo 配对信息。", "MOV_MOOV_MISSING");
}

function buildAppleMakerNote(contentIdentifier) {
  const identifier = normalizedContentIdentifier(contentIdentifier);
  const value = concatBytes([utf8(identifier), new Uint8Array(1)]);
  const header = new Uint8Array(32);
  const view = new DataView(header.buffer);
  header.set(utf8("Apple iOS\0"), 0);
  view.setUint16(10, 1);
  header.set(utf8("MM"), 12);
  view.setUint16(14, 1);
  view.setUint16(16, 0x0011);
  view.setUint16(18, 2);
  view.setUint32(20, value.byteLength);
  view.setUint32(24, 32);
  view.setUint32(28, 0);
  return concatBytes([header, value]);
}

function buildExifApp1(contentIdentifier) {
  const makerNote = buildAppleMakerNote(contentIdentifier);
  const tiff = concatBytes([utf8("MM"), new Uint8Array([0, 0x2a]), uint32(8)]);

  const ifd0 = new Uint8Array(18);
  const ifd0View = new DataView(ifd0.buffer);
  ifd0View.setUint16(0, 1);
  ifd0View.setUint16(2, 0x8769);
  ifd0View.setUint16(4, 4);
  ifd0View.setUint32(6, 1);
  ifd0View.setUint32(10, 26);
  ifd0View.setUint32(14, 0);

  const exifIfd = new Uint8Array(18);
  const exifView = new DataView(exifIfd.buffer);
  exifView.setUint16(0, 1);
  exifView.setUint16(2, 0x927c);
  exifView.setUint16(4, 7);
  exifView.setUint32(6, makerNote.byteLength);
  exifView.setUint32(10, 26 + exifIfd.byteLength);
  exifView.setUint32(14, 0);

  const body = concatBytes([tiff, ifd0, exifIfd, makerNote]);
  const segmentLength = body.byteLength + 8;
  if (segmentLength > 0xffff) {
    throw new LivePhotoEngineError("EXIF 配对信息超过 JPEG APP1 上限。", "EXIF_TOO_LARGE");
  }
  const header = new Uint8Array(4);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 0xffe1);
  headerView.setUint16(2, segmentLength);
  return concatBytes([header, utf8("Exif\0\0"), body]);
}

function injectJpegContentIdentifier(jpegValue, contentIdentifier) {
  const jpeg = copyBytes(jpegValue, "JPEG 数据");
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new LivePhotoEngineError("封面不是有效 JPEG。", "INVALID_JPEG");
  }
  const app1 = buildExifApp1(contentIdentifier);
  const view = new DataView(jpeg.buffer);
  let offset = 2;
  while (offset + 4 <= jpeg.byteLength) {
    const marker = view.getUint16(offset);
    if (marker !== 0xffe0 && marker !== 0xffe1) break;
    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > jpeg.byteLength) {
      throw new LivePhotoEngineError("JPEG APP 段结构损坏。", "INVALID_JPEG_SEGMENT");
    }
    offset += 2 + segmentLength;
  }
  return concatBytes([jpeg.subarray(0, offset), app1, jpeg.subarray(offset)]);
}

function byteSequenceIndex(haystackValue, needleValue) {
  const haystack = asUint8Array(haystackValue);
  const needle = asUint8Array(needleValue);
  if (!needle.byteLength) return 0;
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function verifyPairedMetadata(movieValue, jpegValue, contentIdentifier) {
  const identifier = normalizedContentIdentifier(contentIdentifier);
  const movie = asUint8Array(movieValue);
  const jpeg = asUint8Array(jpegValue);
  const keyPosition = byteSequenceIndex(movie, utf8(QUICKTIME_CONTENT_IDENTIFIER));
  const movieIdPosition = byteSequenceIndex(movie, utf8(identifier));
  const makerNotePosition = byteSequenceIndex(jpeg, utf8("Apple iOS\0"));
  const jpegIdPosition = byteSequenceIndex(jpeg, utf8(identifier));
  const makerTagPosition = byteSequenceIndex(jpeg, new Uint8Array([0x00, 0x11, 0x00, 0x02]));
  const valid = [keyPosition, movieIdPosition, makerNotePosition, jpegIdPosition, makerTagPosition]
    .every((position) => position >= 0);
  if (!valid) {
    throw new LivePhotoEngineError("JPG 与 MOV 的 Live Photo 配对信息不完整。", "PAIR_METADATA_INVALID", {
      keyPosition,
      movieIdPosition,
      makerNotePosition,
      jpegIdPosition,
      makerTagPosition,
    });
  }
  return { valid: true, contentIdentifier: identifier };
}

function safeStem(value, fallback = "live-photo") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[^\w\u3400-\u9fff-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned.slice(0, 48) || fallback;
}

function buildPvtParts({ stem, movieBytes, photoBytes }) {
  const safe = safeStem(stem);
  return [
    { path: `${safe}.pvt/${safe}.MOV`, bytes: copyBytes(movieBytes, "MOV 数据") },
    { path: `${safe}.pvt/${safe}.JPG`, bytes: copyBytes(photoBytes, "JPEG 数据") },
    { path: `${safe}.pvt/metadata.plist`, bytes: utf8(PVT_METADATA_PLIST) },
  ];
}

function findPart(parts, suffix) {
  return parts.find((part) => String(part.path || "").endsWith(suffix));
}

function verifyPvtParts(parts, { stem, contentIdentifier }) {
  const safe = safeStem(stem);
  if (!Array.isArray(parts)) {
    throw new LivePhotoEngineError("PVT 文件清单无效。", "PVT_PARTS_INVALID");
  }
  const required = [
    `${safe}.pvt/${safe}.MOV`,
    `${safe}.pvt/${safe}.JPG`,
    `${safe}.pvt/metadata.plist`,
  ];
  const names = parts.map((part) => part.path);
  for (const path of required) {
    if (!names.includes(path)) {
      throw new LivePhotoEngineError(`PVT 缺少文件：${path}`, "PVT_FILE_MISSING", { path });
    }
  }
  const movie = findPart(parts, ".MOV");
  const photo = findPart(parts, ".JPG");
  const plist = findPart(parts, "metadata.plist");
  verifyPairedMetadata(movie.bytes, photo.bytes, contentIdentifier);
  const plistText = new TextDecoder().decode(asUint8Array(plist.bytes));
  if (!plistText.includes("PFVideoComplementMetadataVersionKey") || !plistText.includes("<string>1</string>")) {
    throw new LivePhotoEngineError("PVT metadata.plist 内容无效。", "PVT_PLIST_INVALID");
  }
  return { valid: true, files: required, contentIdentifier: normalizedContentIdentifier(contentIdentifier) };
}

async function blobLikeToBytes(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return copyBytes(value);
  }
  if (value && typeof value.arrayBuffer === "function") {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new LivePhotoEngineError("ZIP 数据格式无效。", "INVALID_ZIP_BINARY");
}

async function verifyZipHeader(value) {
  const bytes = await blobLikeToBytes(value);
  const valid = bytes.byteLength >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && [0x03, 0x05, 0x07].includes(bytes[2]);
  if (!valid) throw new LivePhotoEngineError("生成结果不是有效 ZIP。", "ZIP_SIGNATURE_INVALID");
  return true;
}

async function verifyPvtArchive(archive, { JSZip, stem, contentIdentifier }) {
  await verifyZipHeader(archive);
  if (typeof JSZip?.loadAsync !== "function") {
    throw new LivePhotoEngineError("当前 JSZip 不支持回读校验，不能确认 PVT 完整性。", "ZIP_VERIFY_UNAVAILABLE");
  }
  let loaded;
  try {
    loaded = await JSZip.loadAsync(archive);
  } catch (error) {
    throw new LivePhotoEngineError("ZIP 无法重新打开，PVT 打包失败。", "ZIP_READ_FAILED", { cause: error });
  }
  const safe = safeStem(stem);
  const paths = [
    `${safe}.pvt/${safe}.MOV`,
    `${safe}.pvt/${safe}.JPG`,
    `${safe}.pvt/metadata.plist`,
  ];
  const parts = [];
  for (const path of paths) {
    const entry = loaded.file(path);
    if (!entry || typeof entry.async !== "function") {
      throw new LivePhotoEngineError(`ZIP 内缺少文件：${path}`, "ZIP_FILE_MISSING", { path });
    }
    parts.push({ path, bytes: await entry.async("uint8array") });
  }
  return verifyPvtParts(parts, { stem: safe, contentIdentifier });
}

async function packPvtBundle({ JSZip, stem, movieBytes, photoBytes, contentIdentifier, outputType = "blob" }) {
  if (typeof JSZip !== "function") {
    throw new LivePhotoEngineError("JSZip 未加载，无法生成 PVT。", "JSZIP_UNAVAILABLE");
  }
  const safe = safeStem(stem);
  const parts = buildPvtParts({ stem: safe, movieBytes, photoBytes });
  verifyPvtParts(parts, { stem: safe, contentIdentifier });
  const zip = new JSZip();
  for (const part of parts) zip.file(part.path, part.bytes, { binary: true });
  const archive = await zip.generateAsync({ type: outputType, compression: "STORE", mimeType: "application/zip" });
  await verifyPvtArchive(archive, { JSZip, stem: safe, contentIdentifier });
  return { archive, archiveName: `${safe}.zip`, stem: safe, parts };
}

function normalizeMediaRect(mediaRect, cardCanvas, outputWidth, outputHeight, rectSpace = "card") {
  if (!mediaRect || !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(mediaRect[key])))) {
    throw new LivePhotoEngineError("视频在卡片中的位置无效。", "INVALID_MEDIA_RECT");
  }
  const scaleX = rectSpace === "output" ? 1 : outputWidth / Number(cardCanvas?.width || 0);
  const scaleY = rectSpace === "output" ? 1 : outputHeight / Number(cardCanvas?.height || 0);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new LivePhotoEngineError("背景卡片尺寸无效。", "INVALID_CARD_CANVAS");
  }
  const x = Math.max(0, Math.round(Number(mediaRect.x) * scaleX));
  const y = Math.max(0, Math.round(Number(mediaRect.y) * scaleY));
  const width = Math.min(outputWidth - x, Math.round(Number(mediaRect.width) * scaleX));
  const height = Math.min(outputHeight - y, Math.round(Number(mediaRect.height) * scaleY));
  if (width < 2 || height < 2) {
    throw new LivePhotoEngineError("视频区域超出卡片或尺寸过小。", "INVALID_MEDIA_RECT");
  }
  return { x, y, width, height };
}

const TRACK_MATRIX_SCALE = 65_536;
const TRACK_MATRIX_PERSPECTIVE_SCALE = 1_073_741_824;
const TRACK_MATRIX_EPSILON = 1 / 1_000;

function parseTrackRotation(matrix) {
  if (matrix == null) return 0;
  if (typeof matrix.length !== "number" || matrix.length < 9) {
    throw new LivePhotoEngineError(
      "视频方向信息不完整，请先导出为标准 MP4 或 MOV 后重试。",
      "VIDEO_TRACK_MATRIX_UNSUPPORTED",
    );
  }
  const values = Array.from(matrix).slice(0, 9).map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new LivePhotoEngineError("视频方向信息无效。", "VIDEO_TRACK_MATRIX_UNSUPPORTED");
  }
  const basisScale = Math.max(...values.slice(0, 6).map(Math.abs)) > 2 ? TRACK_MATRIX_SCALE : 1;
  const perspectiveScale = Math.abs(values[8]) > 2 ? TRACK_MATRIX_PERSPECTIVE_SCALE : 1;
  const [a, b, u, c, d, v] = values.slice(0, 6).map((value, index) => (
    value / (index === 2 || index === 5 ? perspectiveScale : basisScale)
  ));
  const w = values[8] / perspectiveScale;
  const near = (actual, expected) => Math.abs(actual - expected) <= TRACK_MATRIX_EPSILON;
  const perspectiveIsFlat = near(u, 0) && near(v, 0) && near(w, 1);
  const rotations = [
    [0, [1, 0, 0, 1]],
    [90, [0, 1, -1, 0]],
    [180, [-1, 0, 0, -1]],
    [270, [0, -1, 1, 0]],
  ];
  const matched = rotations.find(([, expected]) => (
    perspectiveIsFlat && [a, b, c, d].every((value, index) => near(value, expected[index]))
  ));
  if (!matched) {
    throw new LivePhotoEngineError(
      "视频包含暂不支持的斜切、缩放或非正交旋转，请先导出为标准 0°/90°/180°/270° 的 MP4 或 MOV。",
      "VIDEO_TRACK_MATRIX_UNSUPPORTED",
      { matrix: values },
    );
  }
  return matched[0];
}

function orientedVideoDimensions(width, height, rotation) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (!(normalizedWidth > 0 && normalizedHeight > 0)) {
    throw new LivePhotoEngineError("视频尺寸无法读取。", "VIDEO_DIMENSIONS_MISSING");
  }
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new LivePhotoEngineError("视频旋转角度不受支持。", "VIDEO_TRACK_MATRIX_UNSUPPORTED");
  }
  return rotation === 90 || rotation === 270
    ? { width: normalizedHeight, height: normalizedWidth }
    : { width: normalizedWidth, height: normalizedHeight };
}

function orientedCanvasTransform(width, height, rotation) {
  if (rotation === 90) return [0, 1, -1, 0, height, 0];
  if (rotation === 180) return [-1, 0, 0, -1, width, height];
  if (rotation === 270) return [0, -1, 1, 0, 0, width];
  return [1, 0, 0, 1, 0, 0];
}

function sourceRect(videoWidth, videoHeight, crop, focusX, focusY, targetWidth, targetHeight) {
  if (crop) {
    const normalized = {
      x: Math.max(0, Math.min(1, Number(crop.x) || 0)),
      y: Math.max(0, Math.min(1, Number(crop.y) || 0)),
      width: Math.max(0.001, Math.min(1, Number(crop.width) || 1)),
      height: Math.max(0.001, Math.min(1, Number(crop.height) || 1)),
    };
    normalized.width = Math.min(normalized.width, 1 - normalized.x);
    normalized.height = Math.min(normalized.height, 1 - normalized.y);
    return {
      x: videoWidth * normalized.x,
      y: videoHeight * normalized.y,
      width: videoWidth * normalized.width,
      height: videoHeight * normalized.height,
    };
  }
  const scale = Math.max(targetWidth / videoWidth, targetHeight / videoHeight);
  const width = targetWidth / scale;
  const height = targetHeight / scale;
  const normalizedFocusX = Number.isFinite(Number(focusX)) ? Number(focusX) : 50;
  const normalizedFocusY = Number.isFinite(Number(focusY)) ? Number(focusY) : 50;
  return {
    x: (videoWidth - width) * (Math.max(0, Math.min(100, normalizedFocusX)) / 100),
    y: (videoHeight - height) * (Math.max(0, Math.min(100, normalizedFocusY)) / 100),
    width,
    height,
  };
}

function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, r);
    return;
  }
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
}

function sourceTimestampToTargetIndex(timestampMicros, startMicros, fps, frameTarget) {
  if (!(fps > 0) || !(frameTarget > 0)) return 0;
  return Math.min(
    frameTarget - 1,
    Math.max(0, Math.floor(((Number(timestampMicros) - Number(startMicros)) * fps) / 1_000_000)),
  );
}

function assertMp4Blob(videoBlob) {
  if (!videoBlob || typeof videoBlob.arrayBuffer !== "function") {
    throw new LivePhotoEngineError("没有可读取的视频 Blob。", "VIDEO_BLOB_REQUIRED");
  }
  if (/webm/i.test(String(videoBlob.type || ""))) {
    throw new LivePhotoEngineError("浏览器本地引擎暂不支持 WebM，请转换为 MP4 或 MOV。", "WEBM_UNSUPPORTED");
  }
}

function extractDecoderDescription(entry, DataStream) {
  for (const box of [entry?.avcC, entry?.hvcC, entry?.vpcC, entry?.av1C]) {
    if (!box) continue;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8).slice();
  }
  return null;
}

async function demuxSelectedWindow(videoBlob, startSeconds, endSeconds, runtime, dependencies, timeoutMs = 90_000) {
  assertMp4Blob(videoBlob);
  const MP4Box = runtimeValue(runtime, dependencies, "MP4Box");
  const DataStream = runtimeValue(runtime, dependencies, "DataStream");
  const buffer = await videoBlob.arrayBuffer();
  const file = MP4Box.createFile();
  const samples = [];
  const audioSamples = [];
  let videoTrack = null;
  let audioTrack = null;
  let videoDescription = null;
  let audioDescription = null;

  await new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let idleTimer = 0;
    let timeout = 0;
    const clear = () => {
      runtime.clearTimeout?.(idleTimer);
      runtime.clearTimeout?.(timeout);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { file.stop(); } catch { /* no-op */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clear();
      stop();
      resolve();
    };
    const fail = (message, code = "VIDEO_DEMUX_FAILED") => {
      if (settled) return;
      settled = true;
      clear();
      stop();
      reject(new LivePhotoEngineError(message, code));
    };
    const covered = (bucket) => bucket.length > 0
      && bucket[bucket.length - 1].cts / bucket[bucket.length - 1].timescale >= endSeconds;
    const markIdle = () => {
      runtime.clearTimeout?.(idleTimer);
      idleTimer = runtime.setTimeout?.(finish, 450);
    };

    file.onError = (error) => fail(`无法解析视频：${String(error || "未知错误")}`);
    file.onReady = (info) => {
      videoTrack = info.videoTracks?.[0] || null;
      if (!videoTrack) {
        fail("视频中没有可用画面轨道。", "VIDEO_TRACK_MISSING");
        return;
      }
      try {
        const videoEntries = file.getTrackById(videoTrack.id).mdia.minf.stbl.stsd.entries;
        videoDescription = videoEntries.map((entry) => extractDecoderDescription(entry, DataStream)).find(Boolean) || null;
      } catch {
        videoDescription = null;
      }
      audioTrack = info.audioTracks?.[0] || null;
      if (audioTrack) {
        try {
          const audioEntries = file.getTrackById(audioTrack.id).mdia.minf.stbl.stsd.entries;
          audioDescription = audioEntries
            .map((entry) => entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data)
            .find(Boolean) || null;
          if (audioDescription) audioDescription = new Uint8Array(audioDescription).slice();
        } catch {
          audioDescription = null;
        }
        file.setExtractionOptions(audioTrack.id, "audio", { nbSamples: AUDIO_BATCH_SIZE });
      }
      file.setExtractionOptions(videoTrack.id, "video", { nbSamples: VIDEO_BATCH_SIZE });
      file.start();
      markIdle();
    };
    file.onSamples = (_trackId, kind, chunk) => {
      const bucket = kind === "audio" ? audioSamples : samples;
      bucket.push(...chunk);
      if (covered(samples) && (!audioTrack || covered(audioSamples))) finish();
      else markIdle();
    };

    const source = buffer;
    source.fileStart = 0;
    file.appendBuffer(source);
    file.flush();
    timeout = runtime.setTimeout?.(
      () => (samples.length ? finish() : fail("视频画面读取超时。", "VIDEO_DEMUX_TIMEOUT")),
      timeoutMs,
    );
  });

  if (!samples.length || !videoTrack) {
    throw new LivePhotoEngineError("视频没有可用画面帧。", "VIDEO_SAMPLES_MISSING");
  }
  return { samples, videoTrack, videoDescription, audioSamples, audioTrack, audioDescription };
}

function codecCandidatesForSize(width, height, fps = DEFAULT_OUTPUT_FPS) {
  const normalizedWidth = Math.max(1, Math.ceil(Number(width) || 0));
  const normalizedHeight = Math.max(1, Math.ceil(Number(height) || 0));
  const normalizedFps = Math.max(1, Number(fps) || DEFAULT_OUTPUT_FPS);
  const frameMacroblocks = Math.ceil(normalizedWidth / 16) * Math.ceil(normalizedHeight / 16);
  const macroblocksPerSecond = frameMacroblocks * normalizedFps;
  const requiresLevel5 = frameMacroblocks > H264_LEVEL_4_MAX_FRAME_MACROBLOCKS
    || macroblocksPerSecond > H264_LEVEL_4_MAX_MACROBLOCKS_PER_SECOND;
  return requiresLevel5
    ? [...LEVEL_5_CODEC_CANDIDATES, ...LEVEL_4_CODEC_CANDIDATES]
    : [...LEVEL_4_CODEC_CANDIDATES, ...LEVEL_5_CODEC_CANDIDATES];
}

async function pickCodec(VideoEncoder, width, height, fps, bitrate) {
  for (const codec of codecCandidatesForSize(width, height, fps)) {
    try {
      const result = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate });
      if (result.supported) return codec;
    } catch {
      // Try the next AVC profile.
    }
  }
  throw new LivePhotoEngineError("当前浏览器没有可用的 H.264 WebCodecs 编码器。", "H264_ENCODER_UNSUPPORTED");
}

async function composeCardVideo(options, dependencies = {}) {
  const runtime = dependencies.runtime || globalThis;
  assertCapability(runtime, dependencies);
  const {
    videoBlob,
    cardCanvas,
    mediaRect,
    rectSpace = "card",
    crop = null,
    focusX = 50,
    focusY = 50,
    startSeconds = 0,
    durationSeconds = 5,
    coverOffsetSeconds = 0.2,
    keepSound = true,
    outputWidth = DEFAULT_OUTPUT_WIDTH,
    outputHeight = DEFAULT_OUTPUT_HEIGHT,
    fps = DEFAULT_OUTPUT_FPS,
    bitrate = DEFAULT_VIDEO_BITRATE,
    clipRadius = DEFAULT_CLIP_RADIUS,
    timeoutMs = 90_000,
    onProgress = null,
  } = options || {};

  assertMp4Blob(videoBlob);
  if (!cardCanvas || !Number(cardCanvas.width) || !Number(cardCanvas.height)) {
    throw new LivePhotoEngineError("缺少可绘制的背景卡片 Canvas。", "CARD_CANVAS_REQUIRED");
  }
  if (!(durationSeconds > 0 && durationSeconds <= 15)) {
    throw new LivePhotoEngineError("Live Photo 时长需要大于 0 且不超过 15 秒。", "INVALID_DURATION");
  }

  const VideoEncoder = runtimeValue(runtime, dependencies, "VideoEncoder");
  const VideoDecoder = runtimeValue(runtime, dependencies, "VideoDecoder");
  const VideoFrame = runtimeValue(runtime, dependencies, "VideoFrame");
  const EncodedVideoChunk = runtimeValue(runtime, dependencies, "EncodedVideoChunk");
  const EncodedAudioChunk = runtimeValue(runtime, dependencies, "EncodedAudioChunk");
  const OffscreenCanvas = runtimeValue(runtime, dependencies, "OffscreenCanvas");
  const createImageBitmap = runtimeValue(runtime, dependencies, "createImageBitmap").bind(runtime);
  const Mp4Muxer = runtimeValue(runtime, dependencies, "Mp4Muxer");

  const start = Math.max(0, Number(startSeconds) || 0);
  const end = start + Number(durationSeconds);
  onProgress?.({ stage: "demux", progress: 4, detail: "正在读取所选视频片段…" });
  const demuxed = await demuxSelectedWindow(videoBlob, start, end + 2 / fps, runtime, dependencies, timeoutMs);
  const availableDuration = demuxed.videoTrack.duration / demuxed.videoTrack.timescale;
  if (end > availableDuration + 0.05) {
    throw new LivePhotoEngineError("所选开始时间后的剩余视频不足。", "VIDEO_TOO_SHORT", {
      availableDuration,
      requestedEnd: end,
    });
  }

  const codec = await pickCodec(VideoEncoder, outputWidth, outputHeight, fps, bitrate);
  const well = normalizeMediaRect(mediaRect, cardCanvas, outputWidth, outputHeight, rectSpace);
  const sourceWidth = demuxed.videoTrack.video?.width || demuxed.videoTrack.track_width;
  const sourceHeight = demuxed.videoTrack.video?.height || demuxed.videoTrack.track_height;
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    throw new LivePhotoEngineError("视频尺寸无法读取。", "VIDEO_DIMENSIONS_MISSING");
  }
  const rotation = parseTrackRotation(demuxed.videoTrack.matrix);
  const oriented = orientedVideoDimensions(sourceWidth, sourceHeight, rotation);
  const source = sourceRect(oriented.width, oriented.height, crop, focusX, focusY, well.width, well.height);
  const frameTarget = Math.round(durationSeconds * fps);
  const coverFrameIndex = Math.max(0, Math.min(frameTarget - 1, Math.round(coverOffsetSeconds * fps)));
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new LivePhotoEngineError("无法创建视频合成画布。", "OFFSCREEN_CONTEXT_MISSING");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const cardBitmap = await createImageBitmap(cardCanvas);
  const frameCanvas = new OffscreenCanvas(oriented.width, oriented.height);
  const frameContext = frameCanvas.getContext("2d", { alpha: false });
  if (!frameContext) throw new LivePhotoEngineError("无法创建视频方向校正画布。", "OFFSCREEN_CONTEXT_MISSING");
  frameContext.imageSmoothingEnabled = true;
  frameContext.imageSmoothingQuality = "high";
  const frameTransform = orientedCanvasTransform(sourceWidth, sourceHeight, rotation);

  const sourceHasAudio = Boolean(demuxed.audioTrack && demuxed.audioSamples.length);
  const canCopyAudio = Boolean(
    keepSound
      && sourceHasAudio
      && typeof EncodedAudioChunk === "function"
      && demuxed.audioDescription
      && /mp4a/i.test(String(demuxed.audioTrack.codec || "")),
  );
  if (keepSound && sourceHasAudio && !canCopyAudio) {
    throw new LivePhotoEngineError(
      "当前浏览器或源视频不支持无损保留音轨；请关闭声音后重试，或换用含 AAC 音轨的 MP4。",
      "AUDIO_COPY_UNSUPPORTED",
      {
        codec: demuxed.audioTrack?.codec || null,
        encodedAudioChunkAvailable: typeof EncodedAudioChunk === "function",
        decoderDescriptionAvailable: Boolean(demuxed.audioDescription),
      },
    );
  }
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: "avc", width: outputWidth, height: outputHeight, frameRate: fps },
    ...(canCopyAudio ? {
      audio: {
        codec: "aac",
        numberOfChannels: demuxed.audioTrack.audio?.channel_count || 2,
        sampleRate: demuxed.audioTrack.audio?.sample_rate || 44_100,
      },
    } : {}),
    fastStart: false,
  });

  let encoderFailure = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderFailure = error; },
  });
  encoder.configure({ codec, width: outputWidth, height: outputHeight, framerate: fps, bitrate, latencyMode: "quality" });

  let decoderFailure = null;
  let frameCount = 0;
  let coverPromise = null;
  const startMicros = Math.round(start * 1_000_000);
  const frameDurationMicros = Math.round(1_000_000 / fps);

  // 手机视频经常是 24/30/60fps。不能简单“取前 N 帧”，否则 60fps
  // 素材会把 5 秒内容压成前 2.5 秒。这里把源时间戳映射到固定输出
  // 时间轴：高帧率会丢帧，低帧率会补帧，导出时长始终与用户选择一致。
  const encodeCurrentCanvas = () => {
    if (frameCount >= frameTarget) return;
    if (frameCount === coverFrameIndex) {
      coverPromise = canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    }
    const composed = new VideoFrame(canvas, {
      timestamp: frameCount * frameDurationMicros,
      duration: frameDurationMicros,
    });
    encoder.encode(composed, { keyFrame: frameCount % fps === 0 });
    composed.close();
    frameCount += 1;
    if (frameCount % Math.max(1, Math.floor(fps / 2)) === 0) {
      onProgress?.({ stage: "compose", progress: 10 + Math.round((frameCount / frameTarget) * 70), detail: "正在合成卡片与视频画面…" });
    }
  };
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (frameCount >= frameTarget || frame.timestamp < startMicros) return;
        const targetIndex = sourceTimestampToTargetIndex(frame.timestamp, startMicros, fps, frameTarget);
        // 多个源帧落在同一个 30fps 槽位时，只保留时间更靠后的那一帧。
        if (targetIndex < frameCount) return;
        frameContext.setTransform(1, 0, 0, 1, 0, 0);
        frameContext.clearRect(0, 0, oriented.width, oriented.height);
        frameContext.setTransform(...frameTransform);
        frameContext.drawImage(frame, 0, 0, sourceWidth, sourceHeight);
        frameContext.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(cardBitmap, 0, 0, outputWidth, outputHeight);
        context.save();
        context.beginPath();
        roundedRectPath(context, well.x, well.y, well.width, well.height, clipRadius);
        context.clip();
        context.drawImage(frameCanvas, source.x, source.y, source.width, source.height, well.x, well.y, well.width, well.height);
        context.restore();
        // 24fps 等低帧率素材可能跨过多个 30fps 槽位；重复当前画面补齐。
        while (frameCount <= targetIndex && frameCount < frameTarget) encodeCurrentCanvas();
      } finally {
        frame.close();
      }
    },
    error: (error) => { decoderFailure = error; },
  });
  decoder.configure({
    codec: demuxed.videoTrack.codec,
    codedWidth: sourceWidth,
    codedHeight: sourceHeight,
    ...(demuxed.videoDescription ? { description: demuxed.videoDescription } : {}),
  });

  try {
    let firstSample = 0;
    for (let index = 0; index < demuxed.samples.length; index += 1) {
      const seconds = demuxed.samples[index].cts / demuxed.samples[index].timescale;
      if (seconds > start) break;
      if (demuxed.samples[index].is_sync) firstSample = index;
    }
    const decodeEnd = end + 2 / fps;
    for (let index = firstSample; index < demuxed.samples.length; index += 1) {
      if (frameCount >= frameTarget) break;
      const sample = demuxed.samples[index];
      if (sample.cts / sample.timescale > decodeEnd) break;
      decoder.decode(new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: Math.round((sample.cts * 1_000_000) / sample.timescale),
        duration: Math.round((sample.duration * 1_000_000) / sample.timescale),
        data: sample.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    if (decoderFailure) throw new LivePhotoEngineError("视频解码失败。", "VIDEO_DECODE_FAILED", { cause: decoderFailure });
    if (!frameCount) throw new LivePhotoEngineError("所选片段没有画面帧。", "VIDEO_FRAME_MISSING");
    // 最后一帧通常停在片段终点前一个采样点，用画布中最后画面补足尾部。
    while (frameCount < frameTarget) encodeCurrentCanvas();
    await encoder.flush();
    encoder.close();
    if (encoderFailure) throw new LivePhotoEngineError("视频编码失败。", "VIDEO_ENCODE_FAILED", { cause: encoderFailure });

    if (canCopyAudio) {
      const selected = demuxed.audioSamples.filter((sample) => {
        const seconds = sample.cts / sample.timescale;
        return seconds >= start && seconds < end;
      });
      if (selected.length) {
        const audioBase = selected[0].cts / selected[0].timescale;
        selected.forEach((sample, index) => {
          const chunk = new EncodedAudioChunk({
            type: "key",
            timestamp: Math.round(((sample.cts / sample.timescale) - audioBase) * 1_000_000),
            duration: Math.round((sample.duration / sample.timescale) * 1_000_000),
            data: sample.data,
          });
          muxer.addAudioChunk(chunk, index === 0 ? { decoderConfig: { description: demuxed.audioDescription } } : undefined);
        });
      }
    }
    muxer.finalize();
    if (!coverPromise) coverPromise = canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    const coverBlob = await coverPromise;
    onProgress?.({ stage: "encoded", progress: 82, detail: "卡片视频已编码，正在写入配对信息…" });
    return {
      movieBytes: new Uint8Array(muxer.target.buffer),
      coverJpegBytes: new Uint8Array(await coverBlob.arrayBuffer()),
      frameCount,
      codec,
      audioCopied: canCopyAudio,
      mediaRect: well,
      sourceRotation: rotation,
      orientedSourceDimensions: oriented,
    };
  } finally {
    cardBitmap.close?.();
    try { decoder.close(); } catch { /* already closed */ }
    try { encoder.close(); } catch { /* already closed */ }
  }
}

async function createLivePhotoPackage(options, dependencies = {}) {
  const runtime = dependencies.runtime || globalThis;
  assertCapability(runtime, dependencies);
  const platform = options?.platform === "wechat" ? "wechat" : "xhs";
  const durationSeconds = Number(options?.durationSeconds) || (platform === "wechat" ? 3 : 5);
  const composed = await composeCardVideo({ ...options, durationSeconds }, dependencies);
  const contentIdentifier = normalizedContentIdentifier(options?.contentIdentifier, runtime);
  const movieBytes = injectQuickTimeContentIdentifier(composed.movieBytes, contentIdentifier);
  const photoBytes = injectJpegContentIdentifier(composed.coverJpegBytes, contentIdentifier);
  verifyPairedMetadata(movieBytes, photoBytes, contentIdentifier);
  const suffix = platform === "wechat" ? "WECHAT_3S" : "XHS_5S";
  const stem = safeStem(`${options?.title || "live-photo"}_${suffix}_LIVE`);
  const JSZip = runtimeValue(runtime, dependencies, "JSZip");
  const packed = await packPvtBundle({
    JSZip,
    stem,
    movieBytes,
    photoBytes,
    contentIdentifier,
    outputType: options?.zipOutputType || "blob",
  });
  options?.onProgress?.({ stage: "complete", progress: 100, detail: "Live Photo 发布包已生成并通过结构校验。" });
  return {
    ...packed,
    contentIdentifier,
    movieBytes,
    photoBytes,
    frameCount: composed.frameCount,
    codec: composed.codec,
    audioCopied: composed.audioCopied,
  };
}

const ChengYiLivePhotoEngine = Object.freeze({
  checkCapability,
  assertCapability,
  composeCardVideo,
  createLivePhotoPackage,
  injectQuickTimeContentIdentifier,
  injectJpegContentIdentifier,
  verifyPairedMetadata,
  buildPvtParts,
  packPvtBundle,
  verifyPvtParts,
  verifyPvtArchive,
  verifyZipHeader,
  safeStem,
  sourceTimestampToTargetIndex,
  parseTrackRotation,
  orientedVideoDimensions,
  codecCandidatesForSize,
  constants: Object.freeze({
    OUTPUT_WIDTH: DEFAULT_OUTPUT_WIDTH,
    OUTPUT_HEIGHT: DEFAULT_OUTPUT_HEIGHT,
    OUTPUT_FPS: DEFAULT_OUTPUT_FPS,
    VIDEO_BITRATE: DEFAULT_VIDEO_BITRATE,
    PVT_METADATA_PLIST,
    QUICKTIME_CONTENT_IDENTIFIER,
  }),
});

if (typeof window !== "undefined") window.ChengYiLivePhotoEngine = ChengYiLivePhotoEngine;

export {
  LivePhotoEngineError,
  checkCapability,
  assertCapability,
  composeCardVideo,
  createLivePhotoPackage,
  injectQuickTimeContentIdentifier,
  injectJpegContentIdentifier,
  verifyPairedMetadata,
  buildPvtParts,
  packPvtBundle,
  verifyPvtParts,
  verifyPvtArchive,
  verifyZipHeader,
  safeStem,
  sourceTimestampToTargetIndex,
  parseTrackRotation,
  orientedVideoDimensions,
  codecCandidatesForSize,
  PVT_METADATA_PLIST,
  QUICKTIME_CONTENT_IDENTIFIER,
};

export default ChengYiLivePhotoEngine;
