/**
 * Fixture tests for <tools-dir>/frame-diff.mjs — the re-run reuse check.
 *
 * Pixels: a 200x120 frame with one block (node 1:2) and a row (node 1:3). The tolerance default
 * (8) was calibrated on two real MCP exports of one unchanged BSA frame a month apart: Δ1 on
 * most pixels (colour rounding), up to Δ5 around raster assets, real edits all above 8.
 * Structure: the real Plain Text Field snapshot in tools/figma/ (see fingerprint.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blank, writePng } from "./lib/png.mjs";
import { fingerprint } from "./lib/fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "frame-diff.mjs");
const SNAPSHOT = JSON.parse(readFileSync(join(HERE, "figma", "plain-text-field.snapshot.json"), "utf8"));
const GLYPH = "I199:12076;1:298;202:382";

function rect(png, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * png.width + xx) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b;
  }
}
function frame({ shade = 0, ink = [30, 30, 30], w = 200 } = {}) {
  const png = blank(w, 120, [255 - shade, 253 - shade, 251 - shade]);
  rect(png, 20, 20, 60, 30, ink);
  return png;
}
/** The real snapshot with the "$" glyph rebound from Neutral/Base to Text/Tertiary — same #6F7276. */
function rebound() {
  const s = structuredClone(SNAPSHOT);
  const g = s.nodes.find((n) => n.id === GLYPH);
  g.boundVariables.fills = ["VariableID:1:73"];
  g.fillBindings = [{ color: "VariableID:1:73" }];
  return s;
}
const layout = (regions) => ({ frame: "1:1", w: 200, h: 120, regions });
const BLOCK = { figmaNode: "1:2", name: "Block", kind: "instance", x: 20, y: 20, w: 60, h: 30 };
const ROW = { figmaNode: "1:3", name: "Row", kind: "region", x: 0, y: 80, w: 200, h: 40 };

function run({ prior, current, priorSnap = SNAPSHOT, currentSnap = SNAPSHOT, stored = false, priorLayout, currentLayout, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "frame-diff-"));
  const p = (n) => join(dir, n);
  writePng(p("prior.png"), prior);
  writePng(p("current.png"), current);
  // stored: the prior side is a fingerprint.json as val-figma keeps it; else a raw snapshot.
  writeFileSync(p("prior-fp.json"), JSON.stringify(stored ? fingerprint(priorSnap) : priorSnap));
  writeFileSync(p("current-fp.json"), JSON.stringify(currentSnap));
  const argv = [
    TOOL, "--prior", p("prior.png"), "--current", p("current.png"),
    "--prior-fingerprint", p("prior-fp.json"), "--current-fingerprint", p("current-fp.json"),
    "--out", p("r.json"), ...args,
  ];
  if (priorLayout) {
    writeFileSync(p("pl.json"), JSON.stringify(layout(priorLayout)));
    writeFileSync(p("cl.json"), JSON.stringify(layout(currentLayout)));
    argv.push("--prior-layout", p("pl.json"), "--current-layout", p("cl.json"));
  }
  const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
  return { ...r, report: r.status === 0 ? JSON.parse(readFileSync(p("r.json"), "utf8")) : null };
}

