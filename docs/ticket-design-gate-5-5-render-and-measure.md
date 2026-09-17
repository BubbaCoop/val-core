# Ticket: `/design` never renders the page — add Gate 5.5, render-and-measure

**Status:** open · **Raised:** 2026-09-16 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 2 of 3 (pipeline convergence)
**Severity:** high — this is the one that has already cost a run

## What happened

A `/design` run produced a page with five visible defects. Every gate passed. That is the
pipeline working as specified, not a leak in it.

**Nothing in `/design` renders anything.** Every gate is static text analysis over source:

| gate | what it does | does it paint? |
|---|---|---|
| 2 / 3 concept | `class-audit` over `concept.v<n>.html` — the Tailwind pass *compiles* candidate classes | no |
| 5 build | `class-audit` over `05-package`, `handoff-check` runs every `.svelte` through `svelte/compiler` | no |
| 6 verify | the verifier reads the concept, `contract.json`, `mapping.md`, `HANDOFF.md`, the `.svelte` files | no |

**Compile is not render.** A component that compiles cleanly, carries only sanctioned classes,
implements every block and matches every copy string can still overflow its column, clip its
own text, stack two regions on top of each other, or reference a sprite glyph that does not
resolve. No gate can fail on something that only exists once painted.

## The correction this ticket supersedes

The first framing of this work was "wire `/val`'s accuracy stage into the `/design` verifier at
Gate 6, against the concept's cited Figma frames." **That is impossible as stated, and the
reason is structural, not a missing feature:**

- `/design` cites no frames. The §7 concept contract is a grey-box wireframe carrying
  `data-block`, `data-class`, `data-region`, `data-states`, `data-copy` — there is no frame id,
  URL or reference image in `concept.md`, `contract.json` or `contract.schema.json`.
- Every stage is *forbidden* from reading one: `design-brief-intake:38`,
  `design-concept-architect:42`, `design-critic:35`, `design-page-builder:47`,
  `templates/commands/design.template.md:265`, and `skills/design-methodology/SKILL.md:18`
  ("no Figma, no PNG, no memory of what 'a form usually looks like'").

`grid-diff` needs a reference. `/design` has none, by design — it composes from a methodology
rather than reproducing a frame. Adding cited frames would convert `/design` into `/val` for
the cited blocks and contradict the reason the pipeline exists.

**What is needed is reference-free rendering, not grid-diff.**

## What is reusable, and what is not

The accuracy tooling splits cleanly along the reference line. This is not a run-schema problem
that could be refactored away — the reference-dependent half assumes a Figma frame because
measuring against a Figma frame is `/val`'s job.

| tool | coupling | portable? |
|---|---|---|
| `screenshot.mjs` | hardcodes `<run-dir>/04-build/index.html` (`:57`); manifest `frames[]` for w/h/scale; `window.valPage.applyState` | **no** — the path, and `05-package/` has nothing renderable |
| `grid-diff.mjs` | most portable: explicit `--reference` / `--build` / `--out` / `--scale`, tolerates a missing manifest | mechanically yes, **but there is no reference** — v(n)→v(n+1) regression only |
| `classify-tiles.mjs` | `layout.json` regions to *name* findings; degrades to unmapped tile groups | degraded, and moot without a reference |
| `geometry-check.mjs` | `layout.json` Figma boxes + `04-build/regions.json` + `04-build/index.html` | **no** — every assertion is "does the render match the frame's numbers" |
| `qa/harness.mjs` + `qa/standing.mjs` | `createSuite({ pageUrl })` takes an explicit URL (`harness.mjs:296-298`); S01–S06 are page-agnostic and auto-discovering | **yes, directly — this is the reusable half** |
| `regression-check.mjs` | fix list with `selectorScope` + before/after captures | in principle; needs the verifier's fix list to gain a scope field |

## The work, in three parts

### a. A render shell — the real work, and val-core does not have one

