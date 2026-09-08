---
name: visual-verification
description: >
  How to measure rendered output against a Figma design without fooling
  yourself — Chrome's rendering traps (hairlines, fractional borders, Auto
  line-height), pixel measurement by coverage rather than threshold, the
  grid-diff tile classes, and the artifact-vs-defect classification that
  decides whether a Val accuracy gate passes. Library-independent.
---

# Visual verification

Two lenses, neither replaces the other: **computed-style assertions**
(does the element have the token, size and state the spec pins?) and
**pixel comparison** (does the render match the export?). Static source
checks are a third lens — they see a hardcoded hex the render can't; the
render sees a 1px height error the source can't.

## 1. Chrome rendering traps — the causes of almost every geometry miss

- **A 0.5px border renders as a full 1px**, at 1x and 2x DPI, and the
  extra pixel is really in the layout box. A hairline adds **2px** to a
  bordered element's height. Consequences:
  - Never size a bordered component with `min-height` — pin `height` from
    the Figma frame.
  - Bottom-only hairlines on rows ship as an **inset `box-shadow`**
    (`0 -0.5px 0 0 inset`) with the height pinned (e.g. `h-[92.5px]`), not a
    border.
- **Fractional `border-width` is floored** (`1.5px` → `1px`). Fractional
  rings ship as inset `box-shadow`, which paints the authored width exactly
  and matches Figma's inside-stroke alignment with no layout impact.
- **Inside strokes on content-driven heights** — a real border adds to the
  drawn height (308 renders 310). Inset shadow again.
- **`text-decoration-thickness: 0.5px` renders 1px.** Fractional underlines
  need a background-gradient band.
- **Side-specific hairlines need the side-specific length utility.**
  `border-t border-[length:…]` sets all four sides.
- **Figma "Auto" line-height makes the line box font-dependent.** Never
  derive a component height from it — pin the height measured from the
  variant frame.
- **Weight steps reflow hug widths** (~1px at 400→500). Figma's own; pin
  and list.
- **`overflow: clip` eats a box's own `box-shadow`** — pair it with
  `filter: drop-shadow()` and never "fix" one without the other.
- **Tailwind v4 dropped implicit-var shorthand** (`rounded-[--token]`).
  Write `var()` explicitly; the invalid CSS is discarded without a warning.
  Check the compiled bundle when a style mysteriously doesn't apply.

## 2. Measuring pixels — coverage, not threshold

A binary "is this pixel dark?" test rounds a 1.5px stroke to 2 and a
15.6px knob to 16. Measure by **coverage**: project each pixel's colour
onto the vector between the two known flat colours (background A,
mark B) to get 0–1 coverage, then sum along a scanline.

```js
const { PNG } = require("pngjs");
const png = PNG.sync.read(require("fs").readFileSync(file));
const px = (x, y) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i+1], png.data[i+2]]; };
const t = (p, A, B) => { let n = 0, d = 0; for (let c = 0; c < 3; c++) { n += (p[c]-A[c])*(B[c]-A[c]); d += (B[c]-A[c])**2; } return Math.min(1, Math.max(0, n / d)); };
// stroke width across a scanline y from x0..x1: Σ t(px(x,y), A, B) — divide by the render scale
// average across ≥40 scanlines; report "1.51px at 2.4x → authored 1.5"
```

Rules:

- Sample colours from **interior pixels** away from antialiased edges.
- Report the **achieved render scale** with every number; Figma never
  upscales, so small nodes are at 1x and the coverage sum *is* the width.
- **State-pair byte diffs** are the highest-value measurement: a confirmed
  0-diff between "hover" and "pressed" is a design defect caught for free.
- **Rendered casing** (uppercase vs typed) is a pixel fact — it settles
  whether a type style carries a transform.

## 3. Computed-style assertions (Storybook harness)

- Compare colours with `{ token: '--color-x' }`, never a literal — the
  theme emits `oklch()`, so a hardcoded `rgb()` fails even when correct.
- Default tolerance is exact. Widen only where the delta is understood and
  written next to the check.
- **Let transitions settle before reading colour** (~400ms after `Tab` —
  `transition-colors` covers `outline-color`, so an immediate read is an
  in-flight blend).
- **Do not check accessible names with `textContent`** — it reads through
  `display:none`. Use axe or `ariaSnapshot()`.
- Assert what a state does **NOT** change (Checkbox's ring stays constant;
  the label ink never fades) — those are the regressions a hand edit
  introduces.
- **Probe lessons from Val QA runs** (10 of 11 first-run failures in one
  run were probes, not the build):
  - Park the mouse in empty margin before reading a *rest* style — the
    pointer left over the last clicked element keeps `:hover` applied.
  - A focus ring may be an `outline` **or** a `box-shadow`; accept either,
    then assert the computed-style delta on every Tab stop.
  - Never `page.fill()` before a Tab pass — it moves Chromium's
    sequential-focus start point. Drive state through the page's own API
    (`window.valPage.applyState`) on a fresh page, then Tab from `body`.
  - From `body`, Shift+Tab lands on the **last** focusable element.
  - Measure page growth on the content/footer boxes, not
    `document.scrollHeight` — a `min-height: 100vh` body hides it.

