#!/usr/bin/env node
/**
 * Val tool — tile-by-tile visual diff of the built page against the design
 * export.
 *
 * Usage: node <tools-dir>/grid-diff.mjs <run-dir>
 *
 * Reads:  <run-dir>/01-extraction/exports/page@2x.png   (design)
 *         <run-dir>/06-accuracy/build@2x.png            (build)
 *         <run-dir>/manifest.json                       (input.exportScale)
 * Writes: <run-dir>/06-accuracy/diff-report.json
 *         <run-dir>/06-accuracy/overlay.png
 *
 * Dimension policy: never scale/stretch. Equal widths with a height delta
 * of <= 2% pads the shorter image with white at the bottom; anything else
 * exits non-zero printing both dimension pairs.
 *
 * Grid: fixed 64px tiles in CSS-pixel terms (64 x exportScale device px).
 * Partial edge tiles are allowed. Tiles >= 99.5% white in BOTH images are
 * marked empty and excluded from scoring.
 *
 * Classification per tile (pixelmatch, threshold 0.1, includeAA false):
 *   pass  < 2% mismatch
 *   warn  2–8%
 *   fail  > 8%
 */

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const TILE_CSS_PX = 64;
const PIXELMATCH_OPTS = { threshold: 0.1, includeAA: false };
const WHITE_MIN = 250; // channel floor for "white" when detecting empty tiles
const EMPTY_WHITE_RATIO = 0.995;
const PASS_MAX = 2; // < 2% mismatch
const WARN_MAX = 8; // 2–8% warn, > 8% fail
const HEIGHT_PAD_TOLERANCE = 0.02;

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: node <tools-dir>/grid-diff.mjs <run-dir>");
  process.exit(1);
}

const runPath = resolve(runDir);
const designPath = join(runPath, "01-extraction", "exports", "page@2x.png");
const buildPath = join(runPath, "06-accuracy", "build@2x.png");

for (const p of [designPath, buildPath]) {
  if (!existsSync(p)) {
    console.error(`Missing input image: ${p}`);
    process.exit(1);
  }
}

let exportScale = 2;
const manifestPath = join(runPath, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  exportScale = manifest?.input?.exportScale ?? 2;
}
const tilePx = TILE_CSS_PX * exportScale; // tile size in device pixels

let design = PNG.sync.read(readFileSync(designPath));
let build = PNG.sync.read(readFileSync(buildPath));

// ---- dimension normalization (pad only, never scale) ----------------------
if (design.width !== build.width) {
  console.error(
    `Width mismatch — cannot diff. design: ${design.width}x${design.height}, build: ${build.width}x${build.height}`,
  );
  process.exit(1);
}
if (design.height !== build.height) {
  const taller = Math.max(design.height, build.height);
  const delta = Math.abs(design.height - build.height) / taller;
  if (delta > HEIGHT_PAD_TOLERANCE) {
    console.error(
      `Height mismatch beyond ${HEIGHT_PAD_TOLERANCE * 100}% — cannot diff. ` +
        `design: ${design.width}x${design.height}, build: ${build.width}x${build.height}`,
    );
    process.exit(1);
  }
  if (design.height < taller) design = padToHeight(design, taller);
  if (build.height < taller) build = padToHeight(build, taller);
}

function padToHeight(png, height) {
  const out = new PNG({ width: png.width, height });
  out.data.fill(255); // white, opaque
  png.data.copy(out.data, 0, 0, png.width * png.height * 4);
  return out;
}

const { width, height } = design;
const cols = Math.ceil(width / tilePx);
const rows = Math.ceil(height / tilePx);

// ---- helpers ---------------------------------------------------------------
function cropTile(png, x0, y0, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const srcStart = ((y0 + y) * png.width + x0) * 4;
    const row = png.data.subarray(srcStart, srcStart + tw * 4);
    out.set(row, y * tw * 4);
  }
  return out;
}

function whiteRatio(rgba) {
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

// ---- tile loop -------------------------------------------------------------
const tiles = [];
let pass = 0;
let warn = 0;
let fail = 0;
let nonEmptyTiles = 0;

for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const x0 = col * tilePx;
    const y0 = row * tilePx;
    const tw = Math.min(tilePx, width - x0); // partial edge tiles allowed
    const th = Math.min(tilePx, height - y0);

    const a = cropTile(design, x0, y0, tw, th);
    const b = cropTile(build, x0, y0, tw, th);

    // Reported coordinates are CSS pixels.
    const base = {
      col,
      row,
      x: Math.round(x0 / exportScale),
      y: Math.round(y0 / exportScale),
    };

    if (
      whiteRatio(a) >= EMPTY_WHITE_RATIO &&
      whiteRatio(b) >= EMPTY_WHITE_RATIO
    ) {
      tiles.push({ ...base, empty: true });
      continue;
    }

    nonEmptyTiles++;
    const mismatched = pixelmatch(a, b, null, tw, th, PIXELMATCH_OPTS);
    const mismatchPct = (mismatched / (tw * th)) * 100;

    let cls;
    if (mismatchPct < PASS_MAX) {
      cls = "pass";
      pass++;
    } else if (mismatchPct <= WARN_MAX) {
      cls = "warn";
      warn++;
    } else {
      cls = "fail";
      fail++;
    }

    tiles.push({
      ...base,
      mismatchPct: Math.round(mismatchPct * 10) / 10,
      class: cls,
    });
  }
}

const passPct = nonEmptyTiles
  ? Math.round((pass / nonEmptyTiles) * 1000) / 10
  : 100;

const report = {
  tileSizePx: TILE_CSS_PX,
  exportScale,
  imagePx: { width, height },
  grid: { cols, rows },
  summary: { nonEmptyTiles, pass, warn, fail, passPct },
  tiles,
};

writeFileSync(
  join(runPath, "06-accuracy", "diff-report.json"),
  JSON.stringify(report, null, 2),
);

// ---- overlay: build at 50% opacity over the design --------------------------
const overlay = new PNG({ width, height });
for (let i = 0; i < overlay.data.length; i += 4) {
  overlay.data[i] = (design.data[i] + build.data[i]) >> 1;
  overlay.data[i + 1] = (design.data[i + 1] + build.data[i + 1]) >> 1;
  overlay.data[i + 2] = (design.data[i + 2] + build.data[i + 2]) >> 1;
  overlay.data[i + 3] = 255;
}
writeFileSync(
  join(runPath, "06-accuracy", "overlay.png"),
  PNG.sync.write(overlay),
);

console.log(
  `Grid ${cols}x${rows} (${TILE_CSS_PX}px tiles @ ${exportScale}x) — ` +
    `${nonEmptyTiles} non-empty tiles: ${pass} pass, ${warn} warn, ${fail} fail — passPct ${passPct}%`,
);
