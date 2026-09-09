#!/usr/bin/env node
/**
 * Val tool — did a rework change only what it was asked to, and did it make
 * every fix region better (or at least not worse) against the reference?
 * Costs no model tokens; run it before dispatching QA on a reworked build.
 *
 * Usage: node <tools-dir>/regression-check.mjs <run-dir> --before <png> --after <png> [flags]
 *
 *   --reference <png>       the design reference for the same frame/scale; when
 *                           given, each fix region's mismatch is measured
 *                           ref-vs-before and ref-vs-after and must not grow
 *   --fixlist <json>        the orchestrator's fix list (array of entries). A
 *                           fix region comes from entry.box {x,y,w,h} (CSS px)
 *                           or from entry.figmaNode via the frame's layout.json
 *   --frame <state|index>   frame whose layout.json resolves figmaNode boxes
 *   --scale <n>             device scale of the captures (default: the frame's
 *                           comparison scale)
 *   --margin <px>           CSS px of slack around each fix region (default 2)
 *   --out <json>            report path (default <run-dir>/04-build/regression-check.json)
 *
 * Verdict: PASS when every changed cluster lies inside a fix region and no fix
 * region got worse against the reference. Without --fixlist the changed
 * clusters are reported and scope is not asserted (exit 0, verdict INFO).
 * Dimension change between before and after is always FAIL.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs, fail, printCapped } from "./lib/args.mjs";
import { loadRun, selectFrame, loadLayout, regionByNode, comparisonScale } from "./lib/manifest.mjs";
import { readPng, changedClusters, boxContains, regionMismatch, cssToDeviceBox } from "./lib/png.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const runDir = positional[0];
if (!runDir || !opts.before || !opts.after) {
  fail("Usage: node <tools-dir>/regression-check.mjs <run-dir> --before <png> --after <png> [--reference png] [--fixlist json] [--frame s] [--scale n] [--margin px] [--out json]");
}

let run;
try {
  run = loadRun(runDir);
} catch (e) {
  fail(e.message);
}
const { runPath, manifest, frames } = run;
const frame = selectFrame(frames, opts.frame);
const scale = opts.scale ? Number(opts.scale) : comparisonScale(frame, manifest);
const margin = (opts.margin ? Number(opts.margin) : 2) * scale;
const outPath = opts.out ? resolve(opts.out) : join(runPath, "04-build", "regression-check.json");
const rel = (p) => relative(runPath, p) || p;

for (const p of [opts.before, opts.after, opts.reference].filter(Boolean)) {
  if (!existsSync(resolve(p))) fail(`Missing image: ${p}`);
}
const before = readPng(resolve(opts.before));
const after = readPng(resolve(opts.after));

const report = {
  before: rel(resolve(opts.before)),
  after: rel(resolve(opts.after)),
  reference: opts.reference ? rel(resolve(opts.reference)) : null,
  scale,
  frame: frame.id ?? null,
  state: frame.state,
};

if (before.width !== after.width || before.height !== after.height) {
  report.verdict = "FAIL";
  report.reason = `capture dimensions changed: before ${before.width}x${before.height}, after ${after.width}x${after.height} — a layout regression, or captures at different scales/states`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`✗ REGRESSION — ${report.reason}`);
  process.exit(1);
}

const { total, clusters } = changedClusters(before, after);
report.changedPixels = total;
report.clusters = clusters.slice(0, 50).map((c) => ({ ...c, css: { x: Math.floor(c.x0 / scale), y: Math.floor(c.y0 / scale), w: Math.ceil(c.w / scale), h: Math.ceil(c.h / scale) } }));

// ---- fix regions -------------------------------------------------------------
let fixRegions = [];
if (opts.fixlist) {
  const listPath = resolve(opts.fixlist);
  if (!existsSync(listPath)) fail(`Fix list not found: ${listPath}`);
  const raw = JSON.parse(readFileSync(listPath, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.fixList ?? raw.fixes ?? [];
  const layout = loadLayout(runPath, frame);
  const resolveBox = (e) => {
    if (e.box) return { cssBox: e.box, via: "box" };
    if (e.figmaNode && layout) {
      const r = regionByNode(layout, e.figmaNode);
      if (r) return { cssBox: { x: r.x, y: r.y, w: r.w, h: r.h }, via: "layout.json" };
    }
    return null;
  };
  const push = (e, role, id) => {
    const res = resolveBox(e);
    if (!res) {
      fixRegions.push({ id, role, figmaNode: e.figmaNode ?? null, unresolved: true });
      return;
    }
    fixRegions.push({ id, role, figmaNode: e.figmaNode ?? null, via: res.via, css: res.cssBox, device: cssToDeviceBox(res.cssBox, scale, margin) });
  };
  for (const e of entries) {
    push(e, "fix", e.id ?? null);
    // Siblings: elements in the same component the fix must leave alone. A
    // change there is in scope (the fix may repaint the component) but the
    // region must not get WORSE against the reference — the F13 shape: the
    // label was fixed while the arrow beside it regressed.
    for (const s of e.siblings ?? []) {
      const sib = typeof s === "string" ? { name: s } : s;
      push(sib, "sibling", `${e.id ?? "fix"}:sibling:${sib.name ?? sib.figmaNode ?? "?"}`);
    }
  }
}
const resolved = fixRegions.filter((r) => !r.unresolved);
report.fixRegions = fixRegions;

// ---- scope: every cluster inside some fix region --------------------------------
const outOfScope = [];
if (opts.fixlist) {
  for (const c of clusters) {
    if (!resolved.some((r) => boxContains(r.device, c))) outOfScope.push(c);
  }
}
report.outOfScope = outOfScope.slice(0, 50).map((c) => ({ ...c, css: { x: Math.floor(c.x0 / scale), y: Math.floor(c.y0 / scale), w: Math.ceil(c.w / scale), h: Math.ceil(c.h / scale) } }));

// ---- direction: did each fix region get better against the reference? -------------
const worse = [];
if (opts.reference) {
  const ref = readPng(resolve(opts.reference));
  if (ref.width !== before.width) {
    fail(`Reference width ${ref.width} ≠ capture width ${before.width} — pass the reference for this frame/scale`);
  }
  for (const r of resolved) {
    const b = regionMismatch(ref, before, r.device);
    const a = regionMismatch(ref, after, r.device);
    r.mismatch = { before: round1(b.pct), after: round1(a.pct), beforeCount: b.count, afterCount: a.count };
    if (a.count > b.count) worse.push(r);
  }
}
report.worse = worse.map((r) => ({ id: r.id, role: r.role, figmaNode: r.figmaNode, mismatch: r.mismatch }));

const unresolved = fixRegions.filter((r) => r.unresolved);
let verdict;
if (!opts.fixlist) verdict = "INFO";
else if (outOfScope.length || worse.length) verdict = "FAIL";
else verdict = "PASS";
report.verdict = verdict;
report.note = !opts.fixlist
  ? "no --fixlist: change footprint reported, scope not asserted"
  : unresolved.length
    ? `${unresolved.length} fix/sibling entr${unresolved.length === 1 ? "y" : "ies"} had no box/figmaNode resolvable via layout.json — their scope could not be checked (${unresolved.map((r) => r.id).join(", ")})`
    : null;
writeFileSync(outPath, JSON.stringify(report, null, 2));

const lines = [];
const mark = verdict === "PASS" ? "✓" : verdict === "FAIL" ? "✗" : "·";
lines.push(`${mark} ${verdict}: ${total} px changed in ${clusters.length} cluster(s) @${scale}x` + (opts.fixlist ? ` — ${resolved.length} fix region(s), ${outOfScope.length} cluster(s) out of scope, ${worse.length} region(s) worse vs reference` : ""));
for (const c of clusters.slice(0, 8)) {
  lines.push(`    cluster ${c.count} px at device x[${c.x0},${c.x1}] y[${c.y0},${c.y1}] (css ${Math.floor(c.x0 / scale)},${Math.floor(c.y0 / scale)} ${Math.ceil(c.w / scale)}x${Math.ceil(c.h / scale)})${opts.fixlist ? (outOfScope.includes(c) ? "  ← OUT OF SCOPE" : "  in scope") : ""}`);
}
for (const r of resolved) {
  if (r.mismatch) lines.push(`    ${r.role} ${r.id ?? r.figmaNode}: mismatch vs reference ${r.mismatch.before}% → ${r.mismatch.after}%${worse.includes(r) ? "  ← WORSE" : ""}`);
}
if (report.note) lines.push(`    note: ${report.note}`);
lines.push(`Report: ${outPath}`);
printCapped(lines, 25);
process.exit(verdict === "FAIL" ? 1 : 0);

function round1(n) {
  return Math.round(n * 10) / 10;
}
