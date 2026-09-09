/**
 * Pixel helpers shared by grid-diff, regression-check and classify-tiles.
 * All coordinates are DEVICE pixels unless a function says otherwise.
 *
 * The grid policy lives here so every tool measures the same way:
 *   64 CSS-px tiles × scale, pixelmatch threshold 0.1 with AA ignored,
 *   pass < 2% · warn 2–8% · fail > 8% · empty ≥ 99.5% white in both.
 *   Dimension policy: never scale; pad ≤ 2% height delta with white.
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

export const TILE_CSS_PX = 64;
export const PIXELMATCH_OPTS = { threshold: 0.1, includeAA: false };
export const WHITE_MIN = 250;
export const EMPTY_WHITE_RATIO = 0.995;
export const PASS_MAX = 2;
export const WARN_MAX = 8;
export const HEIGHT_PAD_TOLERANCE = 0.02;

export const readPng = (path) => PNG.sync.read(readFileSync(path));
export const writePng = (path, png) => writeFileSync(path, PNG.sync.write(png));

export function blank(width, height, rgb = [255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return png;
}

export function padToHeight(png, height) {
  const out = blank(png.width, height);
  png.data.copy(out.data, 0, 0, png.width * png.height * 4);
  return out;
}

/** Pad-only normalization. Throws with both dimension pairs on anything else. */
export function normalizeHeights(a, b) {
  const dims = `a: ${a.width}x${a.height}, b: ${b.width}x${b.height}`;
  if (a.width !== b.width) {
    throw new Error(`Width mismatch — cannot diff. ${dims}`);
  }
  if (a.height === b.height) return { a, b, padded: null };
  const taller = Math.max(a.height, b.height);
  const delta = Math.abs(a.height - b.height) / taller;
  if (delta > HEIGHT_PAD_TOLERANCE) {
    throw new Error(
      `Height mismatch beyond ${HEIGHT_PAD_TOLERANCE * 100}% — cannot diff. ${dims}`,
    );
  }
  const padded = { a: a.height, b: b.height, paddedTo: taller };
  if (a.height < taller) a = padToHeight(a, taller);
  if (b.height < taller) b = padToHeight(b, taller);
  return { a, b, padded };
}

export function clampBox(png, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(png.width - 1, Math.ceil(box.x1));
  const y1 = Math.min(png.height - 1, Math.ceil(box.y1));
  return { x0, y0, x1, y1, w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
}

export function cropRegion(png, x0, y0, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const srcStart = ((y0 + y) * png.width + x0) * 4;
    out.set(png.data.subarray(srcStart, srcStart + tw * 4), y * tw * 4);
  }
  return out;
}

export function whiteRatio(rgba) {
  const total = rgba.length / 4;
  let white = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      rgba[i] >= WHITE_MIN &&
      rgba[i + 1] >= WHITE_MIN &&
      rgba[i + 2] >= WHITE_MIN &&
      rgba[i + 3] >= WHITE_MIN
    ) {
      white++;
    }
  }
  return white / total;
}

export function classifyPct(pct) {
  if (pct < PASS_MAX) return "pass";
  if (pct <= WARN_MAX) return "warn";
  return "fail";
}

/** The 64-CSS-px tile comparison. Reported x/y are CSS px; tiles carry col/row. */
export function tileGrid(design, build, scale) {
  const tilePx = TILE_CSS_PX * scale;
  const { width, height } = design;
  const cols = Math.ceil(width / tilePx);
  const rows = Math.ceil(height / tilePx);
  const tiles = [];
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let nonEmptyTiles = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * tilePx;
      const y0 = row * tilePx;
      const tw = Math.min(tilePx, width - x0);
      const th = Math.min(tilePx, height - y0);
      const a = cropRegion(design, x0, y0, tw, th);
      const b = cropRegion(build, x0, y0, tw, th);
      const base = { col, row, x: Math.round(x0 / scale), y: Math.round(y0 / scale) };
      if (whiteRatio(a) >= EMPTY_WHITE_RATIO && whiteRatio(b) >= EMPTY_WHITE_RATIO) {
        tiles.push({ ...base, empty: true });
        continue;
      }
      nonEmptyTiles++;
      const mismatched = pixelmatch(a, b, null, tw, th, PIXELMATCH_OPTS);
      const mismatchPct = (mismatched / (tw * th)) * 100;
      const cls = classifyPct(mismatchPct);
      if (cls === "pass") pass++;
      else if (cls === "warn") warn++;
      else fail++;
      tiles.push({ ...base, mismatchPct: Math.round(mismatchPct * 10) / 10, class: cls });
    }
  }
  const passPct = nonEmptyTiles ? Math.round((pass / nonEmptyTiles) * 1000) / 10 : 100;
  return { tilePx, cols, rows, tiles, summary: { nonEmptyTiles, pass, warn, fail, passPct } };
}

