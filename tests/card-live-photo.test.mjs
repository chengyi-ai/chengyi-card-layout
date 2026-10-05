import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  LivePhotoEngineError,
  assertCapability,
  buildPvtParts,
  checkCapability,
  codecCandidatesForSize,
  injectJpegContentIdentifier,
  injectQuickTimeContentIdentifier,
  packPvtBundle,
  parseTrackRotation,
  orientedVideoDimensions,
  safeStem,
  sourceTimestampToTargetIndex,
  verifyPairedMetadata,
  verifyPvtArchive,
  verifyPvtParts,
  verifyZipHeader,
} from "../live-photo-engine.js";

const CONTENT_ID = "123E4567-E89B-42D3-A456-426614174000";
const FIXED_ONE = 65_536;
const FIXED_PERSPECTIVE_ONE = 1_073_741_824;

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function ascii(value) {
  return new TextEncoder().encode(value);
}

function box(type, payload = new Uint8Array()) {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, payload.byteLength + 8);
  header.set(ascii(type), 4);
  return concat(header, payload);
}

function uint32(...values) {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, Number(value)));
  return output;
}

function uint64(...values) {
  const output = new Uint8Array(values.length * 8);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value)));
  return output;
}

function chunkOffsetBox(type, offsets, declaredCount = offsets.length) {
  const entries = type === "co64" ? uint64(...offsets) : uint32(...offsets);
  return box(type, concat(new Uint8Array(4), uint32(declaredCount), entries));
}

function moovWithChunkOffsets(type, offsets, declaredCount = offsets.length) {
  return box("moov", box("trak", box("mdia", box("minf", box("stbl", chunkOffsetBox(type, offsets, declaredCount))))));
}

function readBoxAt(bytes, offset, end = bytes.byteLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset);
  const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
  const headerSize = size32 === 1 ? 16 : 8;
  const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : (size32 || end - offset);
  return { offset, type, size, headerSize, payloadStart: offset + headerSize, end: offset + size };
}

function findChild(bytes, start, end, wantedType) {
  let offset = start;
  while (offset < end) {
    const current = readBoxAt(bytes, offset, end);
    if (current.type === wantedType) return current;
    offset = current.end;
  }
  return null;
}

function readChunkOffsets(movie, type) {
  const moov = findChild(movie, 0, movie.byteLength, "moov");
  assert.ok(moov, "应找到 moov");
  let current = moov;
  for (const childType of ["trak", "mdia", "minf", "stbl", type]) {
    current = findChild(movie, current.payloadStart, current.end, childType);
    assert.ok(current, `应找到 ${childType}`);
  }
  const view = new DataView(movie.buffer, movie.byteOffset, movie.byteLength);
  const entryCount = view.getUint32(current.payloadStart + 4);
  return Array.from({ length: entryCount }, (_, index) => (
    type === "co64"
      ? view.getBigUint64(current.payloadStart + 8 + index * 8)
      : view.getUint32(current.payloadStart + 8 + index * 4)
  ));
}

function chunkOffsetFixture({ type = "stco", moovFirst = true, offsets = null, declaredCount } = {}) {
  const ftyp = box("ftyp", ascii("isom"));
  const mediaPayload = ascii("VIDEO-DATA");
  const mdat = box("mdat", mediaPayload);
  const placeholderOffsets = offsets || (type === "co64" ? [0n] : [0]);
  const placeholderMoov = moovWithChunkOffsets(type, placeholderOffsets, declaredCount);
  const mdatPayloadOffset = moovFirst
    ? ftyp.byteLength + placeholderMoov.byteLength + 8
    : ftyp.byteLength + 8;
  const resolvedOffsets = offsets || (type === "co64"
    ? [BigInt(mdatPayloadOffset)]
    : [mdatPayloadOffset]);
  const moov = moovWithChunkOffsets(type, resolvedOffsets, declaredCount);
  const movie = moovFirst ? concat(ftyp, moov, mdat) : concat(ftyp, mdat, moov);
  return { movie, moov, mdatPayloadOffset, mediaPayload };
}

