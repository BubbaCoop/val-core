/**
 * Fixture tests for <tools-dir>/grid-diff.mjs — plain node:test.
 *
 * Run: node --test <tools-dir>/grid-diff.test.mjs
 *
 * 1. An image diffed against itself scores 100% pass.
 * 2. Against a copy with a 20px-shifted block, failures localize to that
 *    block's tiles only — every other non-empty tile still passes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "grid-diff.mjs");

// Fixture images are 640x640 device px at exportScale 2 (320x320 CSS px),
// so the 64-CSS-px grid is 128 device px per tile — a 5x5 grid.
const SIZE = 640;

function blankPng() {
  const png = new PNG({ width: SIZE, height: SIZE });
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

function makeRunDir(designPng, buildPng) {
  const dir = mkdtempSync(join(tmpdir(), "val-grid-diff-"));
  mkdirSync(join(dir, "01-extraction", "exports"), { recursive: true });
  mkdirSync(join(dir, "06-accuracy"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ input: { exportScale: 2, frame: { w: 320, h: 320 } } }),
  );
  writeFileSync(
    join(dir, "01-extraction", "exports", "page@2x.png"),
    PNG.sync.write(designPng),
  );
  writeFileSync(
    join(dir, "06-accuracy", "build@2x.png"),
    PNG.sync.write(buildPng),
  );
  return dir;
}

function runTool(dir) {
  execFileSync(process.execPath, [TOOL, dir], { stdio: "pipe" });
  return JSON.parse(
    readFileSync(join(dir, "06-accuracy", "diff-report.json"), "utf8"),
  );
}

test("identical images score 100% pass", () => {
  const a = blankPng();
  drawRect(a, 40, 40, 120, 120, GREY); // stable content in tile (0,0)
  drawRect(a, 300, 300, 80, 80, BLUE);

  const b = blankPng();
  drawRect(b, 40, 40, 120, 120, GREY);
  drawRect(b, 300, 300, 80, 80, BLUE);

  const report = runTool(makeRunDir(a, b));

  assert.equal(report.summary.passPct, 100);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.fail, 0);
  assert.ok(
    report.summary.nonEmptyTiles > 0,
    "fixture content must produce non-empty tiles",
  );
  assert.equal(report.grid.cols, 5);
  assert.equal(report.grid.rows, 5);
});

test("a 20px-shifted block fails only in that block's tiles", () => {
  const a = blankPng();
  drawRect(a, 40, 40, 120, 120, GREY); // identical in both — must pass
  drawRect(a, 300, 300, 80, 80, BLUE); // block, original position

  const b = blankPng();
  drawRect(b, 40, 40, 120, 120, GREY);
  drawRect(b, 320, 300, 80, 80, BLUE); // same block shifted 20px right

  const report = runTool(makeRunDir(a, b));

  // The block's footprint across both images spans device x 300–400,
  // y 300–380 → tiles (col 2, row 2) and (col 3, row 2) at 128px tiles.
  const expected = new Set(["2,2", "3,2"]);

  const nonPass = report.tiles.filter(
    (t) => t.class === "warn" || t.class === "fail",
  );
  assert.ok(nonPass.length > 0, "the shift must be detected");
  assert.ok(
    nonPass.some((t) => t.class === "fail"),
    "the shift must produce at least one fail-class tile",
  );
  for (const t of nonPass) {
    assert.ok(
      expected.has(`${t.col},${t.row}`),
      `tile (${t.col},${t.row}) flagged ${t.class} outside the shifted block`,
    );
  }

  // The untouched content tile still passes.
  const stable = report.tiles.find((t) => t.col === 0 && t.row === 0);
  assert.equal(stable.class, "pass");
});
