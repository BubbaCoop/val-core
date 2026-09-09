/**
 * Fixture tests for <tools-dir>/grid-diff.mjs — plain node:test.
 *
 * Run: node --test <tools-dir>/grid-diff.test.mjs
 *
 * 1. An image diffed against itself scores 100% pass.
 * 2. Against a copy with a 20px-shifted block, failures localize to that
 *    block's tiles only — every other non-empty tile still passes.
 * 3. A frames[] manifest with a requester 2x reference resolves that
 *    reference (and its scale) without flags.
 * 4. --frame <state> reads/writes the frames/<state>/ directories.
 * 5. --baseline carries per-tile classifications forward and reports deltas.
 * 6. Explicit --reference/--build/--out work with no manifest at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "grid-diff.mjs");

// Fixture images are 640x640 device px at exportScale 2 (320x320 CSS px),
// so the 64-CSS-px grid is 128 device px per tile — a 5x5 grid.
const SIZE = 640;

function blankPng(size = SIZE) {
  const png = new PNG({ width: size, height: size });
  png.data.fill(255);
  return png;
}

function drawRect(png, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

const BLUE = [30, 77, 140];
const GREY = [91, 91, 104];

function stable() {
  const a = blankPng();
  drawRect(a, 40, 40, 120, 120, GREY);
  drawRect(a, 300, 300, 80, 80, BLUE);
  return a;
}
function shifted() {
  const b = blankPng();
  drawRect(b, 40, 40, 120, 120, GREY);
  drawRect(b, 320, 300, 80, 80, BLUE); // same block shifted 20px right
  return b;
}

function makeRunDir(designPng, buildPng, manifest = { input: { exportScale: 2, frame: { w: 320, h: 320 } } }) {
  const dir = mkdtempSync(join(tmpdir(), "val-grid-diff-"));
  mkdirSync(join(dir, "01-extraction", "exports"), { recursive: true });
  mkdirSync(join(dir, "06-accuracy"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  if (designPng) writeFileSync(join(dir, "01-extraction", "exports", "page@2x.png"), PNG.sync.write(designPng));
  if (buildPng) writeFileSync(join(dir, "06-accuracy", "build@2x.png"), PNG.sync.write(buildPng));
  return dir;
}

function runTool(dir, args = [], reportPath = join(dir, "06-accuracy", "diff-report.json")) {
  const out = execFileSync(process.execPath, [TOOL, dir, ...args], { stdio: "pipe" }).toString();
  return { report: JSON.parse(readFileSync(reportPath, "utf8")), out };
}

test("identical images score 100% pass", () => {
  const { report } = runTool(makeRunDir(stable(), stable()));
  assert.equal(report.summary.passPct, 100);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.fail, 0);
  assert.ok(report.summary.nonEmptyTiles > 0, "fixture content must produce non-empty tiles");
  assert.equal(report.grid.cols, 5);
  assert.equal(report.grid.rows, 5);
  assert.equal(report.comparison.referenceSource, "extraction-export");
  assert.equal(report.comparison.state, "default");
});

test("a 20px-shifted block fails only in that block's tiles", () => {
  const { report } = runTool(makeRunDir(stable(), shifted()));
  // The block's footprint across both images spans device x 300–400,
  // y 300–380 → tiles (col 2, row 2) and (col 3, row 2) at 128px tiles.
  const expected = new Set(["2,2", "3,2"]);
  const nonPass = report.tiles.filter((t) => t.class === "warn" || t.class === "fail");
  assert.ok(nonPass.length > 0, "the shift must be detected");
  assert.ok(nonPass.some((t) => t.class === "fail"), "the shift must produce at least one fail-class tile");
  for (const t of nonPass) {
    assert.ok(expected.has(`${t.col},${t.row}`), `tile (${t.col},${t.row}) flagged ${t.class} outside the shifted block`);
  }
  const stableTile = report.tiles.find((t) => t.col === 0 && t.row === 0);
  assert.equal(stableTile.class, "pass");
});

test("frames[] manifest with a requester 2x reference resolves it without flags", () => {
  const manifest = {
    input: {
      exportScale: 1, // the MCP export would be 1x…
      frame: { w: 320, h: 320 },
      frames: [{ state: "empty", w: 320, h: 320, reference: { path: "00-input/ref.png", w: 640, h: 640, scale: 2 } }],
    },
  };
  const dir = makeRunDir(null, stable(), manifest);
  mkdirSync(join(dir, "00-input"));
  writeFileSync(join(dir, "00-input", "ref.png"), PNG.sync.write(stable()));
  const { report } = runTool(dir);
  assert.equal(report.comparison.referenceSource, "requester-reference");
  assert.equal(report.exportScale, 2, "…but the requester reference is 2x, so the comparison runs at 2x");
  assert.equal(report.grid.cols, 5);
  assert.equal(report.summary.passPct, 100);
  assert.equal(report.comparison.state, "empty");
});

test("--frame <state> uses the frames/<state>/ directories", () => {
  const manifest = {
    input: {
      exportScale: 2,
      frame: { w: 320, h: 320 },
      frames: [{ state: "empty", w: 320, h: 320 }, { state: "filled", w: 320, h: 320 }],
    },
  };
  const dir = makeRunDir(stable(), stable(), manifest);
  mkdirSync(join(dir, "01-extraction", "frames", "filled", "exports"), { recursive: true });
  mkdirSync(join(dir, "06-accuracy", "frames", "filled"), { recursive: true });
  writeFileSync(join(dir, "01-extraction", "frames", "filled", "exports", "page@2x.png"), PNG.sync.write(stable()));
  writeFileSync(join(dir, "06-accuracy", "frames", "filled", "build@2x.png"), PNG.sync.write(shifted()));
  const reportPath = join(dir, "06-accuracy", "frames", "filled", "diff-report.json");
  const { report } = runTool(dir, ["--frame", "filled"], reportPath);
  assert.equal(report.comparison.state, "filled");
  assert.ok(report.summary.fail > 0, "the filled frame's shifted build must register");
  assert.ok(existsSync(join(dir, "06-accuracy", "frames", "filled", "overlay.png")));
  // The primary frame's report is untouched (never written).
  assert.ok(!existsSync(join(dir, "06-accuracy", "diff-report.json")));
});

test("--baseline carries classifications forward and reports deltas", () => {
  const dir = makeRunDir(stable(), shifted());
  const first = runTool(dir).report;
  // The accuracy agent classified the two shifted tiles in run 1.
  first.findings = [{ id: "F1", classification: "accepted-deviation", tiles: [{ col: 2, row: 2 }, { col: 3, row: 2 }] }];
  const basePath = join(dir, "06-accuracy", "run-1.json");
  writeFileSync(basePath, JSON.stringify(first));

  // Run 2: build unchanged → everything carried, nothing new.
  const same = runTool(dir, ["--baseline", basePath]).report;
  assert.equal(same.baseline.carriedCount, 2);
  assert.equal(same.baseline.uncarriedNonPass.length, 0);
  assert.equal(same.baseline.newNonPassTiles.length, 0);
  assert.equal(same.baseline.tileClassDeltas.length, 0);
  assert.equal(same.baseline.carriedClassification["2,2"].classification, "accepted-deviation");
  assert.equal(same.baseline.carriedClassification["2,2"].finding, "F1");

  // Run 3: the shift is fixed → the two tiles resolve; and a new defect appears elsewhere.
  const fixedPlusNew = stable();
  drawRect(fixedPlusNew, 500, 40, 60, 60, BLUE); // new block in tile (3,0)/(4,0)
  writeFileSync(join(dir, "06-accuracy", "build@2x.png"), PNG.sync.write(fixedPlusNew));
  const third = runTool(dir, ["--baseline", basePath]).report;
  assert.equal(third.baseline.resolvedTiles.length, 2);
  assert.ok(third.baseline.newNonPassTiles.length >= 1, "the new block must surface as new non-pass");
  assert.ok(third.baseline.newNonPassTiles.every((t) => t.row === 0));
  assert.equal(third.baseline.carriedCount, 0);
  assert.equal(third.baseline.uncarriedNonPass.length, third.baseline.newNonPassTiles.length);
});

test("explicit --reference/--build/--out need no manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "val-grid-diff-bare-"));
  writeFileSync(join(dir, "a.png"), PNG.sync.write(stable()));
  writeFileSync(join(dir, "b.png"), PNG.sync.write(shifted()));
  const out = join(dir, "out");
  const { report } = runTool(dir, ["--reference", join(dir, "a.png"), "--build", join(dir, "b.png"), "--out", out, "--scale", "2"], join(out, "diff-report.json"));
  assert.equal(report.comparison.referenceSource, "explicit");
  assert.equal(report.grid.cols, 5);
  assert.ok(report.summary.fail > 0);
});
