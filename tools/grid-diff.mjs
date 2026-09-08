#!/usr/bin/env node
/**
 * Val tool — tile-by-tile visual diff of the built page against the design
 * export (or any reference).
 *
 * Usage: node <tools-dir>/grid-diff.mjs <run-dir> [flags]
 *
 *   --frame <state|index>   which manifest input.frames[] entry (default: primary)
 *   --reference <png>       override the reference image
 *   --build <png>           override the build capture
 *   --out <dir>             override the output directory
 *   --scale <n>             override the device scale (tile = 64 CSS px × scale)
 *   --baseline <report>     a previous diff-report.json: carry its per-tile
 *                           classifications forward and report what changed
 *
 * Defaults (unchanged from 0.1.x for the primary frame):
 *   reference  <run-dir>/01-extraction/exports/page@2x.png, or the frame's
 *              recorded requester reference (frames[].reference) when present
 *   build      <run-dir>/06-accuracy/build@2x.png
 *   out        <run-dir>/06-accuracy/   → diff-report.json + overlay.png
 *   scale      frames[].reference.scale, else manifest input.exportScale
 * For frames[n>0] the defaults live under 01-extraction/frames/<state>/ and
 * 06-accuracy/frames/<state>/.
 *
 * Dimension policy: never scale/stretch. Equal widths with a height delta
 * of <= 2% pads the shorter image with white at the bottom; anything else
 * exits non-zero printing both dimension pairs.
 *
 * Grid: fixed 64px tiles in CSS-pixel terms (64 x scale device px).
 * Tiles >= 99.5% white in BOTH images are marked empty and excluded.
 * Classification per tile (pixelmatch, threshold 0.1, includeAA false):
 *   pass < 2% · warn 2–8% · fail > 8%
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs, fail } from "./lib/args.mjs";
import {
  loadRun,
  selectFrame,
  accuracyDir,
  referenceFor,
  comparisonScale,
} from "./lib/manifest.mjs";
import { readPng, writePng, normalizeHeights, tileGrid, overlay, TILE_CSS_PX } from "./lib/png.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const runDir = positional[0];
if (!runDir) fail("Usage: node <tools-dir>/grid-diff.mjs <run-dir> [--frame s] [--reference png] [--build png] [--out dir] [--scale n] [--baseline report]");

let run;
try {
  run = loadRun(runDir);
} catch (e) {
  // 0.1.x behaviour: a run without a manifest still diffs with defaults.
  run = { runPath: resolve(runDir), manifest: { input: { exportScale: 2 } }, frames: null };
}
const { runPath, manifest } = run;
const frame = run.frames ? selectFrame(run.frames, opts.frame) : { index: 0, state: "default", reference: null };

const ref = opts.reference
  ? { path: resolve(opts.reference), scale: null, source: "explicit" }
  : referenceFor(runPath, frame, manifest);
const outDir = opts.out ? resolve(opts.out) : accuracyDir(runPath, frame);
const buildPath = opts.build ? resolve(opts.build) : join(outDir, "build@2x.png");
const scale = opts.scale ? Number(opts.scale) : ref.scale ?? comparisonScale(frame, manifest);

for (const p of [ref.path, buildPath]) {
  if (!existsSync(p)) fail(`Missing input image: ${p}`);
}
mkdirSync(outDir, { recursive: true });

let design;
let build;
let padded;
try {
  const n = normalizeHeights(readPng(ref.path), readPng(buildPath));
  design = n.a;
  build = n.b;
  padded = n.padded;
} catch (e) {
  fail(e.message.replace("a:", "design:").replace("b:", "build:"));
}

const grid = tileGrid(design, build, scale);
const rel = (p) => relative(runPath, p) || p;

const report = {
  tileSizePx: TILE_CSS_PX,
  exportScale: scale,
  comparison: {
    frame: frame.id ?? null,
    state: frame.state,
    reference: rel(ref.path),
    referenceSource: ref.source,
    build: rel(buildPath),
    scale,
  },
  imagePx: { width: design.width, height: design.height },
  heightNormalization: padded,
  grid: { cols: grid.cols, rows: grid.rows },
  summary: grid.summary,
  tiles: grid.tiles,
};

// ---- baseline carry-forward -------------------------------------------------
if (opts.baseline) {
  const basePath = resolve(opts.baseline);
  if (!existsSync(basePath)) fail(`Baseline report not found: ${basePath}`);
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const key = (t) => `${t.col},${t.row}`;
  const prev = new Map((base.tiles ?? []).map((t) => [key(t), t]));

  // Per-tile classification from the previous run: explicit tileClassification
  // (object or array) first, else derived from findings[].tiles.
  const prevClass = new Map();
  const tc = base.tileClassification;
  for (const t of Array.isArray(tc) ? tc : Object.values(tc ?? {})) {
    if (t && t.col !== undefined) prevClass.set(key(t), { classification: t.classification, finding: t.finding ?? null });
  }
  for (const f of base.findings ?? []) {
    for (const t of f.tiles ?? []) {
      const k = typeof t === "string" ? t : key(t);
      if (!prevClass.has(k)) prevClass.set(k, { classification: f.classification ?? null, finding: f.id ?? f.region ?? null });
    }
  }

  const tileClassDeltas = [];
  const newNonPassTiles = [];
  const resolvedTiles = [];
  const carriedClassification = {};
  for (const t of grid.tiles) {
    const p = prev.get(key(t));
    const nowNonPass = !t.empty && t.class !== "pass";
    const wasNonPass = p && !p.empty && p.class !== "pass";
    if (p && (p.class !== t.class || p.mismatchPct !== t.mismatchPct)) {
      tileClassDeltas.push({ col: t.col, row: t.row, before: [p.class ?? "empty", p.mismatchPct ?? null], after: [t.class ?? "empty", t.mismatchPct ?? null] });
    }
    if (nowNonPass && !wasNonPass) newNonPassTiles.push(t);
    if (!nowNonPass && wasNonPass) resolvedTiles.push({ col: t.col, row: t.row });
    if (nowNonPass && prevClass.has(key(t))) carriedClassification[key(t)] = prevClass.get(key(t));
  }
  report.baseline = {
    path: rel(basePath),
    summary: base.summary ?? null,
    tileClassDeltas,
    newNonPassTiles,
    resolvedTiles,
    carriedClassification,
    carriedCount: Object.keys(carriedClassification).length,
    uncarriedNonPass: grid.tiles.filter((t) => !t.empty && t.class !== "pass" && !carriedClassification[key(t)]).map((t) => ({ col: t.col, row: t.row, class: t.class, mismatchPct: t.mismatchPct })),
  };
}

writeFileSync(join(outDir, "diff-report.json"), JSON.stringify(report, null, 2));
writePng(join(outDir, "overlay.png"), overlay(design, build));

const s = grid.summary;
let line =
  `Grid ${grid.cols}x${grid.rows} (${TILE_CSS_PX}px tiles @ ${scale}x) — ` +
  `${s.nonEmptyTiles} non-empty tiles: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail — passPct ${s.passPct}%`;
if (padded) line += ` (padded: ${JSON.stringify(padded)})`;
if (report.baseline) {
  const b = report.baseline;
  line += `\nvs baseline: ${b.tileClassDeltas.length} tile delta(s), ${b.newNonPassTiles.length} new non-pass, ${b.resolvedTiles.length} resolved, ${b.carriedCount} classification(s) carried, ${b.uncarriedNonPass.length} to adjudicate`;
}
console.log(line);
