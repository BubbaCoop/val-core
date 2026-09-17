# Ticket: mark `~/Desktop/shortapp svelte test` as stale — do not update it

**Status:** open · **Raised:** 2026-09-17 · **Repo:** target is `~/Desktop/shortapp svelte test`;
filed here because val-core is where the render-shell decision lives
**Affected version:** n/a (consumer app) · **Order:** 5
**Severity:** low, but it is a trap that gets more attractive as ticket 2 gets discussed

## What it is

`~/Desktop/shortapp svelte test` is a SvelteKit app whose `src/app.css` carries the §11 load
path exactly as the methodology mandates:

```css
@import "@valiify/shortapp-ui/fonts";
@import "tailwindcss";
@import "@valiify/shortapp-ui/source";
```

with the comment "Never import the library from JavaScript — it fails silently," and a shell
that keeps page CSS out. **It is the only app on disk with the correct load path.**

## Why it is a trap

Its `package.json` pins:

- `@valiify/shortapp-ui: ^0.1.2` — against a shipped **1.3.0**
- `@valiify/val-core: ^0.2.0` — against **0.6.1**

`^0.1.2` does not admit 1.x, so the installed library is pre-1.0. That range spans the entire
`va-` rename: the app's components are written against the **unprefixed** vocabulary, and
everything checked in it is checked against a library that predates the class identity both
repos now declare `strict`.

The trap is the combination. Because it is the only host with the right load path, it is the
natural thing to reach for the moment anyone wants to *see* a page render — which is precisely
the conversation ticket 2 (Gate 5.5) opens. Someone will boot it, get a plausible-looking page,
and draw a conclusion about a library it is not running.

The alternative host is no better in a different way: `shortapp-ui/examples/sveltekit-starter`
is current, but imports `reset.css` + the prebuilt bundle rather than the §11 path, because it
exists to test cascade specificity. Neither is a render target.

## Fix — mark it, do not update it

**Add a README line to the app** saying what it pins and what that predates. Something with the
three facts in it:

> Pins `@valiify/shortapp-ui@^0.1.2` against a shipped 1.3.0 — a range that predates the `va-`
> class rename, so its components use the unprefixed vocabulary. Nothing measured here is
> current. This is not a render target; see val-core's Gate 5.5 render shell.

**Do not upgrade it.** Upgrading is worse than leaving it stale:

- It would need every component rewritten for the `va-` vocabulary, which is real work whose
  only product is a test app nobody has a current use for.
- Once current, it *invites* being trusted as a render target — and it is a hand-maintained app
  that will drift again, silently, the next time the library ships. A stale app that says it is
  stale is safe; a fresh app that will silently go stale is the same trap with a longer fuse.
- The real answer is ticket 2's **generated** shell, which cannot drift because it is produced
  per run from the library's own declared entry. Putting effort into the hand-maintained app
  competes with the thing that makes it unnecessary.

A README line is honest, costs nothing, and does not create an obligation to maintain.

## Cross-reference

Add a line to `ticket-design-gate-5-5-render-and-measure.md`'s host survey noting that the app
is marked stale, so whoever picks that ticket up does not re-evaluate it as a candidate. The
survey already says it is unusable; this records that the decision was deliberate rather than an
oversight waiting to be corrected.

## Not in scope

Whether the app should exist at all. It documents the §11 load path in a working form, which has
value even frozen. Deleting it is a separate call.
