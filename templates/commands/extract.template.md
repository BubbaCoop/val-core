---
description: >
  Run the component-extraction pipeline — pull one component's full spec from
  the {{LIBRARY_DISPLAY_NAME}} Figma file through three parallel lanes plus cross-checking
  synthesis, then implement it. Usage: /extract <ComponentName> <figma-node-url>
---
{{GENERATED_HEADER}}

You are the orchestrator of the component-extraction pipeline. This is NOT the
Val pipeline (Val assembles pages from finished components; this builds the
components) — never invoke val-* agents from here and never touch Val's
run directory ({{RUN_OUTPUT_DIR}}/) or registry ({{REGISTRY_PATH}}).

The full component process is {{COMPONENT_PROCESS_DOC}}; this command runs its
Steps 1–2 as a gated multi-agent pipeline and then continues Steps 3–7
yourself. The library-independent extraction methodology (Figma API traps,
token lessons, CSS traps) is {{CORE_SKILLS_DIR}}/extract-methodology/SKILL.md.

## Gate 0 — Metadata sweep (you, one cheap call)

Run `get_metadata` on the component node from the URL (file
`{{FIGMA_FILE_KEY}}`). Record the variant matrix: every variant's node id,
name, and dimensions. If the node is not a component set (a lone frame, or a
page), stop and ask which set to extract.

Decide the lane set by component size:
- Standard: all three lanes.
- SKIP the visual lane when the component has: no text (so no casing
  question), no vector glyphs, no strokes, and only whole-integer geometry —
  i.e. nothing the APIs could flatten or misreport AND no state pairs worth
  pixel-diffing. State the skip decision and its reasoning in your status.
  When in doubt, run it — but with its ≤20-call budget it is cheap enough
  that the skip is an optimization, not a rescue.
- The visual lane's budget rule means it may report "could not measure X
  within budget" — that is a follow-up decision for YOU at Gate 1, not a
  deficiency: re-invoke it for that one measurement only if synthesis will
  need the value.

## Gate 1 — Parallel lanes (one message, all Agent calls together)

Spawn IN PARALLEL, each with the component name, set node id, and the full
variant matrix from Gate 0 pasted in:

- `extract-structure` — plus any component-specific structural questions
- `extract-tokens`
- `extract-visual` — plus what specifically to measure (strokes, dots, gaps)

Verify each report against its agent's definition of done (the report-format
section in its agent file). A lane that answered with guesses or skipped a
required section gets re-invoked ONCE with the specific deficiency named. If
it fails twice, halt and report.

A lane that CRASHES (server error, early termination) is not a failed lane —
RESUME it with SendMessage to its agent id ("continue from where you left
off"), which preserves its downloads and partial work, rather than spawning a
fresh agent.

## Gate 2 — Synthesis

Spawn `extract-synthesis` with all three lane reports pasted into its prompt.
Verify its output has all six deliverable sections. If it reports a BLOCKING
conflict, stop and surface it to the user before writing any CSS — do not
implement around a contradiction.

## Gate 3 — Implement (you, per {{COMPONENT_PROCESS_DOC}} Steps 3–7)

1. Add any NEW theme tokens to {{FIGMA_TOKENS_JSON}}, then
   `npm run build:theme`.
2. `npm run new:component <Name>` — scaffold.
3. Write the CSS from the synthesis Tailwind map. The trap flags are
   binding — a flagged fractional stroke ships as an inset box-shadow, a
   flagged missing state combination ships with the `:not()` exclusion.
4. Write the story; states Figma does not draw get documented gaps, not
   invented styling.
5. Add the visual spec from the synthesis assertion list —
   `{ token: '--color-x' }` comparisons, never literals.
6. Document in CLAUDE.md Quick Reference (include the designer-list items).
7. Verify: `npm run build && npm run typecheck`,
   `npm run verify:component <Name>`, build/serve Storybook,
   `npm run verify:visual -- <Name>`, `npm run verify:a11y -- <Name>`,
   then screenshot the story and eyeball it against the Figma render.
8. Stage with `git add` — never commit or push.

## Multiple components

`/extract` calls for several components can overlap: run each component's
Gate 0 yourself, then launch all components' lanes in parallel batches.
Synthesis stays per-component.
