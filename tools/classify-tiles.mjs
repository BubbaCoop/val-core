#!/usr/bin/env node
/**
 * Val tool — turn grid-diff's non-pass tiles into named findings with numeric
 * evidence, so the accuracy agent adjudicates a short list instead of probing
 * tile by tile.
 *
 * Usage: node <tools-dir>/classify-tiles.mjs <run-dir> [flags]
 *
 *   --frame <state|index>   frame whose diff-report/layout to use (default: primary)
 *   --report <json>         diff-report.json to read (default: the frame's 06-accuracy/)
 *   --accepted <json>       accepted deviations: [{ id, figmaNode?, tiles?: [[col,row]], note? }]
 *   --crops                 write a native-scale reference|build crop per needs-review finding
 *   --crops all             …per finding
 *   --out <dir>             where crops go (default: <accuracy-dir>/crops/)
 *
 * For every warn/fail tile: map it to the layout.json region with the largest
 * overlap (instances preferred over containers), group tiles by region into a
 * finding, and measure on the finding's box in both images:
 *   colour histograms (top 4) and whether the colour sets match byte-for-byte
 *   (±6/channel), ink bounding boxes against the dominant colour and their
 *   deltas, the best horizontal shift within ±4 device px and the residual
 *   mismatch after shifting, and the direct mismatch.
 *
 * Pre-labels — CANDIDATES for the agent to confirm, never a verdict:
 *   accepted-candidate    region or tile is in --accepted
 *   artifact-candidate    colours match, |shift| ≤ 2 dev px, ink box deltas ≤ 2,
 *                         residual after shift < direct (the rasterizer signature)
 *   needs-review          everything else — the agent looks at these
 *
 * Writes autoFindings + autoClassificationSummary into the diff-report (never
 * touching the agent's own findings/classificationSummary). Prints ≤ 40 lines.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, fail, printCapped } from "./lib/args.mjs";
import { loadRun, selectFrame, accuracyDir, loadLayout, resolveRunPath, referenceFor } from "./lib/manifest.mjs";
import {
  readPng,
  writePng,
  normalizeHeights,
  tileBox,
  unionBox,
  intersectionArea,
  colourHistogram,
  coloursMatch,
  inkBBox,
  bestHorizontalShift,
  regionMismatch,
  sideBySide,
  cssToDeviceBox,
  TILE_CSS_PX,
} from "./lib/png.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2), { booleans: [] });
const runDir = positional[0];
if (!runDir) fail("Usage: node <tools-dir>/classify-tiles.mjs <run-dir> [--frame s] [--report json] [--accepted json] [--crops [all]] [--out dir]");

let run;
try {
  run = loadRun(runDir);
} catch (e) {
  fail(e.message);
}
const { runPath, manifest, frames } = run;
const frame = selectFrame(frames, opts.frame);
const accDir = accuracyDir(runPath, frame);
const reportPath = opts.report ? resolve(opts.report) : join(accDir, "diff-report.json");
if (!existsSync(reportPath)) fail(`No diff-report at ${reportPath} — run grid-diff first`);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const scale = report.exportScale ?? 2;
const tilePx = (report.tileSizePx ?? TILE_CSS_PX) * scale;

const refPath = report.comparison?.reference ? resolveRunPath(runPath, report.comparison.reference) : referenceFor(runPath, frame, manifest).path;
const buildPath = report.comparison?.build ? resolveRunPath(runPath, report.comparison.build) : join(accDir, "build@2x.png");
for (const p of [refPath, buildPath]) if (!existsSync(p)) fail(`Missing image: ${p}`);
let ref;
let build;
try {
  const n = normalizeHeights(readPng(refPath), readPng(buildPath));
  ref = n.a;
  build = n.b;
} catch (e) {
  fail(e.message);
}

const layout = loadLayout(runPath, frame);
const regions = (layout?.regions ?? []).map((r) => ({ ...r, device: cssToDeviceBox(r, scale) }));
const rank = (kind) => (kind === "instance" ? 3 : kind === "divider" ? 2 : 1);

let accepted = [];
if (opts.accepted) {
  const p = resolve(opts.accepted);
  if (!existsSync(p)) fail(`Accepted list not found: ${p}`);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  accepted = Array.isArray(raw) ? raw : raw.accepted ?? [];
}
const acceptedByNode = new Map(accepted.filter((a) => a.figmaNode).map((a) => [a.figmaNode, a]));
const acceptedByTile = new Map();
for (const a of accepted) for (const t of a.tiles ?? []) acceptedByTile.set(`${t[0]},${t[1]}`, a);

// ---- map tiles to regions -----------------------------------------------------
const nonPass = (report.tiles ?? []).filter((t) => !t.empty && t.class !== "pass");
const groups = new Map(); // key -> { region|null, tiles[] }
// An instance or divider needs a non-trivial overlap to claim a tile (a
// one-pixel sliver of a neighbour must not steal it); containers never beat
// an instance, and among containers the smallest (most specific) wins.
const minClaim = Math.max(64, 0.02 * tilePx * tilePx);
for (const t of nonPass) {
  const tb = tileBox(t, tilePx, ref.width, ref.height);
  let best = null;
  for (const r of regions) {
    const area = intersectionArea(tb, r.device);
    if (!area) continue;
    const rk = rank(r.kind);
    if (rk > 1 && area < minClaim) continue;
    const regionArea = (r.device.x1 - r.device.x0 + 1) * (r.device.y1 - r.device.y0 + 1);
    const cand = { r, rk, area, regionArea };
    const wins =
      !best ||
      cand.rk > best.rk ||
      (cand.rk === best.rk && (cand.rk > 1 ? cand.area > best.area : cand.regionArea < best.regionArea));
    if (wins) best = cand;
  }
  best = best?.r ?? null;
  const key = best ? best.figmaNode : `unmapped:${t.row}`; // unmapped tiles group by row
  if (!groups.has(key)) groups.set(key, { region: best, tiles: [] });
  groups.get(key).tiles.push({ ...t, device: tb });
}

// ---- measure each finding -------------------------------------------------------
const findings = [];
let n = 0;
for (const [key, g] of groups) {
  n++;
  const id = `A${String(n).padStart(2, "0")}`;
  const tilesUnion = unionBox(g.tiles.map((t) => t.device));
  // Measure on the region box clipped to the tiles' union when mapped, else the union.
  const box = g.region
    ? {
        x0: Math.max(g.region.device.x0, tilesUnion.x0),
        y0: Math.max(g.region.device.y0, tilesUnion.y0),
        x1: Math.min(g.region.device.x1, tilesUnion.x1),
        y1: Math.min(g.region.device.y1, tilesUnion.y1),
      }
    : tilesUnion;
  if (box.x1 < box.x0 || box.y1 < box.y0) Object.assign(box, tilesUnion);

  const histRef = colourHistogram(ref, box);
  const histBuild = colourHistogram(build, box);
  const match = coloursMatch(histRef, histBuild);
  const bgRef = histRef[0]?.rgb ?? [255, 255, 255];
  const bgBuild = histBuild[0]?.rgb ?? bgRef;
  const inkRef = inkBBox(ref, box, bgRef);
  const inkBuild = inkBBox(build, box, bgBuild);
  const inkDelta = inkRef && inkBuild ? { dx: inkBuild.x0 - inkRef.x0, dy: inkBuild.y0 - inkRef.y0, dw: inkBuild.w - inkRef.w, dh: inkBuild.h - inkRef.h } : null;
  const shift = bestHorizontalShift(ref, build, box);
  const direct = regionMismatch(ref, build, box);

  const acc = (g.region && acceptedByNode.get(g.region.figmaNode)) || g.tiles.map((t) => acceptedByTile.get(`${t.col},${t.row}`)).find(Boolean) || null;
  let preClass;
  let why;
  if (acc) {
    preClass = "accepted-candidate";
    why = `matches accepted deviation ${acc.id ?? "(unnamed)"}`;
  } else if (
    match &&
    Math.abs(shift.shift) <= 2 &&
    inkDelta &&
    Math.abs(inkDelta.dw) <= 2 &&
    Math.abs(inkDelta.dh) <= 2 &&
    Math.abs(inkDelta.dy) <= 2 &&
    shift.mismatchPct < shift.directPct
  ) {
    preClass = "artifact-candidate";
    why = `colours match byte-for-byte; ink box Δ ${fmtDelta(inkDelta)}; shift ${shift.shift}px cuts mismatch ${r1(shift.directPct)}% → ${r1(shift.mismatchPct)}%`;
  } else if (
    match &&
    inkDelta &&
    Math.abs(inkDelta.dx) <= 1 &&
    Math.abs(inkDelta.dy) <= 1 &&
    Math.abs(inkDelta.dw) <= 1 &&
    Math.abs(inkDelta.dh) <= 1 &&
    direct.pct <= 8
  ) {
    // Same colours, same ink footprint, sub-fail mismatch, no shift to explain
    // it: glyph antialiasing — the other rasterizer signature.
    preClass = "artifact-candidate";
    why = `colours match byte-for-byte and the ink footprint is identical (Δ ${fmtDelta(inkDelta)}); ${r1(direct.pct)}% mismatch with no shift is antialiasing`;
  } else {
    preClass = "needs-review";
    why = [
      match ? "colours match" : `colour sets differ (ref ${histRef.slice(0, 2).map((h) => h.rgb.join(",")).join(" / ")} vs build ${histBuild.slice(0, 2).map((h) => h.rgb.join(",")).join(" / ")})`,
      inkDelta ? `ink box Δ ${fmtDelta(inkDelta)}` : inkRef || inkBuild ? "ink present in only one image" : "no ink either side",
      `best shift ${shift.shift}px: ${r1(shift.directPct)}% → ${r1(shift.mismatchPct)}%`,
    ].join("; ");
  }

  findings.push({
    id,
    figmaNode: g.region?.figmaNode ?? null,
    region: g.region?.name ?? "(unmapped)",
    kind: g.region?.kind ?? null,
    componentKey: g.region?.componentKey ?? null,
    tiles: g.tiles.map((t) => ({ col: t.col, row: t.row, class: t.class, mismatchPct: t.mismatchPct })),
    tileCount: g.tiles.length,
    box: { device: box, css: { x: Math.floor(box.x0 / scale), y: Math.floor(box.y0 / scale), w: Math.ceil((box.x1 - box.x0 + 1) / scale), h: Math.ceil((box.y1 - box.y0 + 1) / scale) } },
    evidence: {
      directMismatchPct: r1(direct.pct),
      coloursMatch: match,
      histogram: { reference: histRef.map(hEntry), build: histBuild.map(hEntry) },
      ink: { reference: inkRef && strip(inkRef), build: inkBuild && strip(inkBuild), delta: inkDelta },
      horizontalShift: { shift: shift.shift, mismatchPctAfterShift: r1(shift.mismatchPct) },
    },
    preClassification: preClass,
    rationale: why,
    acceptedId: acc?.id ?? null,
  });
}

// ---- crops ------------------------------------------------------------------------
let cropsWritten = 0;
if (opts.crops) {
  const cropDir = opts.out ? resolve(opts.out) : join(accDir, "crops");
  mkdirSync(cropDir, { recursive: true });
  for (const f of findings) {
    if (opts.crops !== "all" && f.preClassification !== "needs-review") continue;
    const b = f.box.device;
    const pad = 4 * scale;
    const png = sideBySide(ref, build, { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
    const p = join(cropDir, `${f.id}-${(f.region || "unmapped").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40)}.png`);
    writePng(p, png);
    f.crop = p;
    cropsWritten++;
  }
}

// ---- write + print ------------------------------------------------------------------
const counts = { "accepted-candidate": 0, "artifact-candidate": 0, "needs-review": 0 };
for (const f of findings) counts[f.preClassification]++;
report.autoFindings = findings;
report.autoClassificationSummary = {
  nonPassTiles: nonPass.length,
  findings: findings.length,
  ...counts,
  layoutUsed: !!layout,
  acceptedListUsed: !!opts.accepted,
  note: "pre-classification by numeric evidence; the accuracy agent confirms each finding into (a)/(b)/(c) and writes findings + classificationSummary",
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));

const lines = [];
lines.push(`${nonPass.length} non-pass tile(s) → ${findings.length} finding(s): ${counts["accepted-candidate"]} accepted-candidate, ${counts["artifact-candidate"]} artifact-candidate, ${counts["needs-review"]} needs-review${layout ? "" : "  (no layout.json — findings are unmapped tile groups)"}`);
const order = { "needs-review": 0, "artifact-candidate": 1, "accepted-candidate": 2 };
for (const f of [...findings].sort((p, q) => order[p.preClassification] - order[q.preClassification])) {
  lines.push(`  ${f.id} ${f.preClassification.padEnd(18)} ${f.region}${f.figmaNode ? ` (${f.figmaNode})` : ""} · ${f.tileCount} tile(s) · ${f.evidence.directMismatchPct}% — ${f.rationale}${f.crop ? ` → ${f.crop}` : ""}`);
}
if (cropsWritten) lines.push(`${cropsWritten} crop(s) written`);
lines.push(`Report: ${reportPath} (autoFindings, autoClassificationSummary)`);
printCapped(lines, 40);

function r1(x) {
  return Math.round(x * 10) / 10;
}
function hEntry(h) {
  return { rgb: h.rgb, share: Math.round(h.share * 1000) / 1000 };
}
function strip(b) {
  return { x0: b.x0, y0: b.y0, w: b.w, h: b.h };
}
function fmtDelta(d) {
  return `dx ${d.dx} dy ${d.dy} dw ${d.dw} dh ${d.dh}`;
}
