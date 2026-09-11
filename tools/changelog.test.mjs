/**
 * Release contract: the changelog must have been cut before the version was bumped.
 *
 * 0.4.0 shipped with its entire contents still under `## [Unreleased]` and no `## [0.4.0]`
 * heading — the README said to cut first, but as a comment inside a block of commands, and it
 * was skipped. Nothing failed, because nothing was checking. This is that check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

/** `## [1.2.3] — 2026-01-01` → { version, date } */
const releaseHeadings = () =>
  [...changelog.matchAll(/^##\s*\[([^\]]+)\]\s*(?:—|-|–)?\s*(\S+)?\s*$/gm)]
    .map((m) => ({ version: m[1], date: m[2] ?? null }))
    .filter((h) => h.version !== "Unreleased");

test("CHANGELOG has a dated heading for the version in package.json", () => {
  const headings = releaseHeadings();
  const match = headings.find((h) => h.version === version);
  assert.ok(
    match,
    `package.json is ${version} but CHANGELOG.md has no "## [${version}]" heading — the release ` +
      `was bumped without cutting the changelog, so the shipped work is still filed under ` +
      `[Unreleased]. Rename "## [Unreleased]" to "## [${version}] — YYYY-MM-DD" and open a fresh ` +
      `empty [Unreleased] above it (README "Releasing", step 1). Headings found: ` +
      headings.map((h) => h.version).join(", "),
  );
  assert.match(
    match.date ?? "",
    /^\d{4}-\d{2}-\d{2}$/,
    `"## [${version}]" carries no YYYY-MM-DD date`,
  );
});

test("an empty [Unreleased] section is open for the next change", () => {
  assert.match(changelog, /^##\s*\[Unreleased\]\s*$/m, "CHANGELOG.md has no [Unreleased] heading");
});

test("every release heading carries a YYYY-MM-DD date", () => {
  const undated = releaseHeadings().filter((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h.date ?? ""));
  assert.deepEqual(undated.map((h) => h.version), [], "release headings missing a date");
});

test("the newest release heading is the current version", () => {
  // Catches cutting for one version and bumping to another. The one-commit window between
  // "Changelog x.y.z" and `npm version` is the exception the README's ordering creates, and
  // it is why this asserts the newest heading rather than the file's whole ordering.
  const first = releaseHeadings()[0];
  assert.ok(first, "CHANGELOG.md lists no releases");
  assert.equal(
    first.version,
    version,
    `the newest CHANGELOG heading is [${first.version}] but package.json is ${version} — ` +
      `cut and bump disagree`,
  );
});
