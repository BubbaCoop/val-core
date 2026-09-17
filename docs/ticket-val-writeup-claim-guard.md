# Ticket: the unmeasured-claim guard does not cover `/val`'s `07-writeup.md`

**Status:** open · **Raised:** 2026-09-16 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 1 of 3 (pipeline convergence) — do this one first
**Severity:** low effort, real exposure — the guard already exists and is pointed at one pipeline only

## What is missing

0.6.1 added a phrase-class guard to `tools/design/handoff-check.mjs` after a generated
`HANDOFF.md` told a dev team the prebuilt bundle "renders identically" to `/source`. The guard
covers `HANDOFF.md` and package `.svelte` / `.js` / `.ts` comments.

`/val` produces a prose deliverable too — `07-writeup.md`, written freehand by the orchestrator
at Gate 7 (`templates/commands/val.template.md:167`) — plus `04-build/self-check.md`, written
freehand by `val-build`. **Neither is scanned by anything.**

## Why it applies here, despite the pipelines being different

The 0.6.1 rationale was that a generated deliverable asserting a rendering outcome nobody
measured is a pipeline defect, not a wording slip. That reasoning is about the *deliverable*,
not about `/design`. `/val` ships a deliverable of the same kind to the same audience.

The risk profile is different in a way worth stating honestly rather than overselling:

- **Lower base rate.** `07-writeup.md` is specified to report measurements — final accuracy %,
  QA summary, behaviours verified, deliberate deviations. `/val` is already in the business of
  citing numbers, so it is *less* likely than `/design` was to invent a rendering claim from
  nothing.
- **Higher cost when it happens.** An unmeasured claim sitting beside three measured numbers
  reads as a fourth measured number. The writeup's own credibility is what makes the bad
  sentence dangerous.

There is also a specific opening. Gate 7 step 3 asks for "deliberate deviations and why" and
"anything needing human review". A deviation explained as *"this renders the same as the
Figma anyway"* is exactly the phrase class, in exactly the section that invites it.

## What exists to reuse

`tools/design/handoff-check.mjs:372-375` — the whole mechanism is three small pieces:

```js
const CLAIMS = [/renders?\s+identical/i, /pixel[- ]identical/i,
                /identical(ly)?\s+(render|look|appear)/i,
                /looks?\s+the\s+same\s+(with|without)\b/i, /no\s+visual\s+difference/i];
const claimLines = (text) => …   // skips negations and lines citing measured|verified
const CLAIM_FIX  = "…"
```

The escapes matter and should carry over unchanged: a negation is the correction, and a line
citing `measured` / `verified` is the evidence. In `/val` the second escape is the *normal*
case, not a loophole — an accuracy-gate finding genuinely is measured, and the writeup should
say so in those words.

## Fix

Lift `CLAIMS` / `claimLines` / `CLAIM_FIX` out of `handoff-check.mjs` into a shared module —
`tools/lib/claim-check.mjs` is the obvious home, beside `report.mjs` and `stylesheet-path.mjs`,
both of which were split out of a tool for the same reason (testability without the tool's
dependencies). `handoff-check` imports it; nothing about its behaviour changes.

Then point it at `/val`. Two candidate call sites, and the choice is a real one:

1. **A new tiny tool** (`tools/writeup-check.mjs <run-dir>`) the orchestrator runs at Gate 7
   before signing off. Consistent with how every other `/val` gate works — a script the
   orchestrator runs that costs no model tokens — and it can also check the things Gate 7 step 1
   already asks the orchestrator to verify by hand (final accuracy recorded, `qaPass` set, QA
   ran after the last build change).
2. **Fold it into an existing tool.** There is no natural host: `geometry-check`, `grid-diff`
   and `regression-check` all run before the writeup exists.

**(1) is the recommendation**, and the extra Gate 7 manifest assertions are the reason — the
claim guard alone would not justify a new file, but Gate 7 currently has no mechanical check at
all, and it is the gate that signs the run off.

Scope note: scan `07-writeup.md` and `04-build/self-check.md`. Do **not** scan
`06-accuracy/diff-report.json` findings — those descriptions are written *from* measurements and
the word "identical" in one is a legitimate finding description.

## Tests

Mirror `tools/design/handoff-check.test.mjs`'s coverage of the phrase class, and add the one
case that is `/val`-specific and is the whole point of the escape: a writeup line that cites the
accuracy measurement and uses the word "identical" must **pass**, and the same sentence with the
citation removed must **fail**. Per the distinguishable-failure rule, assert the refusal text
names the file and quotes the offending line, rather than asserting exit 1.

## Not in scope

The writeup's *content* requirements (divergence ledger, open questions carried through) stay
the orchestrator's judgement. This ticket adds one mechanical check, not a writeup schema.
