---
name: design-methodology
description: >
  How the design pipeline turns an employee's business brief into a
  handoff-ready page using ONLY a component library and a surface methodology
  document — the brief schema, the grey-box concept contract, the five stop
  triggers, the rules-applied report, the Svelte 5 translation rules for a
  CSS-only library, the consumer-app conventions, and how a surface
  methodology is written or rewritten when a surface is redesigned.
  Library-independent; each library's methodology lives at its configured
  design.methodologyDir.
---

# Design methodology

The design pipeline exists to eliminate one failure mode: **invented style**.
A page on a surface is composed from (1) the component library — the only
source of classes, tokens and utilities — and (2) that surface's methodology
document, which says how those components are assembled into steps. Nothing
else: no Figma, no PNG, no memory of what "a form usually looks like", no
external design system. When the library and the methodology together do not
determine something, the agent stops and asks; it never fills the gap.

Pipeline: `design-brief-intake` → `design-concept-architect` ⇄
`design-critic` → **human gate** (`/design build`) → `design-page-builder` ⇄
`design-handoff-verifier`. The orchestrator is `/design`. At the human gate a
reviewer may instead send changes back as `00-input/feedback-<n>.md` (§8b),
which re-enters the architect ⇄ critic loop and is uncapped.

## 1. Reading a surface methodology

Every surface methodology follows the same section anatomy. Read it in full
once per run (they are ~400 lines), then cite it by §:

| § | Role in the pipeline |
| --- | --- |
| §0 Conventions | value notation; **the library value is the rule** where a frame and the library disagree on a value. May open with the surface's principles and its change process (§13) — read them: every later § is one of them applied |
| §1 Layout skeleton | the page shell (web + mobile); composition of the column, title block, button row |
| §2 Archetypes | the closed list of step types and their commit rows — a brief needing anything else is a STOP |
| §3 Hierarchy | title block, grouping, fold rules |
| §4 Density | spacing rhythm as Tailwind utilities |
| §5 Component selection | which component for which kind of question; button tiers; add-affordances |
| §6 States | empty / disabled / selected / error / loading rules |
| §7 Navigation | forward/back verbs, position indicator, edit hub |
| §8 Copy | casing, voice, labels, placeholders, help text |
| §9 Anti-patterns | what never appears — a brief asking for one is a STOP |
| §10 Component map | pattern → library class (+ slots, states), and the design-file node each component comes from |
| §11 Patterns with no component | utility-only compositions — the only sanctioned non-component markup |
| §12 Planned additions | components decided but not built; pages use the §11 interim recipe |
| §13 Open items | unspecified — a brief touching one is a STOP. Includes components drawn in the design file but not yet in the package |
| Appendix | value ledger (token ↔ utility ↔ role) |

Never read the companion `*-decisions.md` (history, not rules), anything
under `_dashboard-archive/`, or any image.

### 1b. The surface block

What differs between surfaces but is not a design rule lives in the
library's `val/config.json` under `design.surfaces.<id>` and is rendered
into every design agent as a "Surfaces configured for this library" block:
the **viewports** a concept must draw (one `<main data-concept>` each), the
**region vocabulary** for `data-region` (a step-based surface: `header ·
title-block · content · button-row · mobile-footer`; a shell-based one:
`nav-rail · bar-48 · tab-row · sub-toolbar · module-label · module-display ·
rail-card …`), the **brief schema** with its required (★) headings, the
surface's own **stop triggers**, and the **concept sections** concept.md opens
with. Nothing in it duplicates the methodology: planned values are read from
the methodology's §12 interim-class column, forbidden components from its §10
"shipped but unused" line, and the mono companion rule from the theme's own
"needs font-mono" comments.

## 2. The library as the only source

Read fresh every run — never from memory. Library-relative paths mean
`<libraryRoot>/<path>`; in a consumer app `libraryRoot` is
`node_modules/<package>`.

- `CLAUDE.md` → the `#### <ComponentName>` Quick Reference sections for the
  components you map (Grep the heading, Read that section — never the whole
  file) and the `### Design Tokens` subsection.
- `src/components/<name>.css` for every mapped component — the selectors are
  the class API; the comment header carries the anatomy and the states that
  exist. A state the CSS does not model does not exist.
