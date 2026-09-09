/**
 * Fixture tests for <tools-dir>/regression-check.mjs.
 *
 * A 320x320 CSS-px frame at scale 2. layout.json places block A (fix target)
 * and block B (must not change). The fix list names A by figmaNode.
 *
 * 1. Change inside A only → PASS.
 * 2. Change inside B → FAIL, cluster reported out of scope.
 * 3. With a reference: A improves → PASS; A gets worse → FAIL (the F13 case).
 * 4. Capture dimensions change → FAIL.
 * 5. No fix list → INFO, exit 0, footprint reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "regression-check.mjs");
const SCALE = 2;
const SIZE = 320 * SCALE;
const BLUE = [30, 77, 140];
const GREEN = [40, 140, 60];
const GREY = [91, 91, 104];

function blank(h = SIZE) {
  const png = new PNG({ width: SIZE, height: h });
  png.data.fill(255);
  return png;
}
function rect(png, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * png.width + xx) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
}
// CSS boxes: A (150,150,40,40) → device 300..380 ; B (20,20,60,60) → device 40..160
const A = { x: 150, y: 150, w: 40, h: 40 };
const B = { x: 20, y: 20, w: 60, h: 60 };
const dev = (r) => [r.x * SCALE, r.y * SCALE, r.w * SCALE, r.h * SCALE];

function scene({ aColor = BLUE, aTopHalf = null, bColor = GREY, height = SIZE } = {}) {
  const p = blank(height);
  rect(p, ...dev(B), bColor);
  rect(p, ...dev(A), aColor);
  if (aTopHalf) rect(p, A.x * SCALE, A.y * SCALE, A.w * SCALE, (A.h * SCALE) / 2, aTopHalf);
  return p;
}

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), "val-regression-"));
  mkdirSync(join(dir, "01-extraction"), { recursive: true });
  mkdirSync(join(dir, "04-build"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ input: { exportScale: SCALE, frame: { w: 320, h: 320 }, frames: [{ state: "default", w: 320, h: 320 }] } }));
  writeFileSync(
    join(dir, "01-extraction", "layout.json"),
    JSON.stringify({ frame: "0:1", state: "default", w: 320, h: 320, regions: [{ figmaNode: "1:1", name: "block A", kind: "instance", ...A }, { figmaNode: "1:2", name: "block B", kind: "instance", ...B }] }),
  );
  writeFileSync(join(dir, "04-build", "fixlist.json"), JSON.stringify([{ id: "F1", figmaNode: "1:1", selectorScope: "#a", siblings: [] }]));
  return dir;
}

function write(dir, name, png) {
  const p = join(dir, name);
  writeFileSync(p, PNG.sync.write(png));
  return p;
}

function run(dir, args) {
  const r = spawnSync(process.execPath, [TOOL, dir, ...args], { encoding: "utf8" });
  const report = JSON.parse(readFileSync(join(dir, "04-build", "regression-check.json"), "utf8"));
  return { status: r.status, out: r.stdout + r.stderr, report };
}

test("a change confined to the fix region passes", () => {
  const dir = makeRun();
  const before = write(dir, "before.png", scene({ aColor: BLUE }));
  const after = write(dir, "after.png", scene({ aColor: GREEN }));
  const { status, report } = run(dir, ["--before", before, "--after", after, "--fixlist", join(dir, "04-build", "fixlist.json")]);
  assert.equal(status, 0);
  assert.equal(report.verdict, "PASS");
  assert.ok(report.changedPixels > 0);
  assert.equal(report.outOfScope.length, 0);
  assert.equal(report.fixRegions[0].via, "layout.json");
});

test("a change outside every fix region fails and is reported", () => {
  const dir = makeRun();
  const before = write(dir, "before.png", scene());
  const after = write(dir, "after.png", scene({ bColor: GREEN })); // B changed, A untouched
  const { status, report } = run(dir, ["--before", before, "--after", after, "--fixlist", join(dir, "04-build", "fixlist.json")]);
  assert.equal(status, 1);
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.outOfScope.length, 1);
  const c = report.outOfScope[0];
  assert.ok(c.x0 >= 40 && c.x1 <= 160 && c.y0 >= 40 && c.y1 <= 160, `cluster must be B's box, got ${JSON.stringify(c)}`);
});

test("with a reference, an improved fix region passes and a worsened one fails", () => {
  const dir = makeRun();
  const ref = write(dir, "ref.png", scene({ aColor: GREEN }));
  const before = write(dir, "before.png", scene({ aColor: GREEN, aTopHalf: BLUE })); // half wrong
  const good = write(dir, "good.png", scene({ aColor: GREEN })); // fixed
  const bad = write(dir, "bad.png", scene({ aColor: BLUE })); // now fully wrong — the F13 shape
  const fix = join(dir, "04-build", "fixlist.json");

  const ok = run(dir, ["--before", before, "--after", good, "--reference", ref, "--fixlist", fix]);
  assert.equal(ok.status, 0);
  assert.equal(ok.report.verdict, "PASS");
  assert.ok(ok.report.fixRegions[0].mismatch.after < ok.report.fixRegions[0].mismatch.before);

  const worse = run(dir, ["--before", before, "--after", bad, "--reference", ref, "--fixlist", fix]);
  assert.equal(worse.status, 1);
  assert.equal(worse.report.verdict, "FAIL");
  assert.equal(worse.report.worse.length, 1);
  assert.equal(worse.report.worse[0].id, "F1");
  assert.equal(worse.report.outOfScope.length, 0, "the change was in scope — it is the direction that fails it");
});

test("a sibling that regresses while the fix improves fails (the F13 shape)", () => {
  const dir = makeRun();
  // Reference: A green, B grey. Before: A wrong (blue), B right. After: A fixed, B recoloured.
  const ref = write(dir, "ref.png", scene({ aColor: GREEN }));
  const before = write(dir, "before.png", scene({ aColor: BLUE }));
  const after = write(dir, "after.png", scene({ aColor: GREEN, bColor: BLUE }));
  const fix = join(dir, "04-build", "fixlist-sib.json");
  writeFileSync(fix, JSON.stringify([{ id: "F7", figmaNode: "1:1", selectorScope: "#a .label", siblings: [{ name: "arrow", figmaNode: "1:2" }] }]));
  const r = run(dir, ["--before", before, "--after", after, "--reference", ref, "--fixlist", fix]);
  assert.equal(r.status, 1);
  assert.equal(r.report.verdict, "FAIL");
  assert.equal(r.report.outOfScope.length, 0, "a sibling change is in scope…");
  assert.equal(r.report.worse.length, 1, "…but it must not get worse");
  assert.equal(r.report.worse[0].role, "sibling");
  assert.equal(r.report.worse[0].id, "F7:sibling:arrow");
  const fixRegion = r.report.fixRegions.find((x) => x.role === "fix");
  assert.ok(fixRegion.mismatch.after < fixRegion.mismatch.before, "the fix itself improved");
  assert.match(r.out, /sibling F7:sibling:arrow: .*← WORSE/);
});

test("changed capture dimensions always fail", () => {
  const dir = makeRun();
  const before = write(dir, "before.png", scene());
  const after = write(dir, "after.png", scene({ height: SIZE + 8 }));
  const { status, report } = run(dir, ["--before", before, "--after", after]);
  assert.equal(status, 1);
  assert.equal(report.verdict, "FAIL");
  assert.match(report.reason, /dimensions changed/);
});

test("without a fix list the footprint is reported and scope is not asserted", () => {
  const dir = makeRun();
  const before = write(dir, "before.png", scene());
  const after = write(dir, "after.png", scene({ bColor: GREEN }));
  const { status, report, out } = run(dir, ["--before", before, "--after", after]);
  assert.equal(status, 0);
  assert.equal(report.verdict, "INFO");
  assert.equal(report.clusters.length, 1);
  assert.match(out, /scope not asserted/);
});
