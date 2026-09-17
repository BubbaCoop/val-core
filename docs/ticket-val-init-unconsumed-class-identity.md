# Ticket: a declared class identity that no enabled pipeline consumes passes `val-init` and enforces nothing

**Status:** open · **Raised:** 2026-09-16 · **Repo:** `@valiify/val-core` (this repo)
**Affected version:** 0.6.1 · **Found in:** `valiify-dashboard-ui` (on val-core `^0.6.0`)
**Severity:** live — a shipped consumer is in this state right now
**Not part of** the `/val` ↔ `/design` convergence work; fixable on its own.

## What is live today

`valiify-dashboard-ui/val/config.json`:

```json
"library": { "name": "dashboard", "classPrefix": "vd", "classSpelling": "strict", … },
"pipelines": { "val": true, "extract": true }
```

- `pipelines.design` is absent, so `wantDesign` is false (`bin/val-init.mjs:89` —
  `pipelines.design === true`).
- `CLASS_AUDIT_FLAGS` is consumed by **five templates, all `design-*`** — the command template
  and the four design agents. `val-init` skips every one of them when `wantDesign` is false
  (`bin/val-init.mjs:230-239`).
- **Result: `--class-prefix vd --class-strict` is rendered into zero generated files.** The two
  keys are inert. dashboard-ui's `.claude/agents/` contains ten agents, all `val-*` and
  `extract-*`, none of which mentions a class, a prefix, or a spelling.

The repo declares the strictest available gate state and gets no gate.

## Why this is the 0.6.0 failure arriving through the other door

0.6.0 removed `classSpelling`'s default precisely so a weakened gate could never be implicit.
Its own changelog:

> A library that set `classPrefix` and never thought about spelling sat in a permanently
> weakened gate, which is exactly the drift the key's own description warns against, and nothing
> failed to say so: `PREFIX: va (tolerant)` is a label in the headline, and labels do not get
> acted on.

The guard it added, `checkClassIdentity` (`bin/val-init.mjs:352-368`), asserts that the two keys
stand or fall together. dashboard-ui **satisfies it completely** — both keys are set, the value
is a legal enum member, strict is the stronger of the two states — and enforces nothing anyway.

The gap is the guard's scope. It is called at `bin/val-init.mjs:74`, immediately after
`validate()` and **fifteen lines before `wantDesign` is computed**. It checks the pair against
itself. It cannot check the pair against the thing that would consume it, because at that point
nothing has decided what will be generated.

0.6.0's reasoning was that a config must not be able to claim a gate state it does not have.
That reasoning was applied to one of the two ways a config can do that:

| how the claim fails | 0.6.0 | this ticket |
|---|---|---|
| the pair is incomplete, so the flags render wrong or not at all | **caught** | — |
| the pair is complete, but nothing that consumes it is generated | not considered | **uncaught** |

Both end in a `class-audit` invocation that does not exist or does not carry the flags. The
second is worse in one respect: the config reads as maximally strict, so there is nothing in it
to prompt a second look.

## Fix

`checkClassIdentity` needs to run **after** the pipeline flags are resolved, and to know which
placeholders will actually be substituted. Concretely: move the call below the
`wantVal` / `wantExtract` / `wantDesign` block, pass the three flags in, and add a third check —
a declared class identity must be consumed by at least one enabled pipeline.

Today `CLASS_AUDIT_FLAGS` has exactly one consumer set, so the check is "`classPrefix` is set
and `wantDesign` is false". Do not hardcode that. The durable form is to derive it: after the
substitution map is built and the template list is known, assert that every identity-bearing
placeholder appears in at least one template that will be written. That way the check keeps
working when the vocabulary gate reaches `/val` and the answer changes, rather than becoming a
stale special case that has to be remembered and removed.

**Severity of the failure:** this should `fail()`, not warn. A warning is the thing 0.6.0
explicitly rejected — "labels do not get acted on." The message should name both sides, as the
existing two refusals do, and be distinguishable from them:

```
library.classPrefix is set ("vd") but no enabled pipeline consumes it.
  The class-audit flags are rendered only by the design templates, and
  pipelines.design is not true — so --class-prefix vd --class-strict reaches
  no generated file and nothing enforces the identity.
  Either enable pipelines.design, or drop library.classPrefix and
  library.classSpelling until a pipeline that reads them is enabled.
```

## Tests

`tools/val-init.test.mjs` already covers the config→flags path and is the right home. Per the
distinguishable-failure rule, exit 1 is not the assertion — assert that this refusal's text
differs from both existing ones and names the key at fault:

- `classPrefix` + `classSpelling` + `pipelines.design: false` → **fails**, message names
  `classPrefix` *and* `pipelines.design`
- the same config with `pipelines.design: true` → **passes**, and the five design templates
  render `--class-prefix vd --class-strict`
- no `classPrefix`, no `classSpelling`, design off → **passes** unchanged (a library with
  neither key must stay unaffected)
- all three refusal messages asserted mutually distinct, so this one cannot collapse into the
  existing pair

## What dashboard-ui should do meanwhile

Two honest options, and the choice belongs to that repo, not to this one:

1. **Drop both keys** until a pipeline consumes them. The config then states what is true: no
   class identity is enforced there. `class-audit` classification is byte-for-byte unaffected,
   because it never ran.
2. **Enable `pipelines.design`.** dashboard-ui already has `design-methodology/dashboard.md` on
   disk — 496 lines, fully §-formatted, carrying the §10 forbidden line
   (`` `.vd-pill`, `.vd-card` ``) and a §12 planned table, so it is class-audit-ready as written.
   What it lacks is `library.package` and a `design.surfaces` block, both of which `val-init`
   already validates and warns about.

(2) is the better end state and is close. (1) is the correct interim, because a config that
overstates its own enforcement is worse than one that claims nothing. Whichever is chosen,
dashboard-ui is also a version behind (`^0.6.0`) and should pick up 0.6.1.
