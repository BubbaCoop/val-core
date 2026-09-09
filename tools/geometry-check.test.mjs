/**
 * Browser tests for <tools-dir>/geometry-check.mjs. Skipped when Chromium is
 * not installed (`npx playwright install chromium`).
 *
 * A 400x300 frame with a header region (mapped via regions.json) and a card
 * instance (mapped via data-val-node). Exact geometry passes; a 5px drift
 * fails and is named in the report.
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
