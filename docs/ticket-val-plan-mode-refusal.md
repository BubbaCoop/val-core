# Ticket: `/val` has no plan-mode refusal — gates can appear to pass with nothing on disk

**Status:** open · **Raised:** 2026-09-17 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Order:** 1 — **most urgent of the batch; do this first**
**Severity:** high · **Effort:** template text only, no tool change, no schema change
**Blocks nothing. Depends on nothing.** This is independent of the convergence work.

## What is missing

`templates/commands/design.template.md:74-82` refuses to start under plan mode:

> **Refuse to run in plan mode.** Every gate of this pipeline writes files — the brief, the
> concept, the package. Under plan mode those writes are blocked, and the stages degrade quietly
> into drafting prose into a plan file: gates appear to pass, nothing lands on disk, and the
> failure only surfaces when a later stage cannot read what the earlier one "wrote".

`templates/commands/val.template.md` has no equivalent. Gate 0 checks that the run directory
can be described, that the agents are registered and that the registry is fresh. It never checks
that it is allowed to write.

## Why this is more urgent for `/val` than it was for `/design`

**`/design`'s template documents this as a failure that has already happened.** It is written in
the past tense, as a lesson. `/val` never received the lesson, and `/val` writes strictly more
than `/design` does:

| | `/design` | `/val` |
|---|---|---|
| directories created at Gate 0 | `00-input/`, `02-concept/` | `00-input/` … `06-accuracy/` — seven |
| manifest | written once, appended per gate | written once, appended per gate, **re-read end to end at Gate 7** |
| files written by model turns | brief, concept, critique, package | extraction, component map, requirements, page, styles, regions, self-check, QA spec, QA report |
| files written by **tools** | `class-audit.json`, `handoff-check.json` | `geometry-<state>.json`, `build@2x.png`, `diff-report.json`, `overlay.png`, `console.log`, `capture.json`, `regression-check.json`, crops |
| destructive filesystem ops | none | the rework loop **moves** the previous accuracy capture into `run-<n>/` before re-running |

The tool row is the one that makes this worse than `/design`'s case. `/design`'s gates are
verified by reading files a model wrote; a blocked write there produces an empty directory and
an obvious downstream read failure. `/val`'s gates are verified by **tool output that the tool
must first write to disk**:

- Gate 4 requires `04-build/geometry-<state>.json` to report PASS *per frame*
- Gate 6 requires `06-accuracy/diff-report.json`, `overlay.png` and a capture per frame
- the rework loop requires `regression-check.json` before any QA dispatch

Under plan mode `node .../screenshot.mjs`, `node .../geometry-check.mjs` and
`node .../grid-diff.mjs` are all blocked as non-readonly. The stage cannot produce the artefact
the orchestrator is specified to check, and the only remaining way for it to report is
narratively — which is exactly the "gates appear to pass" failure, arriving through a path
`/design` does not have.

The rework loop is the sharpest case. Step 4 archives the previous capture by moving it, then
re-invokes the builder. A blocked move followed by an unblocked-looking re-run would compare a
new build against a baseline that was never archived — and `--baseline` carries classifications
forward by tile, so the report would look complete and be wrong.

**Plan mode is a live condition in this environment, not a hypothetical.** The audit that
produced this ticket began in it.

## Fix

Add a Gate 0 step to `templates/commands/val.template.md`, mirroring
`design.template.md:74-82`. Same shape, `/val`'s specifics:

- name what is blocked — the seven run directories, the manifest, every stage output, and
  **every shipped tool**, since the tools write their own reports
- state the failure mode plainly: gates appear to pass, nothing lands on disk, and the failure
  surfaces at the next stage's read — or, worse, at Gate 6, where a missing archive silently
  changes what the comparison means
- STOP at the gate. Do not begin the run. Do not write a plan describing the run that would
  have happened.

Word it as `/design`'s is worded — the value of that text is that it explains *why* rather than
just refusing, so an orchestrator that hits it can tell the requester something useful.

## Where it goes

`/val`'s Gate 0 is steps 1–5. This belongs **before step 1**, not appended as step 6: `/design`
puts its equivalent at the end of Gate 0 because its steps 1–4 are cheap reads, but `/val`'s
step 1 is *"Create `{{RUN_OUTPUT_DIR}}/<yyyy-mm-dd>-<slug>/` with `00-input/` … `06-accuracy/`"*
— a write, and the first thing the gate does. A refusal that runs after it has already failed
to create seven directories is checking the wrong thing at the wrong time.

Renumber 1–5 to 2–6.

## Definition of done

`/val` invoked under plan mode stops at Gate 0, says why, and creates nothing — no run
directory, no manifest, no plan file describing the run.

## Note for the run in flight

A `/val` run executing right now is not affected by this ticket either way: if it is writing
files, it is not in plan mode, and this changes nothing about it. The guard prevents the next
one from starting in a state where it cannot.
