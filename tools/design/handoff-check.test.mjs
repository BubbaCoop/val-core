/** Fixture tests for <tools-dir>/design/handoff-check.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "handoff-check.mjs");

const CONCEPT = `<!doctype html><html><body>
<main data-concept data-viewport="web">
  <section data-block="b01" data-region="header" data-class=".header" data-states="rest"><p>Header</p></section>
  <section data-block="b02" data-region="content" data-class=".text-field .text-field-box" data-states="empty error"><p>Field</p></section>
</main></body></html>`;

const PAGE = `<script>
  let { value = $bindable(""), invalid = false } = $props();
</script>
<header data-block="b01" class="header">Valiify</header>
<div data-block="b02" class="text-field">
  <div class="text-field-box">
    <input class="text-field-input" bind:value aria-invalid={invalid ? "true" : undefined} placeholder="123 Main St" />
  </div>
  {#if invalid}<p class="text-field-hint">Enter a street address, not a PO Box.</p>{/if}
</div>
<svg aria-hidden="true"><use href="#arrow-right" /></svg>`;

const CONTRACT = {
  route: "/consumer/residential-details",
  archetype: "form",
  blocks: [
    { id: "b01", region: "header", file: "src/routes/+page.svelte", classes: ["header"] },
    { id: "b02", region: "content", file: "src/routes/+page.svelte", classes: ["text-field"] },
  ],
  states: [
    { id: "empty", when: 'value === ""', prop: "value", blocks: ["b02"] },
    { id: "error", when: "invalid === true", prop: "invalid", blocks: ["b02"] },
  ],
  actions: [{ id: "continue", label: "Continue", kind: "continue" }],
  copy: [{ id: "c01", text: "Enter a street address, not a PO Box.", source: "brief" }],
  icons: ["arrow-right"],
};

const HANDOFF = `# Handoff
## 1. Status and provenance
## 2. Load path
## 3. Public API
## 4. Markup contract
## 5. Behaviour spec
## 6. Payload
## 7. Deviations
## 8. Library defects and gaps to raise upstream
## 9. Tests
## 10. Evidence
## 11. Gotchas
## 12. Open questions for the dev team
## Methodology rules applied
## Unsure
`;

function setup({ concept = CONCEPT, page = PAGE, contract = CONTRACT, handoff = HANDOFF, hash, sprite = true } = {}) {
  const run = mkdtempSync(join(tmpdir(), "val-handoff-"));
  mkdirSync(join(run, "02-concept"), { recursive: true });
  mkdirSync(join(run, "05-package", "src", "routes"), { recursive: true });
  writeFileSync(join(run, "02-concept", "concept.v1.html"), concept);
  const sha = hash ?? createHash("sha256").update(concept).digest("hex");
  writeFileSync(join(run, "04-approval.md"), `# Approval\n| Concept | \`02-concept/concept.v1.html\` |\n| sha256 | \`${sha}\` |\n`);
  writeFileSync(join(run, "05-package", "src", "routes", "+page.svelte"), page);
  writeFileSync(join(run, "05-package", "contract.json"), JSON.stringify(contract, null, 2));
  writeFileSync(join(run, "05-package", "mapping.md"), "| block | class | file |\n");
  writeFileSync(join(run, "05-package", "HANDOFF.md"), handoff);
  let spritePath = null;
  if (sprite) {
    spritePath = join(run, "sprite.svg");
    writeFileSync(spritePath, `<svg><symbol id="arrow-right"></symbol><symbol id="check"></symbol></svg>`);
  }
  return { run, spritePath };
}
const run = (dir, sprite) => spawnSync(process.execPath, [TOOL, dir, ...(sprite ? ["--sprite", sprite] : [])], { encoding: "utf8" });
const report = (dir) => JSON.parse(readFileSync(join(dir, "handoff-check.json"), "utf8"));
const checks = (rep, check) => rep.findings.filter((f) => f.check === check && f.severity === "fail");

test("a complete package passes", () => {
  const { run: dir, spritePath } = setup();
  const r = run(dir, spritePath);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /HANDOFF-CHECK: PASS/);
  const rep = report(dir);
  assert.equal(rep.counts.conceptBlocks, 2);
  assert.equal(rep.counts.contractBlocks, 2);
  assert.ok(rep.counts.props >= 2, "props were parsed from $props()");
});

test("props survive commas inside defaults, object/array literals and aliases", () => {
  const page = `<script>
  let {
    entity = "Northgate Logistics, INC",
    rows = [{ a: 1, b: 2 }],
    config: cfg = { mode: "x", n: 2 },
    invalid = false,
    value = $bindable(""),
  } = $props();
</script>
<header data-block="b01" class="header">{entity}</header>
<div data-block="b02" class="text-field">
  <div class="text-field-box">
    <input class="text-field-input" bind:value aria-invalid={invalid ? "true" : undefined} />
  </div>
  {#if invalid}<p class="text-field-hint">Enter a street address, not a PO Box.</p>{/if}
</div>
<svg aria-hidden="true"><use href="#arrow-right" /></svg>`;
  const contract = structuredClone(CONTRACT);
  // states driven by props declared AFTER the comma-bearing default
  contract.states = [
    { id: "empty", when: 'value === ""', prop: "value", blocks: ["b02"] },
    { id: "error", when: "invalid === true", prop: "invalid", blocks: ["b02"] },
  ];
  const { run: dir, spritePath } = setup({ page, contract });
  const r = run(dir, spritePath);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rep = report(dir);
  assert.ok(rep.counts.props >= 6, `expected every prop, got ${rep.counts.props}`);
});

test("a concept edited after approval voids the approval", () => {
  const { run: dir, spritePath } = setup({ hash: "0".repeat(64) });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.equal(checks(report(dir), "approval").length, 1);
  assert.match(r.stdout, /hash does not match/);
});

test("a missing block implementation fails", () => {
  const { run: dir, spritePath } = setup({ page: PAGE.replace(/data-block="b02"/, "") });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "blocks").some((f) => /b02 has no implementation/.test(f.message)));
});

test("a data-class the package never uses fails", () => {
  const { run: dir, spritePath } = setup({ page: PAGE.replace(/class="text-field-box"/, 'class="text-field-inner"') });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "blocks").some((f) => /data-class not found/.test(f.message)));
});

test("an unreachable state fails", () => {
  const contract = structuredClone(CONTRACT);
  contract.states[1] = { id: "error", when: "somethingNobodyPassed === true", prop: "somethingNobodyPassed", blocks: ["b02"] };
  const { run: dir, spritePath } = setup({ contract });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "states").some((f) => /not reachable/.test(f.message)));
});

test("a concept state missing from the contract fails", () => {
  const contract = structuredClone(CONTRACT);
  contract.states = [];
  const { run: dir, spritePath } = setup({ contract });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "states").some((f) => /"error" is not in contract.states/.test(f.message)));
});

test("a package built from a superseded concept fails on copy ids", () => {
  // The approved concept declares c14a; the contract (built from the older version) still
  // carries c09. Ids, blocks and markup all line up — only the concept↔contract copy
  // reconciliation can catch it.
  const concept = CONCEPT.replace('data-states="empty error"', 'data-states="empty error" data-copy="c14a"');
  const { run: dir, spritePath } = setup({ concept });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const fails = report(dir).findings.filter((f) => f.check === "copy" && f.severity === "fail");
  assert.ok(fails.some((f) => /declares copy c14a/.test(f.message)), JSON.stringify(fails, null, 1));
});

test("copy whose text drifted from the approved concept fails", () => {
  const concept = CONCEPT.replace(
    '<p>Field</p>',
    '<p data-copy-id="c01">Enter a street address, not a PO Box.</p>',
  );
  const contract = structuredClone(CONTRACT);
  contract.copy[0].text = "Enter a street address (no PO boxes).";
  const page = PAGE.replace("Enter a street address, not a PO Box.", "Enter a street address (no PO boxes).");
  const { run: dir, spritePath } = setup({ concept, contract, page });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(report(dir).findings.some((f) => /differs from the approved concept/.test(f.message)));
});

test("a copy string split across child elements compares whole, not fragment", () => {
  // The eyebrow renders its run and its section name as separate spans; extracting only the
  // text before the first child would compare "STEP 4 OF 7 /" against the full string.
  const concept = CONCEPT.replace(
    '<p>Header</p>',
    '<p data-copy-id="c00">STEP 4 OF 7 / <span>RESIDENCE</span></p>',
  );
  const contract = structuredClone(CONTRACT);
  contract.copy.push({ id: "c00", role: "eyebrow", text: "STEP 4 OF 7 / RESIDENCE", source: "brief", verbatimInMarkup: false });
  const { run: dir, spritePath } = setup({ concept, contract });
  const r = run(dir, spritePath);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("copy that is not verbatim fails", () => {
  const { run: dir, spritePath } = setup({ page: PAGE.replace("Enter a street address, not a PO Box.", "Enter a street address (no PO boxes).") });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "copy").some((f) => /c01 does not appear verbatim in the markup/.test(f.message)));
});

test("a missing HANDOFF section, a missing file, and an invalid contract each fail", () => {
  const { run: dir, spritePath } = setup({ handoff: HANDOFF.replace("## 7. Deviations\n", "") });
  assert.equal(run(dir, spritePath).status, 1);
  assert.ok(checks(report(dir), "handoff").length >= 1);

  const bad = structuredClone(CONTRACT);
  delete bad.route;
  bad.blocks[0].id = "header";        // violates the ^b[0-9]+$ pattern
  bad.copy[0].source = "invented";    // not in the enum
  const { run: d2, spritePath: s2 } = setup({ contract: bad });
  assert.equal(run(d2, s2).status, 1);
  const errs = checks(report(d2), "contract").map((f) => f.message).join("\n");
  assert.match(errs, /contract\.route: required/);
  assert.match(errs, /does not match/);
  assert.match(errs, /is not one of/);
});

test("the load path and the sprite may not live in the package", () => {
  const { run: dir, spritePath } = setup({ page: `<script>\n  import sprite from "@valiify/shortapp-ui/icons/sprite.svg?raw";\n  let { invalid = false } = $props();\n</script>\n${PAGE}` });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "shell").some((f) => /loads the icon sprite/.test(f.message)));
});

test("a blocked concept block cannot be built", () => {
  const { run: dir, spritePath } = setup({ concept: CONCEPT.replace('data-block="b02"', 'data-block="b02" data-blocked="no-component"') });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "blocks").some((f) => /still data-blocked/.test(f.message)));
});

test("a .svelte file that does not compile fails", () => {
  const { run: dir, spritePath } = setup({ page: `<script>let { invalid = false } = $props();</script>\n{#if invalid}\n<div data-block="b01" class="header">unclosed` });
  const r = run(dir, spritePath);
  assert.equal(r.status, 1);
  assert.ok(checks(report(dir), "compile").length >= 1, JSON.stringify(report(dir).findings, null, 1));
});
