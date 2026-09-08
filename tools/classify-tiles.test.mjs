/**
 * Fixture tests for <tools-dir>/classify-tiles.mjs (run after grid-diff).
 *
 * 320x320 at scale 1 (5x5 grid). layout.json has a "text" instance and a
 * "block" instance. The build shifts the text 1px right (a rasterizer-shaped
 * difference) and recolours the block (a genuine difference).
 *
 * 1. Tiles map to the right regions; text → artifact-candidate, block → needs-review.
 * 2. --accepted turns the block into accepted-candidate.
 * 3. --crops writes a side-by-side crop for needs-review findings only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const GRID = join(DIR, "grid-diff.mjs");
const TOOL = join(DIR, "classify-tiles.mjs");
const SIZE = 320;
const INK = [26, 26, 26];
const BLUE = [30, 77, 140];
const RED = [180, 40, 40];

function blank() {
  const png = new PNG({ width: SIZE, height: SIZE });
  png.data.fill(255);
  return png;
}
function rect(png, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * png.width + xx) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
}
/** glyph-like run: 12 rects of 6px with 4px gaps, 16 tall, starting at x. */
function textRun(png, x, y) {
  for (let i = 0; i < 12; i++) rect(png, x + i * 10, y, 6, 16, INK);
}
/** the same run, but every even glyph is 2px narrower — antialiasing-shaped, no shift. */
function textRunThin(png, x, y) {
  for (let i = 0; i < 12; i++) rect(png, x + i * 10, y, i % 2 ? 6 : 4, 16, INK);
}
const TEXT = { figmaNode: "2:1", name: "heading", kind: "instance", x: 70, y: 70, w: 120, h: 20 };
const CAPTION = { figmaNode: "2:3", name: "caption", kind: "instance", x: 70, y: 150, w: 120, h: 20 };
const BLOCK = { figmaNode: "2:2", name: "swatch", kind: "instance", x: 200, y: 200, w: 60, h: 60 };
const PAGE = { figmaNode: "2:0", name: "page", kind: "region", x: 0, y: 0, w: 320, h: 320 };

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), "val-classify-"));
  mkdirSync(join(dir, "01-extraction", "exports"), { recursive: true });
  mkdirSync(join(dir, "06-accuracy"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ input: { exportScale: 1, frame: { w: SIZE, h: SIZE }, frames: [{ state: "default", w: SIZE, h: SIZE }] } }));
  writeFileSync(join(dir, "01-extraction", "layout.json"), JSON.stringify({ frame: "2:0", state: "default", w: SIZE, h: SIZE, regions: [PAGE, TEXT, CAPTION, BLOCK] }));
  const ref = blank();
  textRun(ref, 70, 72);
  textRun(ref, 70, 152);
  rect(ref, 200, 200, 60, 60, BLUE);
  const build = blank();
  textRun(build, 71, 72); // 1px right
  textRunThin(build, 70, 152); // same footprint, thinner glyphs
  rect(build, 200, 200, 60, 60, RED); // recoloured
  writeFileSync(join(dir, "01-extraction", "exports", "page@2x.png"), PNG.sync.write(ref));
  writeFileSync(join(dir, "06-accuracy", "build@2x.png"), PNG.sync.write(build));
  execFileSync(process.execPath, [GRID, dir], { stdio: "pipe" });
  return dir;
}

function classify(dir, args = []) {
  const out = execFileSync(process.execPath, [TOOL, dir, ...args], { stdio: "pipe" }).toString();
  return { out, report: JSON.parse(readFileSync(join(dir, "06-accuracy", "diff-report.json"), "utf8")) };
}

test("tiles map to layout regions and are pre-classified by evidence", () => {
  const dir = makeRun();
  const { report, out } = classify(dir);
  const f = report.autoFindings;
  assert.equal(f.length, 3, `expected 3 findings, got ${JSON.stringify(f.map((x) => x.region))}`);
  const text = f.find((x) => x.figmaNode === "2:1");
  const caption = f.find((x) => x.figmaNode === "2:3");
  const block = f.find((x) => x.figmaNode === "2:2");
  assert.ok(text && caption && block, "all instances must be found (the page region must not win the overlap)");
  assert.equal(text.preClassification, "artifact-candidate");
  assert.equal(text.evidence.coloursMatch, true);
  assert.equal(text.evidence.horizontalShift.shift, 1);
  assert.equal(text.evidence.ink.delta.dw, 0);
  assert.equal(caption.preClassification, "artifact-candidate", "identical footprint + colours + sub-8% with no shift = antialiasing");
  assert.equal(caption.evidence.horizontalShift.shift, 0);
  assert.match(caption.rationale, /antialiasing/);
  assert.equal(block.preClassification, "needs-review");
  assert.equal(block.evidence.coloursMatch, false);
  assert.ok(block.tileCount >= 1);
  assert.equal(report.autoClassificationSummary["needs-review"], 1);
  assert.match(out, /1 needs-review/);
  // The agent's own fields are untouched.
  assert.equal(report.findings, undefined);
});

test("--accepted pre-labels a region as accepted-candidate", () => {
  const dir = makeRun();
  const acc = join(dir, "accepted.json");
  writeFileSync(acc, JSON.stringify([{ id: "D3", figmaNode: "2:2", note: "swatch colour is a documented deviation" }]));
  const { report } = classify(dir, ["--accepted", acc]);
  const block = report.autoFindings.find((x) => x.figmaNode === "2:2");
  assert.equal(block.preClassification, "accepted-candidate");
  assert.equal(block.acceptedId, "D3");
});

test("--crops writes a side-by-side crop for needs-review findings only", () => {
  const dir = makeRun();
  const { report } = classify(dir, ["--crops"]);
  const cropDir = join(dir, "06-accuracy", "crops");
  assert.ok(existsSync(cropDir));
  const files = readdirSync(cropDir);
  assert.equal(files.length, 1, `one crop expected, got ${files.join(", ")}`);
  const block = report.autoFindings.find((x) => x.figmaNode === "2:2");
  assert.ok(block.crop.endsWith(files[0]));
  const png = PNG.sync.read(readFileSync(block.crop));
  // reference + gap + build, same height as the padded box
  assert.ok(png.width > png.height, "side-by-side is wider than tall for a square box");
});
