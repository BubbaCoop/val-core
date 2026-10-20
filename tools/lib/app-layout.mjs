/**
 * The one app-owned layout stylesheet a design package may carry.
 *
 * class-audit rejects all page CSS by default, and that default is right: the
 * failure this pipeline exists to prevent is invented style. But a component
 * library ships components, not page layout, and its prebuilt utility surface
 * is closed — so some layout needs cannot be met from shipped classes at all.
 * The case that forced this: a step whose web button row and mobile sticky
 * footer are two elements in two DOM positions. Showing one and hiding the
 * other needs display utilities at a breakpoint; a closed surface may not ship
 * them, and the methodology then has to choose between blocking the page and
 * letting the app write a media query.
 *
 * This module is that media query's fence. A library opts in by declaring ONE
 * stylesheet (design.output.appLayoutStylesheet). That file — and only that
 * file — is audited instead of rejected, under four rules:
 *
 *   1. LAYOUT properties take any value: display, visibility, position and its
 *      offsets, flex/grid flow and alignment, grid track sizing.
 *   2. Any OTHER property is visual, and must take its value from library
 *      tokens: at least one var(--token) the theme defines, and nothing else
 *      but lengths, numbers and structural keywords. `inset 0 1px 0
 *      var(--color-stroke-divider)` passes; `#ccc`, `red`, `13px` alone fail.
 *   3. Every selector is anchored on an APP class or id, and names no library
 *      class. The stylesheet arranges the page; it never restyles a component,
 *      and a bare `button {}` would reach every library-rendered button.
 *   4. Breakpoints are @media width conditions only. No other at-rule: no
 *      @import (it would hide a second stylesheet), no @layer (a layered rule
 *      loses to the unlayered bundle and the override silently does nothing),
 *      no @font-face/@keyframes (visual), no custom properties (they would
 *      redefine library tokens), no !important.
 *
 * And one rule about ORDER, because the bundle is unlayered: an app rule and a
 * library utility of equal specificity are decided by source order, so an app
 * stylesheet loaded BEFORE the bundle loses every tie and its hide rule does
 * nothing. Wherever the app stylesheet is loaded — an import, a <link>, an
 * @import, or the load path written in HANDOFF.md — the library bundle must be
 * loaded earlier in that same place. A stylesheet loaded somewhere the bundle
 * is not loaded cannot have its order proven, and fails; so does one that is
 * declared and never loaded at all.
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---- what counts as layout ------------------------------------------------------------

export const LAYOUT_PROPERTIES = new Set([
  // visibility
  "display",
  "visibility",
  // position
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-block",
  "inset-inline",
  "inset-block-start",
  "inset-block-end",
  "inset-inline-start",
  "inset-inline-end",
  // flow
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "order",
  "float",
  "clear",
  "align-items",
  "align-content",
  "align-self",
  "justify-content",
  "justify-items",
  "justify-self",
  "place-items",
  "place-content",
  "place-self",
  // track sizing
  "grid",
  "grid-template",
  "grid-template-columns",
  "grid-template-rows",
  "grid-template-areas",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-auto-flow",
  "grid-area",
  "grid-column",
  "grid-column-start",
  "grid-column-end",
  "grid-row",
  "grid-row-start",
  "grid-row-end",
]);

// Left out on purpose, and why — so the next reader does not "fix" the list:
//   gap / margin / padding / width / height: spacing rhythm and box size come from
//     shipped utilities; there are no spacing tokens to bind them to.
//   z-index: the library carries a z-index scale; an app value would bypass it.
//   overflow, content-visibility: not in the requested set; add deliberately if needed.

/** Words a token-valued visual declaration may carry beside its var()s. */
const VISUAL_KEYWORDS = new Set([
  "inset",
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "auto",
  "currentcolor",
  "transparent",
  "inherit",
  "initial",
  "unset",
]);
const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px|rem|em|%|vh|vw|svh|dvh|lvh|ch|ex)?$/;
const MEDIA_WORDS = new Set(["screen", "all", "only", "and", "not", "or"]);
const WIDTH_FEATURES = new Set(["width", "min-width", "max-width"]);

// ---- a deliberately small CSS reader --------------------------------------------------

/** Blank comments to spaces, keeping newlines, so offsets still map to source lines. */
const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Rules, at-rules and declarations, with source lines. Tolerant: a construct it
 * does not understand becomes an `errors` entry, which the audit reports as a
 * violation — an unreadable rule is not a rule the audit has cleared.
 */