function pairedFixtures() {
  const sourceMovie = concat(box("ftyp", ascii("isom")), box("moov"));
  const sourceJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  return {
    movie: injectQuickTimeContentIdentifier(sourceMovie, CONTENT_ID),
    photo: injectJpegContentIdentifier(sourceJpeg, CONTENT_ID),
  };
}

async function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  throw new TypeError("Unsupported fake ZIP input");
}

class FakeJSZip {
  constructor() {
    this.entries = new Map();
  }

  file(path, data) {
    if (arguments.length > 1) {
      this.entries.set(path, data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
      return this;
    }
    const stored = this.entries.get(path);
    if (!stored) return null;
    return {
      async: async (type) => {
        assert.equal(type, "uint8array");
        return stored.slice();
      },
    };
  }

  async generateAsync({ type }) {
    const records = [...this.entries].map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]);
    const output = concat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), ascii(JSON.stringify(records)));
    if (type === "blob") return new Blob([output], { type: "application/zip" });
    if (type === "arraybuffer") return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    return output;
  }

  static async loadAsync(value) {
    const bytes = await asBytes(value);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const records = JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
    const zip = new FakeJSZip();
    for (const [path, encoded] of records) zip.entries.set(path, new Uint8Array(Buffer.from(encoded, "base64")));
    return zip;
  }
}

test("JPG 和 MOV 必须写入同一 ContentIdentifier", () => {
  const { movie, photo } = pairedFixtures();
  const result = verifyPairedMetadata(movie, photo, CONTENT_ID);

  assert.equal(result.valid, true);
  assert.equal(result.contentIdentifier, CONTENT_ID);
  assert.ok(new TextDecoder().decode(movie).includes("com.apple.quicktime.content.identifier"));
  assert.ok(new TextDecoder().decode(photo).includes("Apple iOS\0"));
});

test("moov 在 mdat 前时递归修正 stco，且只移动注入点之后的偏移", () => {
  const provisional = chunkOffsetFixture({ moovFirst: true, offsets: [0, 0] });
  const source = chunkOffsetFixture({
    moovFirst: true,
    offsets: [4, provisional.mdatPayloadOffset],
  });
  const insertionPoint = source.mdatPayloadOffset - 8;
  const patched = injectQuickTimeContentIdentifier(source.movie, CONTENT_ID);
  const insertedByteLength = patched.byteLength - source.movie.byteLength;
  const offsets = readChunkOffsets(patched, "stco");

  assert.ok(insertedByteLength > 0);
  assert.deepEqual(offsets, [4, source.mdatPayloadOffset + insertedByteLength]);
  assert.deepEqual(
    patched.subarray(offsets[1], offsets[1] + source.mediaPayload.byteLength),
    source.mediaPayload,
  );
  const patchedMoov = findChild(patched, 0, patched.byteLength, "moov");
  assert.equal(patchedMoov.size, source.moov.byteLength + insertedByteLength);
  assert.ok(4 < insertionPoint && source.mdatPayloadOffset >= insertionPoint);
});

test("moov 在 mdat 后时 stco 不应移动已在注入点之前的媒体数据", () => {
  const source = chunkOffsetFixture({ moovFirst: false });
  const patched = injectQuickTimeContentIdentifier(source.movie, CONTENT_ID);
  const offsets = readChunkOffsets(patched, "stco");

  assert.deepEqual(offsets, [source.mdatPayloadOffset]);
  assert.deepEqual(
    patched.subarray(offsets[0], offsets[0] + source.mediaPayload.byteLength),
    source.mediaPayload,
  );
});

test("moov 在 mdat 前时 co64 也会递归修正", () => {
  const source = chunkOffsetFixture({ moovFirst: true, type: "co64" });
  const patched = injectQuickTimeContentIdentifier(source.movie, CONTENT_ID);
  const insertedByteLength = patched.byteLength - source.movie.byteLength;
  const offsets = readChunkOffsets(patched, "co64");

  assert.deepEqual(offsets, [BigInt(source.mdatPayloadOffset + insertedByteLength)]);
  assert.deepEqual(
    patched.subarray(Number(offsets[0]), Number(offsets[0]) + source.mediaPayload.byteLength),
    source.mediaPayload,
  );
});

