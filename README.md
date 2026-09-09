# @valiify/val-core

Val is the agent pipeline the Valiify component libraries use to turn Figma
into verified code. This package is the **shared** part: the agent
templates, the orchestrator commands, the measurement tools, and the
methodology skills. Each library keeps only what is genuinely its own — a
`val/config.json` and its design-system skill — and generates its agents
from here.

```
                 @valiify/val-core                       library repo
  ┌──────────────────────────────────────┐    ┌──────────────────────────────────┐
  │ templates/agents/*.template.md       │    │ val/config.json  (the 5 deltas)  │
  │ templates/commands/*.template.md     │ ─▶ │ .claude/agents/*.md   GENERATED  │
  │ tools/  grid-diff · screenshot ·     │    │ .claude/commands/*.md GENERATED  │
  │         generate-registry            │    │ val/tools  → symlink into core   │
  │ skills/ extract-methodology ·        │    │ .claude/skills/<library>-ui/     │
  │         visual-verification ·        │    │ val/registry/components.json     │
  │         component-mapping            │    │ val/runs/                        │
  └──────────────────────────────────────┘    └──────────────────────────────────┘
                     npx val-init
```

## What Val does

**`/val <figma-url> [writeup]`** — page assembly. Six gated stages, each a
subagent with a definition of done the orchestrator verifies:

1. `val-figma` — extract the frame: node tree, variables, prototype
   behaviours, exports, disclosure-state variants
2. `val-components` — map every instance to a library component with a
   confidence rating
3. `val-context` — requirements from the writeup, annotations and flows;
   BLOCKING questions surfaced, never defaulted
4. `val-build` — static page from library components + tokens; geometry
   self-verified; never invents unseen content
5. `val-qa` — Playwright over every recorded behaviour + standing checks
6. `val-accuracy` — tile diff against the export; every non-pass tile
   classified; PASS = zero genuine defects

**`/extract <Component> <figma-node-url>`** — component extraction. Three
parallel lanes (`extract-structure`, `extract-tokens`, `extract-visual`)
read the same component set independently; `extract-synthesis` cross-checks
them into an implementation spec. The main session then implements per the
library's component process.

## Install in a library

```bash
npm install --save-dev @valiify/val-core        # or: file:../val-core while unpublished
cp node_modules/@valiify/val-core/val.config.example.json val/config.json
# edit val/config.json — see "Configuration"
npx val-init
git add .claude/ val/config.json val/tools
```

`val-init` writes `.claude/agents/*.md` and `.claude/commands/*.md` and
links `val/tools` to the package's tools. **Commit the generated files** —
Claude Code reads them from the repo, and a checkout must work without
running anything. Each carries a header naming its source; edit the
template or the config, never the output.

Keep them honest in CI:

```bash
npx val-init --check     # exit 1 if any generated file is stale or hand-edited
```

If the library previously carried its own `val/tools/` directory, remove it
(`git rm -r val/tools`) and re-run `val-init` so the symlink can be created.

## Configuration

`val/config.json` holds everything that differs between libraries — and
nothing else. Schema: [schema/val.config.schema.json](schema/val.config.schema.json);
worked example: [val.config.example.json](val.config.example.json).

| key | what it drives |
| --- | --- |
| `library.name` / `displayName` / `figmaFileKey` | run manifests, agent prose, the extract lanes' file key |
| `paths.designSystemSkill` | the library-specific skill the build and synthesis agents read (**required**; stays in the library repo) |
| `paths.*` (registry, tokens, css, sprite, stories, runs, tools, …) | every repo path the agents reference; defaults match the Valiify layout |
| `typography.fonts` / `systemNote` / `dataRule` | the one place the libraries' design systems change agent behaviour (Inter-only vs Inter + JetBrains Mono) |
| `audience` | the register sentence in requirements §1 |
| `pipelines.val` / `pipelines.extract` | generate one pipeline or both |

Two libraries, two configs, identical methodology:

```jsonc
// shortapp                                  // dashboard
"typography": {                              "typography": {
  "fonts": ["@fontsource/inter"],              "fonts": ["@fontsource/inter", "@fontsource/jetbrains-mono"],
  "systemNote": "… INTER-ONLY …",              "systemNote": "Inter for UI, JetBrains Mono strictly for verifiable data",
  "dataRule": "tabular-nums (Inter-only …)"    "dataRule": "JetBrains Mono + tabular-nums"
}                                            }
```

## Placeholders

Templates use `{{UPPER_SNAKE}}` placeholders; `val-init` fails on any it
does not know. Current set: `LIBRARY_NAME`, `LIBRARY_DISPLAY_NAME`,
`FIGMA_FILE_KEY`, `DESIGN_SYSTEM_SKILL_PATH`, `REGISTRY_PATH`,
`TOKEN_SOURCE`, `COMPONENT_CSS`, `ICON_SPRITE`, `STORIES_DIR`,
`COMPONENTS_DIR`, `RUN_OUTPUT_DIR`, `TOOLS_DIR`, `FIGMA_TOKENS_JSON`,
`BUILD_THEME_SCRIPT`, `VISUAL_SPECS_SCRIPT`, `COMPONENT_PROCESS_DOC`,
`CLAUDE_MD_SECTIONS`, `CORE_SKILLS_DIR`, `FONT_PACKAGES`,
`TYPE_SYSTEM_NOTE`, `DATA_TYPOGRAPHY_RULE`, `AUDIENCE_NOTE`,
`QA_PROBES_PATH`, `GENERATED_HEADER`.

