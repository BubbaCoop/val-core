/** Fixture tests for <tools-dir>/design/feedback-check.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "feedback-check.mjs");

const CONCEPT = `<!doctype html><html><body>
<main data-concept data-viewport="web" data-title="Primary contact">
  <section data-block="b01" data-region="header" data-class=".header" data-states="rest"><p data-label>Header</p></section>
  <section data-block="b02" data-region="title-block" data-class="type-eyebrow" data-copy="c01 c02"><p data-label data-copy-id="c02">Who should we contact?</p></section>
  <section data-block="b03" data-region="field-group" data-class=".text-field" data-states="empty error"><p data-label>First name</p></section>
</main></body></html>`;

const HEADER = "| id | block | severity | rule | finding | fix |";

/** A feedback file body: the version pin, then the findings table. */
const fb = (rows, { concept = "concept.v1.html", header = HEADER, pin = true } = {}) =>
  `# Feedback\n${pin ? `Concept: ${concept}\n` : ""}\n${header}\n${rows}`;

/** Build a run dir with the given feedback files; returns its path. */
function runDir(feedback, { concepts = { 1: CONCEPT } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "val-feedback-"));
  mkdirSync(join(dir, "00-input"), { recursive: true });
  mkdirSync(join(dir, "02-concept"), { recursive: true });
  for (const [n, html] of Object.entries(concepts)) {
    writeFileSync(join(dir, "02-concept", `concept.v${n}.html`), html);
  }
  for (const [n, text] of Object.entries(feedback)) {
    writeFileSync(join(dir, "00-input", `feedback-${n}.md`), text);
  }
  return dir;
}

const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [TOOL, dir, ...args], { encoding: "utf8", cwd: dir });
  return { ...r, out: `${r.stdout}${r.stderr}` };
};

test("a well-formed feedback round passes and counts its findings", () => {
  const dir = runDir({
    1: fb(
      "| H1 | b03 | blocking | §5 | first name should be a dropdown | map to .dropdown-field |\n" +
        "| H2 | c02 | advisory | §8 | title reads cold | soften to second person |\n",
    ),
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FEEDBACK-CHECK: PASS/);
  assert.match(r.out, /FINDINGS: 2 \| BLOCKING: 1 \| ADVISORY: 1/);
});

// ---- version pinning ----------------------------------------------------------------

test("a round with no Concept: line fails — a stale round must be distinguishable", () => {
  const dir = runDir({
    1: fb("| H1 | b03 | blocking | §5 | wrong control | map to .dropdown-field |\n", { pin: false }),
  });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no `Concept:` line/);
});

test("feedback on a superseded concept is rejected, not silently applied", () => {
  // b03 exists in BOTH versions, so target-existence alone would let this pass.
  const dir = runDir(
    { 1: fb("| H1 | b03 | blocking | §5 | reviewed on v1 | change it |\n", { concept: "concept.v1.html" }) },
    { concepts: { 1: CONCEPT, 2: CONCEPT } },
  );
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /round targets concept\.v1\.html but is being checked against concept\.v2\.html/);
  assert.match(r.out, /block ids are stable across versions/);
});

test("a Concept: pin that disagrees with an explicit --concept fails", () => {
  const dir = runDir(
    { 1: fb("| H1 | b03 | blocking | §5 | a | fix a |\n", { concept: "concept.v2.html" }) },
    { concepts: { 1: CONCEPT, 2: CONCEPT } },
  );
  const r = run(dir, "--concept", "02-concept/concept.v1.html");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /round targets concept\.v2\.html but is being checked against concept\.v1\.html/);
});

test("a malformed Concept: value fails", () => {
  const dir = runDir({
    1: fb("| H1 | b03 | advisory | §8 | a | fix a |\n", { concept: "v2" }),
  });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not a concept\.v<n>\.html file name/);
});

// ---- targets ------------------------------------------------------------------------

