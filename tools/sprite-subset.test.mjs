/** Fixture tests for <tools-dir>/sprite-subset.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "sprite-subset.mjs");

const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<symbol id="arrow-left" viewBox="0 0 24 24"><path d="M1 1"/></symbol>
<symbol id="arrow-right" viewBox="0 0 24 24"><path d="M2 2"/></symbol>
<symbol id='globe' viewBox="0 0 24 24"><circle r="3"/></symbol>
</svg>`;

function setup(html) {
  const dir = mkdtempSync(join(tmpdir(), "val-sprite-"));
  writeFileSync(join(dir, "sprite.svg"), SPRITE);
  writeFileSync(join(dir, "index.html"), html);
  return dir;
}
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

test("keeps only the symbols the page references", () => {
  const dir = setup(`<svg><use href="#globe"/></svg> <svg><use xlink:href="#arrow-left"></use></svg> <svg id="val-sprite"><symbol id="arrow-right"></symbol></svg>`);
  const r = run([join(dir, "sprite.svg"), "--used-by", join(dir, "index.html"), "--out", join(dir, "subset.svg")]);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, "subset.svg"), "utf8");
  assert.match(out, /id="arrow-left"/);
  assert.match(out, /id='globe'/);
  assert.doesNotMatch(out, /arrow-right/, "an already-inlined symbol that nothing <use>s is not kept");
  assert.match(out, /id="val-sprite"/);
  assert.match(r.stderr, /2 of 3 symbols kept/);
});

test("a referenced id missing from the sprite exits 1 and names it", () => {
  const dir = setup(`<svg><use href="#attach-money"/></svg>`);
  const r = run([join(dir, "sprite.svg"), "--used-by", join(dir, "index.html")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MISSING from sprite: attach-money/);
});

test("--ids works without a page and writes to stdout", () => {
  const dir = setup("");
  const r = run([join(dir, "sprite.svg"), "--ids", "globe,arrow-right"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /globe/);
  assert.match(r.stdout, /arrow-right/);
  assert.doesNotMatch(r.stdout, /arrow-left/);
});