**Rule for template authors:** a line is either generic methodology or a
substituted config value. Library-specific prose (a font constraint, a
component-family name, a Figma alias) never lives in a template — it goes
in the config, the library's design-system skill, or the registry.

## Tools

All take a Val run directory and are reached through the `val/tools` link.
Defaults act on the primary frame; `--frame <state>` selects another entry of
the manifest's `input.frames[]` (its files live under `…/frames/<state>/`).

- `screenshot.mjs <run-dir> [--frame s] [--state name] [--setup script.mjs] [--scale n] [--out dir]`
  — headless full-page capture at the frame's width and comparison scale;
  drives states through `window.valPage.applyState`; records console errors.
- `grid-diff.mjs <run-dir> [--frame s] [--reference png] [--build png] [--out dir] [--scale n] [--baseline report]`
  — 64px-tile pixelmatch against the frame's best reference (the requester's
  2x export when recorded, else the MCP export); pad-only normalization;
  `--baseline` carries a previous report's per-tile classifications forward
  and lists what changed. Writes `diff-report.json` + `overlay.png`.
- `classify-tiles.mjs <run-dir> [--frame s] [--accepted json] [--crops [all]]`
  — maps non-pass tiles to `layout.json` regions, groups them into findings
  with numeric evidence (colour histograms, ink boxes, best horizontal shift)
  and pre-labels each `accepted-candidate` / `artifact-candidate` /
  `needs-review`; optional native-scale reference|build crops for the last.
- `geometry-check.mjs <run-dir> [--frame s | --all] [--tolerance px]`
  — the build gate's geometry self-check in one command: renders each frame,
  asserts page size / no scroll / every `layout.json` region within ±2px
  (selectors from `04-build/regions.json` or `data-val-node`), zero console
  errors. Writes `geometry-<state>.{json,md}`; exit 1 on any miss.
- `regression-check.mjs <run-dir> --before png --after png [--reference png] [--fixlist json]`
  — byte-diff of two captures clustered into regions; with a fix list, every
  changed cluster must lie inside a fix region (or a listed sibling) and no
  fix or sibling region may get worse against the reference — strict by
  design. Zero model tokens; run before dispatching QA.
- `sprite-subset.mjs <sprite.svg> --used-by index.html [--out file]`
  — emits only the `<symbol>`s a page references (5 instead of 2,000).
- `qa/harness.mjs` + `qa/standing.mjs` (import, not run) — the Playwright
  plumbing for `05-qa.spec.mjs`: fresh context per test, error collectors,
  token-resolving style reads, mouse parking, outline-or-shadow focus rings,
  a Tab-order pass, rendered-ink measurement, the report writer, and the six
  standing checks (hover, expand/collapse, sticky, resize, keyboard, console)
  with auto-discovery. Start from `qa/example.spec.mjs`. Library-specific
  probe hooks go in the module named by `paths.qaProbes` (optional).
- `generate-registry.mjs [repo-root]` — Storybook stories → component
  registry; reads paths from `val/config.json`; hand-added enrichment
  survives regeneration.

Tested: `npm test` (pixel tools with fixtures; geometry-check and the QA
harness against headless Chromium — skipped if it is not installed).

## Skills

Library-independent methodology, referenced from the generated agents by
path (`node_modules/@valiify/val-core/skills/…`):

- **extract-methodology** — which Figma tool answers which question, what
  each silently gets wrong, the three-lane cross-check, token-extraction
  lessons, what Figma routinely gets wrong
- **visual-verification** — Chrome rendering traps, coverage-based pixel
  measurement, grid-diff classes, artifact-vs-defect classification
- **component-mapping** — registry schema, confidence ladder, aliases,
  deviations, merge contract

## Roadmap

`val-core` is layer 0. Planned layers build on it without duplicating
extraction or verification:

- **val-dev** — UI concepting across several libraries plus business/UX
  context, choosing the right library per requirement
- **val-ops** — small tickets and configuration changes end to end
- **val-consumer** — customer-facing generation (applicant emails, reports,
  loan memos)

## Versioning

- **major** — config schema or agent contract changes (status lines,
  run-directory layout, manifest shape)
- **minor** — new templates, tools, skills, or optional config keys
- **patch** — template wording, tool fixes, docs

Run `npx val-init` after upgrading; `--check` in CI flags drift. Note that
even a docs-only patch changes the version stamped into every generated
file's header, so every release forces consumers to regenerate. Changes
that do not touch the published tarball (CI, CHANGELOG, this README) are
committed, not released.

## Releasing

Publishing is local — npm requires interactive 2FA for this account. CI
(`.github/workflows/ci.yml`) verifies; it never publishes.

```sh
# on a green main with a clean tree
#   move CHANGELOG "[Unreleased]" -> "[x.y.z] — YYYY-MM-DD", then:
git commit -am "Changelog x.y.z"
npm test && npm run check && npm pack --dry-run   # what CI runs; no "npm warn" lines
npm version patch|minor|major                     # bumps, commits, tags vx.y.z
npm publish                                       # browser 2FA prompt
git push origin main --follow-tags                # CI re-verifies; tag must match version
```

Then finish the release in each consumer library, or its `val:check` CI
gate goes red on the header change:

```sh
npm install --save-dev @valiify/val-core@x.y.z
npx val-init          # regenerates .claude/agents + .claude/commands
git add .claude/ val/tools package.json package-lock.json
```

## License

MIT © Valiify