- `src/themes/*.css` — the `@theme` block: every `--color-*`, `--text-*`,
  `--radius-*`, `--shadow-*` token, and — where the library has them — the
  `@utility type-*` casing utilities. `src/utilities/*.css` — `@utility
  focus-ring` and siblings. A library whose configured casing rule says no
  text style carries a transform has no casing utility at all: its caps are
  typed into the string.
- `GETTING_STARTED.md` — the load path, the framework snippets, and
  "Components That Need JavaScript" (the behaviours a page must implement).
- The library's design-system skill (the compact class map).

Ignore `types/*.d.ts` as a class source — it is a partial editor aid.

## 3. The five stop triggers

Stop and ask — never guess — when:

1. `no-component` — a required block has no §10 class and no §11 composition.
2. `brief-missing-field` — the brief lacks a required field (§6 below).
3. `archetype-not-in-§2` — the brief needs a step type §2 does not list.
4. `§13-open-item` — the brief touches something §13 lists as unspecified.
5. `§9-forbidden` — the brief asks for something §9 forbids.

Every question uses the clarification format the orchestrator relays
verbatim, plus the trigger:

```
Q: <the question, answerable in one message>
TRIGGER: no-component | brief-missing-field | archetype-not-in-§2 | §13-open-item | §9-forbidden
NEEDED-FOR: <block / field / step it blocks>
CHECKED: <methodology §s and library files you read before asking>
COST-OF-GUESSING: <what a wrong default breaks>
ACCEPTABLE-ANSWER: <a sentence, a decision, or "out of scope">
```

**Every stop-trigger question is BLOCKING.** The single non-blocking class
is missing non-legal copy (title, description, label, help, placeholder,
error message), which the architect drafts per §8 and marks DRAFT (§5) —
recorded as a question with its proposed default so the reviewer sees it at
the gate. A partial gap in a §11 recipe, an unspecified width, a state no
component models, a §13 item — these are stops, not defaults, however
plausible the nearest value looks. An agent with open BLOCKING questions
ends `BLOCKED` and writes everything that IS determined.

## 4. Rules applied / Unsure

Every output file ends with two sections:

```
## Methodology rules applied
- §2 Form archetype — chosen because the step collects ~6 fields on one topic
- §4 field pitch — `.text-field` stack at `gap-5`
- §5 dropdown for enumerations — state field → `.dropdown-field`
…
## Unsure
- §5 conditional-reveal indent (~22px `[raw]`, §13) — used `pl-5.5` per §11; flagged
- copy c04 (help text) — DRAFT, brief supplied none; §8 voice applied
```

"Applied" lists each rule with the decision it produced; "Unsure" lists every
place a rule was ambiguous, a default was taken, or copy was drafted. An
empty Unsure section is a claim, not a default — write "none" only after
checking.

## 5. Question protocol and copy

Copy is content, not style — but invented content is still invention. The
brief supplies copy or it doesn't:

- Supplied copy is used **verbatim** (typos are the brief's; note them in
  Unsure, do not fix silently).
- Missing copy is **drafted** per §8 and marked `DRAFT` everywhere it appears
  (concept.md copy table `source: DRAFT`, `data-copy-source="DRAFT"` in the
  concept, `source: "DRAFT"` in contract.json). The human gate shows the
  DRAFT list; approval covers it.
- Legal/consent text is never drafted — `brief-missing-field`.

## 6. `01-brief.md` schema

The **surface block** defines the schema body — its brief schema is the
fixed heading list, its ★ headings the stop set (missing →
`brief-missing-field`). A step-based surface asks for flow, step position
and fields; a shell-based reviewer surface asks for archetype, reviewer role,
object under review, the decision the page supports, data by module,
verification sources per field and rail roll-ups. Whatever the body, every
brief opens with `# Brief — <slug>` and `## Surface <id> · methodology <path>`
and closes with the same trailer:

```
## Source map         | brief sentence (quoted) | rows it supports |
## Open questions     BLOCKING (every stop trigger) · NON-BLOCKING (missing non-legal copy, with DRAFT defaults)
## Methodology rules applied
## Unsure
```

