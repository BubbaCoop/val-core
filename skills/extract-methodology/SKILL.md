---
name: extract-methodology
description: >
  How to read a Figma component set accurately with the Figma MCP tools —
  which tool answers which question, what each tool silently gets wrong, the
  three-lane cross-check discipline, and the token-extraction lessons the
  Valiify libraries paid for once already. Library-independent; the
  library's own tokens, casing decisions and component conventions live in
  its design-system skill.
---

# Component extraction methodology

The extraction pipeline exists because **no single Figma API read is
trustworthy**. Metadata flattens, `get_variable_defs` deduplicates, renders
never upscale, layer names lie. Every value that ships should have been
established by two independent reads that agree — or carry an explicit note
that it could not be.

## 1. Cheapest tool per question

| Question | Tool | Cost | Notes |
| --- | --- | --- | --- |
| What variants exist? Their ids, names, sizes? | `get_metadata` on the SET | 1 call | Always first. Catches axes the designer added/removed without saying. If the URL is a lone frame or a page, stop and ask which set. |
| Child layers, geometry, how each mark is drawn | `get_design_context` | ≤4 calls | One call on the set, or one representative variant per structurally distinct Type — not per state. Returned SVG is a **feature**: read radii, offsets, stroke widths and alignment from the source. |
| Which variables does each variant bind? | `get_variable_defs` on EVERY variant + the set | all in ONE message | Parallel calls, never one per turn. Applied-only: a variable bound nowhere on that node is silently absent. |
| Real stroke width, glyph size, whether two states differ at all | `get_screenshot` + a pngjs script | ≤20 calls total | Only pixels know these. See `visual-verification`. |
| Every variable in the collection, used or not | Plugin API via `use_figma` → `figma.variables.getLocalVariableCollectionsAsync` | 1 call | The **only** completeness source. The applied-only sweep missed 26 of 56 colours on the Short App file. |

## 2. What each tool silently gets wrong

- **`get_variable_defs` returns only variables applied to that layer.** A
  token defined but unused is invisible. Audit completeness with the Plugin
  API enumeration or `search_design_system`, never with per-node reads.
- **`get_variable_defs` deduplicates.** Two paints sharing one variable
  appear once; when two marks *could* share a variable, say so rather than
  asserting which paint binds it.
- **`get_screenshot` never upscales above native size**, whatever
  `maxDimension` says (verified at 2048/4096/65536). A 20px control comes
  back at 20px. Plan coverage-based sub-pixel measurement from the start;
  do not retry with a bigger `maxDimension`.
- **Renders composite onto an opaque white matte** with ~0.5–1px offsets.
  Recover fractional coverage by projecting each pixel onto the vector
  between the two known flat colours.
- **Duplicate style names collapse.** The API returns a keyed object, so
  two styles sharing a name become one, and the survivor's values get
  attributed to the wrong style. A token that "looks wrong" — check for a
  name collision first.
- **Layer names lie.** "ChevronLeft" that renders right, "arrow-right"
  that is a pencil, "AttachMoneyRounded" that is an arrow. Ship the glyph
  the render shows (Code Connect resolution when available), and put the
  misnaming on the designer list.
- **`lineHeight: 100` is Figma's "Auto" sentinel, not 100%.** Emit
  `line-height: normal`. Emitting `1` makes styles visibly too tight.
- **Every `letterSpacing` value is a percentage of font size**, never px.
  Emit `em` (10% → `0.1em`).
- **Metadata dimensions can be wrong by exactly the hairline trap** (a
  92.5px row read as 94.5). When a metadata read disagrees with arithmetic
  from the authored children, arithmetic + pixels win.

## 3. The three-lane discipline

Structure, tokens and visual run **in parallel**, each answering only its
own questions and reporting raw values. Synthesis then diffs them:

- structure's declared stroke width **vs** visual's measured width
- tokens' hex **vs** visual's sampled colour (alpha included)
- structure's geometry **vs** the variant frame dimensions
- tokens' per-state delta **vs** visual's state distinguishability

A CONFLICT is a finding, not noise to smooth over: report both values,
which lane is more likely right and why, and mark it BLOCKING when
implementation cannot proceed. The worst shipped extraction errors were
single-source readings nobody cross-checked (a ring a third too thick from
a binary-threshold trace; a knob measured 15px by raster when authored 16).

