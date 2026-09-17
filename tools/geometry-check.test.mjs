/**
 * Browser tests for <tools-dir>/geometry-check.mjs. Skipped when Chromium is
 * not installed (`npx playwright install chromium`).
 *
 * A 400x300 frame with a header region (mapped via regions.json) and a card
 * instance (mapped via data-val-node). Exact geometry passes; a 5px drift
 * fails and is named in the report; the same drift covered by --accepted
 * reports `accepted` and the frame passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "geometry-check.mjs");

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

function makeRun(cardY) {
  const dir = mkdtempSync(join(tmpdir(), "val-geometry-"));
  mkdirSync(join(dir, "01-extraction"), { recursive: true });
  mkdirSync(join(dir, "04-build"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ input: { exportScale: 1, frame: { w: 400, h: 300 }, frames: [{ state: "default", w: 400, h: 300 }] } }));
  writeFileSync(
    join(dir, "01-extraction", "layout.json"),
    JSON.stringify({
      frame: "9:0",
      state: "default",
      w: 400,
      h: 300,
      regions: [
        { figmaNode: "9:1", name: "header", kind: "region", x: 0, y: 0, w: 400, h: 50 },
        { figmaNode: "9:2", name: "card", kind: "instance", x: 20, y: 70, w: 200, h: 100 },
      ],
    }),
  );
  writeFileSync(join(dir, "04-build", "regions.json"), JSON.stringify({ "9:1": "header" }));
  writeFileSync(
    join(dir, "04-build", "index.html"),
    `<!doctype html><html><head><style>
      html,body{margin:0;height:300px;overflow:hidden}
      header{height:50px;background:#eee}
      .card{position:absolute;left:20px;top:${cardY}px;width:200px;height:100px;background:#ddd}
    </style></head><body><header></header><div class="card" data-val-node="9:2"></div></body></html>`,
  );
  return dir;
}

test("exact geometry passes; a 5px drift fails and is named", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  const ok = makeRun(70);
  const r1 = spawnSync(process.execPath, [TOOL, ok], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  const rep1 = JSON.parse(readFileSync(join(ok, "04-build", "geometry-default.json"), "utf8"));
  assert.equal(rep1.verdict, "PASS");
  assert.equal(rep1.counts.ok, 2);
  assert.equal(rep1.regions.find((x) => x.figmaNode === "9:1").via, "regions.json");
  assert.equal(rep1.regions.find((x) => x.figmaNode === "9:2").via, "data-val-node");
  assert.ok(existsSync(join(ok, "04-build", "geometry-default.md")));
  assert.match(r1.stdout, /✓ default: page 400x300/);

  const drift = makeRun(75);
  const r2 = spawnSync(process.execPath, [TOOL, drift], { encoding: "utf8" });
  assert.equal(r2.status, 1);
  const rep2 = JSON.parse(readFileSync(join(drift, "04-build", "geometry-default.json"), "utf8"));
  assert.equal(rep2.verdict, "FAIL");
  const card = rep2.regions.find((x) => x.figmaNode === "9:2");
  assert.equal(card.status, "fail");
  assert.equal(card.delta.dy, 5);
  assert.match(r2.stdout, /✗ card \(9:2\)/);
});

test("a drift covered by --accepted is reported, not failed", async (t) => {
  const dir = makeRun(75); // the same 5px drift the previous test fails on
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  writeFileSync(
    join(dir, "accepted.json"),
    JSON.stringify([{ id: "D7", figmaNode: ["9:2"], frames: ["default"], note: "the frame draws a stray 5px; the component's own geometry ships" }]),
  );
  const r = spawnSync(process.execPath, [TOOL, dir, "--accepted", "accepted.json"], { encoding: "utf8" }); // run-relative, as the templates document
  const rep = JSON.parse(readFileSync(join(dir, "04-build", "geometry-default.json"), "utf8"));
  assert.equal(rep.verdict, "PASS", "an accepted miss must not sink the frame");
  const card = rep.regions.find((x) => x.figmaNode === "9:2");
  assert.equal(card.status, "accepted");
  assert.equal(card.acceptedId, "D7");
  assert.equal(card.delta.dy, 5, "the miss is still measured and recorded, not hidden");
  assert.equal(rep.counts.accepted, 1);
  assert.equal(rep.counts.fail, 0);
  assert.equal(r.status, 0, "exit code follows the verdict");
  assert.match(r.stdout, /1 accepted/);
  assert.match(r.stdout, /~ card \(9:2\)/, "an accepted miss is printed, never silent");
});

test("an accepted entry scoped to other frames does not excuse this one", async (t) => {
  const dir = makeRun(75);
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  writeFileSync(
    join(dir, "accepted.json"),
    JSON.stringify([{ id: "D7", figmaNode: "9:2", frames: ["mobile-filled"], note: "only on the mobile frame" }]),
  );
  const r = spawnSync(process.execPath, [TOOL, dir, "--accepted", "accepted.json"], { encoding: "utf8" });
  const rep = JSON.parse(readFileSync(join(dir, "04-build", "geometry-default.json"), "utf8"));
  assert.equal(rep.verdict, "FAIL");
  assert.equal(rep.regions.find((x) => x.figmaNode === "9:2").status, "fail");
  assert.equal(r.status, 1);
});

test("a region the build deliberately omits is accepted, not unmapped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "val-geometry-"));
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  mkdirSync(join(dir, "01-extraction"), { recursive: true });
  mkdirSync(join(dir, "04-build"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ input: { exportScale: 1, frame: { w: 400, h: 300 }, frames: [{ state: "default", w: 400, h: 300 }] } }));
  writeFileSync(
    join(dir, "01-extraction", "layout.json"),
    JSON.stringify({
      frame: "9:0",
      state: "default",
      w: 400,
      h: 300,
      regions: [
        { figmaNode: "9:1", name: "header", kind: "region", x: 0, y: 0, w: 400, h: 50 },
        // Drawn in the frame at opacity 0 and dropped by the requirements — the page has no element for it.
        { figmaNode: "9:9", name: "hidden-back-icon", kind: "instance", x: 20, y: 15, w: 18, h: 18 },
      ],
    }),
  );
  writeFileSync(join(dir, "04-build", "regions.json"), JSON.stringify({ "9:1": "header" }));
  writeFileSync(
    join(dir, "04-build", "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;height:300px;overflow:hidden}header{height:50px;background:#eee}</style></head><body><header></header></body></html>`,
  );
  const bare = spawnSync(process.execPath, [TOOL, dir], { encoding: "utf8" });
  assert.equal(bare.status, 1, "without an entry, a region with no element is still unmapped and fails");

  writeFileSync(join(dir, "accepted.json"), JSON.stringify([{ id: "S15", figmaNode: "9:9", note: "out of scope by the requirements" }]));
  const r = spawnSync(process.execPath, [TOOL, dir, "--accepted", "accepted.json"], { encoding: "utf8" });
  const rep = JSON.parse(readFileSync(join(dir, "04-build", "geometry-default.json"), "utf8"));
  assert.equal(rep.verdict, "PASS");
  assert.equal(rep.counts.unmapped, 0);
  assert.equal(rep.counts.accepted, 1);
  const row = rep.regions.find((x) => x.figmaNode === "9:9");
  assert.equal(row.status, "accepted");
  assert.equal(row.notBuilt, true);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not built/);
});