Every filled row is sourced to a quoted brief sentence; a row that cannot be
sourced is a question, not an inference. Copy is recorded verbatim; roles
not supplied are listed as such. Intake never chooses an archetype or a
component — it records what the brief asks for and flags §2/§9/§13
collisions (and the surface block's own stop triggers) as BLOCKING questions.

## 7. The concept contract

`02-concept/concept.v<n>.html` (n = 1, 2, … per critic loop) + `concept.md`
+ `fix-ledger.md` (from v2 on).

The concept is a **grey-box wireframe**. It links the pipeline's fixed
stylesheet and carries no `<style>`, no `style=`, and no `class=` attributes
at all — the real library classes go in `data-class`. One `<main>` per
viewport the surface defines (a step-based applicant surface has web and
mobile, both mandatory; a fixed-width reviewer surface has one, at the
methodology's viewport). Every block carries `data-region` from the
surface block's region vocabulary so the critic can check the shell part by part.

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Concept — <slug> v1</title>
<link rel="stylesheet" href="<TOOLS_DIR>/design/concept.css">
</head><body>
<main data-concept data-viewport="web" data-title="Residential details">
  <section data-block="b01" data-region="header" data-archetype="form" data-class=".header .header-logo .text-selector"
           data-methodology="§1.1 §10" data-states="rest">
    <p data-label>Header — logo centred, language selector right</p>
  </section>
  <section data-block="b02" data-archetype="form" data-class="type-eyebrow text-display text-input text-content-tertiary text-primary-text text-content-primary text-content-secondary"
           data-methodology="§3" data-copy="c01 c02 c03">
    <p data-label data-role="eyebrow">STEP 4 OF 7 / <span>RESIDENCE</span></p>
    <p data-label data-role="title" data-copy-id="c02">Where do you live?</p>
    <p data-label data-role="description" data-copy-id="c03" data-copy-source="DRAFT">We use this to …</p>
  </section>
  <section data-block="b03" data-archetype="form" data-class=".text-field .text-field-title-row .text-field-title .text-field-box .text-field-input .text-field-hint"
           data-methodology="§4 §5 §6" data-states="empty error" data-copy="c04">
    <p data-label>Street address — text, required, placeholder "123 Main St"</p>
  </section>
  …
  <section data-block="b09" data-archetype="form" data-class=".btn .btn-secondary .btn-primary flex gap-6 flex-1"
           data-methodology="§1.1 §5 §6" data-states="disabled enabled" data-copy="c10 c11">
    <span data-control="secondary">BACK</span><span data-control="primary" data-disabled="true">CONTINUE</span>
  </section>
</main>
<main data-concept data-viewport="mobile" data-title="Residential details"> … </main>
</body></html>
```

A shell-based surface draws the same way, with its own regions and no step
chrome. A reviewer page with a section and a side panel:

```html
<main data-concept data-viewport="web" data-title="Application">
  <section data-block="b01" data-region="header" data-archetype="application-detail"
           data-class=".vd-breadcrumbs .vd-btn .vd-btn-outline .vd-btn-primary vd:flex vd:h-13 vd:items-center vd:justify-between"
           data-methodology="§1.2 §5" data-states="rest blocked" data-copy="c01 c02">
    <p data-label>Header — breadcrumb to the record; Decline, Approve (blocked while findings are open)</p>
  </section>
  <section data-block="b02" data-region="section" data-archetype="application-detail"
           data-class=".vd-summary-preview .vd-record .vd-content-row .vd-severity-count .vd-severity-marker .vd-severity-marker-critical"
           data-methodology="§2.1 §6.1" data-states="collapsed expanded" data-copy="c03 c04">
    <p data-label>Business — gutter title; summary line that reads on its own; status column: critical marker + 1</p>
  </section>
  <section data-block="b03" data-region="panel-findings" data-archetype="application-detail"
           data-class=".vd-panel-section-header .vd-finding-row .vd-finding-card .vd-radio-select .vd-finding-option"
           data-methodology="§2.1" data-states="closed open-choosing open-requesting resolved" data-copy="c05">
    <p data-label>Findings — one flat list; a finding opens in place; resolutions are radios</p>
  </section>
</main>
```

Attributes:

- `data-block` — stable id `b01…`; the build carries the same id into the
  Svelte markup (`data-block="b03"` on the block's root element) so coverage
  is checked mechanically. Ids never change between versions; removed blocks
  are listed in the fix ledger.
- `data-region` — the shell part, from the surface block's region vocabulary.
- `data-archetype` — the §2 archetype of the page (same on every block).
- `data-class` — every library class / sanctioned utility the block will use,
  space-separated, component classes with a leading dot. `class-audit`
  checks each one; the build's element for this block must use a superset.
  **Apply the library's class identity here if it has one** — see §12. The
  examples above are written unprefixed; a library with an identity spells the
  same blocks `.va-btn`, `va:flex`.
- `data-methodology` — the §s that determine this block.
- `data-states` — the states this block has (from §6); each must be reachable
  in the build via a prop.
- `data-copy` — copy ids from the concept.md copy table; drafted copy carries
  `data-copy-source="DRAFT"` on the element that shows it.
- Nested blocks are allowed (a roster card containing rows).

`concept.md` sections, in order: the surface block's concept sections (the
surface's own — archetype + §2 row and why, then e.g. step position and
eyebrow, or shell + module inventory with margin labels + rail card contents
+ sub-toolbar contents) · Hierarchy rationale (§3) · Mapping table
`| block | region | pattern | §10 class or §11 recipe | content | states |` ·
Copy table `| id | role | text | source (brief/DRAFT) | §8 rule |` · Planned
values used `| block | value | class | §12 row |` · Responsive behaviour
where the surface defines one · Open questions · Methodology rules applied ·
Unsure.

`fix-ledger.md` (rework passes): `| finding id | block | change made | § |`
— one row per critique finding, including "no change — disputed because …".

## 8. Critique format

`03-critique-<n>.md`: verdict line, then findings:

```
CRITIQUE: FAIL | FINDINGS: 3 | BLOCKING: 2

| id | block | severity | rule | finding | fix |
| F1 | b05 | blocking | §5 dropdown for enumerations | state field is a .text-field | map to .dropdown-field … |
| F2 | b09 | blocking | §2 Form commit row | primary enabled at rest | disabled until valid (§6) |
| F3 | c03 | advisory | §8 description states the why | "Please fill out…" | rewrite: one sentence, second person |
```

PASS requires zero blocking findings and no open stop-trigger questions.
Checklist A–G is in the critic's agent file.

### 8b. Human feedback (`00-input/feedback-<n>.md`)

The reviewer at the human gate uses the **same table** as the critic, so one
rework path serves both: `| id | block | severity | rule | finding | fix |`,
ids `H1, H2 …` (the critic's are `F1, F2 …`). `block` is a `data-block` or copy
id from the concept reviewed, or `-` for the whole page; `rule` may be empty,
since a reviewer need not cite a §; `fix` must say what to do.

The file opens with a required `Concept: concept.v<n>.html` line **pinning the
version the reviewer looked at**. Block ids are stable across versions, so
without the pin a round collected on v2 applies cleanly to v3 and the
substitution is invisible; with it the round is rejected and the gate is
re-posted against the current concept.

`tools/design/feedback-check.mjs` validates the file before the architect is
dispatched: the pin (present, well-formed, and current), ids, severities, a
non-empty fix, and that every target exists in the pinned concept.

Feedback rounds are counted in `manifest.loops.feedback`, **uncapped and
separate from `loops.critic`**: a reviewer iterating is the product working, a
critic failing to converge in 3 passes is a defect. A round re-enters Gate 2
and is then critiqued like any other version, so feedback never bypasses the
critic. A finding that asks for what the methodology forbids or does not
determine is a stop trigger, not a rework — approval does not authorise
invented style. Such a finding comes back in the §3 clarification shape with an
added `ROUTE:` line naming what would make the ask legal (a §12 planned
addition with an interim class, or a §13 open item) and stating that the edit
belongs in the methodology file and git, not the feedback channel. The reviewer
is owed the route, never a bare refusal.

## 9. The package contract

`05-package/` mirrors a consumer app so it drops into one unchanged:

```
05-package/
  <pagesDir>/<flow>/<step-slug>/+page.svelte      the step — composes the blocks, owns step state
  <componentsDir>/<Block>.svelte                   one per composed pattern (the analogue of lib/*.js)
  mapping.md          | block | pattern | class(es) | file:line |
  contract.json       machine-readable — validated against tools/design/contract.schema.json
  HANDOFF.md          the established handoff document (11 sections, below)
```

`contract.json`:

```json
{
  "route": "/business/residential-details",
  "step": { "n": 4, "m": 7, "section": "RESIDENCE" },
  "archetype": "form",
  "blocks": [{ "id": "b03", "component": "TextField", "classes": ["text-field", "text-field-box"] }],
  "fields": [{ "id": "street", "label": "Street address", "type": "text", "format": "free", "required": true, "placeholder": "123 Main St", "bind": "values.street" }],
  "states": [{ "id": "error", "when": "invalid[field] === true", "blocks": ["b03"] }],
  "actions": [{ "id": "continue", "label": "CONTINUE", "kind": "continue", "enabledWhen": "isValid" }],
  "copy": [{ "id": "c02", "text": "Where do you live?", "source": "brief" }],
  "icons": ["arrow-left", "arrow-right"]
}
```

`HANDOFF.md` sections (the established format; keep the numbering):
1 Status and provenance · 2 Load path · 3 Public API (props, bindables,
events) · 4 Markup contract (block → element → classes) · 5 Behaviour spec ·
6 Payload (the values object) · 7 Deviations (kept / removed / brief-governed)
· 8 Library defects and gaps to raise upstream · 9 Tests (class-audit and
handoff-check output) · 10 Evidence · 11 Gotchas · **12 Open questions for the
dev team** · Methodology rules applied · Unsure.

## 10. HTML → Svelte 5 translation rules (CSS-only library)

**The HTML in the library's CLAUDE.md is the authoritative markup.** A Svelte
component wraps it verbatim — same elements, same nesting, class strings
untouched — and adds behaviour only: `aria-*` bound to state, `{#if}` for
states, event handlers, `bind:` on the real inputs. No restructuring, no
restyling. If the markup does not fit a Svelte prop shape, keep the markup
and adapt the props. Concretely:

1. **Start from the CLAUDE.md example** for the component (or the §11
   recipe), paste it, and replace only text nodes and attribute values with
   `{expressions}`. Never add, rename, reorder or abbreviate a class; never
   add a wrapper element the example does not have. A conditional class is
   allowed only where both alternatives are sanctioned and the methodology
   names the choice (`class={wide ? "w-full" : "flex-1"}`).
2. **State comes from the input or the ARIA attribute the CSS already
   selects on** — `:has(:checked)`, `:has(:focus)`, `[aria-invalid="true"]`,
   `[aria-selected="true"]`, `[aria-expanded="true"]`, `[aria-pressed]`,
   `:disabled`. So `<input class="radio" bind:group={value}>`,
   `aria-invalid={invalid ? "true" : undefined}`, `disabled={!isValid}`.
   Never a synced class (`class:selected`).
3. **States the brief names are `{#if}` branches** over the same markup
   (loading skeleton rows, the failed-module alert, the empty row), each
   reachable from a prop named in `contract.json`.
4. **Runes.** `let { id, label, value = $bindable(""), invalid = false }
   = $props();` (JSDoc-typed in JS projects); `$derived` for validity,
   `$state` for page state; no stores.
5. **Slots are snippets** — `{@render children?.()}`; named snippets only
   where the example has a slot-like child.
6. **Icons** are the example's sprite glyphs: `<svg aria-hidden="true"><use
   href="#name" /></svg>` with exactly the classes the example gives the
   `svg`. The sprite is inlined once at the shell (§11), never in a page.
7. **JS-needing components** (GETTING_STARTED "Components That Need
   JavaScript") get exactly the behaviour described there, inside the
   component; nothing beyond.
8. **Omitted parts.** When the brief forbids what an optional part does,
   keep the component and omit that part; note it in HANDOFF.md. Never
   hand-compose a substitute for a component.
9. **No `<style>`, no `style=`, no `style:` directives, no `@apply`, no
   `.css` files in the package.** Layout comes from the methodology's
   utilities, written as it writes them.
10. **Casing follows the library's rule, never your own.** Where the library
    ships `type-*` utilities, uppercase is styled, never typed: the utility
    carries the transform and markup text is sentence case. Where the
    library's casing rule says no text style carries a transform (the rule
    is rendered into your instructions), the reverse holds: caps are typed
    into the string exactly where the design file types them, and nothing
    adds `uppercase`.
11. **Responsive** only with the breakpoint the methodology names (Tailwind's
    native `md:` on the Short App).
12. **Traceability**: the root element of each concept block carries
    `data-block="<id>"`; no other concept attribute leaks into the package.

## 11. Consumer-app conventions

The package targets a consumer app built the way the library documents:

- Stylesheet (`src/app.css` in SvelteKit) in this order — load-bearing:
  `@import "<package>/fonts";` → `@import "tailwindcss";` →
  `@import "<package>/source";`. Never import the library from JavaScript
  (fails silently).
- The shell (`src/routes/+layout.svelte`) imports `../app.css` and inlines
  the sprite once: `import sprite from "<package>/icons/sprite.svg?raw";`
  then `<div hidden aria-hidden="true">{@html sprite}</div>` before the
  page. Pages and components never load the sprite.
- Library-relative paths in docs (`src/…`, `CLAUDE.md`) mean
  `node_modules/<package>/<path>` in a consumer.
- Routing, navigation between steps and persistence are the host app's;
  the page emits `onback` / `oncontinue` callbacks (props) with the payload
  and never navigates itself.

## 11b. Planned values (`[raw — planned, §12]`)

A methodology may name a value the library has not shipped yet — a shadow, a
1.5px stroke, an info colour, a warning variant — marked `[raw — planned, §12]`
or `[planned variant, §12]`. Its §12 table carries an **interim class**
column: the ONE way the value is written until the library ships the
addition. Use it verbatim — never a hex or a token name of your own, never a
second spelling. The architect lists every use in concept.md ("Planned
values used": block · value · class · §12 row), `class-audit` reads the same
column and reports the classes as PLANNED, the build carries the table into
HANDOFF.md §7/§8 so the dev team knows what to swap, and the verifier fails a
planned value written any other way.

## 12. Class discipline (what `class-audit` enforces)

**Class identity.** Some libraries namespace their vocabulary so it cannot
collide with whatever the host app already loads (Tailwind's own utilities, or
another component library's `.btn` / `.modal` / `.badge`). When the
`class-audit` command in your instructions carries `--class-prefix <p>`, that
library has one, and every class you write takes it:

- component classes are namespaced — `.btn` → `.<p>-btn`, `.text-field-input` →
  `.<p>-text-field-input`
- utilities carry the Tailwind v4 prefix, which **leads** any variant —
  `flex` → `<p>:flex`, `md:w-full` → `<p>:md:w-full`
- the library's own `@utility` names take it too — `<p>:focus-ring`,
  `<p>:type-eyebrow`

Read the prefix off that command rather than assuming: a library without one
writes classes bare, and `--class-prefix` is absent. While a library is
migrating, the audit accepts both spellings; once its instructions also carry
`--class-strict`, the unprefixed spelling is rejected.

**The one app layout stylesheet.** By default a page carries no CSS at all. When
the `class-audit` command in your instructions carries `--app-layout <path>`,
this library leaves page layout to the app, and exactly ONE stylesheet — that
path, inside the package — may exist. The audit reads it instead of rejecting
it, and holds it to five rules:

- **layout properties take any value** — display, visibility, position and its
  offsets, flex/grid flow and alignment, grid track sizing;
- **any other property takes its value from library tokens** — at least one
  `var(--token)` the theme defines, plus lengths and structural keywords
  (`inset 0 1px 0 var(--color-stroke-divider)` passes; `#ccc`, `red`, `13px`
  alone do not);
- **every selector is an app-owned class or id, and never a library class** — the
  stylesheet arranges the page, it never restyles a component, and a bare
  `button {}` would reach every library-rendered button;
- **breakpoints are `@media` width conditions only** — no `@import`, `@layer`,
  `@font-face`, custom properties or `!important`;
- **it loads AFTER the library bundle**, wherever it is loaded: the bundle is
  unlayered, so on a specificity tie the later stylesheet wins, and an app rule
  loaded first silently does nothing. Name both in HANDOFF.md's load path, in one
  fenced block, library first.

The classes it defines count as sanctioned in markup. Every other stylesheet,
`<style>`, `style=` and `style:` is still a violation. Without the flag, none of
this applies: write no CSS.

A class is **sanctioned** only if it is one of: a selector in
`src/components/*.css`; an `@utility`; a token utility that derives from a
`@theme` token **and** is cited in the methodology or CLAUDE.md; a native
structural utility on the fixed list (`flex grid items-* justify-* gap
shrink-0 min-w-0 sr-only relative absolute sticky top-0 bottom-0 mx-auto
w-full h-full flex-1 flex-col …`); a spacing/sizing utility cited literally in
the methodology or CLAUDE.md; an arbitrary-value class cited literally in the
methodology; a **planned** class from the methodology's §12 interim
column. The `md:` variant of a sanctioned class is sanctioned. Surface rules
the audit enforces per element, all derived from the sources themselves: the
§10 "shipped components that no in-scope frame uses" line is a forbidden list
(`.card`, `.pill`, `.avatar`…); a text token whose theme comment says
"needs font-mono" requires `font-mono` on the same element; a four-side
`border-[length:var(--border-thin)]` beside a side flag is wrong — the seam
is `border-b border-b-[length:…]`.

Everything else is **unsanctioned** — including on-grid spacing the
methodology never uses (`mt-7`) and Tailwind's default palette
(`bg-red-500`, `text-sm`), which compile in a consumer build because the
theme does not reset Tailwind's namespaces. Hard violations: colour/size
literals, `/opacity`, `!important`, `(--var)` shorthand, arbitrary variants and
arbitrary properties (`[--x:1px]` — set the width or value with a cited utility
on the element instead),
`font-*` / `leading-*` / `tracking-*` / `uppercase` / `text-<n>` (type is a
token), `<style>`, `style=`, `style:`, `@apply`, any external design system.

An unsanctioned class is never "close enough". Either the methodology
sanctions it (cite the §) or the block needs a different composition — or a
`no-component` question.

## 13. Writing or rewriting a surface methodology

The pipeline reads a methodology; people write one. When a surface is designed
for the first time, or redesigned, the methodology is the LAST artefact
produced, not the first — it records what the design file and the library
already agree on. This section is for whoever writes it (a person or an agent
asked to), and it explains to every other agent why a methodology looks the
way it does.

### 13a. What a design-principles document becomes

A designer's own account of a surface is usually organised by intent —
principles, process, layout, status language, wording, library rules, page by
page, what was approved and rejected, mistakes to avoid, open questions. The
anatomy in §1 is organised by what an agent needs to look up. The ideas stay;
only their address changes:

| The designer's heading | Lands in | As |
| --- | --- | --- |
| Principles | §0 | a numbered list, each pointing at the § that applies it |
| Process (how a change is made) | §0 | the steps, ending with "take the gaps to the library, then update this file" |
| Layout system | §1 | one shell per archetype, each with its regions and the utilities that draw them |
| Page by page | §2 | one archetype entry per page: order, what collapses, what is fixed |
| "Reduce", "read on its own", "never hide data" | §3 | hierarchy rules |
| Spacing and row heights | §4 | a table of relationship → utility, with the component's own heights marked as the component's |
| Library discipline ("check the library first", "reuse the pattern for the job") | §5 | a job → component table with a Never column |
| Status and feedback language | §6 | a closed marker table: state → marker → class → design-file node; then confirmations, messages, menus, and the state-coverage list |
| Content and wording; product constraints | §8 | wording rules with the designer's own before/after examples; constraints as stops |
| Anti-patterns | §9 | the checklist, verbatim |
| Approved and rejected | §9 | the table, verbatim — the Rejected column is a stop list |
| Open questions | §13 | open items — each one a stop |

Keep the designer's words wherever they are already a rule ("Never checkboxes
for a single choice"). Add only what an agent needs to act on the rule: the
class, the node, the utility.

### 13b. Three names for every component

A rule that names a component names it three ways, so a designer, a developer
and an agent point at the same thing:

1. **The design-file component** — its name and node id in the library's
   Figma file (`Content Row`, `168:845`).
2. **The package class** — what is written in markup (`.vd-content-row`).
3. **The job on this surface** — "a section's collapsed summary line".

§10 carries all three for every shipped component, in the order of the design
file's own component page. The same node ids belong in the library's component
registry (`figmaNodeIds`, with the design file's set names in `figmaNames`
where they differ from the registry key): that is what turns a `/val` mapping
from a name guess into an exact match, and without Code Connect files the
generator does not fill them in — they are hand-maintained and survive
regeneration.

A component that exists in the design file and not in the package is listed
too, by name and node, under a heading that says so. It is not composable: a
block that needs one is a `no-component` stop. Listing it is what keeps an
agent from rebuilding it by hand.

### 13c. The order of work when a surface is redesigned

A redesign changes many components at once and introduces parts nobody has
named. The order that worked (Dashboard review surface, 2026-11: 41 → 77
components across two library releases):

1. **Design settles first, in the design tool** — explored as distinct
   concepts, prototyped where interaction has to be felt, narrowed by the
   designer, then drawn into the existing frames with every state beside them
   (default, hover, open, selected, empty, loading or running, error or
   failed, confirmation, success message, dark theme) and grouped by ticket.
2. **The library is swept against the redrawn component page**, tokens before
   components. Every place the library will differ from the file goes on a
   list for the designer — a divergence without a list entry is a silent fork.
3. **One real page is built from the library as a test**, every frame a
   reachable state, in every theme, using only shipped classes plus the page's
   own layout.
4. **Everything the test page had to work around is written down in four
   lists**: library bugs · places a shipped component differs from the page
   frames · parts the library does not ship (each a stand-in on the page) ·
   differences that are the page's own.
5. **The first three lists are closed in the library, never on the page.** A
   stand-in that survives on a page is a component nobody else can use; a
   workaround that survives is a bug every other page will hit.
6. **The test page is rebuilt with no workarounds and no stand-ins.** Its own
   CSS should be layout only.
7. **The methodology is rewritten from the result** — and only now. Shell
   compositions (§11) are transcribed from the page's layout into the library's
   utility spelling; §10 is regenerated against the library; decisions the
   library cannot express yet become §12 rows with an interim class, and
   undecided ones become §13 stops.

Writing the methodology before step 3 produces rules the library cannot
satisfy. Extracting components without step 3 produces components that do not
line up with each other: a shared column grid is a property of a page, and no
single component set shows it.

### 13d. Rules for the rewrite itself

- **Keep the anatomy.** §0–§13 and the appendix keep their numbers and roles.
  `class-audit` reads the §10 "shipped but unused" line and the §12 interim
  column by position; agents cite by §.
- **Superseded is not rejected.** A rule the redesign replaced goes in a
  "superseded" table (old → new) so a page built on the old shell is
  recognised and not copied. The designer's approved / rejected table is kept
  verbatim and is not padded with inferences.
- **A shell that was not redrawn is carried over and labelled**, with its
  original evidence. Do not restyle it by analogy with the redesigned one.
- **A methodology can be a build input.** Where a library ships a closed
  utility set generated from the methodology, deleting a citation deletes the
  utility from the next bundle and breaks pages already built on it. Diff the
  cited set before and after; keep what dropped in a labelled "retained"
  appendix until a release removes it on purpose.
- **Every composition is checked by the audit before it is written down.** Put
  the §11 recipe's classes in a throwaway concept and run `class-audit` with
  the surface's flags. A recipe the audit rejects (an arbitrary property, an
  uncited utility) is not a recipe.
- **Re-read the surface block.** A redesign changes the region vocabulary, the
  brief schema, the stop triggers and the concept sections in
  `design.surfaces.<id>`; a methodology and a surface block that disagree
  produce briefs for a page that no longer exists.
- **State what is not known.** A page whose pattern is approved but whose
  values were never extracted says so, per rule ("high (pattern) / not
  extracted (values)"). An agent may compose the pattern's shell from such a
  rule and must stop at the first value it would have to invent.
