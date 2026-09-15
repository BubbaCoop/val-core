/**
 * Contract tests for the class-identity half of bin/val-init.mjs.
 *
 * This path had no coverage at all: CLASS_AUDIT_FLAGS decides whether a library's generated
 * agents run class-audit with the window open or shut, and nothing checked that the config
 * it is built from is read correctly — or refused when it is incoherent.
 *
 * Lives in tools/ rather than beside bin/ because npm test globs tools/*.test.mjs; the same
 * reason tools/changelog.test.mjs sits here while testing a repo-level concern.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INIT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "val-init.mjs");

/** Minimal config that generates the design agents — the ones carrying the class-audit call. */
function baseConfig(library = {}) {
  return {
    library: {
      name: "t",
      displayName: "T",
      figmaFileKey: "PA5pr1Q8KLfbjTxdAbFm0V",
      package: "@valiify/t-ui",
      ...library,
    },
    paths: { designSystemSkill: ".claude/skills/t/SKILL.md" },
    pipelines: { design: true },
    design: { surfaces: { s: { displayName: "S", methodology: "s.md" } } },
  };
}

function run(library) {
  const dir = mkdtempSync(join(tmpdir(), "val-init-"));
  mkdirSync(join(dir, "val"), { recursive: true });
  writeFileSync(join(dir, "val", "config.json"), JSON.stringify(baseConfig(library), null, 2));
  const r = spawnSync(process.execPath, [INIT], { encoding: "utf8", cwd: dir });
  return { ...r, dir, message: r.stderr + r.stdout };
}

/** The class-audit command line as the generated build agent will actually run it. */
const renderedCommand = (dir) =>
  readFileSync(join(dir, ".claude", "agents", "design-page-builder.md"), "utf8")
    .split("\n")
    .find((l) => l.includes("class-audit.mjs"));

// ---- what the flags render to -----------------------------------------------------------

test("classSpelling strict renders --class-strict beside the prefix", () => {
  const r = run({ classPrefix: "va", classSpelling: "strict" });
  assert.equal(r.status, 0, r.message);
  assert.match(renderedCommand(r.dir), /--class-prefix va --class-strict/);
});

test("classSpelling tolerant renders the prefix WITHOUT --class-strict", () => {
  const r = run({ classPrefix: "va", classSpelling: "tolerant" });
  assert.equal(r.status, 0, r.message);
  const cmd = renderedCommand(r.dir);
  assert.match(cmd, /--class-prefix va/);
  assert.doesNotMatch(cmd, /--class-strict/, "the window must stay open when tolerance is declared");
});

test("a library with no class identity renders no class flags at all", () => {
  const r = run({});
  assert.equal(r.status, 0, r.message);
  const cmd = renderedCommand(r.dir);
  assert.doesNotMatch(cmd, /--class-prefix/);
  assert.doesNotMatch(cmd, /--class-strict/);
});

// ---- the refusals, and whether they are telling apart from one another ------------------
// Three different misconfigurations must not collapse into one generic "invalid config".
// Message quality is the whole reason this is a hand-written check rather than a schema
// keyword, so it is asserted rather than assumed.

const MISSING_SPELLING = () => run({ classPrefix: "va" });
const MISSING_PREFIX = () => run({ classSpelling: "strict" });
const BAD_ENUM = () => run({ classPrefix: "va", classSpelling: "Strict" });

test("classPrefix without classSpelling is refused, and the message states both values", () => {
  const r = MISSING_SPELLING();
  assert.equal(r.status, 1, r.message);
  assert.match(r.message, /library\.classSpelling is required/);
  assert.match(r.message, /"strict"/, "the message must state what strict does");
  assert.match(r.message, /"tolerant"/, "…and what tolerant does, or it cannot be acted on");
});

test("classSpelling without classPrefix is refused — the CLI guard is not bypassable by config", () => {
  // class-audit itself refuses `--class-strict` without `--class-prefix`. Going through config
  // used to render NOTHING instead, silently: a config that declared strict and enforced none.
  const r = MISSING_PREFIX();
  assert.equal(r.status, 1, r.message);
  assert.match(r.message, /library\.classPrefix is required/);
});

test("an enum value that is merely miscased is refused, not silently downgraded to tolerant", () => {
  // "Strict" passed the hand-rolled validator, then failed the === "strict" test and rendered
  // a TOLERANT command line — the config said the window was shut while it was open.
  const r = BAD_ENUM();
  assert.equal(r.status, 1, r.message);
  assert.match(r.message, /"Strict"/, "the offending value must be quoted back");
  assert.match(r.message, /"tolerant" \| "strict"/, "…alongside the legal values");
});

test("the three refusals are distinguishable from one another", () => {
  const messages = [MISSING_SPELLING(), MISSING_PREFIX(), BAD_ENUM()].map((r) => r.message.trim());
  assert.equal(new Set(messages).size, 3, `three failure modes collapsed into one message:\n${messages.join("\n---\n")}`);
  // and each names the key or value actually at fault, not just "invalid config"
  assert.doesNotMatch(messages[1], /classSpelling is required/, "the reverse direction must not reuse the forward message");
});
