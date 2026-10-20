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
//
// The weight of these tests sits on the CLOSED window, because that is the state a shipped
// library runs in. Asserting only that the prefixed spelling is accepted would pass equally
// well with tolerance still on, so every path asserts the bare spelling is rejected too.

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

test("strict: every registration path rejects the bare spelling and accepts the prefixed one", () => {
  const { dir, pkg } = setup();
  const lib = join(dir, "renamed");
  renamedFixtureLibrary(lib);
  writeFileSync(
    join(pkg, "Page.svelte"),
    `<div class="va:flex flex va:mx-auto mx-auto va:md:w-full md:w-full">
  <button class="va-btn va-btn-primary btn btn-primary">x</button>
  <p class="va:type-eyebrow type-eyebrow va:focus-ring focus-ring">y</p>
  <h1 class="va:text-display text-display va:rounded-md rounded-md va:w-140 w-140">t</h1>
</div>`,
  );
  const r = run(pkg, lib, ["--class-prefix", "va", "--class-strict"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(report.rules.classSpelling, "strict");

  // The prefixed spelling stays sanctioned, one row per registration path. The two @utility
  // paths (src/themes vs src/utilities) are listed separately on purpose: a sanctioning bug
  // can hit one and not the other.
  for (const [cls, kind] of [
    ["va-btn", "component"],
    ["va-btn-primary", "component"],
    ["va:type-eyebrow", "utility"],
    ["va:focus-ring", "utility"],
    ["va:text-display", "token"],
    ["va:rounded-md", "token"],
    ["va:flex", "structural"],
    ["va:mx-auto", "structural"],
    ["va:md:w-full", "structural"],
    ["va:w-140", "cited"],
  ]) {
    assert.equal(kindOf(report, cls), kind, `${cls} should still be sanctioned as ${kind}`);
  }

  // …and the bare spelling of every one of them is REJECTED. This is the window being shut:
  // asserting the prefixed half alone would pass just as well while tolerance was still on.
  for (const cls of [
    "btn",
    "btn-primary",
    "type-eyebrow",
    "focus-ring",
    "text-display",
    "rounded-md",
    "flex",
    "mx-auto",
    "md:w-full",
    "w-140",
  ]) {
    assert.equal(kindOf(report, cls), "unsanctioned", `${cls} must be rejected once the window is closed`);
  }

  // A rejection has to say what to write, not merely that it is wrong.
  assert.match(report.classes.find((c) => c.cls === "btn").reason, /va-btn/);
  assert.match(report.classes.find((c) => c.cls === "flex").reason, /va:flex/);
});

test("tolerant window: a renamed library still sanctions the old spelling", () => {
  // Tolerance is still reachable — it is the CLI default without --class-strict, and a
  // library mid-rename declares it explicitly — so the path stays covered.
  const { dir, pkg } = setup();
  const lib = join(dir, "renamed");
  renamedFixtureLibrary(lib);
  writeFileSync(join(pkg, "Page.svelte"), `<button class="va-btn va-btn-primary btn btn-primary">x</button>`);
  const r = run(pkg, lib, ["--class-prefix", "va"]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(report.rules.classSpelling, "tolerant");
  assert.equal(kindOf(report, "va-btn"), "component");
  assert.equal(kindOf(report, "va-btn-primary"), "component");
  assert.equal(kindOf(report, "btn"), "component", "the pre-rename spelling stays sanctioned in the window");
  assert.equal(kindOf(report, "btn-primary"), "component");
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

// ---- --app-layout: the one declared app layout stylesheet ------------------------------------

const PKG = "@acme/ui";
const LIB_FIRST = "```css\n@import \"@acme/ui/styles.css\";\n@import \"./src/lib/app-layout.css\";\n```\n";

/** A package with a declared stylesheet, a page that hooks it, and a HANDOFF load path. */
function appLayoutPkg({ css, page, handoff = LIB_FIRST } = {}) {
  const { lib, pkg } = setup();
  mkdirSync(join(pkg, "src", "lib"), { recursive: true });
  writeFileSync(
    join(pkg, "src", "lib", "app-layout.css"),
    css ??
      `.step-actions-web { display: none; }
.step-actions-mobile { display: flex; box-shadow: inset 0 1px 0 var(--color-primary); }
@media (min-width: 48rem) {
  .step-actions-web { display: flex; }
  .step-actions-mobile { display: none; }
}`,
  );
  writeFileSync(join(pkg, "Page.svelte"), page ?? `<div class="step-actions-web flex"><button class="btn btn-primary">Go</button></div>`);
  if (handoff !== null) writeFileSync(join(pkg, "HANDOFF.md"), `# Handoff\n\nLoad path:\n\n${handoff}`);
  return { lib, pkg };
}

const auditApp = (pkg, lib, extra = []) => {
  const r = run(pkg, lib, ["--package", PKG, "--app-layout", "src/lib/app-layout.css", ...extra]);
  return { r, report: JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8")) };
};
const reasons = (report) => report.issues.map((i) => `${i.detail} :: ${i.reason}`);

test("app layout: without --app-layout every stylesheet is still a violation — default unchanged", () => {
  const { lib, pkg } = appLayoutPkg();
  const r = run(pkg, lib, ["--package", PKG]);
  const report = JSON.parse(readFileSync(join(pkg, "class-audit.json"), "utf8"));
  assert.equal(r.status, 1);
  assert.ok(report.issues.some((i) => /pages carry no CSS/.test(i.reason)), reasons(report).join("\n"));
  assert.equal(report.rules.appLayout.active, false);
});

test("app layout: the declared stylesheet is audited, its classes are sanctioned, and the page passes", () => {
  const { lib, pkg } = appLayoutPkg();
  const { r, report } = auditApp(pkg, lib);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(report.verdict, "PASS");
  assert.equal(kindOf(report, "step-actions-web"), "app-layout", "an app class the stylesheet defines is not 'unsanctioned'");
  assert.deepEqual(report.rules.appLayout.appClasses, ["step-actions-mobile", "step-actions-web"]);
  assert.equal(report.rules.appLayout.loadedFrom, 1);
  assert.match(r.stdout, /app layout\s+src\/lib\/app-layout\.css: 4 rule\(s\), 5 declaration\(s\)/);
});

test("app layout: layout properties take any value; a visual property only takes tokens", () => {
  const { lib, pkg } = appLayoutPkg({
    css: `.row {
  display: grid; grid-template-columns: 1fr 2fr; position: sticky; top: 0; justify-content: space-between;
  box-shadow: inset 0 1px 0 var(--color-primary);
  color: red;
  padding: 13px;
  background: var(--color-nope);
  border: 1px solid #ccc;
  outline-color: var(--color-primary, red);
  box-shadow: 0 0 0 1px #ccc, inset 0 1px 0 var(--color-primary);
}`,
  });
  const { r, report } = auditApp(pkg, lib);
  assert.equal(r.status, 1);
  const got = reasons(report).join("\n");
  assert.match(got, /color: red :: visual value outside tokens/);
  assert.match(got, /padding: 13px :: visual value outside tokens/);
  assert.match(got, /--color-nope is not a token the library theme defines/);
  assert.match(got, /border: 1px solid #ccc :: visual value outside tokens/, "no token at all");
  assert.match(got, /#ccc, inset 0 1px 0 var\(--color-primary\) :: visual value outside tokens — "#ccc"/, "a raw colour beside a valid token still fails");
  assert.match(got, /var\(--color-primary, red\) :: visual value outside tokens — "red"/, "a raw colour in a var() fallback is still a raw colour");
  assert.doesNotMatch(got, /display|grid-template-columns|position|top:|justify-content/, "layout properties pass with any value");
  assert.doesNotMatch(got, /^box-shadow: inset 0 1px 0 var\(--color-primary\) ::/m, "a token-valued visual property passes");
});

test("app layout: a selector may never name a library class, under either spelling", () => {
  const { lib, pkg } = appLayoutPkg({
    css: `.btn { display: none; }
.wrap .btn-primary { display: none; }
.va-btn { display: none; }
.va\\:flex { display: none; }
.wrap { display: flex; }`,
  });
  const { report } = auditApp(pkg, lib, ["--class-prefix", "va"]);
  const got = reasons(report).join("\n");
  assert.match(got, /^\.btn :: restyles a library class \(\.btn\)/m);
  assert.match(got, /\.wrap \.btn-primary :: restyles a library class \(\.btn-primary\)/);
  assert.match(got, /\.va-btn :: restyles a library class/);
  assert.match(got, /\.va\\:flex :: restyles a library class \(\.va:flex\)/, "an escaped prefixed utility is still a library class");
  assert.doesNotMatch(got, /^\.wrap :: /m);
});

test("app layout: a selector must be anchored on an app class or id", () => {
  const { lib, pkg } = appLayoutPkg({
    css: `button { display: none; }
* { display: block; }
[data-x] { display: none; }
#mobile-footer { display: flex; }
body .step-actions-web { display: none; }`,
  });
  const { report } = auditApp(pkg, lib);
  const got = reasons(report).join("\n");
  for (const sel of ["button", "\\*", "\\[data-x\\]"]) assert.match(got, new RegExp(`^${sel} :: selector is not anchored`, "m"));
  assert.doesNotMatch(got, /#mobile-footer ::|body \.step-actions-web ::/, "an id, or an app class under an element, is anchored");
});

test("app layout: only @media width breakpoints; no imports, layers, fonts, custom properties or !important", () => {
  const { lib, pkg } = appLayoutPkg({
    css: `@import "./more.css";
@layer app { .a { display: none; } }
@font-face { font-family: X; }
@media (prefers-color-scheme: dark) { .a { display: none; } }
@media screen and (width >= 768px) { .a { display: flex; } }
.a { --color-primary: red; display: block !important; }`,
  });
  const { report } = auditApp(pkg, lib);
  const got = reasons(report).join("\n");
  assert.match(got, /@import :: @import would load a second stylesheet/);
  assert.match(got, /@layer :: @layer — a layered app rule loses to the unlayered bundle/);
  assert.match(got, /@font-face :: @font-face — the app layout stylesheet allows @media width breakpoints only/);
  assert.match(got, /prefers-color-scheme: dark\) — breakpoints are width conditions only/);
  assert.doesNotMatch(got, /width >= 768px/, "the range syntax is a width condition");
  assert.match(got, /--color-primary: red :: defines a custom property/);
  assert.match(got, /display: block !important :: !important/);
});

test("app layout: loading it BEFORE the library bundle fails — the unlayered bundle would win every tie", () => {
  const { lib, pkg } = appLayoutPkg({ handoff: "```css\n@import \"./src/lib/app-layout.css\";\n@import \"@acme/ui/styles.css\";\n```\n" });
  const { r, report } = auditApp(pkg, lib);
  assert.equal(r.status, 1);
  assert.ok(report.issues.some((i) => /loads BEFORE the library bundle/.test(i.reason) && i.file.endsWith("HANDOFF.md")), reasons(report).join("\n"));
});

test("app layout: order is proven per file — a file loading it without the bundle fails, a Svelte import in order passes", () => {
  const { lib, pkg } = appLayoutPkg({ handoff: null });
  writeFileSync(join(pkg, "+layout.svelte"), `<script>\n  import "@acme/ui/styles.css";\n  import "$lib/app-layout.css";\n</script>\n<slot />`);
  assert.equal(auditApp(pkg, lib).r.status, 0, "library first, in one entry, passes");

  writeFileSync(join(pkg, "+error.svelte"), `<script>import "$lib/app-layout.css";</script>`);
  const { report } = auditApp(pkg, lib);
  assert.ok(report.issues.some((i) => /but not the library bundle — load order cannot be proven/.test(i.reason)), reasons(report).join("\n"));
});

test("app layout: declared and present but never loaded fails; prose is not a load path", () => {
  const { lib, pkg } = appLayoutPkg({ handoff: "Load @acme/ui/styles.css first, then src/lib/app-layout.css.\n" });
  const { r, report } = auditApp(pkg, lib);
  assert.equal(r.status, 1);
  assert.ok(report.issues.some((i) => /never loaded/.test(i.reason)), reasons(report).join("\n"));
});

test("app layout: a second stylesheet beside the declared one is still rejected", () => {
  const { lib, pkg } = appLayoutPkg();
  writeFileSync(join(pkg, "src", "lib", "extra.css"), `.x { display: none; }`);
  const { report } = auditApp(pkg, lib);
  assert.ok(report.issues.some((i) => i.detail === "extra.css" && /the only app CSS allowed is the declared src\/lib\/app-layout\.css/.test(i.reason)), reasons(report).join("\n"));
});

test("app layout: declared but absent is nothing to audit, and a single-file target ignores it", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="flex">x</div>`);
  const { r, report } = auditApp(pkg, lib);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(report.rules.appLayout.present, false);
  assert.match(r.stdout, /declared, not present — nothing to audit/);

  const concept = join(pkg, "concept.v1.html");
  writeFileSync(concept, `<section data-block="b01" data-class="flex">x</section>`);
  const c = run(concept, lib, ["--package", PKG, "--app-layout", "src/lib/app-layout.css"]);
  assert.equal(c.status, 0, "the shared flag must not fail a concept audit: " + c.stdout + c.stderr);
});

test("app layout: --app-layout without a path is refused", () => {
  const { lib, pkg } = setup();
  writeFileSync(join(pkg, "Page.svelte"), `<div class="flex">x</div>`);
  const r = run(pkg, lib, ["--app-layout"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--app-layout needs a path/);
});
