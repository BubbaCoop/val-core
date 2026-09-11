/** Unit tests for <tools-dir>/lib/report.mjs — where a check's report may be written. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReport } from "./report.mjs";

const scratch = () => mkdtempSync(join(realpathSync(tmpdir()), "val-report-"));

test("writes beside the target when that lands inside the working directory", () => {
  const cwd = scratch();
  const r = resolveReport({ defaultPath: join(cwd, "run", "handoff-check.json"), cwd });
  assert.equal(r.path, join(cwd, "run", "handoff-check.json"));
  assert.equal(r.reason, undefined);
});

test("refuses to write into a tree outside the working directory, and says why", () => {
  const cwd = scratch();
  const other = scratch();
  const r = resolveReport({ defaultPath: join(other, "class-audit.json"), cwd });
  assert.equal(r.path, null, "a check must not mutate a tree it is only inspecting");
  assert.match(r.reason, /outside the working directory/);
  assert.match(r.reason, /pass --out <path>/);
});

test("--out is explicit intent and writes anywhere", () => {
  const cwd = scratch();
  const other = scratch();
  const dest = join(other, "elsewhere.json");
  assert.equal(resolveReport({ out: dest, defaultPath: join(other, "x.json"), cwd }).path, dest);
});

test("--no-write always wins, even for an in-tree target", () => {
  const cwd = scratch();
  const r = resolveReport({ noWrite: true, defaultPath: join(cwd, "run", "x.json"), cwd });
  assert.equal(r.path, null);
  assert.equal(r.reason, "--no-write");
});

test("a symlinked path to the working directory still counts as inside", () => {
  // The macOS case: process.cwd() reports /private/var/... while the argument says
  // /var/..., and a naive string compare reads an ordinary in-tree run as outside.
  const base = scratch();
  const realDir = join(base, "real");
  mkdirSync(join(realDir, "run"), { recursive: true });
  const link = join(base, "link");
  symlinkSync(realDir, link);

  const viaLink = resolveReport({ defaultPath: join(link, "run", "r.json"), cwd: realDir });
  assert.ok(viaLink.path, "a symlinked spelling of an in-tree path must still be written");

  const viaReal = resolveReport({ defaultPath: join(realDir, "run", "r.json"), cwd: link });
  assert.ok(viaReal.path, "and the reverse spelling too");
});

test("the target being the working directory itself is inside", () => {
  const cwd = scratch();
  assert.ok(resolveReport({ defaultPath: join(cwd, "r.json"), cwd }).path);
});
