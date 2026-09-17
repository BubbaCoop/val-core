# Ticket: pin `model: inherit` on the `val-*` agents and record the model per gate

**Status:** open · **Raised:** 2026-09-17 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 3
**Decision:** made — match `/design`. This ticket implements it; it does not re-open it.

## What is missing

| | `design-*` | `val-*` |
|---|---|---|
| `model: inherit` in agent frontmatter | all 5 | **0 of 6** |
| model recorded in the manifest | top level **and** on every gate record | not at all |

`/design` records it twice on purpose (`templates/commands/design.template.md:51-54`):

> Record the model you are running under as `"model"` — every stage inherits it. Record it
> **again on every gate record** as `"model"`, read at the time that gate returns rather than
> copied from the top. A single top-level field states an intention; a per-gate field is the
> only thing that proves no stage silently ran on another model, which has already happened
> once. A gate whose model differs from the run's is a finding, not a detail: say so in the
> writeup.

`/val` does neither. Its manifest gate record is
`{ "gate", "agent", "status", "at", "notes" }` — no model. The only occurrence of the word
"model" in `val.template.md` is "costs no model tokens", in an unrelated sentence.

## Why this is not left to omission

Two reasons, and the second is the one that bites this week.

**1. The same reason `/design` already carries.** A stage silently running on another model has
happened once in this codebase. `model: inherit` in frontmatter is what makes a stage follow the
session; the per-gate field is what makes a divergence *visible* rather than merely unlikely.
An intention stated once at the top of a manifest is not evidence about what any particular gate
did.

**2. An unrecorded model invalidates cost comparison between runs.** The efficiency work is
measured in tokens — the templates are full of it: a build pass that went 233k → 59k → 17k, a
QA run at 152k against re-runs at 73k and 41k, a rework cycle at ~500k, a run whose 140k context
was re-cached across 97 turns for 13.4M cache-read tokens. Those numbers are the justification
for every budget line in every `val-*` agent. **A token count whose model is unrecorded is not
comparable to another token count.** Comparing two `/val` runs, or a `/val` run against a
`/design` run, requires knowing what each gate ran on, and right now the `/val` side cannot
answer.

## The change

**Templates — frontmatter.** Add `model: inherit` to all six:
`val-figma`, `val-components`, `val-context`, `val-build`, `val-qa`, `val-accuracy`.

**Template — `val.template.md` Gate 0 step 3.** Add `"model"` to the manifest object written at
setup, with `/design`'s framing: every stage inherits it.

**Template — `val.template.md`, "At each gate".** The append becomes:

```
{ "gate", "agent", "status": "pass"|"rework", "at": ISO, "model": "<the model that gate ran on>", "notes" }
```

read at the time the gate returns, not copied from the top.

**Template — Gate 7.** Gate 7 step 1 already re-reads the manifest end to end for unresolved
warns and QA ordering. Add the model check to that list, and to step 3's writeup: a gate whose
model differs from the run's is a finding, stated in `07-writeup.md` — same wording as
`/design`'s.

## Scope note: `extract-*`

The four `extract-*` agents have no `model: inherit` either. **Out of scope here** — the
decision taken was for `val-*`, `/extract` has no manifest and no gate records to carry the
field, and widening this ticket would turn a mechanical change into a design question about what
`/extract` should record at all. Worth its own ticket if the same reasoning is wanted there.

## Versioning — argue minor, but the call is the maintainer's

README's rule lists **manifest shape** explicitly under *major*. This change is additive:

- `tools/lib/manifest.mjs` reads `manifest.input.*` only — `loadRun`, `resolveFrames`,
  `selectFrame`, `referenceFor`, `exportScale`. **Nothing in any shipped tool reads
  `manifest.gates`.** A new key on a gate record cannot break a tool.
- An older manifest without the field stays readable; a newer one stays readable by an older
  tool.
- The frontmatter addition changes which model a stage runs on only where the session model
  differs from the default, which is the intended behaviour, not a contract break.

So: **minor**, on the reading that "manifest shape" means a change existing readers must handle.
Flagging it because the rule names the word and this is the first additive-only manifest change
since it was written — if the intent was stricter, this is a major and should say so.

## Tests

`tools/agent-templates.test.mjs` is the right home — it already asserts properties across the
generated agent set. Add:

- every `val-*` template declares `model: inherit`, asserted per file so a failure names which
  one, not "some agent is missing it"
- the assertion is written over the template set, not a hardcoded list of six, so a seventh
  `val-*` agent added later is covered on arrival rather than silently exempt

The manifest field is orchestrator prose and not mechanically testable here; it is checked by
Gate 7 reading its own manifest.

## Definition of done

A `/val` run's `manifest.json` names the model at the top and on every gate record, and Gate 7
reports a mismatch as a finding in the writeup rather than leaving it in the file for someone to
notice.
