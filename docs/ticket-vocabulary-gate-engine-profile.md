# Ticket: split `class-audit` into a sanction engine and a surface profile, and read `class-manifest.json`

**Status:** open · **Raised:** 2026-09-16 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 3 of 3 (pipeline convergence) — largest, least urgent
**Severity:** medium — `/val` has no class checking at all, but its accuracy gate catches most
of what one would find

## What is missing

`/val` has **no vocabulary enforcement of any kind.** Not a weakened version — none.

`{{CLASS_AUDIT_FLAGS}}` renders into exactly five places, all `/design`:

- `templates/commands/design.template.md:95`
- `templates/agents/design-concept-architect.template.md:148`
- `templates/agents/design-critic.template.md:43`
- `templates/agents/design-page-builder.template.md:105`
- `templates/agents/design-handoff-verifier.template.md:21`

Zero `/val` templates mention the tool, a class prefix, or a sanctioned class. The nearest thing
is `val-build` rule 2 — "every color, radius, spacing and type value comes from variables.json
or the design-system tokens… Hardcoded hex values in rules are a gate failure" — which is a
**token** rule, checked by a literal scan inside a self-check script the agent writes itself.
Nothing checks that a class exists, is spelled for the library's identity, or is present in the
stylesheet the page actually linked.

## Why a straight port is wrong

`class-audit` cannot simply be pointed at `04-build/`. Three blockers, in increasing severity:

1. **`--methodology` is mandatory** (`tools/design/class-audit.mjs:62`) and hard-fails without
   it. A `/val` run reproduces an arbitrary Figma frame; it has no surface. (dashboard-ui does
   have a `design-methodology/dashboard.md` on disk, fully §-formatted and currently unused —
   but see 2.)
2. **Three rules are surface-scoped and actively wrong for `/val`.** The §10 forbidden list is
   "shipped components that no in-scope frame uses" — for shortapp that is `.va-avatar`,
   `.va-toast`, `.va-status-tracker` and six more. A `/val` run may legitimately be reproducing
   a frame that uses exactly those. Same for §12 interim classes and the concept-wireframe
   `class=` rule.
3. **One rule is fatal by construction.** `class-audit.mjs:493-496` treats any `.css` file in
   the target as a hard violation — "stylesheet in the package — pages carry no CSS".
   `val-build`'s mandated output is `04-build/index.html` **and** `04-build/styles.css`.
   Pointing the tool at `04-build/` fails on line 1 of `styles.css` before it classifies a
   single class.

So: **the invocation does not port; the sanction engine does.**

## The split

**Engine** — library-derived, pipeline-neutral, no methodology required:

- the sanction table: component selector, `@utility`, `@theme`-derived token, structural
  allowlist, cited spacing/sizing, arbitrary value
- class identity: `--class-prefix` / `--class-strict`, including the detail that the prefix is
  consumed *before* variant parsing (`va:md:w-full`), which 0.5.0 made a tested invariant
- the hard violations that are true everywhere: colour/size literals, `/opacity`,
  `!important`, `(--var)` shorthand, arbitrary variants, `font-*` / `leading-*` / `tracking-*` /
  `uppercase` / `text-<n>`, `@apply`, external design systems
- the advisory Tailwind compile pass

**Profile** — optional, supplied by `/design`, omitted by `/val`:

- §10 forbidden set
- §12 planned interim column
- companion rules (a text token whose theme comment says "needs font-mono")
- hairline rule (four-side `border-[length:…]` beside a side flag)
- the concept-wireframe `class=` rule
- **`noPageCss`** — the "pages carry no CSS" violation, as a flag. On for `/design`, off for
  `/val`, whose build writes `styles.css` by design.

`/val` then gets: does this class exist in the library, is it spelled for the declared identity,
and — see below — is it available in the entry this page linked.

## Read `class-manifest.json`

Both libraries publish a machine-readable vocabulary and **val-core references it nowhere**:

| library | export | components | utilities | declares |
|---|---|---|---|---|
| shortapp-ui 1.3.0 | `./manifest` | 146 | 281 | `classPrefix`, `componentNamespace`, `utilityPrefix` |
| dashboard-ui 0.2.1 | `./manifest` | 313 | 306 | same |

`class-audit` currently re-derives the same facts by parsing `src/components/*.css` and
`@utility` declarations. That works in a library repo where the source is present; the manifest
works anywhere, including from `node_modules` in a consumer, and it is generated from the built
artifact so it cannot drift from what actually shipped.

**Shape divergence to resolve first.** The two manifests are not the same schema:

- shortapp: `{ components, utilities }`
- dashboard: `{ components, customUtilities, prefixedUtilities }` plus
  `customUtilitiesReachableFrom`

Either the engine handles both, or the libraries converge. Converging is better and is a
library-side ticket; val-core should not encode the difference.

Keep source-parsing as the fallback when no manifest is present — a library that has not
adopted the export must not lose its audit.

## The entry dependency

This is the part that makes the gate worth building rather than merely consistent.

A `/val` page links `dist/index.css`, which ships **no utility layer at all** — measured: 0
occurrences of `va:` in shortapp's `dist/index.css` against 281 in `dist/shortapp-ui.css`.
GETTING_STARTED states it directly: "`.` / `./index.css` — these ship **no** utility layer at
all; neither spelling will work."

So the engine's verdict depends on which entry the run declared, not just on which library it
is:

| declared entry | components | utilities the page may write |
|---|---|---|
| `standalone` (`dist/index.css`) | `.va-*` | **none** — the page hand-writes its layout CSS |
| `integration` (`dist/shortapp-ui.css`) | `.va-*` | `va:*` only |
| `source` (`src/library.css`) | `.va-*` | bare, generated by the host's Tailwind |

The engine reads the `utilities` field from the declared entry and rejects accordingly. **This
depends on the `library.entries` config change** in the `paths.componentCss` ticket. Without it
the gate cannot tell a legitimate `va:flex` from one that will silently not resolve.

Note the consequence for `/val` specifically: under `standalone`, the page's layout lives in
hand-written `04-build/styles.css`, which is precisely the file nothing reads today. The entry
choice and the missing gate are the same hole from two sides.

## Cost, and why this is third

`class-audit.mjs` is ~33.5k with a ~24.3k test file. The test file is both why the refactor is
tractable and why it will take a while: `class-audit.test.mjs` asserts the per-path sanction
matrix under strict and tolerant spellings, and every one of those assertions has to keep
passing across the split, unchanged.

It is third in order because `/val` has an accuracy gate. A misspelled or unresolvable class
that silently no-ops shows up as a visual defect and is caught downstream at Gate 6. `/design`
had neither a vocabulary gap nor a render step, which is why it shipped five defects and `/val`
has not. That is an argument for sequencing, not for skipping: "caught downstream" means a full
rework cycle instead of a script that costs no model tokens.

## Tests

Per the tooling rule, a false positive here is a tool bug — the engine must never push a
working `/val` build into being rewritten. Add, alongside the existing matrix:

- the same class set audited with and without a profile, asserting identical verdicts for
  everything the profile does not govern
- `04-build/styles.css` present and **not** a violation with `noPageCss` off, and a violation
  with it on
- a `va:` utility sanctioned under `integration` and rejected under `standalone`, with the
  rejection naming the entry and the reason — not a generic "unsanctioned"
- manifest-driven and source-derived sanction sets producing the same verdict for the same
  library, so adopting the manifest is provably not a behaviour change

Per the gates-can-under-read rule, diff the manifest-driven extractor against the source-parsing
one across the whole library before trusting the swap; a green run on a subset proves nothing
about coverage.