## 4. Page-level accuracy: the grid diff

`grid-diff.mjs` compares the design export and the build screenshot in
fixed **64 CSS-px tiles** (× export scale in device px), pixelmatch at
threshold 0.1 with antialiasing ignored:

| class | mismatch |
| --- | --- |
| pass | < 2% |
| warn | 2–8% |
| fail | > 8% |
| empty | ≥ 99.5% white in BOTH images — excluded from scoring |

Dimension policy: **never scale or stretch.** Equal widths with ≤2% height
delta pad the shorter image with white; anything else is a normalization
failure reported with both dimension pairs. A width mismatch is a build
geometry bug, not a diff problem.

`screenshot.mjs` renders at the manifest's frame width and achieved export
scale, waits for `document.fonts.ready` plus one settle frame, and records
console errors — a page with console errors is not measurable.

## 5. Classifying non-pass tiles — the measurement that gates

The raw tile pass-percentage is **advisory**. At 1x density Chromium and
Figma rasterize text differently enough that most text tiles land in warn
regardless of build quality; a percentage threshold sends reworks chasing
artifacts (one run burned ~400k tokens that way). Every warn/fail tile is
classified into exactly one class, and **PASS requires zero class (c)**:

- **(a) accepted-deviation** — covered by a deviation the requirements or
  the orchestrator's brief explicitly accepts. Cite it.
- **(b) rasterization-artifact** — proven engine difference: whole-run
  horizontal glyph shifts with byte-matching colours and ±1–2px aligned
  geometry. Verify before classifying (sample colours; check run
  alignment). This class is for *proven* differences, never unexplained
  ones.
- **(c) genuine-defect** — real geometry, colour, glyph or content
  difference. Anything not proven into (a) or (b) is (c) — including
  inside matched library components, where a defect always means rework.

Group adjacent tiles belonging to one element into one finding with a
named region, component, Figma node, plain-language description and a
suspected cause (`token | layout | component-variant | content | font`).
`classify-tiles.mjs` does the mapping and grouping and attaches the numeric
evidence (colour-set match, ink boxes, best horizontal shift and residual)
with a *candidate* label per finding; the agent confirms each into (a)/(b)/(c)
and views only the crops of `needs-review` findings.

## 6. Build-time geometry self-check (catch it before the gate)

Before a build is handed to QA, render it headless at the frame's
dimensions and assert: (a) rendered page size equals the frame, no scroll
at load unless required; (b) every region in the extraction's
`layout.json` lands within ±2px of its x/y/w/h. Record measured-vs-expected
and write the figmaNode → selector map to `04-build/regions.json` so the
accuracy and regression checks reuse it. `geometry-check.mjs <run-dir>
--all` is that check as one command (it also drives states through
`window.valPage.applyState`); never rebuild it probe by probe. The classic
drift sources are the hairline trap accumulating at every bordered
boundary and content-sized containers where the frame is fixed. Shipping
unverified geometry cost one run its largest rework cycle (~500k tokens).

## 7. Rework economics

Batch cosmetic QA failures with the accuracy findings into **one** fix
list, one rework, one re-verification. Dispatch an immediate rework only
for failures that would corrupt the measurement (broken layout, console
errors, wrong page dimensions). QA always re-runs after any build change —
visual fixes are the classic way behaviours break.

After a rework, **byte-diff the previous and new build captures before
dispatching QA** (`regression-check.mjs --before … --after … --reference …
--fixlist …`): changed pixels must lie inside the fix-list regions, and no
fix region's mismatch against the reference may have grown. That check
costs no model tokens and is the most conclusive evidence of what a rework
touched; in one run it was the *last* thing measured, after a 73k-token QA
re-run had already passed a build with a regressed icon. Fix lists name a
`selectorScope` (the label span, not the button) and the `siblings` that
must measure unchanged.

## 8. Token discipline — what actually costs

A 1.36M-token run was audited turn by turn. Weighted at relative prices it
came to ~12.5M input-equivalent tokens, two-thirds of them cache **writes**:
each agent's growing context re-cached on every turn. Two multipliers
explain almost all of it, and neither is "a big file was read once":

- **Images in context.** The Read tool renders a PNG into the model's
  context, where it stays for every later turn. Three agents viewed the two
  3840-px references (~600k characters each time); one viewed 19 crops. The
  1x section crops the extraction had produced were never used. Rule: view
  an image only when a numeric measurement cannot settle the question, and
  then only a native-scale crop of the region in question.
- **Turns × context.** The build agent ran 97 turns at ~140k context (13.4M
  cache-read tokens) assembling its self-check probe by probe; accuracy ran
  90 turns writing a grid-diff replica. Rule: after reading inputs, the
  first artefact is the script; run it once; print ≤40 lines and write the
  rest to files. Budgets are stated per agent and are real — "could not
  verify X within budget" is a valid report; a silent skip is not.

The cheapest measurements in that run were also the most conclusive: a
byte-diff of two captures (62 px changed — exactly the icon's box) and a
`getComputedStyle` read. Reach for those first.