`05-package/` is deliberately shell-less. `handoff-check`'s `shell` check **fails the package**
if a load path, a sprite import or a stylesheet appears inside it
(`tools/design/handoff-check.mjs:470-480`), because skill §11 puts all three at the app shell.
That is correct and should not change. It does mean the package cannot be rendered where it sits.

Two existing hosts, both unusable today:

- `shortapp-ui/examples/sveltekit-starter` — **wrong load path for this purpose.** Its
  `app.css` imports `reset.css` + the prebuilt bundle, not the §11
  `fonts → tailwindcss → source` path the methodology mandates, and it inlines no sprite. It is
  a specificity test rig.
- `~/Desktop/shortapp svelte test` — **right** §11 load path, but pins
  `@valiify/shortapp-ui@^0.1.2` against a shipped 1.3.0, and val-core `^0.2.0`. That range
  predates the `va-` rename entirely. **Deliberately left stale and marked as such** — see
  `ticket-mark-shortapp-svelte-test-as-stale.md`; do not re-evaluate it as a candidate, and do
  not upgrade it, because a hand-maintained host drifts silently and the generated shell is what
  removes the need for one.

val-core should **generate** a minimal shell per run: `app.css` at the configured entry's
documented load path, `+layout.svelte` inlining the configured sprite once, the package's
routes mounted, everything else empty. Boot it with `vite createServer` + Playwright.

The boot path is already proven in the library:
`shortapp-ui/examples/sveltekit-starter/check-scoped-styles.mjs` is exactly
`createServer` → `chromium` → `getComputedStyle`, and its own comment says it exists "to keep
the HANDOFF's second clause honest."

**This depends on the `library.entries` decision** in the `paths.componentCss` ticket — the
shell has to know *which* entry it is booting, because the three entries admit three different
class vocabularies and do three different things to the host reset. Land that first or the
shell hardcodes an assumption.

### b. The reference-free assertion set — where the five defects live

Everything here is checkable without a reference image:

- horizontal overflow **at each methodology viewport**. S04 currently runs 1440 / 1280 / 1024;
  the Short App surface's own viewports are 1920 and 375. That gap is worth closing regardless
  of this ticket.
- zero-size, clipped or overlapping elements
- text overflowing its box
- console errors — S06 already
- **an unresolved sprite glyph.** `<use href="#x">` pointing at nothing renders empty and is
  invisible to every current gate. `sprite-subset.mjs` already knows how to detect a missing
  glyph statically; the rendered check catches the case where the sprite was not inlined at all.
- **a class present in markup that matched no rule** — measurable by comparing computed styles
  against the same element with the class removed. This is the rendered counterpart of the
  vocabulary gate, and catches a sanctioned class that is simply absent from the entry the
  shell loaded.
- S01 hover, S02 disclosure cycling, S05 keyboard reachability

### c. A rendered-evidence requirement in HANDOFF.md §10

`handoff-check` requires the **Evidence** heading to exist and never reads its content. Once
Gate 5.5 produces a report, §10 should have to cite it.

This closes the 0.6.1 loop. The phrase class had to be banned because nobody had measured;
once the pipeline measures, the `measured|verified` escape becomes the normal path rather than
a loophole, and the handoff can say what the page actually does.

## Placement — Gate 5.5, not inside Gate 6

Do **not** put the browser inside the verifier's turn budget. Gate 6 is 15 tool uses of static
reading with a 6-use re-run budget; a shell build, a vite boot and a Playwright pass do not fit
and should not compete with the judgements only a reader can make.

Gate 5.5 runs after the builder and before the verifier, writes `05b-render/` (report + capture
+ console log), and the verifier reads the report the way `val-accuracy` reads
`screenshot.mjs`'s output. A Gate 5.5 failure routes to the builder in rework mode on the
existing Gate 6 loop counter (`loops.verify`), so the cap and the `needs-human-review` exit stay
in one place.

## Definition of done

- A `/design` run whose page overflows its column at 375 fails before the verifier sees it, and
  the failure names the block id and the viewport.
- `HANDOFF.md` §10 cites the render report, and the §2 load-path sentence can state what was
  measured instead of working around the phrase class.