export function parseCss(input) {
  const src = blankComments(input);
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  const out = { rules: [], atRules: [], errors: [] };

  const matchBrace = (open) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i;
    }
    return -1;
  };

  const declarations = (from, to) => {
    const decls = [];
    let start = from;
    for (let i = from; i <= to; i++) {
      if (i < to && src[i] !== ";") continue;
      const raw = src.slice(start, i);
      const text = raw.trim();
      if (text) {
        const at = start + raw.indexOf(text);
        const colon = text.indexOf(":");
        if (colon === -1) {
          out.errors.push({ line: lineAt(at), reason: "unreadable declaration", detail: text });
        } else {
          let value = text.slice(colon + 1).trim();
          const important = /!\s*important\s*$/i.test(value);
          if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
          decls.push({ prop: text.slice(0, colon).trim().toLowerCase(), value, important, line: lineAt(at) });
        }
      }
      start = i + 1;
    }
    return decls;
  };

  const items = (from, to, media) => {
    let i = from;
    while (i < to) {
      while (i < to && /\s/.test(src[i])) i++;
      if (i >= to) break;
      let j = i;
      while (j < to && src[j] !== "{" && src[j] !== ";" && src[j] !== "}") j++;
      const head = src.slice(i, j).trim();
      if (j >= to || src[j] === "}") {
        if (head) out.errors.push({ line: lineAt(i), reason: "unterminated rule", detail: head });
        break;
      }
      if (src[j] === ";") {
        if (head.startsWith("@")) {
          out.atRules.push({ name: (head.match(/^@([\w-]+)/) ?? [, ""])[1].toLowerCase(), prelude: head, line: lineAt(i), block: false });
        } else if (head) {
          out.errors.push({ line: lineAt(i), reason: "declaration outside a rule", detail: head });
        }
        i = j + 1;
        continue;
      }
      const close = matchBrace(j);
      if (close === -1) {
        out.errors.push({ line: lineAt(i), reason: "unbalanced braces", detail: head });
        break;
      }
      if (head.startsWith("@")) {
        const name = (head.match(/^@([\w-]+)/) ?? [, ""])[1].toLowerCase();
        const prelude = head.slice(name.length + 1).trim();
        out.atRules.push({ name, prelude, line: lineAt(i), block: true });
        if (name === "media") items(j + 1, close, media ? `${media} and ${prelude}` : prelude);
      } else if (src.slice(j + 1, close).includes("{")) {
        out.errors.push({ line: lineAt(i), reason: "nested rule — write each selector at the top level or inside @media", detail: head });
      } else {
        out.rules.push({ selector: head, decls: declarations(j + 1, close), media, line: lineAt(i) });
      }
      i = close + 1;
    }
  };

  items(0, src.length, null);
  return out;
}

// ---- the four content rules -----------------------------------------------------------

/** Class names in a selector, escapes resolved (`.va\:flex` → `va:flex`). */
export function selectorClasses(selector) {
  return [...selector.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

function checkValue(value, tokens) {
  const vars = [...value.matchAll(/var\(\s*--([A-Za-z0-9_-]+)\s*(?:,([^)]*))?\)/g)];
  if (!vars.length) return "visual value outside tokens — a non-layout property must take its value from a library token";
  for (const v of vars) {
    if (!tokens.has(v[1])) return `--${v[1]} is not a token the library theme defines`;
  }
  // What remains once the var()s are gone — including any var() fallback — must be
  // lengths, numbers and structural keywords. A raw colour hiding beside a token fails here.
  const rest = value.replace(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,([^)]*))?\)/g, (_, fb) => ` ${fb ?? ""} `);
  for (const tok of rest.split(/[\s,/]+/).filter(Boolean)) {
    if (LENGTH.test(tok) || VISUAL_KEYWORDS.has(tok.toLowerCase())) continue;
    return `visual value outside tokens — "${tok}" is not a token, length or structural keyword`;
  }
  return null;
}

function checkMedia(prelude) {
  const features = [...prelude.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (!features.length) return "a breakpoint needs a width condition";
  for (const f of features) {
    // `(min-width: 48rem)` or the range form `(width >= 768px)`.
    const name = (f.match(/^([a-z-]+)\s*:/i) ?? f.match(/^([a-z-]+)\s*[<>=]/i) ?? [, ""])[1].toLowerCase();
    if (!WIDTH_FEATURES.has(name)) return `@media (${f}) — breakpoints are width conditions only`;
  }
  const words = prelude.replace(/\([^)]*\)/g, " ").split(/[\s,]+/).filter(Boolean);
  for (const w of words) {
    if (!MEDIA_WORDS.has(w.toLowerCase())) return `@media ${prelude} — "${w}" is not a width breakpoint`;
  }
  return null;
}

/**
 * Audit the declared stylesheet's CONTENT. `isLibraryClass(name)` says whether a
 * class belongs to the library (component or utility); `tokens` is every custom
 * property the theme defines, without the leading `--`.
 * Returns issues in class-audit's shape: { line, reason, detail }.
 */