Lane rules that keep the cross-check honest:

- **Raw values only.** No lane converts, normalizes or renames. `100` stays
  `100`; letter-spacing stays a percentage; variable names stay Figma's.
- **`null` beats a guess.** "Could not measure within budget" is a valid
  finding; a plausible rounded value is a defect waiting to ship.
- **Report the method with every number** ("coverage across 40 scanlines at
  2.4x → 1.51px ≈ authored 1.5"). An unexplained number cannot be
  cross-checked.
- **Budgets are real.** Visual ≤20 calls; structure ≤4 design-context
  calls; tokens = one parallel burst. Past runs at 49–66 visual calls spent
  most of them re-confirming values the tokens lane already binds exactly.

## 4. Synthesis output contract

Compress agreements, spend prose on decisions. A value all lanes agree on
gets one table row. Full prose is reserved for conflicts and their
resolution, trap flags that forced a non-obvious implementation, and
designer-list items. All sections are required — brevity about settled
facts is efficiency; dropping a conflict or an "could not determine" note
is a defect.

## 5. Token-extraction lessons (paid for once — do not relearn)

- **Do not redefine Tailwind's own token names** unless the override is
  deliberate and documented. Tailwind v4 ships `--radius-xs/sm/md/lg`;
  redefining them silently changes `rounded-*` for every consumer. Either
  match Tailwind's values byte-for-byte or name radii by role.
- **Never define `--spacing-8: 8px`.** Tailwind v4's scale multiplies
  `--spacing` (0.25rem); that token makes `p-8` mean 8px instead of 32px.
  Whole-px Figma spacing maps to native steps (8 → `p-2`); half-pixels use
  arbitrary syntax (`p-[7.5px]` — the multiplier form does not compile).
- **`--text-*` tokens carry neither font-family nor text-transform.** Mono
  styles need an explicit `font-mono`; uppercase label styles need a paired
  `type-*` utility that bundles the casing.
- **Casing is a styled transform, not typed caps** — until a component
  proves otherwise. Figma samples are typically typed mixed-case; whether a
  style carries an uppercase transform is settled per component from the
  render, then recorded in the token file.
- **Styles named "- Bold" often resolve to Medium/500.** Read the weight
  the style reports; never map the name.
- **Figma's `Text` / `BG` groups map to public prefixes that avoid
  doubled utilities** (`text-text-secondary`, `bg-bg-paper`) — e.g.
  `content` / `surface`. The mapping is a build-script table, not an
  agent's judgement.
- **Token names are public API.** Values may change; names may not.

## 6. What Figma routinely gets wrong (recognize, don't "fix")

Patterns seen across both Valiify files. Reproduce faithfully, pin in the
spec, list for the designer:

- **`Primary/Focus` is the literal name of the PRESSED fill** — wire to
  `:active`, never `:focus-visible`.
- **Error states bind the Warning (amber) ramp** while a full Error ramp
  sits unused. An authoring slip; ship verbatim until rebound.
- **Hover and pressed byte-identical** (0-diff) on a variant pair — one
  rule, designer list.
- **Sample-hug widths** (239, 214, 509) are not specs — width is the
  caller's; heights are frame authority and get pinned.
- **Height math that doesn't close** (13+13+20 = 46 in a 48 frame) —
  resolve by pinning the frame height, not by inventing padding.
- **State axes that are unwired** — all variants bind identical variables
  and render identical pixels. Ship no state styling; top designer-list
  item.
- **Structurally different drawings of the same visual** (stroke on the
  frame vs a child ellipse) — visually identical; report, don't normalize.
- **Broken absolute geometry on secondary content** (a hint block at
  −313%) — ship in normal flow as a labelled correction.
- **Missing state combinations** (no checked+hover drawn) — exclude them by
  name in CSS (`:not(:checked)`) rather than layering invented styling.

## 7. Designer list

Every extraction ends with the items the designer must see: missing
variants, misnamed layers, unbound raw values, unwired axes, ramp
misbindings, geometry that doesn't close. Write them as findings with the
node id and the evidence (which lane, which measurement). The library keeps
a consolidated list; the extraction's job is to feed it, never to resolve
design questions by implementation.
