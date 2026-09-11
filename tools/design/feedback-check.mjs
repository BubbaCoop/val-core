#!/usr/bin/env node
/**
 * Design tool — human feedback check.
 *
 * The design pipeline has two machine inputs to a concept rework (design-critic's
 * findings) and one human one: a reviewer's feedback at the gate. This validates the
 * human file so the orchestrator can settle mechanically whether it is actionable
 * before spending the architect's 8-tool rework budget on it.
 *
 *   node <tools-dir>/design/feedback-check.mjs <run-dir> [--feedback 00-input/feedback-2.md]
 *        [--concept 02-concept/concept.v1.html] [--out json]
 *
 * With neither flag it takes the highest-numbered feedback file and the highest-numbered
 * concept version — the pair a rework would actually use.
 *
 * Checks, in order (any FAIL exits 1):
 *   file        the feedback file exists, is non-empty, and its name carries a round number
 *   version     the file pins the concept version it targets (`Concept: concept.v<n>.html`)
 *               and that version is the CURRENT one. A reviewer who commented on v2 after
 *               v3 was rendered is rejected rather than silently applied: block ids are
 *               stable across versions, so overlapping ids would otherwise let v2 feedback
 *               land on v3 unnoticed. The fix is to re-post the gate, not to guess.
 *   table       a findings table is present with the critic's columns
 *               (id · block · severity · rule · finding · fix)
 *   ids         every id matches ^H[0-9]+$ and is unique — H distinguishes a human
 *               finding from the critic's F, so the fix ledger records who asked
 *   targets     every `block` names a data-block or copy id that EXISTS in the target
 *               concept (or `-` for whole-page feedback). Studio composes findings
 *               against a rendered concept; a stale id means the feedback points at a
 *               version that no longer exists, and the architect would silently skip it
 *   severity    each is `blocking` or `advisory` — the critic's vocabulary, so the
 *               orchestrator can apply one rule to both sources
 *   fix         non-empty: the column says what to do, not merely what is wrong
 *   findings    at least one finding — an empty file would burn a concept version
 *
 * Feedback rounds are counted in manifest.loops.feedback and are deliberately OUTSIDE
 * the critic's cap: a reviewer iterating is the product working, a critic failing to
 * converge is a defect. This tool never reads or enforces that cap.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parseArgs, fail, printCapped } from "../lib/args.mjs";

const COLUMNS = ["id", "block", "severity", "rule", "finding", "fix"];
const SEVERITIES = new Set(["blocking", "advisory"]);

const { positional, opts } = parseArgs(process.argv.slice(2));
const runDir = positional[0];
if (!runDir) {
  fail(
    "Usage: node <tools-dir>/design/feedback-check.mjs <run-dir> [--feedback 00-input/feedback-<n>.md] [--concept 02-concept/concept.v<n>.html] [--out json]",
  );
}
const runPath = resolve(runDir);
if (!existsSync(runPath)) fail(`Run directory not found: ${runDir}`);

const findings = [];
const add = (check, severity, message, detail) =>
  findings.push({ check, severity, message, ...(detail ? { detail } : {}) });
const fatal = (check, message, detail) => add(check, "fail", message, detail);
const warn = (check, message, detail) => add(check, "warn", message, detail);

/** Highest-numbered file matching `re` (capture group 1 = the number) in `dir`. */
function latest(dir, re) {
  if (!existsSync(dir)) return null;
  const hits = [];
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (m) hits.push({ name, n: Number(m[1]) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.n - a.n);
  return hits[0];
}

// ---- resolve the pair a rework would use ---------------------------------------------

let feedbackRel = opts.feedback;
let round = null;
if (!feedbackRel) {
  const f = latest(join(runPath, "00-input"), /^feedback-(\d+)\.md$/);
  if (!f) fail("No 00-input/feedback-<n>.md found (and --feedback not given).");
  feedbackRel = join("00-input", f.name);
  round = f.n;
} else {
  const m = /feedback-(\d+)\.md$/.exec(basename(feedbackRel));
  round = m ? Number(m[1]) : null;
}
const feedbackPath = join(runPath, feedbackRel);

const latestConcept = latest(join(runPath, "02-concept"), /^concept\.v(\d+)\.html$/);
let conceptRel = opts.concept;
if (!conceptRel) {
  if (!latestConcept) fail("No 02-concept/concept.v<n>.html found (and --concept not given).");
  conceptRel = join("02-concept", latestConcept.name);
}
const conceptPath = join(runPath, conceptRel);

// ---- file ----------------------------------------------------------------------------

let body = "";
if (!existsSync(feedbackPath)) {
  fatal("file", `feedback file is missing: ${feedbackRel}`);
} else {
  body = readFileSync(feedbackPath, "utf8");
  if (!body.trim()) fatal("file", `feedback file is empty: ${feedbackRel}`);
  if (round === null) {
    fatal("file", `feedback file name carries no round number: ${basename(feedbackRel)}`, "expected feedback-<n>.md so manifest.loops.feedback can be reconciled");
  }
}

// ---- version (the concept this round pins itself to) --------------------------------

/** `Concept: concept.v2.html` — the version the reviewer actually looked at. */
const pinMatch = /^[ \t]*concept[ \t]*:[ \t]*(\S+)[ \t]*$/im.exec(body);
const pinned = pinMatch ? basename(pinMatch[1]) : null;

if (body.trim()) {
  if (!pinned) {
    fatal(
      "version",
      "no `Concept:` line — the round does not say which concept version it targets",
      "add `Concept: concept.v<n>.html`; without it a stale round cannot be distinguished from a current one",
    );
  } else if (!/^concept\.v\d+\.html$/.test(pinned)) {
    fatal("version", `\`Concept: ${pinned}\` is not a concept.v<n>.html file name`);
  } else if (pinned !== basename(conceptRel)) {
    fatal(
      "version",
      `round targets ${pinned} but is being checked against ${basename(conceptRel)}`,
      "re-post the human gate against the current concept and collect the feedback again — block ids are stable across versions, so applying this round would land it on the wrong one silently",
    );
  } else if (latestConcept && pinned !== latestConcept.name) {
    fatal(
      "version",
      `round targets ${pinned}, but ${latestConcept.name} is the current version`,
      "the reviewer commented on a superseded concept; re-post the gate against the current one rather than reinterpreting their findings",
    );
  }
}

// ---- concept (the target whose ids the findings must resolve against) ----------------

const blockIds = new Set();
const copyIds = new Set();
if (!existsSync(conceptPath)) {
  fatal("targets", `target concept is missing: ${conceptRel}`);
} else {
  const concept = readFileSync(conceptPath, "utf8");
  for (const m of concept.matchAll(/\sdata-block\s*=\s*"([^"]+)"/g)) blockIds.add(m[1]);
  for (const m of concept.matchAll(/\sdata-copy\s*=\s*"([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/).filter(Boolean)) copyIds.add(id);
  }
  for (const m of concept.matchAll(/\sdata-copy-id\s*=\s*"([^"]+)"/g)) copyIds.add(m[1]);
  if (!blockIds.size) fatal("targets", `target concept declares no data-block: ${conceptRel}`);
}

// ---- table ---------------------------------------------------------------------------

/** Split a markdown table row into trimmed cells, dropping the leading/trailing pipes. */
const cells = (line) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isDivider = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

const rows = [];
let headerSeen = false;
for (const line of body.split(/\r?\n/)) {
  if (!line.trim().startsWith("|")) continue;
  if (isDivider(line)) continue;
  const c = cells(line);
  if (!headerSeen) {
    const lower = c.map((x) => x.toLowerCase());
    if (COLUMNS.every((col, i) => lower[i] === col)) {
      headerSeen = true;
      continue;
    }
    // a table that starts without the expected header is reported once, below
    continue;
  }
  if (c.length < COLUMNS.length) {
    fatal("table", `finding row has ${c.length} cells, expected ${COLUMNS.length}`, line.trim());
    continue;
  }
  rows.push(Object.fromEntries(COLUMNS.map((col, i) => [col, c[i]])));
}

if (body.trim() && !headerSeen) {
  fatal("table", `no findings table with the critic's columns: | ${COLUMNS.join(" | ")} |`);
}

// ---- ids · targets · severity · fix --------------------------------------------------

const seen = new Set();
for (const r of rows) {
  const where = `${r.id || "(no id)"}`;

  if (!/^H\d+$/.test(r.id)) {
    fatal("ids", `id "${r.id}" is not H<n>`, "human findings use H1, H2 … so the ledger records who asked; the critic uses F<n>");
  } else if (seen.has(r.id)) {
    fatal("ids", `duplicate finding id "${r.id}"`);
  } else {
    seen.add(r.id);
  }

  const target = r.block;
  if (target && target !== "-" && blockIds.size) {
    if (!blockIds.has(target) && !copyIds.has(target)) {
      const kind = /^c\d+$/.test(target) ? "copy id" : "block";
      fatal(
        "targets",
        `${where}: ${kind} "${target}" is not in ${basename(conceptRel)}`,
        `concept declares blocks [${[...blockIds].join(" ")}]${copyIds.size ? ` and copy ids [${[...copyIds].join(" ")}]` : ""}`,
      );
    }
  } else if (!target) {
    fatal("targets", `${where}: block column is empty`, 'use "-" for feedback about the page as a whole');
  }

  if (!SEVERITIES.has((r.severity || "").toLowerCase())) {
    fatal("severity", `${where}: severity "${r.severity}" is not blocking|advisory`);
  }

  if (!r.fix) {
    fatal("fix", `${where}: fix column is empty`, "the fix column tells the architect what to do, not merely what is wrong");
  }
  if (!r.finding) warn("fix", `${where}: finding column is empty`);
  if (!r.rule) warn("fix", `${where}: no rule cited`, "a § makes the change auditable; human feedback may legitimately have none");
}

if (body.trim() && headerSeen && !rows.length) {
  fatal("findings", "findings table has no rows", "an empty feedback round would burn a concept version for no change");
}

// ---- report --------------------------------------------------------------------------

const fails = findings.filter((f) => f.severity === "fail");
const warns = findings.filter((f) => f.severity === "warn");
const blocking = rows.filter((r) => (r.severity || "").toLowerCase() === "blocking");
const advisory = rows.filter((r) => (r.severity || "").toLowerCase() === "advisory");

const report = {
  tool: "feedback-check",
  runDir: runPath,
  feedback: feedbackRel,
  concept: conceptRel,
  pinnedConcept: pinned,
  latestConcept: latestConcept ? latestConcept.name : null,
  round,
  verdict: fails.length ? "FAIL" : "PASS",
  counts: { findings: rows.length, blocking: blocking.length, advisory: advisory.length },
  rows,
  findings,
};

if (opts.out) {
  const outPath = opts.out === "json" ? join(runPath, "feedback-check.json") : resolve(opts.out);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  report.written = outPath;
}

const lines = [
  `FEEDBACK-CHECK: ${report.verdict} | FILE: ${basename(feedbackRel)} | CONCEPT: ${basename(conceptRel)} | FINDINGS: ${rows.length} | BLOCKING: ${blocking.length} | ADVISORY: ${advisory.length} | FAILURES: ${fails.length} | WARNINGS: ${warns.length}`,
];
for (const f of [...fails, ...warns]) {
  lines.push(`  ${f.severity === "fail" ? "FAIL" : "warn"}  ${f.check.padEnd(9)} ${f.message}${f.detail ? `\n        ${f.detail}` : ""}`);
}
if (report.written) lines.push(`  report: ${report.written}`);
printCapped(lines);

process.exit(report.verdict === "PASS" ? 0 : 1);
