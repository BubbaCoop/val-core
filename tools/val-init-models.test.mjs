/**
 * Contract tests for the `models` config key of bin/val-init.mjs — the per-agent model override.
 *
 * The override exists to move mechanical stages to a cheaper model. Three things must hold:
 * it lands in the generated frontmatter (inserted or replaced), it cannot name an agent that
 * does not exist (a typo would silently change nothing), and it cannot reach the design-*
 * agents, whose `model: inherit` is a run-integrity invariant (agent-templates.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INIT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "val-init.mjs");

function run(models) {
  const dir = mkdtempSync(join(tmpdir(), "val-init-models-"));
  mkdirSync(join(dir, "val"), { recursive: true });
  const config = {
    library: { name: "t", displayName: "T", figmaFileKey: "PA5pr1Q8KLfbjTxdAbFm0V", package: "@valiify/t-ui" },
    paths: { designSystemSkill: ".claude/skills/t/SKILL.md" },
    pipelines: { design: true },
    design: { surfaces: { s: { displayName: "S", methodology: "s.md" } } },
    ...(models ? { models } : {}),
  };
  writeFileSync(join(dir, "val", "config.json"), JSON.stringify(config, null, 2));
  const r = spawnSync(process.execPath, [INIT], { encoding: "utf8", cwd: dir });
  return { ...r, dir, message: r.stderr + r.stdout };
}

const modelOf = (dir, agent) => {
  const text = readFileSync(join(dir, ".claude", "agents", `${agent}.md`), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)[1];
  return /^model:\s*(\S+)\s*$/m.exec(fm)?.[1] ?? null;
};

test("without models, every agent keeps its template's choice", () => {
  const r = run();
  assert.equal(r.status, 0, r.message);
  assert.equal(modelOf(r.dir, "val-qa"), null);
  assert.equal(modelOf(r.dir, "val-components"), "sonnet");
  assert.equal(modelOf(r.dir, "design-critic"), "inherit");
});

test("an agent with no model line gets one inserted; the others are untouched", () => {
  const r = run({ "val-qa": "sonnet", "val-context": "sonnet" });
  assert.equal(r.status, 0, r.message);
  assert.equal(modelOf(r.dir, "val-qa"), "sonnet");
  assert.equal(modelOf(r.dir, "val-context"), "sonnet");
  assert.equal(modelOf(r.dir, "val-build"), null);
  assert.equal(modelOf(r.dir, "val-accuracy"), null);
});

test("an agent whose template pins a model has it replaced, not duplicated", () => {
  const r = run({ "val-components": "opus" });
  assert.equal(r.status, 0, r.message);
  const text = readFileSync(join(r.dir, ".claude", "agents", "val-components.md"), "utf8");
  assert.equal((text.match(/^model:/gm) ?? []).length, 1);
  assert.equal(modelOf(r.dir, "val-components"), "opus");
});

test("the frontmatter stays well-formed after an insert (name and tools survive)", () => {
  const r = run({ "val-figma": "claude-opus-5-5" });
  assert.equal(r.status, 0, r.message);
  const text = readFileSync(join(r.dir, ".claude", "agents", "val-figma.md"), "utf8");
  assert.match(text, /^---\nname: val-figma\n[\s\S]*\ntools: [^\n]+\n[\s\S]*model: claude-opus-5-5\n---\n/);
});

test("a name that matches no agent fails and lists the real ones — a typo must not be a no-op", () => {
  const r = run({ "val-qaa": "sonnet" });
  assert.notEqual(r.status, 0);
  assert.match(r.message, /models\.val-qaa names no agent/);
  assert.match(r.message, /val-qa/);
});

test("the design-* agents cannot be overridden", () => {
  const r = run({ "design-critic": "sonnet" });
  assert.notEqual(r.status, 0);
  assert.match(r.message, /design-\* agents pin model: inherit/);
});

test("a value that is not a model alias or claude-* id fails validation", () => {
  const r = run({ "val-qa": "gpt-5" });
  assert.notEqual(r.status, 0);
  assert.match(r.message, /models\.val-qa: "gpt-5" does not match/);
});