export function auditAppLayoutCss(css, { isLibraryClass, tokens }) {
  const parsed = parseCss(css);
  const issues = [];
  const appClasses = new Set(); // the app classes this stylesheet defines — sanctioned in markup
  const add = (line, reason, detail) => issues.push({ line, reason, detail });

  for (const e of parsed.errors) add(e.line, `app layout stylesheet: ${e.reason}`, e.detail);

  for (const a of parsed.atRules) {
    if (a.name === "media" && a.block) {
      const why = checkMedia(a.prelude);
      if (why) add(a.line, why, `@media ${a.prelude}`);
      continue;
    }
    const reason = {
      import: "@import would load a second stylesheet the audit never reads",
      layer: "@layer — a layered app rule loses to the unlayered bundle, so the override would silently do nothing",
    }[a.name] ?? `@${a.name} — the app layout stylesheet allows @media width breakpoints only`;
    add(a.line, reason, `@${a.name}`);
  }

  for (const r of parsed.rules) {
    for (const sel of r.selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      const classes = selectorClasses(sel);
      const lib = classes.filter(isLibraryClass);
      if (lib.length) {
        add(r.line, `restyles a library class (.${lib[0]}) — the app stylesheet arranges the page, it never restyles a component`, sel);
        continue;
      }
      for (const c of classes) appClasses.add(c);
      const anchored = classes.length > 0 || /#[A-Za-z_-]/.test(sel);
      if (!anchored) add(r.line, "selector is not anchored on an app class or id — a bare element or universal selector reaches library-rendered elements", sel);
    }
    for (const d of r.decls) {
      if (d.prop.startsWith("--")) {
        add(d.line, "defines a custom property — app CSS may not (re)define tokens", `${d.prop}: ${d.value}`);
        continue;
      }
      if (d.important) {
        add(d.line, "!important — the app stylesheet wins by load order, never by force", `${d.prop}: ${d.value} !important`);
        continue;
      }
      if (LAYOUT_PROPERTIES.has(d.prop)) continue;
      const why = checkValue(d.value, tokens);
      if (why) add(d.line, why, `${d.prop}: ${d.value}`);
    }
  }

  return { issues, appClasses, rules: parsed.rules.length, declarations: parsed.rules.reduce((n, r) => n + r.decls.length, 0) };
}

// ---- load order -----------------------------------------------------------------------

const PATTERNS = [
  /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  /\bimport\s+(?:[^'"`;]*?\bfrom\s+)?["']([^"']+\.css(?:\?[^"']*)?)["']/g,
  /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g,
];

/** Stylesheet references in source order: [{ spec, index }]. */
function refsIn(text, offset = 0) {
  const found = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ spec: m[1], index: offset + m.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * References a file makes, in order. Markdown counts only inside fenced code
 * blocks: HANDOFF.md's load path is a fence, and prose mentioning both files in
 * any order is not a load path.
 */
export function loadReferences(text, ext) {
  if (ext !== ".md") return refsIn(text);
  const out = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    out.push(...refsIn(m[1], m.index + m[0].indexOf(m[1])));
  }
  return out;
}

/**
 * Check every place the app stylesheet is loaded. `files` is [{ path, rel, text, ext }];
 * `isLibraryBundle(spec, fromDir)` says whether a reference is the library bundle;
 * `appBase` is the declared stylesheet's file name.
 */
export function checkLoadOrder(files, { isLibraryBundle, appBase, appRel }) {
  const issues = [];
  let loaded = 0;
  for (const f of files) {
    const refs = loadReferences(f.text, f.ext);
    const app = refs.filter((r) => basename(r.spec.split("?")[0]) === appBase);
    if (!app.length) continue;
    loaded++;
    const lib = refs.filter((r) => isLibraryBundle(r.spec, dirname(f.path)));
    const lineAt = (i) => f.text.slice(0, i).split("\n").length;
    if (!lib.length) {
      issues.push({ file: f.rel, line: lineAt(app[0].index), reason: `loads ${appBase} but not the library bundle — load order cannot be proven here; load both from one entry, library first`, detail: app[0].spec });
    } else if (app[0].index < lib[0].index) {
      issues.push({ file: f.rel, line: lineAt(app[0].index), reason: `${appBase} loads BEFORE the library bundle — the bundle is unlayered, so an equal-specificity library rule wins and the app rule does nothing`, detail: `${app[0].spec} before ${lib[0].spec}` });
    }
  }
  if (!loaded) {
    issues.push({ file: appRel, line: 1, reason: "declared app layout stylesheet is never loaded — name it in HANDOFF.md's load path, in a fenced block, after the library bundle", detail: appBase });
  }
  return { issues, loadedFrom: loaded };
}

/** A library-bundle predicate for a package name and the library's root on disk. */
export function libraryBundleMatcher({ packageName, libRoot }) {
  const roots = [join(libRoot, "dist"), join(libRoot, "src")].map((p) => resolve(p));
  return (spec, fromDir) => {
    if (packageName && (spec === packageName || spec.startsWith(`${packageName}/`))) return true;
    if (spec.startsWith(".") || isAbsolute(spec)) {
      const abs = resolve(fromDir, spec.split("?")[0]);
      return roots.some((r) => !relative(r, abs).startsWith("..") && abs.endsWith(".css"));
    }
    return false;
  };
}