test("co64 与 stco 都防止注入后整数溢出", () => {
  const stco = chunkOffsetFixture({ moovFirst: true, offsets: [0xffff_ffff] });
  assert.throws(
    () => injectQuickTimeContentIdentifier(stco.movie, CONTENT_ID),
    (error) => error instanceof LivePhotoEngineError && error.code === "MOV_STCO_OVERFLOW",
  );

  const co64 = chunkOffsetFixture({ moovFirst: true, type: "co64", offsets: [0xffff_ffff_ffff_ffffn] });
  assert.throws(
    () => injectQuickTimeContentIdentifier(co64.movie, CONTENT_ID),
    (error) => error instanceof LivePhotoEngineError && error.code === "MOV_CO64_OVERFLOW",
  );
});

test("损坏的 stco/co64 条目数不会被当成成功", () => {
  const malformed = chunkOffsetFixture({ moovFirst: true, offsets: [100], declaredCount: 2 });
  assert.throws(
    () => injectQuickTimeContentIdentifier(malformed.movie, CONTENT_ID),
    (error) => error instanceof LivePhotoEngineError && error.code === "INVALID_MOV_CHUNK_OFFSET_TABLE",
  );
  const malformed64 = chunkOffsetFixture({
    moovFirst: true,
    type: "co64",
    offsets: [100n],
    declaredCount: 2,
  });
  assert.throws(
    () => injectQuickTimeContentIdentifier(malformed64.movie, CONTENT_ID),
    (error) => error instanceof LivePhotoEngineError && error.code === "INVALID_MOV_CHUNK_OFFSET_TABLE",
  );
});

test("1500x2000 输出优先尝试 H.264 Level 5.0，1080x1440 保持 Level 4.0 优先", () => {
  assert.deepEqual(codecCandidatesForSize(1500, 2000, 30).slice(0, 3), [
    "avc1.640032",
    "avc1.4d0032",
    "avc1.420032",
  ]);
  assert.equal(codecCandidatesForSize(1080, 1440, 30)[0], "avc1.4d0028");
});

const REAL_MP4_FIXTURE = "/private/tmp/chengyi-live-test.mp4";
const REAL_FFMPEG = process.env.FFMPEG_PATH || "/Users/chengyi/.local/bin/ffmpeg";

