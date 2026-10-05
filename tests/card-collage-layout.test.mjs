import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../collage-layout.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'collage-layout.js' });
const api = context.globalThis.ChengYiCollageLayout;

test('自由拼贴基础数值会被稳定限幅', () => {
  assert.equal(api.normalizeHeight(-1), api.MIN_HEIGHT);
  assert.equal(api.normalizeHeight(Infinity), api.DEFAULT_HEIGHT);
  assert.equal(api.normalizeHeight(9999), api.MAX_HEIGHT);
  const item = api.normalizeItem({ id: '图 1<script>', x: -300, y: Infinity, width: 99999, z: -2 });
  assert.equal(item.id, '1script');
  assert.equal(item.x, 0);
  assert.equal(item.y, 600);
  assert.equal(item.width, api.MAX_ITEM_WIDTH);
  assert.equal(item.z, 1);
});

test('三张图片默认错位叠放且层级唯一', () => {
  const items = api.defaultItems(3);
  assert.equal(items.length, 3);
  assert.deepEqual(Array.from(items, (item) => item.z), [1, 2, 3]);
  assert.ok(items[1].x > items[0].x);
  assert.ok(items[1].y > items[0].y);
  assert.ok(items[2].x < api.BASE - items[2].width);
});

test('重复图片 ID 会被改成唯一值且保持独立几何', () => {
  const items = api.normalizeItems([
    { id: 'same', x: 100, y: 200, width: 3000, z: 2 },
    { id: 'same', x: 900, y: 800, width: 4000, z: 1 },
  ]);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
  assert.deepEqual(items.map((item) => [item.x, item.y, item.width]), [
    [900, 800, 4000],
    [100, 200, 3000],
  ]);
});

test('拖动允许重叠但不会移出拼贴区', () => {
  const original = api.normalizeItem({ id: 'a', x: 1000, y: 1200, width: 5000, z: 1 });
  const moved = api.moveItem(original, {
    deltaX: 180,
    deltaY: 120,
    containerWidth: 600,
    containerHeight: 400,
    itemWidth: 300,
    itemHeight: 160,
  });
  assert.equal(JSON.stringify(original), JSON.stringify({ id: 'a', x: 1000, y: 1200, width: 5000, z: 1 }), '拖动不得修改原对象');
  assert.equal(moved.x, 4000);
  assert.equal(moved.y, 4200);

  const topLeft = api.moveItem(original, {
    deltaX: -10000,
    deltaY: -10000,
    containerWidth: 600,
    containerHeight: 400,
    itemWidth: 300,
    itemHeight: 160,
  });
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);

  const bottomRight = api.moveItem(original, {
    deltaX: 10000,
    deltaY: 10000,
    containerWidth: 600,
    containerHeight: 400,
    itemWidth: 300,
    itemHeight: 160,
  });
  assert.equal(bottomRight.x, 5000);
  assert.equal(bottomRight.y, 6000);
});

test('缩放限制最小宽度和右侧边界', () => {
  const item = api.normalizeItem({ id: 'a', x: 3000, y: 0, width: 4000, z: 1 });
  assert.equal(api.resizeItem(item, { deltaX: -9999, containerWidth: 600 }).width, api.MIN_ITEM_WIDTH);
  assert.equal(api.resizeItem(item, { deltaX: 9999, containerWidth: 600 }).width, 7000);
});

test('层级只交换相邻图片并重新编号', () => {
  const items = api.normalizeItems([
    { id: 'a', z: 1 },
    { id: 'b', z: 2 },
    { id: 'c', z: 3 },
  ]);
  const forward = api.stepLayer(items, 'a', 'forward');
  assert.deepEqual(forward.map((item) => `${item.id}:${item.z}`), ['b:1', 'a:2', 'c:3']);
  const backward = api.stepLayer(forward, 'c', 'backward');
  assert.deepEqual(backward.map((item) => `${item.id}:${item.z}`), ['b:1', 'c:2', 'a:3']);
});

test('键盘微调同样受左右和上下边界限制', () => {
  const item = api.normalizeItem({ id: 'a', x: 100, y: 100, width: 4000, z: 1 });
  const moved = api.moveByKeyboard(item, -500, 20000, 3500);
  assert.equal(moved.x, 0);
  assert.equal(moved.y, 6500);
});
