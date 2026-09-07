---
name: component-mapping
description: >
  How Val maps Figma component instances on a page to a component library —
  the registry schema, the confidence ladder, alias handling, deviation
  recording, and the regeneration merge contract. Library-independent; each
  library's registry lives at its configured componentRegistry path.
---

# Component mapping

Val builds pages **from the library, not from pixels**. Every Figma
instance is matched to a registry entry; the library component's markup,
CSS and behaviour are canonical and the Figma instance supplies only
props, content and variant. The mapping stage is where that contract is
decided — an unstated deviation here becomes a wrong build later.

## 1. The registry

`generate-registry.mjs` walks the library's Storybook stories and writes
one entry per component:

```json
"Button": {
  "path": "src/components/button.css",
  "story": "components-button--primary",
  "figmaNodeIds": ["1:218"],
  "figmaNames": ["Button / Standard"],
  "variants": { "type": ["primary", "secondary", "micro", "bubble"] },
  "behaviors": ["Hover darkens the fill; pressed binds Primary/Focus"],
  "props": ["type", "label", "disabled"],
  "tokens": []
}
```

- **Generated, refreshed every run**: `path`, `story`, `variants` (from
  argTypes `options`), `props` (argTypes + args keys).
- **Hand-maintained, merged by union, never overwritten**: `figmaNodeIds`,
  `figmaNames`, `behaviors`, `tokens`. Enrich the registry by hand
  freely — regeneration keeps it.
- **Code Connect** (`*.figma.ts`) files, when present, seed `figmaNodeIds`.
  Without them, name-matching happens at run time.
- **Staleness**: regenerate when the registry is missing or older than the
  newest story file. A mapping run against a stale registry silently
  misses new components; the orchestrator checks this at Gate 0.

## 2. Reading the extraction efficiently

`structure.md` and the registry are read **in full**. `figma.json` is a
lookup table — Grep the specific node ids needed to settle a match. It is
large and mostly irrelevant to mapping; one run spent most of ~168k tokens
reading it end to end.

## 3. The confidence ladder

Every instance gets exactly one rating; the rating decides how much the
build may trust the match.

| confidence | evidence | notes must contain |
| --- | --- | --- |
| **exact** | `figmaComponentKey` appears in an entry's `figmaNodeIds` | — |
| **name-match** | Figma component name equals a registry key OR appears in its `figmaNames` aliases (case/space-normalized) | the normalization applied |
| **visual-guess** | structure and styling clearly match an entry but neither key nor name links them | the justification |
| **none** | no plausible library component | what it is; whether it is a future library candidate |

**Aliases belong in the registry, not in the agent.** Figma set names
routinely differ from registry keys ("Button / Standard" → Button, "Box
action" → BoxAction, "Application Status" → StatusTracker, "Card" →
SelectCard). Record each discovered alias in `figmaNames` so the next run
gets an exact/name match for free; don't carry the list in prose.

## 4. Variant and prop mapping

`variantMapping` translates Figma variant properties to library API
(`"state=collapsed"` → `"defaultOpen: false"`); `propOverrides` carries
instance content (`"title": "OWNERSHIP"`). Check both against the entry's
`variants`/`props` — a Figma variant with no library counterpart is a
deviation to record, not a value to invent.

## 5. Deviations — the details the build gets wrong when unstated

Record **every** difference between an instance and its component's
canonical form: overridden padding, swapped icon, detached styles, a
hidden slot toggled on, a width that isn't the sample hug. The build
applies deviations only where the map's notes call them out; anything
unrecorded is built canonically, and a mismatch there surfaces as a
"genuine defect" at the accuracy gate — an avoidable rework cycle.

## 6. Gaps

Finish the map with a top-level `gaps` array of every `none` and
`visual-guess`. The build renders gaps as one-off markup in the design
language, marked `<!-- val:gap -->`, **provided the design shows what to
build**. A gap is markup you can see; content you would have to invent is
a *question* for the requester, never a gap.

## 7. Definition of done

Every instance in `structure.md` appears in the map; no entry lacks a
confidence rating; every `none`/`visual-guess` has a note; the `gaps`
array is present (possibly empty).