test("真实 moov-before-mdat MP4 注入后仍可解码", {
  skip: !existsSync(REAL_MP4_FIXTURE) || !existsSync(REAL_FFMPEG),
}, () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "chengyi-live-photo-"));
  const outputPath = join(tempDirectory, "patched.MOV");
  try {
    const source = new Uint8Array(readFileSync(REAL_MP4_FIXTURE));
    const patched = injectQuickTimeContentIdentifier(source, CONTENT_ID);
    writeFileSync(outputPath, patched);
    const decoded = spawnSync(REAL_FFMPEG, [
      "-hide_banner",
      "-v", "error",
      "-i", outputPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-f", "null",
      "-",
    ], { encoding: "utf8" });
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("PVT 使用同名目录、MOV、JPG 和 metadata.plist", () => {
  const { movie, photo } = pairedFixtures();
  const parts = buildPvtParts({ stem: "程意 测试/项目", movieBytes: movie, photoBytes: photo });

  assert.deepEqual(parts.map((part) => part.path), [
    "程意-测试-项目.pvt/程意-测试-项目.MOV",
    "程意-测试-项目.pvt/程意-测试-项目.JPG",
    "程意-测试-项目.pvt/metadata.plist",
  ]);
  assert.equal(verifyPvtParts(parts, { stem: "程意 测试/项目", contentIdentifier: CONTENT_ID }).valid, true);
});

test("PVT ZIP 打包后必须能回读并再次校验", async () => {
  const { movie, photo } = pairedFixtures();
  const result = await packPvtBundle({
    JSZip: FakeJSZip,
    stem: "品牌 实况",
    movieBytes: movie,
    photoBytes: photo,
    contentIdentifier: CONTENT_ID,
    outputType: "uint8array",
  });

  assert.equal(result.archiveName, "品牌-实况.zip");
  assert.equal(await verifyZipHeader(result.archive), true);
  const verified = await verifyPvtArchive(result.archive, {
    JSZip: FakeJSZip,
    stem: result.stem,
    contentIdentifier: CONTENT_ID,
  });
  assert.deepEqual(verified.files, [
    "品牌-实况.pvt/品牌-实况.MOV",
    "品牌-实况.pvt/品牌-实况.JPG",
    "品牌-实况.pvt/metadata.plist",
  ]);
});

test("不支持的浏览器能力会明确报错", () => {
  const capability = checkCapability({}, {});
  assert.equal(capability.supported, false);
  assert.ok(capability.missing.includes("VideoEncoder"));
  assert.ok(capability.missing.includes("JSZip"));
  assert.throws(
    () => assertCapability({}, {}),
    (error) => error instanceof LivePhotoEngineError && error.code === "LIVE_PHOTO_UNSUPPORTED",
  );
});

test("结构错误不会伪装成功", async () => {
  assert.equal(safeStem(" ../程意 <> /项目 "), "程意-项目");
  await assert.rejects(
    verifyZipHeader(new Uint8Array([0x00, 0x01, 0x02, 0x03])),
    (error) => error instanceof LivePhotoEngineError && error.code === "ZIP_SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifyPairedMetadata(...Object.values(pairedFixtures()).reverse(), CONTENT_ID),
    (error) => error instanceof LivePhotoEngineError && error.code === "PAIR_METADATA_INVALID",
  );
});

test("24/30/60fps 源时间戳都映射到固定 30fps 输出时间轴", () => {
  const start = 1_000_000;
  const target = 150;
  assert.equal(sourceTimestampToTargetIndex(start, start, 30, target), 0);
  assert.equal(sourceTimestampToTargetIndex(start + 2_500_000, start, 30, target), 75);
  assert.equal(sourceTimestampToTargetIndex(start + 4_999_000, start, 30, target), 149);
  assert.equal(sourceTimestampToTargetIndex(start + 8_333, start, 30, target), 0, "60fps 的第二帧应落在同一输出槽位");
  assert.equal(sourceTimestampToTargetIndex(start + 41_667, start, 30, target), 1, "24fps 源帧应按真实时间而不是帧数映射");
});

test("tkhd 正交矩阵正确解析 0/90/180/270 度旋转", () => {
  assert.equal(parseTrackRotation([
    FIXED_ONE, 0, 0, 0, FIXED_ONE, 0, 0, 0, FIXED_PERSPECTIVE_ONE,
  ]), 0);
  assert.equal(parseTrackRotation([
    0, FIXED_ONE, 0, -FIXED_ONE, 0, 0, 1080 * FIXED_ONE, 0, FIXED_PERSPECTIVE_ONE,
  ]), 90);
  assert.equal(parseTrackRotation([
    -FIXED_ONE, 0, 0, 0, -FIXED_ONE, 0, 1920 * FIXED_ONE, 1080 * FIXED_ONE, FIXED_PERSPECTIVE_ONE,
  ]), 180);
  assert.equal(parseTrackRotation([
    0, -FIXED_ONE, 0, FIXED_ONE, 0, 0, 0, 1920 * FIXED_ONE, FIXED_PERSPECTIVE_ONE,
  ]), 270);
});

test("视频方向尺寸在 90/270 度时交换宽高", () => {
  assert.deepEqual(orientedVideoDimensions(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(orientedVideoDimensions(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(orientedVideoDimensions(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(orientedVideoDimensions(1920, 1080, 270), { width: 1080, height: 1920 });
});

test("非正交 tkhd 矩阵明确拒绝", () => {
  assert.throws(
    () => parseTrackRotation([
      FIXED_ONE, 1000, 0, 0, FIXED_ONE, 0, 0, 0, FIXED_PERSPECTIVE_ONE,
    ]),
    (error) => error instanceof LivePhotoEngineError && error.code === "VIDEO_TRACK_MATRIX_UNSUPPORTED",
  );
});
