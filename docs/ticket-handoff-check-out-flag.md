# Ticket: `handoff-check --out json` writes a file literally named `json`

**Status:** open · **Raised:** 2026-09-16 (in the shortapp repo) · **Refiled here:** 2026-09-17
**Repo:** `@valiify/val-core` (this repo) · **Affected version:** 0.6.1 · **Order:** 4
**Severity:** low impact, high confusion — it drops an untracked file at whatever directory you
ran from, which is easy to commit by accident (and was).

> **Moved.** This was originally filed as
> `docs/ticket-valcore-handoff-check-out-flag.md` in the `valiify shortapp library` repo, where
> it was found. It is a val-core defect and nobody could act on it there. This copy supersedes
> that one; delete the shortapp copy.

## What happened

Run from the library repo root:

```
node val/tools/design/handoff-check.mjs <run-dir> --out json
```

wrote its report to `./json` — a file with no extension at the repo root. It was committed by
accident in `23d4980` and removed in `5d6ce85`.

## Why — the tool contradicts its own usage string

`--out` is a **path**. `tools/lib/report.mjs`:

```js
if (out) return { path: resolve(out) };
```

so `--out json` resolves to `<cwd>/json`.

But `handoff-check.mjs` documents it as a literal value, in two places — the header comment
(line 9) and the `fail()` usage string (line 42):

```
node <tools-dir>/design/handoff-check.mjs <run-dir> [--package 05-package] [--out json]
```

No angle brackets. That reads as "pass `--out json` to get JSON", which is what the invocation
did. **The tool invited the mistake and then followed its own implementation instead of its own
documentation.**

## The three design tools disagree — and it is a three-way split, not two-against-one

Re-checked against 0.6.1. The original ticket described this as two consistent tools and one
inconsistent one; it is actually three distinct behaviours:

| tool | documents | writes a report | `--out json` does |
|---|---|---|---|
| `class-audit.mjs` (`:34`, `:63`) | `[--out <json>]` — angle brackets | always | writes to `./json` — **consistent with its own docs**, which mark it a placeholder |
| `feedback-check.mjs` (`:11`, `:52`) | `[--out json]` — literal | **only when `--out` is given** | resolves to the default path — **consistent with its own docs**, via the special case at `:284` |
| `handoff-check.mjs` (`:9`, `:42`) | `[--out json]` — literal | always | writes to `./json` — **contradicts its own docs** |

That is why the same `--out json` argument produced `feedback-check.json` in the run directory
(correct) and `./json` at the repo root (wrong) in the same session.

Note the second column too: `feedback-check` writes a report only when asked, the other two
always write one. That difference is undocumented in all three and is worth settling in the same
pass.

## Fix — pick one

1. **Make `handoff-check` match `feedback-check`** — add the `opts.out === "json" ? undefined`
   special case. Smallest diff, keeps both documented spellings working.
2. **Make the docs match the code** — change `handoff-check`'s two usage strings to
   `[--out <path>]`, as `class-audit` already does. Honest, but leaves the three tools spelled
   differently for the same flag.
3. **Do both, and unify** — `--out <path>` everywhere in the docs, plus the `json` special case
   everywhere in the code, so the flag behaves identically across all three tools regardless of
   which spelling a caller reaches for.

**(3) is the recommendation, and it has a working reference implementation.**
`tools/design/feedback-check.mjs:282-290` is exactly the shape to lift:

```js
if (opts.out) {
  const dest = resolveReport({
    out: opts.out === "json" ? undefined : opts.out,
    noWrite: opts["no-write"],
    defaultPath: join(runPath, "feedback-check.json"),
  });
```

So (3) is not a design exercise — it is applying one existing eight-line pattern to two other
call sites (`handoff-check.mjs:503`, `class-audit.mjs:650`) and correcting four usage strings.
Better still, lift the special case *into* `resolveReport` so all three tools get it from one
place and a fourth tool cannot reintroduce the split.

The failure here was not that someone typed the wrong thing; it was that three sibling tools,
invoked the same way in the same session, did three different things.

**The guard worth adding either way:** refuse an `--out` value with no extension and no
directory separator. That is almost always a format word being taken as a filename.
`resolveReport` is the one place to put it.

## Consistency with `resolveReport`'s own reasoning

`resolveReport`'s docblock is careful about *not* writing into a tree you are only inspecting.
The same care says: a report path that resolves to a bare filename in the current working
directory is a likely mistake, because the deliberate case names a directory.

## Tests

`tools/lib/report.test.mjs` is the home if the special case lands in `resolveReport`. Per the
distinguishable-failure rule, assert the refusal names the offending value and says what was
expected, rather than asserting a non-zero exit:

- `--out json` → the default path, for all three tools
- `--out reports/x.json` → that path, unchanged
- `--out report` (no extension, no separator) → refused, message quoting `report`
- `--no-write` → still wins over everything

## Already handled on the library side

The shortapp orchestrator's invocation now omits `--out` entirely. `handoff-check`'s default is
`join(runPath, "handoff-check.json")` — the run directory, which is where the report belongs. No
flag is needed for the normal case. That is a workaround, not the fix; the flag is still wrong
for anyone who reaches for it.
