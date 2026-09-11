/**
 * Contract tests for the generated agent templates themselves — the things a run cannot
 * check because by the time a run is wrong, the model has already been chosen and the
 * wrong file has already been read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "templates", "agents");
const SKILLS = join(ROOT, "skills");

const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? m[1] : "";
};

test("every design-* agent pins a model — a judgement stage must not inherit a cheaper default", () => {
  const design = readdirSync(AGENTS).filter((f) => f.startsWith("design-"));
  assert.ok(design.length >= 5, `expected the five design agents, found ${design.length}`);
  for (const f of design) {
    const fm = frontmatter(readFileSync(join(AGENTS, f), "utf8"));
    const m = /^model:\s*(\S+)\s*$/m.exec(fm);
    assert.ok(m, `${f} has no model: in its frontmatter — it would run on whatever the session defaults to`);
    assert.equal(
      m[1],
      "inherit",
      `${f} pins model: ${m[1]}; the design stages must match the session that dispatched them, or two gates of one run silently differ`,
    );
  }
});

test("val-core ships nothing under skills/ that could shadow a library methodology file", () => {
  // A design agent resolves its methodology from manifest.methodology. If val-core ever
  // shipped skills/design-methodology/<surface>.md, a search-based resolution would find
  // the packaged file instead of the library's — and it would look plausible.
  const stray = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith(".md") && name.name !== "SKILL.md") stray.push(p.slice(ROOT.length + 1));
    }
  };
  if (existsSync(SKILLS)) walk(SKILLS);
  assert.deepEqual(
    stray,
    [],
    `skills/ must contain only SKILL.md files; these could be mistaken for a surface methodology: ${stray.join(", ")}`,
  );
});

test("the intake agent is told to resolve the methodology by path, not by search", () => {
  const intake = readFileSync(join(AGENTS, "design-brief-intake.template.md"), "utf8");
  assert.match(intake, /Resolve the methodology by path, never by search/i);
  assert.match(intake, /node_modules/, "the instruction must name the directory the wrong file would come from");
  assert.match(intake, /manifest\.methodology/);
});

test("the orchestrator refuses to run in plan mode", () => {
  const cmd = readFileSync(join(ROOT, "templates", "commands", "design.template.md"), "utf8");
  assert.match(cmd, /Refuse to run in plan mode/i);
});