test("a finding aimed at a block the concept does not declare fails and names it", () => {
  const dir = runDir({ 1: fb("| H1 | b99 | blocking | §5 | change the thing | do the other thing |\n") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /block "b99" is not in concept\.v1\.html/);
  assert.match(r.out, /b01 b02 b03/);
});

test("a copy id present in the concept is a valid target", () => {
  const dir = runDir({ 1: fb("| H1 | c01 | advisory | §8 | eyebrow casing | use the type utility |\n") });
  assert.equal(run(dir).status, 0);
});

test('"-" targets the page as a whole', () => {
  const dir = runDir({ 1: fb("| H1 | - | advisory | §3 | the step asks too much at once | split it |\n") });
  assert.equal(run(dir).status, 0);
});

// ---- ids, severity, fix -------------------------------------------------------------

test("the critic's F<n> ids are rejected — human findings are H<n>", () => {
  const dir = runDir({ 1: fb("| F1 | b03 | blocking | §5 | wrong control | map to .dropdown-field |\n") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /id "F1" is not H<n>/);
});

test("duplicate ids fail", () => {
  const dir = runDir({
    1: fb("| H1 | b03 | blocking | §5 | a | fix a |\n| H1 | b02 | advisory | §8 | b | fix b |\n"),
  });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /duplicate finding id "H1"/);
});

test("an empty fix column fails — the column says what to do", () => {
  const dir = runDir({ 1: fb("| H1 | b03 | blocking | §5 | this is wrong |  |\n") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /fix column is empty/);
});

test("a severity outside blocking|advisory fails", () => {
  const dir = runDir({ 1: fb("| H1 | b03 | nitpick | §5 | small thing | tweak it |\n") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /severity "nitpick" is not blocking\|advisory/);
});

// ---- table shape --------------------------------------------------------------------

test("a table with no rows fails rather than burning a concept version", () => {
  const dir = runDir({ 1: fb("") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /findings table has no rows/);
});

test("a file with no findings table at all fails", () => {
  const dir = runDir({ 1: "Concept: concept.v1.html\n\nPlease make the title friendlier.\n" });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no findings table with the critic's columns/);
});

test("a row missing cells is reported with the offending line", () => {
  const dir = runDir({ 1: fb("| H1 | b03 | blocking |\n") });
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /finding row has 3 cells, expected 6/);
});

test("a divider row and a missing rule are tolerated", () => {
  const dir = runDir({
    1: fb("| H1 | b03 | advisory |  | feels cramped | add the §4 pitch |\n", {
      header: `${HEADER}\n|---|---|---|---|---|---|`,
    }),
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /warn\s+fix\s+H1: no rule cited/);
});

// ---- resolution and output ----------------------------------------------------------

test("with no flags it takes the highest feedback round against the highest concept version", () => {
  const v2 = CONCEPT.replace('data-block="b03"', 'data-block="b04"');
  const dir = runDir(
    {
      1: fb("| H1 | b03 | blocking | §5 | round one | fix it |\n", { concept: "concept.v1.html" }),
      2: fb("| H1 | b04 | blocking | §5 | round two | fix it |\n", { concept: "concept.v2.html" }),
    },
    { concepts: { 1: CONCEPT, 2: v2 } },
  );
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FILE: feedback-2\.md \| CONCEPT: concept\.v2\.html/);
});

test("--out json writes the parsed rows and the pin for the orchestrator to consume", () => {
  const dir = runDir({ 1: fb("| H1 | b03 | blocking | §5 | wrong control | map to .dropdown-field |\n") });
  const r = run(dir, "--out", "json");
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(readFileSync(join(dir, "feedback-check.json"), "utf8"));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.round, 1);
  assert.equal(report.pinnedConcept, "concept.v1.html");
  assert.equal(report.latestConcept, "concept.v1.html");
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].block, "b03");
  assert.equal(report.rows[0].fix, "map to .dropdown-field");
});

test("a missing feedback file exits non-zero with usage guidance", () => {
  const dir = mkdtempSync(join(tmpdir(), "val-feedback-empty-"));
  mkdirSync(join(dir, "02-concept"), { recursive: true });
  writeFileSync(join(dir, "02-concept", "concept.v1.html"), CONCEPT);
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /No 00-input\/feedback-<n>\.md found/);
});
