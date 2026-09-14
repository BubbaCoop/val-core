/** Fixture tests for <tools-dir>/design/class-audit.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
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
    // cwd is the target's own tree, which is how an agent invokes it: from the repo root,
    // with the run directory inside. The report guard only writes inside the working dir.
    { encoding: "utf8", cwd: statSync(target).isDirectory() ? target : dirname(target) },
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

// ---- §12 format contract -------------------------------------------------------------

const PAGE_OK = `<div class="w-140 mx-auto py-12 flex flex-col gap-10"><button class="btn btn-primary">x</button></div>`;

/** Replace the fixture methodology, keeping the §1 lines the other tests rely on. */
function withSection12(lib, section12) {
  const base = readFileSync(join(lib, "short-app.md"), "utf8");
  writeFileSync(join(lib, "short-app.md"), `${base}\n\n${section12}\n\n## 13. Open items\n- nothing\n`);
}

test("§12 with no interim/class column warns — the planned set silently resolved empty", () => {
  const { lib, pkg } = setup();
  withSection12(
    lib,
    `## 12. Planned library additions

| Addition | Spec from the frames | Library home |
|---|---|---|
| Mobile sticky action bar | 76 tall, sticky bottom | new component |
| TextField optional slot | title-row marker | modifier |`,
  );
  writeFileSync(join(pkg, "Page.svelte"), PAGE_OK);
  const r = run(pkg, lib);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CLASS-AUDIT: PASS/, "a format gap is reported, never a failure");
  assert.match(r.stdout, /§12 GAP/);
  assert.match(r.stdout, /lists 2 planned addition\(s\) but its table has no interim\/class column/);
  assert.match(r.stdout, /headers: Addition \| Spec from the frames \| Library home/);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.match(report.rules.plannedDiagnostic, /no interim\/class column/);
});

test("§12 with an interim class column resolves PLANNED and warns about nothing", () => {
  const { lib, pkg } = setup();
  withSection12(
    lib,
    `## 12. Planned library additions

| Addition | Value | Interim class |
|---|---|---|
| Mobile sticky action bar | 76 tall | \`h-19\` |`,
  );
  writeFileSync(join(pkg, "Page.svelte"), `<div class="h-19">x</div>`);
  const r = run(pkg, lib);
  assert.doesNotMatch(r.stdout, /§12 GAP/);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(report.rules.plannedDiagnostic, undefined);
  assert.ok(report.rules.planned.includes("h-19"), "the interim class is sanctioned as PLANNED");
});

test("a methodology with no §12 at all warns about nothing", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), PAGE_OK);
  const r = run(pkg, lib);
  assert.doesNotMatch(r.stdout, /§12 GAP/);
});

test("planned markers with no resolvable interim class warn", () => {
  const { lib, pkg } = setup();
  const base = readFileSync(join(lib, "short-app.md"), "utf8");
  writeFileSync(
    join(lib, "short-app.md"),
    `${base}\nThe footer height is 76 \`[raw — planned, §12]\`.\n\n## 12. Planned library additions\n\nDecided; no table yet.\n`,
  );
  writeFileSync(join(pkg, "Page.svelte"), PAGE_OK);
  const r = run(pkg, lib);
  assert.match(r.stdout, /§12 GAP/);
  assert.match(r.stdout, /marks values .*planned.*but §12 resolved no interim class/);
});

// ---- a library path containing a space ------------------------------------------------

test("a library whose path contains a space audits normally, and names the tailwind state", () => {
  // The spaced path is the whole point: the file: URL for library.css percent-encodes, and
  // the compile check used to vanish into a caught ENOENT while the verdict still said PASS.
  const base = mkdtempSync(join(tmpdir(), "val-class-audit-"));
  const dir = join(base, "valiify shortapp library");
  const lib = join(dir, "lib");
  mkdirSync(lib, { recursive: true });
  fixtureLibrary(lib);
  const pkg = join(dir, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "Page.svelte"), `<div class="w-140 mx-auto py-12 flex flex-col gap-10"></div>`);

  // No --no-tailwind: we want the compile branch to be attempted.
  const r = spawnSync(
    process.execPath,
    [TOOL, pkg, "--library", lib, "--methodology", join(lib, "short-app.md"), "--tailwind-from", lib],
    { encoding: "utf8", cwd: pkg },
  );
  assert.match(r.stdout, /CLASS-AUDIT: (PASS|FAIL)/, r.stdout + r.stderr);
  assert.match(r.stdout, /\| TAILWIND: /, "the headline must always state the tailwind state");
  assert.doesNotMatch(r.stdout, /%20/, "no percent-encoded path may reach a message");
});

