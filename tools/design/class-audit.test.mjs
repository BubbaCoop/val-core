/** Fixture tests for <tools-dir>/design/class-audit.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "class-audit.mjs");

function fixtureLibrary(root) {
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "src", "themes"), { recursive: true });
  mkdirSync(join(root, "src", "utilities"), { recursive: true });
  writeFileSync(
    join(root, "src", "components", "button.css"),
    `/* Button — .list-item lesson mentioned in a comment must NOT register */
@layer components {
  .btn { @apply flex h-12; }
  .btn-primary, .btn-secondary { @apply rounded-sm; }
  .btn:hover:not(:disabled) { color: red; }
}`,
  );
  writeFileSync(
    join(root, "src", "components", "text-field.css"),
    `@layer components { .text-field-box:has(.text-field-input:focus) { @apply border-primary; } }`,
  );
  writeFileSync(
    join(root, "src", "themes", "theme.css"),
    `@theme static {
  --color-primary: oklch(0.47 0.17 20);
  --color-primary-hover: oklch(0.43 0.16 20);
  --color-content-primary: oklch(0.22 0 0);
  --color-surface-paper: oklch(0.99 0 0);
  --text-display: 28px;
  --text-display--line-height: 34px;
  --text-eyebrow: 11px;
  --radius-sm: 4px;
  --radius-md: 6px;
}
@utility type-eyebrow { @apply text-eyebrow uppercase; }`,
  );
  writeFileSync(join(root, "src", "utilities", "index.css"), `@utility focus-ring { outline: 3px solid red; }`);
  writeFileSync(
    join(root, "CLAUDE.md"),
    `#### Button
\`\`\`html
<button class="btn btn-primary w-full">Continue</button>
\`\`\`
Surfaces are \`bg-surface-paper\`; the pressed fill is \`bg-primary-hover\`.`,
  );
  writeFileSync(
    join(root, "short-app.md"),
    `## 1. Layout
Body \`w-140 mx-auto py-12 flex flex-col gap-10\`; cards \`gap-3\`; owner row \`h-[92.5px]\`; title \`text-display text-content-primary\`; radius \`rounded-md\`.
Buttons: \`.btn btn-secondary\` + \`gap-6\` + \`.btn btn-primary flex-1\`. Border \`border-b border-stroke-divider\`.`,
  );
}

function run(target, root, extra = []) {
  return spawnSync(
    process.execPath,
    [TOOL, target, "--library", root, "--methodology", join(root, "short-app.md"), "--no-tailwind", ...extra],
    { encoding: "utf8" },
  );
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "val-class-audit-"));
  const lib = join(dir, "lib");
  fixtureLibrary(lib);
  const pkg = join(dir, "pkg");
  mkdirSync(pkg, { recursive: true });
  return { dir, lib, pkg };
}

const kindOf = (report, cls) => report.classes.find((c) => c.cls === cls)?.kind;