test("matching pixels and matching structure are UNCHANGED", () => {
  const r = run({ prior: frame(), current: frame(), priorLayout: [BLOCK, ROW], currentLayout: [BLOCK, ROW] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.verdict, "UNCHANGED");
  assert.deepEqual(r.report.changedChecks, []);
  assert.match(r.stdout, /^FRAME-DIFF: UNCHANGED \| PIXELS: MATCH \| STRUCTURE: MATCH/);
});

test("a same-colour variable rebind with identical pixels is CHANGED, attributed to structure", () => {
  const r = run({ prior: frame(), current: frame(), currentSnap: rebound() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.verdict, "CHANGED");
  assert.deepEqual(r.report.changedChecks, ["structure"]);
  assert.equal(r.report.pixels.verdict, "MATCH");
  assert.equal(r.report.structure.changed[0].id, GLYPH);
  assert.match(r.stdout, /FRAME-DIFF: CHANGED \(structure\)/);
  assert.match(r.stdout, /VariableID:1:117.*-> .*VariableID:1:73/);
});

test("the prior side may be a stored fingerprint.json rather than a raw snapshot", () => {
  const same = run({ prior: frame(), current: frame(), stored: true });
  assert.equal(same.report.verdict, "UNCHANGED");
  const diff = run({ prior: frame(), current: frame(), stored: true, currentSnap: rebound() });
  assert.deepEqual(diff.report.changedChecks, ["structure"]);
});

test("a paint change with identical structure is CHANGED, attributed to pixels, and names the region", () => {
  const r = run({
    prior: frame(),
    current: frame({ ink: [84, 86, 91] }),
    priorLayout: [BLOCK, ROW],
    currentLayout: [BLOCK, ROW],
  });
  assert.equal(r.report.verdict, "CHANGED");
  assert.deepEqual(r.report.changedChecks, ["pixels"]);
  assert.equal(r.report.structure.verdict, "MATCH");
  assert.deepEqual(r.report.pixels.clusters[0].regions, ["1:2 Block"]);
});

test("both changed reports both", () => {
  const r = run({ prior: frame(), current: frame({ ink: [84, 86, 91] }), currentSnap: rebound() });
  assert.deepEqual(r.report.changedChecks, ["pixels", "structure"]);
});

test("Δ1 colour rounding across the whole frame is render noise, not a change", () => {
  const r = run({ prior: frame(), current: frame({ shade: 1 }) });
  assert.equal(r.report.verdict, "UNCHANGED");
  assert.equal(r.report.pixels.changed, 0);
});

test("--tolerance 0 is byte-exact and reports the same noise as a pixel change", () => {
  const r = run({ prior: frame(), current: frame({ shade: 1 }), args: ["--tolerance", "0"] });
  assert.deepEqual(r.report.changedChecks, ["pixels"]);
});

test("a size change is a pixel change without a pixel comparison", () => {
  const r = run({ prior: frame(), current: frame({ w: 210 }) });
  assert.deepEqual(r.report.changedChecks, ["pixels"]);
  assert.equal(r.report.pixels.changed, null);
  assert.match(r.report.pixels.reasons[0], /size 200x120 -> 210x120/);
});

test("a node moved by 1px in the layout is a pixel-side change even when the pixels match", () => {
  const r = run({ prior: frame(), current: frame(), priorLayout: [BLOCK, ROW], currentLayout: [{ ...BLOCK, y: 21 }, ROW] });
  assert.deepEqual(r.report.changedChecks, ["pixels"]);
  assert.equal(r.report.pixels.layout.moved[0].dy, 1);
});

test("a prior node missing from the current layout blocks reuse", () => {
  const r = run({ prior: frame(), current: frame(), priorLayout: [BLOCK, ROW], currentLayout: [BLOCK] });
  assert.equal(r.report.verdict, "CHANGED");
  assert.equal(r.report.pixels.layout.removed[0].figmaNode, "1:3");
});

test("layout nodes only in the current layout (finer granularity) do not block reuse", () => {
  const child = { figmaNode: "1:4", name: "Label", kind: "region", x: 20, y: 80, w: 40, h: 12 };
  const r = run({ prior: frame(), current: frame(), priorLayout: [BLOCK, ROW], currentLayout: [BLOCK, ROW, child] });
  assert.equal(r.report.verdict, "UNCHANGED");
  assert.equal(r.report.pixels.layout.added.length, 1);
});

test("fingerprints are required — a prior run without one cannot be reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-diff-"));
  writePng(join(dir, "a.png"), frame());
  const r = spawnSync(process.execPath, [TOOL, "--prior", join(dir, "a.png"), "--current", join(dir, "a.png")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prior-fingerprint and --current-fingerprint are required/);
});

test("fingerprints of two different frames are refused", () => {
  const other = { ...structuredClone(SNAPSHOT), frame: "1:999" };
  const r = run({ prior: frame(), current: frame(), currentSnap: other });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /different frames/);
});

test("one layout without the other is a usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-diff-"));
  writePng(join(dir, "a.png"), frame());
  writeFileSync(join(dir, "s.json"), JSON.stringify(SNAPSHOT));
  writeFileSync(join(dir, "l.json"), JSON.stringify(layout([BLOCK])));
  const r = spawnSync(
    process.execPath,
    [TOOL, "--prior", join(dir, "a.png"), "--current", join(dir, "a.png"),
      "--prior-fingerprint", join(dir, "s.json"), "--current-fingerprint", join(dir, "s.json"),
      "--prior-layout", join(dir, "l.json")],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /both --prior-layout and --current-layout/);
});