test("an unavailable tailwind check names itself in the headline and is hoisted above findings", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="w-140 mx-auto py-12"></div>`);
  // --tailwind-from a directory with no tailwindcss: the check cannot run.
  const r = spawnSync(
    process.execPath,
    [TOOL, pkg, "--library", lib, "--methodology", join(lib, "short-app.md"), "--tailwind-from", pkg],
    { encoding: "utf8", cwd: pkg },
  );
  assert.match(r.stdout, /\| TAILWIND: UNAVAILABLE/);
  assert.match(r.stdout, /TAILWIND UNAVAILABLE — the compile check did not run/);
  assert.match(r.stdout, /This verdict is weaker than it looks/);
  const lines = r.stdout.split("\n");
  assert.ok(
    lines.findIndex((l) => /TAILWIND UNAVAILABLE/.test(l)) <= 2,
    "the warning must sit directly under the verdict so printCapped cannot elide it",
  );
});

test("--no-tailwind reports as a deliberate omission, not as unavailable", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="w-140 mx-auto py-12"></div>`);
  const r = run(pkg, lib);
  assert.match(r.stdout, /\| TAILWIND: off/);
  assert.match(r.stdout, /tailwind check skipped: --no-tailwind \(deliberate\)/);
  assert.doesNotMatch(r.stdout, /UNAVAILABLE/);
});

// ---- class identity: the rename tolerance window -----------------------------------------
// A library renaming its vocabulary (.btn -> .va-btn, flex -> va:flex) cannot do it in one
// atomic step across two repos: the audit would reject the new spelling before the rename
// lands, and the old one after. --class-prefix opens a window where BOTH are sanctioned;
// --class-strict closes it again once the rename has shipped.

/** Library whose component classes are already namespaced. */
function renamedFixtureLibrary(root) {
  fixtureLibrary(root);
  writeFileSync(
    join(root, "src", "components", "button.css"),
    `@layer components {
  .va-btn { @apply flex h-12; }
  .va-btn-primary, .va-btn-secondary { @apply rounded-sm; }
}`,
  );
}