test("classifies every sanctioned kind and flags unsanctioned + violations", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(pkg, "Page.svelte"),
    `<script>let a = $state(true);</script>
<div class="w-140 mx-auto py-12 flex flex-col gap-10 md:w-full">
  <button class="btn btn-primary w-full mt-7 bg-red-500 bg-primary/50" style:color="red">x</button>
  <h1 class={"text-display " + (a ? "text-content-primary" : "font-semibold")}>t</h1>
  <p class="h-[92.5px] h-[13px] uppercase type-eyebrow focus-ring rounded-md bg-primary-hover [&_svg]:size-4" class:open={a}>y</p>
</div>`,
  );
  const r = run(pkg, lib);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(report.verdict, "FAIL");

  assert.equal(kindOf(report, "btn"), "component");
  assert.equal(kindOf(report, "btn-primary"), "component");
  assert.equal(kindOf(report, "type-eyebrow"), "utility");
  assert.equal(kindOf(report, "focus-ring"), "utility");
  assert.equal(kindOf(report, "text-display"), "token");
  assert.equal(kindOf(report, "text-content-primary"), "token");
  assert.equal(kindOf(report, "rounded-md"), "token");
  assert.equal(kindOf(report, "bg-primary-hover"), "token", "cited in CLAUDE.md counts");
  assert.equal(kindOf(report, "mx-auto"), "structural");
  assert.equal(kindOf(report, "flex"), "structural");
  assert.equal(kindOf(report, "md:w-full"), "structural");
  assert.equal(kindOf(report, "w-140"), "cited");
  assert.equal(kindOf(report, "gap-10"), "cited");
  assert.equal(kindOf(report, "py-12"), "cited");
  assert.equal(kindOf(report, "w-full"), "structural");
  assert.equal(kindOf(report, "h-[92.5px]"), "arbitrary");

  assert.equal(kindOf(report, "mt-7"), "unsanctioned", "on-grid spacing the methodology never uses");
  assert.equal(kindOf(report, "bg-red-500"), "unsanctioned", "default palette compiles but is not sanctioned");
  assert.equal(kindOf(report, "open"), "unsanctioned", "class: directive toggling a synced class");

  assert.equal(kindOf(report, "bg-primary/50"), "violation");
  assert.equal(kindOf(report, "font-semibold"), "violation");
  assert.equal(kindOf(report, "uppercase"), "violation");
  assert.equal(kindOf(report, "h-[13px]"), "violation");
  assert.equal(kindOf(report, "[&_svg]:size-4"), "violation");
  assert.ok(report.issues.some((i) => i.detail === "style:color"), "style: directive is an issue");
  assert.equal(report.tailwind.checked, false);
  assert.ok(!report.classes.some((c) => c.cls === "list-item"), "comment text never registers a component class");
});

test("a keyword utility the methodology writes literally is sanctioned (ring-inset)", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(lib, "short-app.md"),
    readFileSync(join(lib, "short-app.md"), "utf8") +
      "\nComposed cards ring at `ring-1 ring-inset ring-stroke-divider`; strikethrough is `line-through`.\n",
  );
  writeFileSync(
    join(lib, "src", "themes", "theme.css"),
    readFileSync(join(lib, "src", "themes", "theme.css"), "utf8") + "\n@theme static { --color-stroke-divider: red; }",
  );
  writeFileSync(join(pkg, "Ring.svelte"), '<div class="rounded-md ring-1 ring-inset ring-stroke-divider line-through"></div>');
  const r = run(pkg, lib);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(kindOf(report, "ring-inset"), "cited", "a keyword utility carries no token — citation is what sanctions it");
  assert.equal(kindOf(report, "line-through"), "structural");
  assert.equal(kindOf(report, "ring-stroke-divider"), "token");
});

test("a clean page passes with exit 0", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(pkg, "Clean.svelte"),
    `<main class="w-140 mx-auto py-12 flex flex-col gap-10">
  <h1 class="text-display text-content-primary">Title</h1>
  <div class="flex gap-6"><button class="btn btn-secondary">Back</button><button class="btn btn-primary flex-1" disabled>Continue</button></div>
</main>`,
  );
  const r = run(pkg, lib);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CLASS-AUDIT: PASS/);
});

test("concept wireframes audit data-class and reject class= and <style>", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(pkg, "concept.v1.html"),
    `<!doctype html><html><head><style>body{}</style></head><body>
<main data-concept data-viewport="web">
  <section data-block="b01" data-class=".btn .btn-primary flex-1 gap-9" class="oops"><p data-label>x</p></section>
</main></body></html>`,
  );
  const r = run(pkg, lib);
  assert.equal(r.status, 1);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(kindOf(report, "btn"), "component");
  assert.equal(kindOf(report, "flex-1"), "structural");
  assert.equal(kindOf(report, "gap-9"), "unsanctioned");
  assert.ok(report.issues.some((i) => i.detail === "<style>"));
  assert.ok(report.issues.some((i) => i.detail === "oops"), "class= inside a concept is a violation");
  assert.equal(report.classes.some((c) => c.cls === "oops"), false);
});

