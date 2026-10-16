#!/usr/bin/env node
/**
 * Val tool — has a Figma frame changed since a prior run extracted it? Decides whether a
 * re-run may reuse the prior run's extraction for that frame instead of paying for a fresh
 * one. Costs no model tokens.
 *
 * Usage: node <tools-dir>/frame-diff.mjs --prior <png> --current <png> \
 *          --prior-fingerprint <json> --current-fingerprint <json> [flags]
 *
 *   --prior <png>                  the prior run's MCP export of the frame
 *   --current <png>                a fresh MCP export of the same frame, same scale
 *   --prior-fingerprint <json>     the prior extraction's fingerprint.json (or its raw
 *                                  structure snapshot)
 *   --current-fingerprint <json>   the same for the fresh snapshot
 *   --prior-layout <json>          optional: the prior layout.json, to name the regions a
 *   --current-layout <json>        pixel cluster falls in and to catch moved nodes
 *   --tolerance <n>                per-channel delta ignored as render noise (default 8;
 *                                  two MCP exports of an unchanged frame differ by 1 on most
 *                                  pixels and by up to ~5 around raster assets)
 *   --out <json>                   report path (default: print only)
 *
 * Two independent checks, reported separately:
 *   pixels     — no pixel differs beyond the tolerance and the size matches; with layouts,
 *                no shared node moved or resized by >= 1px and no prior node is missing
 *   structure  — the fingerprints match: same node tree, main components and variant
 *                properties, variable bindings, style ids and auto-layout props
 * UNCHANGED only when both match. Structure is what pixels cannot see: a fill rebound to a
 * different variable with the same value renders identically and is still CHANGED, because
 * the prior figma.json would carry the stale binding into every later stage. Likewise a
 * paint-only change is CHANGED on purpose.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, fail, printCapped } from "./lib/args.mjs";
import { readPng, changedClusters, boxesIntersect } from "./lib/png.mjs";
import { asFingerprint, diffFingerprints } from "./lib/fingerprint.mjs";

const { opts } = parseArgs(process.argv.slice(2));
const USAGE =
  "Usage: node frame-diff.mjs --prior <png> --current <png> --prior-fingerprint <json> --current-fingerprint <json> " +
  "[--prior-layout json --current-layout json] [--tolerance n] [--out json]";
if (!opts.prior || !opts.current) fail(USAGE);
if (!opts["prior-fingerprint"] || !opts["current-fingerprint"]) {
  fail(
    "frame-diff: --prior-fingerprint and --current-fingerprint are required — pixels alone cannot see a " +
      "same-colour variable rebind. A prior run with no fingerprint.json cannot be reused; extract the frame in full.\n" +
      USAGE,
  );
}
for (const k of ["prior", "current", "prior-fingerprint", "current-fingerprint", "prior-layout", "current-layout"]) {
  if (opts[k] && !existsSync(opts[k])) fail(`frame-diff: no such file ${opts[k]}`);
}
if (Boolean(opts["prior-layout"]) !== Boolean(opts["current-layout"])) {
  fail("frame-diff: pass both --prior-layout and --current-layout, or neither");
}
const tolerance = opts.tolerance === undefined ? 8 : Number(opts.tolerance);
if (!Number.isFinite(tolerance) || tolerance < 0) fail(`frame-diff: bad --tolerance ${opts.tolerance}`);

// ---- pixels ---------------------------------------------------------------------------------
const prior = readPng(opts.prior);
const current = readPng(opts.current);
const pixels = {
  verdict: null,
  tolerance,
  size: { prior: [prior.width, prior.height], current: [current.width, current.height] },
  changed: null,
  clusters: [],
  layout: null,
  reasons: [],
};
if (prior.width !== current.width || prior.height !== current.height) {
  pixels.reasons.push(`size ${prior.width}x${prior.height} -> ${current.width}x${current.height}`);
} else {
  const { total, clusters } = changedClusters(prior, current, 16, tolerance);
  pixels.changed = total;
  pixels.clusters = clusters.map((c) => ({ x: c.x0, y: c.y0, w: c.w, h: c.h, count: c.count }));
  if (total) pixels.reasons.push(`${total} px differ beyond tolerance ${tolerance} in ${clusters.length} cluster(s)`);
}

if (opts["prior-layout"]) {
  const regions = (p) => {
    const l = JSON.parse(readFileSync(p, "utf8"));
    return new Map((l.regions ?? []).filter((r) => r.figmaNode).map((r) => [r.figmaNode, r]));
  };
  const before = regions(opts["prior-layout"]);
  const after = regions(opts["current-layout"]);
  const moved = [];
  const removed = [];
  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) {
      removed.push({ figmaNode: id, name: a.name });
      continue;
    }
    const d = { dx: b.x - a.x, dy: b.y - a.y, dw: b.w - a.w, dh: b.h - a.h };
    if (Object.values(d).some((v) => Math.abs(v) >= 1)) moved.push({ figmaNode: id, name: a.name, ...d });
  }
  // Nodes only in the current layout do not block: extraction granularity varies between runs.
  const added = [...after.keys()].filter((id) => !before.has(id)).map((id) => ({ figmaNode: id, name: after.get(id).name }));
  pixels.layout = { moved, removed, added };
  if (moved.length) pixels.reasons.push(`${moved.length} node(s) moved or resized`);
  if (removed.length) pixels.reasons.push(`${removed.length} prior node(s) missing from the layout`);

  const edges = (b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 });
  const all = [...after.values()];
  for (const c of pixels.clusters) {
    const box = edges(c);
    c.regions = all
      .filter((r) => boxesIntersect(box, edges(r)))
      .sort((p, q) => p.w * p.h - q.w * q.h)
      .slice(0, 3)
      .map((r) => `${r.figmaNode} ${r.name ?? ""}`.trim());
  }
}
pixels.verdict = pixels.reasons.length ? "CHANGED" : "MATCH";

// ---- structure ------------------------------------------------------------------------------
const load = (p) => {
  try {
    return asFingerprint(JSON.parse(readFileSync(p, "utf8")));
  } catch (e) {
    fail(`frame-diff: ${p}: ${e.message}`);
  }
};
const fpPrior = load(opts["prior-fingerprint"]);
const fpCurrent = load(opts["current-fingerprint"]);
if (fpPrior.frame !== fpCurrent.frame) {
  fail(`frame-diff: fingerprints are of different frames (${fpPrior.frame} vs ${fpCurrent.frame})`);
}
const sd = diffFingerprints(fpPrior, fpCurrent);
const structure = {
  verdict: sd.same ? "MATCH" : "CHANGED",
  prior: fpPrior.hash,
  current: fpCurrent.hash,
  added: sd.added,
  removed: sd.removed,
  changed: sd.changed,
  reasons: [],
};
if (!sd.same) {
  const parts = [];
  if (sd.changed.length) parts.push(`${sd.changed.length} node(s) changed`);
  if (sd.added.length) parts.push(`${sd.added.length} added`);
  if (sd.removed.length) parts.push(`${sd.removed.length} removed`);
  structure.reasons.push(parts.join(", "));
}

// ---- verdict --------------------------------------------------------------------------------
const changedChecks = [pixels.verdict === "CHANGED" && "pixels", structure.verdict === "CHANGED" && "structure"].filter(Boolean);
const report = {
  prior: opts.prior,
  current: opts.current,
  verdict: changedChecks.length ? "CHANGED" : "UNCHANGED",
  changedChecks,
  pixels,
  structure,
};
if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2) + "\n");

const lines = [
  `FRAME-DIFF: ${report.verdict}${changedChecks.length ? ` (${changedChecks.join(" + ")})` : ""} | ` +
    `PIXELS: ${pixels.verdict}${pixels.reasons.length ? " — " + pixels.reasons.join("; ") : ""} | ` +
    `STRUCTURE: ${structure.verdict}${structure.reasons.length ? " — " + structure.reasons.join("; ") : ""}`,
];
for (const c of pixels.clusters) {
  lines.push(`  pixels: ${c.x},${c.y} ${c.w}x${c.h} (${c.count} px)${c.regions?.length ? " — " + c.regions.join(", ") : ""}`);
}
for (const m of pixels.layout?.moved ?? []) lines.push(`  moved: ${m.figmaNode} ${m.name ?? ""} dx${m.dx} dy${m.dy} dw${m.dw} dh${m.dh}`);
for (const r of pixels.layout?.removed ?? []) lines.push(`  missing from layout: ${r.figmaNode} ${r.name ?? ""}`);
for (const c of structure.changed) {
  for (const f of c.fields) {
    lines.push(`  structure: ${c.id} ${c.name ?? ""} ${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`);
  }
}
for (const a of structure.added) lines.push(`  structure: added ${a.id} ${a.name ?? ""}`);
for (const r of structure.removed) lines.push(`  structure: removed ${r.id} ${r.name ?? ""}`);
printCapped(lines);