test("tolerant window: both spellings are sanctioned, for every registration path", () => {
  const { lib, pkg } = setup();
  writeFileSync(
    join(pkg, "Page.svelte"),
    `<div class="flex va:flex mx-auto va:mx-auto md:w-full va:md:w-full">
  <button class="btn btn-primary va-btn va-btn-primary">x</button>
  <p class="type-eyebrow va:type-eyebrow focus-ring va:focus-ring">y</p>
  <h1 class="text-display va:text-display rounded-md va:rounded-md w-140 va:w-140">t</h1>
</div>`,
  );
  const r = run(pkg, lib, ["--class-prefix", "va"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.rules.classSpelling, "tolerant");

  // component — namespaced and bare, against a library that still defines `.btn`
  assert.equal(kindOf(report, "btn"), "component");
  assert.equal(kindOf(report, "va-btn"), "component");
  assert.equal(kindOf(report, "btn-primary"), "component");
  assert.equal(kindOf(report, "va-btn-primary"), "component");
  // utility — the two registration paths differ (@utility in themes vs utilities), so a
  // sanctioning bug can hit one and not the other. Assert both.
  assert.equal(kindOf(report, "type-eyebrow"), "utility");
  assert.equal(kindOf(report, "va:type-eyebrow"), "utility");
  assert.equal(kindOf(report, "focus-ring"), "utility");
  assert.equal(kindOf(report, "va:focus-ring"), "utility");
  // token / structural / cited, prefixed and bare
  assert.equal(kindOf(report, "text-display"), "token");
  assert.equal(kindOf(report, "va:text-display"), "token");
  assert.equal(kindOf(report, "rounded-md"), "token");
  assert.equal(kindOf(report, "va:rounded-md"), "token");
  assert.equal(kindOf(report, "flex"), "structural");
  assert.equal(kindOf(report, "va:flex"), "structural");
  assert.equal(kindOf(report, "w-140"), "cited");
  assert.equal(kindOf(report, "va:w-140"), "cited");
  // the prefix leads a variant: va:md:w-full, not md:va:w-full
  assert.equal(kindOf(report, "md:w-full"), "structural");
  assert.equal(kindOf(report, "va:md:w-full"), "structural");
});

test("tolerant window: a renamed library still sanctions the old spelling", () => {
  const { dir, pkg } = setup();
  const lib = join(dir, "renamed");
  renamedFixtureLibrary(lib);
  writeFileSync(join(pkg, "Page.svelte"), `<button class="va-btn va-btn-primary btn btn-primary">x</button>`);
  const r = run(pkg, lib, ["--class-prefix", "va"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(kindOf(report, "va-btn"), "component");
  assert.equal(kindOf(report, "va-btn-primary"), "component");
  assert.equal(kindOf(report, "btn"), "component", "the pre-rename spelling stays sanctioned in the window");
  assert.equal(kindOf(report, "btn-primary"), "component");
});

test("--class-strict closes the window: the old spelling becomes unsanctioned", () => {
  const { dir, pkg } = setup();
  const lib = join(dir, "renamed");
  renamedFixtureLibrary(lib);
  writeFileSync(
    join(pkg, "Page.svelte"),
    `<div class="va:flex flex">
  <button class="va-btn btn">x</button>
  <p class="va:focus-ring focus-ring">y</p>
</div>`,
  );
  const r = run(pkg, lib, ["--class-prefix", "va", "--class-strict"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(report.rules.classSpelling, "strict");

  assert.equal(kindOf(report, "va-btn"), "component");
  assert.equal(kindOf(report, "va:flex"), "structural");
  assert.equal(kindOf(report, "va:focus-ring"), "utility");

  assert.equal(kindOf(report, "btn"), "unsanctioned");
  assert.equal(kindOf(report, "flex"), "unsanctioned");
  assert.equal(kindOf(report, "focus-ring"), "unsanctioned");
  // the message has to say what to write, not just that it is wrong
  const btn = report.classes.find((c) => c.cls === "btn");
  assert.match(btn.reason, /va-btn/);
  const flex = report.classes.find((c) => c.cls === "flex");
  assert.match(flex.reason, /va:flex/);
});

test("a forbidden component stays forbidden under either spelling", () => {
  const { dir, pkg } = setup();
  const lib = join(dir, "forbid");
  fixtureLibrary(lib);
  writeFileSync(
    join(lib, "src", "components", "avatar.css"),
    `@layer components { .avatar { @apply flex; } }`,
  );
  writeFileSync(
    join(lib, "short-app.md"),
    `${readFileSync(join(lib, "short-app.md"), "utf8")}
## 10. Scope
Shipped components that no in-scope frame uses: \`.avatar\`.`,
  );
  writeFileSync(join(pkg, "Page.svelte"), `<span class="avatar va-avatar">x</span>`);
  const r = run(pkg, lib, ["--class-prefix", "va"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(kindOf(report, "avatar"), "violation");
  assert.equal(
    kindOf(report, "va-avatar"),
    "violation",
    "renaming must not smuggle a forbidden component past the surface profile",
  );
});

test("without --class-prefix the prefix is not special — default behaviour is unchanged", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="va:flex">x</div>`);
  const r = run(pkg, lib);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(report.rules.classSpelling, "none");
  assert.equal(kindOf(report, "va:flex"), "violation", "reads as an unknown variant, as before");
});

test("--class-strict without --class-prefix is refused rather than silently permissive", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="flex">x</div>`);
  const r = run(pkg, lib, ["--class-strict"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--class-strict requires --class-prefix/);
});