test("surface rules derive from the methodology (§10 unused line, §12 interim column) and the theme (needs font-mono)", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(lib, "src", "components", "card.css"),
    `@layer components { .card { @apply rounded-sm; } .data-row { @apply flex; } .dot { @apply size-2; } }`,
  );
  writeFileSync(
    join(lib, "src", "themes", "theme.css"),
    readFileSync(join(lib, "src", "themes", "theme.css"), "utf8") +
      `\n@theme static {
  --font-mono: "JetBrains Mono";
  --text-data-xs: 12px; /* Data/Data xs (JetBrains Mono Regular — needs font-mono) */
  --text-data-xs--line-height: 16.5px;
  --text-caption: 12px; /* Body Content/Caption */
  --border-thin: 0.5px;
  --color-stroke-divider: red;
  --color-misc-purple: purple;
}`,
  );
  writeFileSync(
    join(lib, "short-app.md"),
    readFileSync(join(lib, "short-app.md"), "utf8") +
      `
IDs are \`text-data-xs font-mono\`; captions \`text-caption\`; seams \`border-b border-b-[length:var(--border-thin)] border-stroke-divider\`; cards \`border border-[length:var(--border-thin)]\`.

## 10. Component map

Shipped components that no in-scope frame uses: \`.pill\`, \`.card\` (scaffolding — never use). Do not map by analogy.

## 12. Planned library additions

| Addition | Spec from the frames | Interim class (use verbatim) | Library home |
|---|---|---|---|
| Workspace-card shadow | \`0 4 4 #000 @8%\` | \`shadow-[0_4px_4px_rgb(0_0_0/0.08)]\` | new token |
| Overridden dot | \`--color-misc-purple\` | \`.dot\` + \`bg-misc-purple\` | dot variant |
| Reject hover | critical on hover | \`hover:border-critical hover:text-critical\` | modifier |

## 13. Open items
`,
  );
  writeFileSync(
    join(pkg, "Dash.svelte"),
    `<div class="card data-row shadow-[0_4px_4px_rgb(0_0_0/0.08)] border border-[length:var(--border-thin)]">
  <span class="text-data-xs font-mono">#1</span>
  <span class="text-data-xs">#2</span>
  <span class="text-caption">no mono needed</span>
  <span class="dot bg-misc-purple"></span>
  <button class="btn hover:border-critical hover:text-critical">Reject</button>
  <div class="border-b border-[length:var(--border-thin)] border-stroke-divider">seam</div>
  <div class="border-b border-b-[length:var(--border-thin)] border-stroke-divider">seam ok</div>
</div>`,
  );
  const r = run(pkg, lib);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.deepEqual(report.rules.forbidden.sort(), ["card", "pill"]);
  assert.equal(kindOf(report, "card"), "violation", ".card is on the §10 unused line");
  assert.equal(kindOf(report, "data-row"), "component");
  assert.equal(kindOf(report, "dot"), "component");
  assert.equal(kindOf(report, "shadow-[0_4px_4px_rgb(0_0_0/0.08)]"), "planned");
  assert.equal(kindOf(report, "bg-misc-purple"), "planned", "§12 interim class, even though the utility is not cited in prose");
  assert.equal(kindOf(report, "hover:border-critical"), "planned");
  assert.equal(report.planned.length, 4, JSON.stringify(report.planned.map((p) => p.class)));
  assert.equal(kindOf(report, "font-mono"), "token", "font-mono derives from --font-mono and is cited");
  assert.equal(kindOf(report, "text-data-xs"), "token");
  assert.equal(kindOf(report, "border-[length:var(--border-thin)]"), "arbitrary");
  assert.equal(kindOf(report, "border-b-[length:var(--border-thin)]"), "arbitrary");
  assert.deepEqual(report.rules.monoTokens, ["text-data-xs"]);
  const companion = report.issues.filter((i) => /without font-mono/.test(i.detail));
  assert.equal(companion.length, 1, "exactly one text-data-* element lacks font-mono; text-caption needs none");
  const seams = report.issues.filter((i) => /border-\[length/.test(i.detail));
  assert.equal(seams.length, 1, "the four-side hairline beside border-b is flagged once; the side-specific one passes");
  assert.match(r.stdout, /PLANNED: 4/);
});

test("stylesheets inside the package are violations", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "page.css"), `.x { color: red; }`);
  writeFileSync(join(pkg, "Ok.svelte"), `<div class="flex"></div>`);
  const r = run(pkg, lib);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stylesheet in the package/);
});
