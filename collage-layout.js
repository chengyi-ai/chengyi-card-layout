(function initChengYiCollageLayout(root) {
  'use strict';

  const BASE = 10000;
  const MAX_ITEMS = 8;
  const MIN_ITEM_WIDTH = 1600;
  const MAX_ITEM_WIDTH = 9500;
  const MIN_HEIGHT = 220;
  const MAX_HEIGHT = 680;
  const DEFAULT_HEIGHT = 440;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function integer(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  function normalizeHeight(value) {
    return integer(clamp(integer(value, DEFAULT_HEIGHT), MIN_HEIGHT, MAX_HEIGHT), DEFAULT_HEIGHT);
  }

  function normalizeItem(item, index = 0) {
    const input = item && typeof item === 'object' ? item : {};
    const width = integer(clamp(integer(input.width, 6200), MIN_ITEM_WIDTH, MAX_ITEM_WIDTH), 6200);
    const x = integer(clamp(integer(input.x, 600 + index * 900), 0, BASE - width), 0);
    const y = integer(clamp(integer(input.y, 600 + index * 900), 0, BASE), 0);
    return {
      id: String(input.id || `item-${index + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || `item-${index + 1}`,
      x,
      y,
      width,
      z: Math.max(1, integer(input.z, index + 1)),
    };
  }

  function normalizeItems(items) {
    const seen = new Set();
    const normalized = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map((item, index) => {
      const next = normalizeItem(item, index);
      let id = next.id;
      let suffix = 2;
      while (seen.has(id)) id = `${next.id}-${suffix++}`;
      seen.add(id);
      return { ...next, id };
    });
    return normalized
      .sort((a, b) => a.z - b.z)
      .map((item, index) => ({ ...item, z: index + 1 }));
  }

  function defaultItems(count) {
    const length = Math.max(0, Math.min(MAX_ITEMS, integer(count, 0)));
    return normalizeItems(Array.from({ length }, (_, index) => ({
      id: `item-${index + 1}`,
      x: 500 + index * 1050,
      y: 500 + index * 950,
      width: length === 1 ? 7600 : 4800,
      z: index + 1,
    })));
  }

  function moveItem(item, movement) {
    const start = normalizeItem(item);
    const input = movement && typeof movement === 'object' ? movement : {};
    const containerWidth = Math.max(1, Number(input.containerWidth) || 1);
    const containerHeight = Math.max(1, Number(input.containerHeight) || 1);
    const itemWidth = Math.max(0, Number(input.itemWidth) || 0);
    const itemHeight = Math.max(0, Number(input.itemHeight) || 0);
    const dx = (Number(input.deltaX) || 0) / containerWidth * BASE;
    const dy = (Number(input.deltaY) || 0) / containerHeight * BASE;
    const maxX = Math.max(0, BASE - itemWidth / containerWidth * BASE);
    const maxY = Math.max(0, BASE - itemHeight / containerHeight * BASE);
    return {
      ...start,
      x: Math.round(clamp(start.x + dx, 0, maxX)),
      y: Math.round(clamp(start.y + dy, 0, maxY)),
    };
  }

  function resizeItem(item, resize) {
    const start = normalizeItem(item);
    const input = resize && typeof resize === 'object' ? resize : {};
    const containerWidth = Math.max(1, Number(input.containerWidth) || 1);
    const delta = (Number(input.deltaX) || 0) / containerWidth * BASE;
    const maxWidth = Math.min(MAX_ITEM_WIDTH, BASE - start.x);
    return {
      ...start,
      width: Math.round(clamp(start.width + delta, MIN_ITEM_WIDTH, Math.max(MIN_ITEM_WIDTH, maxWidth))),
    };
  }

  function moveByKeyboard(item, dx, dy, itemHeightBasis = 0) {
    const start = normalizeItem(item);
    const maxY = Math.max(0, BASE - Math.max(0, Number(itemHeightBasis) || 0));
    return {
      ...start,
      x: Math.round(clamp(start.x + (Number(dx) || 0), 0, BASE - start.width)),
      y: Math.round(clamp(start.y + (Number(dy) || 0), 0, maxY)),
    };
  }

  function stepLayer(items, itemId, direction) {
    const ordered = normalizeItems(items);
    const index = ordered.findIndex((item) => item.id === itemId);
    if (index < 0) return ordered;
    const target = direction === 'backward' ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) return ordered;
    const next = ordered.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next.map((item, position) => ({ ...item, z: position + 1 }));
  }

  root.ChengYiCollageLayout = Object.freeze({
    BASE,
    MAX_ITEMS,
    MIN_ITEM_WIDTH,
    MAX_ITEM_WIDTH,
    MIN_HEIGHT,
    MAX_HEIGHT,
    DEFAULT_HEIGHT,
    clamp,
    normalizeHeight,
    normalizeItem,
    normalizeItems,
    defaultItems,
    moveItem,
    resizeItem,
    moveByKeyboard,
    stepLayer,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