/** Device-px bounding box of a tile. */
export function tileBox(tile, tilePx, width, height) {
  const x0 = tile.col * tilePx;
  const y0 = tile.row * tilePx;
  return {
    x0,
    y0,
    x1: Math.min(width, x0 + tilePx) - 1,
    y1: Math.min(height, y0 + tilePx) - 1,
  };
}

export function overlay(a, b) {
  const out = new PNG({ width: a.width, height: a.height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = (a.data[i] + b.data[i]) >> 1;
    out.data[i + 1] = (a.data[i + 1] + b.data[i + 1]) >> 1;
    out.data[i + 2] = (a.data[i + 2] + b.data[i + 2]) >> 1;
    out.data[i + 3] = 255;
  }
  return out;
}

/** pixelmatch mismatch (count and pct) restricted to a device-px box. */
export function regionMismatch(a, b, box) {
  const c = clampBox(a, box);
  if (!c.w || !c.h) return { count: 0, pct: 0, area: 0 };
  const ca = cropRegion(a, c.x0, c.y0, c.w, c.h);
  const cb = cropRegion(b, c.x0, c.y0, c.w, c.h);
  const count = pixelmatch(ca, cb, null, c.w, c.h, PIXELMATCH_OPTS);
  return { count, pct: (count / (c.w * c.h)) * 100, area: c.w * c.h };
}

/**
 * Byte-exact diff of two same-size images, clustered into connected regions
 * of `cell`-px cells. Returns clusters sorted by changed-pixel count.
 */
export function changedClusters(a, b, cell = 16) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`changedClusters needs equal dimensions (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }
  const cols = Math.ceil(a.width / cell);
  const rows = Math.ceil(a.height / cell);
  const cells = new Map(); // key -> {count, x0,y0,x1,y1}
  let total = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]
      ) {
        total++;
        const key = Math.floor(y / cell) * cols + Math.floor(x / cell);
        let c = cells.get(key);
        if (!c) {
          c = { count: 0, x0: x, y0: y, x1: x, y1: y };
          cells.set(key, c);
        }
        c.count++;
        if (x < c.x0) c.x0 = x;
        if (y < c.y0) c.y0 = y;
        if (x > c.x1) c.x1 = x;
        if (y > c.y1) c.y1 = y;
      }
    }
  }
  // 4-neighbour flood fill over occupied cells.
  const seen = new Set();
  const clusters = [];
  for (const key of cells.keys()) {
    if (seen.has(key)) continue;
    const stack = [key];
    seen.add(key);
    const agg = { count: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    while (stack.length) {
      const k = stack.pop();
      const c = cells.get(k);
      agg.count += c.count;
      agg.x0 = Math.min(agg.x0, c.x0);
      agg.y0 = Math.min(agg.y0, c.y0);
      agg.x1 = Math.max(agg.x1, c.x1);
      agg.y1 = Math.max(agg.y1, c.y1);
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nk = ny * cols + nx;
        if (cells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    clusters.push({ ...agg, w: agg.x1 - agg.x0 + 1, h: agg.y1 - agg.y0 + 1 });
  }
  clusters.sort((p, q) => q.count - p.count);
  return { total, clusters };
}

export function boxContains(outer, inner, margin = 0) {
  return (
    inner.x0 >= outer.x0 - margin &&
    inner.y0 >= outer.y0 - margin &&
    inner.x1 <= outer.x1 + margin &&
    inner.y1 <= outer.y1 + margin
  );
}

export function boxesIntersect(a, b) {
  return !(b.x0 > a.x1 || b.x1 < a.x0 || b.y0 > a.y1 || b.y1 < a.y0);
}

export function intersectionArea(a, b) {
  if (!boxesIntersect(a, b)) return 0;
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
  return Math.max(0, w) * Math.max(0, h);
}

export function unionBox(boxes) {
  return boxes.reduce(
    (u, b) => ({
      x0: Math.min(u.x0, b.x0),
      y0: Math.min(u.y0, b.y0),
      x1: Math.max(u.x1, b.x1),
      y1: Math.max(u.y1, b.y1),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
}

/** Top-N exact colours in a box: [{ rgb: [r,g,b], count, share }]. */
export function colourHistogram(png, box, top = 4) {
  const c = clampBox(png, box);
  const counts = new Map();
  let total = 0;
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      const i = (y * png.width + x) * 4;
      const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  return [...counts.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, top)
    .map(([key, count]) => ({
      rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255],
      count,
      share: total ? count / total : 0,
    }));
}

const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);

/** True when every significant colour in each histogram has a near match in the other. */
export function coloursMatch(histA, histB, { tolerance = 6, minShare = 0.02 } = {}) {
  const sig = (h) => h.filter((e) => e.share >= minShare);
  const covered = (from, to) => sig(from).every((e) => to.some((f) => dist(e.rgb, f.rgb) <= tolerance));
  return covered(histA, histB) && covered(histB, histA);
}

/** Bounding box of pixels that differ from `bg` by more than `threshold` (sum of channel deltas). */
export function inkBBox(png, box, bg, threshold = 24) {
  const c = clampBox(png, box);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      const i = (y * png.width + x) * 4;
      if (dist([png.data[i], png.data[i + 1], png.data[i + 2]], bg) > threshold) {
        count++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!count) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count };
}

/**
 * Find the horizontal offset of `b` relative to `a` inside `box` that minimises
 * pixelmatch mismatch. Returns { shift, mismatchPct, directPct }.
 */
export function bestHorizontalShift(a, b, box, maxShift = 4) {
  const c = clampBox(a, box);
  if (!c.w || !c.h) return { shift: 0, mismatchPct: 0, directPct: 0 };
  const ca = cropRegion(a, c.x0, c.y0, c.w, c.h);
  const direct = pixelmatch(ca, cropRegion(b, c.x0, c.y0, c.w, c.h), null, c.w, c.h, PIXELMATCH_OPTS);
  let best = { shift: 0, count: direct };
  for (let s = -maxShift; s <= maxShift; s++) {
    if (s === 0) continue;
    const bx0 = c.x0 + s;
    if (bx0 < 0 || bx0 + c.w > b.width) continue;
    const cb = cropRegion(b, bx0, c.y0, c.w, c.h);
    const count = pixelmatch(ca, cb, null, c.w, c.h, PIXELMATCH_OPTS);
    if (count < best.count) best = { shift: s, count };
  }
  const area = c.w * c.h;
  return {
    shift: best.shift,
    mismatchPct: (best.count / area) * 100,
    directPct: (direct / area) * 100,
  };
}

/** Reference crop beside build crop, same box, at native scale, with a thin gap. */
export function sideBySide(a, b, box, gap = 4) {
  const c = clampBox(a, box);
  const out = blank(c.w * 2 + gap, c.h, [255, 0, 255]);
  for (let y = 0; y < c.h; y++) {
    const rowA = ((c.y0 + y) * a.width + c.x0) * 4;
    const rowB = ((c.y0 + y) * b.width + c.x0) * 4;
    a.data.copy(out.data, (y * out.width) * 4, rowA, rowA + c.w * 4);
    b.data.copy(out.data, (y * out.width + c.w + gap) * 4, rowB, rowB + c.w * 4);
  }
  return out;
}

/** CSS-px box {x,y,w,h} → device-px inclusive box. */
export function cssToDeviceBox(r, scale, margin = 0) {
  return {
    x0: Math.floor(r.x * scale) - margin,
    y0: Math.floor(r.y * scale) - margin,
    x1: Math.ceil((r.x + r.w) * scale) - 1 + margin,
    y1: Math.ceil((r.y + r.h) * scale) - 1 + margin,
  };
}
