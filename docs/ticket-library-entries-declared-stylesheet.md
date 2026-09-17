# Ticket: `paths.componentCss` cannot express which entry a run wants — add `library.entries`

**Status:** open · **Raised:** 2026-09-17 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 0 of 3 — **prerequisite for the convergence work**
**Severity:** medium on its own; blocking for two other tickets
**Blocks:** `ticket-design-gate-5-5-render-and-measure.md` (2 of 3),
`ticket-vocabulary-gate-engine-profile.md` (3 of 3)

## What is wrong

One key, one string, default `dist/index.css`, described in the schema as "The built library
the val page consumes." It is consumed in **exactly one place** —
`templates/agents/val-build.template.md:42`, "Consume the library through
`{{COMPONENT_CSS}}`". `/design` never reads it, because the package carries no CSS by contract.

Both libraries set it to `dist/index.css`. That is **correct for a standalone val page and
wrong for anything a dev integrates into a host**, and the config has no way to say which one a
run is.

## The three entries, measured

shortapp-ui 1.3.0 and dashboard-ui 0.2.1 publish the same three-entry shape:

| entry | file | components | utilities | preflight | fonts | layering |
|---|---|---|---|---|---|---|
| `.` / `./index.css` | `dist/index.css` | 301 `.va-*` (502 `.vd-*`) | **0** | yes (TW4) | yes, self-contained | layered `theme, base, components, utilities` |
| `./styles.css` | `dist/shortapp-ui.css` | 302 `.va-*` | **281 `va:*`** | no — "the host app owns its reset" | no | **unlayered on purpose**, to beat a host's unlayered reset |
| `./source` | `src/library.css` | `.va-*` | host's Tailwind generates them **bare, unprefixed** | host's | host's | host's |

So `componentCss` is being asked to answer three questions with one string:

1. **which artifact** — a path, which is all the key can currently hold
2. **what class vocabulary the page may write** — `none`, `va:`-prefixed, or bare
3. **what the artifact does to the host's reset** — ships preflight, or defers to the host

Only (1) is a path. (2) and (3) are facts about the run, and nothing records them.

## Why this blocks the other two tickets

**Ticket 2 (Gate 5.5 render shell).** The generated shell has to write an `app.css`. Which
import line it writes *is* the entry choice, and the three entries are not interchangeable —
one ships preflight and fonts, one must load after the host's reset and must not be layered, one
requires the host to run Tailwind over the library's `@theme`. A shell that hardcodes one is a
shell that silently measures the wrong thing for two of the three cases, which is the class of
defect the 0.6.1 claim guard exists to stop being asserted in prose.

**Ticket 3 (vocabulary gate).** The gate's verdict depends on the entry, not just the library.
`va:flex` is sanctioned under `integration`, unresolvable under `standalone`, and misspelled
under `source`. GETTING_STARTED states it directly: "`.` / `./index.css` — these ship **no**
utility layer at all; neither spelling will work." Without a declared entry the gate cannot tell
a legitimate class from one that will compile in nobody's build.

Neither should proceed on a hardcoded assumption, which is why this is 0 rather than 4.

## Fix — declare the entry, do not split the key

Splitting into `componentCssStandalone` / `componentCssIntegration` was considered and is worse:
the run still has to pick one, the choice moves into the library's config rather than the run's,
and neither key says anything about vocabulary or preflight — so ticket 3 would still be blocked.

**`library.entries`** — a small map the library owns, one row per published entry:

```json
"library": {
  "entries": {
    "standalone":  { "path": "dist/index.css",       "utilities": "none",
                     "preflight": true,  "layered": true,
                     "docs": "GETTING_STARTED.md#without-tailwind-v4-the-prebuilt-bundle" },
    "integration": { "path": "dist/shortapp-ui.css", "utilities": "prefixed",
                     "preflight": false, "layered": false,
                     "docs": "GETTING_STARTED.md#without-tailwind-v4-the-prebuilt-bundle" },
    "source":      { "path": "src/library.css",      "utilities": "host-tailwind",
                     "preflight": false, "layered": false,
                     "docs": "GETTING_STARTED.md#step-3-create-your-stylesheet" }
  }
}
```

`utilities` is the enum `"none" | "prefixed" | "host-tailwind"`. Every value above is a fact
already true of both shipped libraries; nothing here is a new decision for them to make.

**The run declares which it wants.**

- `/val` defaults to `standalone`, and for a better reason than convention: a val page is
  compared tile-by-tile against a Figma export at fixed dimensions, so it *wants* the
  self-contained preflight and font import to make the comparison deterministic. This is the
  first place that rationale is written down anywhere — today the template just names a path.
- `/design` declares `integration` or `source` and links nothing. The declaration is what
  `HANDOFF.md` §2 names, and what ticket 2's generated shell boots with.

**`docs` is load-bearing, not a comment.** It is the anchor `HANDOFF.md` §2 cites when it states
the entry's contract — the two-clause text in the library's own GETTING_STARTED. That is the
citation the 0.6.1 guard's `measured|verified` escape is meant to sit beside.

## This is a minor, not a major, because the old key stays

val-core's versioning rule makes a config-schema change a **major** ("config schema or agent
contract changes"). This one does not have to be:

- **`paths.componentCss` stays, as a deprecated alias for `entries.standalone.path`.** A config
  that sets only the old key keeps working, unchanged, and `/val` behaves byte-for-byte as it
  does today — both libraries currently point it at `dist/index.css`, which is exactly what
  `standalone` resolves to.
- `val-init` **warns** when only the old key is present, naming the replacement. A warning is
  right here and wrong in the class-identity ticket: nothing is silently unenforced, the
  existing behaviour is correct, and the only thing missing is the richer declaration.
- Adding `library.entries` is an **optional config key**, which the versioning rule already
  classes as minor.

So: **minor.** Promote it to a major only if and when the alias is removed, which should be its
own release and its own note.

Keep the alias resolution in one place — a small helper beside `stylesheet-path.mjs` — rather
than each consumer reaching for `entries?.standalone?.path ?? paths.componentCss`. There will be
three consumers before this is done (`val-build`'s substitution, ticket 2's shell, ticket 3's
gate) and a scattered fallback is how one of them ends up reading the other key.

## Migration

Both libraries can fill `entries` from facts already true; neither has to change a build. The
one thing to check per library is that `docs` points at a heading that exists — shortapp's
two-clause section and dashboard's equivalent.

`val-init --check` flags the drift in CI, as it does for every other template change.

## Tests

- a config with only `paths.componentCss` renders `{{COMPONENT_CSS}}` exactly as it does today,
  asserted against the current generated output — the alias must be provably not a behaviour
  change
- a config with only `paths.componentCss` warns, and the warning names `library.entries`
- a config with both prefers `entries` and warns about the redundancy
- an unknown entry id requested by a run fails, and the message lists the ids the library
  declares rather than a generic "not found"
- `utilities` outside the enum is refused by the schema — 0.6.0's `enum` fix already covers
  this path, and this is the second key to rely on it

## Open question for whoever picks this up

Whether the run's entry choice lives in the command invocation (`/val … --entry integration`),
in the manifest at Gate 0, or both. The manifest is the better record — it is what the tools
read and what the writeup can cite — but a val run that wants a non-default entry has to be able
to say so before the manifest exists. Suggest: manifest is the source of truth, the flag writes
it at Gate 0, and `library.entries` carries a `default` id so neither has to be given in the
common case.
