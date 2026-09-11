#!/usr/bin/env node
/**
 * Design tool — positive-allowlist class audit.
 *
 * The consumer's Tailwind build compiles the WHOLE default palette and type
 * scale (the library theme does not reset namespaces), so "unknown class"
 * catches nothing. This tool sanctions a class only when the library or the
 * surface methodology does:
 *
 *   component   a selector in <library>/src/components/*.css
 *   utility     an @utility in <library>/src/themes or src/utilities
 *   token       derives from a @theme token AND is cited in the methodology or CLAUDE.md
 *   structural  on the fixed layout list (flex, items-center, w-full, …)
 *   cited       a native spacing/sizing/border utility cited literally in the methodology or CLAUDE.md
 *   arbitrary   an x-[…] class cited literally in the methodology
 *
 * Everything else is UNSANCTIONED (exit 1). Hard VIOLATIONS regardless of
 * citation: colour/size literals, /opacity, !important, (--var) shorthand,
 * arbitrary variants, font-, leading-, tracking-, uppercase, text-<n> (type is
 * a token), <style>, style=, style: directives, @apply, .css files, external
 * design systems, class= attributes inside a concept wireframe.
 *
 * Usage:
 *   node <tools-dir>/design/class-audit.mjs <dir-or-file> --library <root> --methodology <md>
 *        [--claude-md <path>] [--tailwind-from <consumer-root>] [--package <npm-name>]
 *        [--out <json>] [--no-tailwind]
 *
 * Surface rules come from the methodology and the theme themselves — nothing is
 * duplicated elsewhere:
 *   forbidden   the §10 "Shipped components that no in-scope frame uses: …" line
 *   planned     the §12 table's interim/class column — the ONE sanctioned class per
 *               "[raw — planned, §12]" value (reported as PLANNED)
 *   companion   text tokens whose theme comment says "needs font-mono" require font-mono
 *               on the same element (the token carries no font family)
 *   hairline    border-[length:var(--border-thin)] (four sides) beside a side flag
 *               (border-b …) is a violation — seams are side-specific
 *
 * <root> is the library root: the repo itself, or node_modules/<package> in a
 * consumer. Advisory Tailwind pass: when tailwindcss resolves from
 * --tailwind-from (default cwd), every sanctioned class is compiled; one that
 * does not compile is a methodology/library defect, reported, not fatal.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname, relative, dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs, fail, printCapped } from "../lib/args.mjs";
import { resolveReport } from "../lib/report.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2), { booleans: ["no-tailwind", "no-write"] });
const target = positional[0];
if (!target || !opts.library || !opts.methodology) {
  fail(
    "Usage: node <tools-dir>/design/class-audit.mjs <dir-or-file> --library <root> --methodology <md> [--claude-md <path>] [--tailwind-from <root>] [--package <name>] [--out <json>] [--no-tailwind]",
  );
}
const targetPath = resolve(target);
if (!existsSync(targetPath)) fail(`Target not found: ${target}`);
const libRoot = resolve(opts.library);
if (!existsSync(libRoot)) fail(`Library root not found: ${opts.library}`);
const methodologyPath = resolve(opts.methodology);
if (!existsSync(methodologyPath)) fail(`Methodology not found: ${opts.methodology}`);
const claudeMdPath = resolve(opts["claude-md"] ?? join(libRoot, "CLAUDE.md"));

// ---- surface rules read from the methodology + theme -------------------------------------
const METHODOLOGY_MD = readFileSync(methodologyPath, "utf8");

/** §10 "Shipped components that no in-scope frame uses: `.a`, `.b` …" → forbidden set. */
function forbiddenFromMethodology(md) {
  const out = new Set();
  const m = md.match(/Shipped components that no in-scope frame uses[^\n]*/i);
  if (!m) return out;
  for (const c of m[0].matchAll(/`\.?([a-z][a-z0-9-]*)`/g)) out.add(c[1]);
  return out;
}

/** Why §12 resolved to nothing, when that is a format gap rather than "no planned additions". */
let PLANNED_DIAGNOSTIC = null;

/** §12 table: the column whose header mentions interim/class holds the ONE class per planned value. */
function plannedFromMethodology(md) {
  const out = new Map();
  const start = md.search(/^##\s*12\./m);
  if (start === -1) return out;
  const rest = md.slice(start + 1);
  const end = rest.search(/^##\s/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = section.split("\n").filter((l) => /^\|/.test(l.trim()));
  if (rows.length < 2) return out;
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = cells(rows[0]);
  const col = header.findIndex((h) => /interim|class/i.test(h));
  if (col === -1) {
    // The section declares planned additions but names no interim class for any of them, so
    // every class a page writes for one falls through to the generic rules and is sanctioned
    // or rejected for unrelated reasons. Silent until now — the audit reported PLANNED: 0 and
    // looked clean.
    PLANNED_DIAGNOSTIC = `§12 lists ${rows.slice(2).length} planned addition(s) but its table has no interim/class column (headers: ${header.join(" | ")}), so no interim class is sanctioned. A page composing one of these writes a class the audit cannot recognise as planned. Add the column, or move the row to §10 once it ships.`;
    return out;
  }
  for (const line of rows.slice(2)) {
    const cs = cells(line);
    const ref = cs[0]?.replace(/`/g, "") ?? "";
    for (const m of (cs[col] ?? "").matchAll(/`([^`]+)`/g)) {
      for (const tok of m[1].split(/\s+/)) {
        const cls = tok.replace(/^\./, "");
        if (!/^[a-z!\[]/i.test(cls) || /^\./.test(tok) && COMPONENT_HINT.test(cls)) continue;
        if (/^[a-z][a-z0-9-]*:/.test(cls) || /^[a-z][a-z0-9.-]*(\[[^\]]+\])?$/.test(cls)) {
          out.set(splitVariants(cls).base, { class: cls, value: cs[1]?.replace(/`/g, "") ?? "", ref: `§12 ${ref}` });
        }
      }
    }
  }
  return out;
}
const COMPONENT_HINT = /^(dot|btn|field-verification|text-button|progress-bar|section-marker)/;

/** Text tokens whose theme comment says "needs font-mono" → companion required. */
function monoTokensFromTheme() {
  const out = new Set();
  for (const file of cssFiles(join(libRoot, "src", "themes"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/--text-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:[^;]*;\s*\/\*.*font-mono/);
      if (m) out.add("text-" + m[1]);
    }
  }
  return out;
}

const FORBIDDEN = forbiddenFromMethodology(METHODOLOGY_MD);
const PLANNED_CANDIDATES = plannedFromMethodology(METHODOLOGY_MD);
if (!PLANNED_DIAGNOSTIC && !PLANNED_CANDIDATES.size && /\[(?:raw — |raw - )?planned(?: variant)?, §12\]/i.test(METHODOLOGY_MD)) {
  PLANNED_DIAGNOSTIC =
    "the methodology marks values `[raw — planned, §12]` but §12 resolved no interim class for any of them. Those values have no sanctioned spelling, so each use is written differently and the audit cannot tell them apart.";
}
const PLANNED = new Map(); // filled after the vocabulary is loaded — see sealPlanned()
const ALLOW = new Set();
const MONO_TOKENS = monoTokensFromTheme();
const COMPANIONS = MONO_TOKENS.size
  ? [{ re: new RegExp(`^(${[...MONO_TOKENS].join("|")})$`), requires: "font-mono", reason: "this text token carries no font family — without font-mono it renders in Inter (theme comment: needs font-mono)" }]
  : [];
/** A §12 column mentions ordinary classes too (`.btn btn-outline`, `w-80`); only what the audit would
 *  otherwise reject is the interim class. */
function sealPlanned() {
  for (const [base, meta] of PLANNED_CANDIDATES) {
    const k = classify(meta.class).kind;
    if (k === "violation" || k === "unsanctioned") PLANNED.set(base, meta);
  }
}
const ELEMENT_RULES = [
  {
    whenRe: /^border-\[length:var\(--border-thin\)\]$/,
    withRe: /^border-(t|r|b|l|x|y)$/,
    reason: "a seam hairline is side-specific — border-b border-b-[length:var(--border-thin)]; the four-side form beside a side flag sets all four sides",
  },
];

// ---- library vocabulary --------------------------------------------------------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function cssFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(dir, f));
}

function componentClasses() {
  const out = new Set();
  for (const file of cssFiles(join(libRoot, "src", "components"))) {
    const css = stripComments(readFileSync(file, "utf8"));
    // Rule heads: the selector text before each "{", excluding at-rules.
    for (const m of css.matchAll(/([^{};]+)\{/g)) {
      const head = m[1].trim();
      if (!head || head.startsWith("@")) continue;
      for (const c of head.matchAll(/\.([a-z][a-z0-9-]*)/g)) out.add(c[1]);
    }
  }
  return out;
}

function utilities() {
  const out = new Set();
  for (const file of [...cssFiles(join(libRoot, "src", "themes")), ...cssFiles(join(libRoot, "src", "utilities"))]) {
    for (const m of stripComments(readFileSync(file, "utf8")).matchAll(/@utility\s+([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  }
  return out;
}

function themeTokens() {
  const tokens = { color: new Set(), text: new Set(), radius: new Set(), shadow: new Set(), font: new Set() };
  for (const file of cssFiles(join(libRoot, "src", "themes"))) {
    const css = stripComments(readFileSync(file, "utf8"));
    for (const m of css.matchAll(/--(color|text|radius|shadow|font)-([a-z0-9]+(?:-[a-z0-9]+)*?)(--[a-z-]+)?\s*:/g)) {
      if (m[3]) continue; // --text-body--line-height sub-keys are not tokens
      tokens[m[1]].add(m[2]);
    }
  }
  return tokens;
}

// Classes cited literally in a markdown file: inline `code` spans and class="…" inside fences.
const CLASS_SHAPE = /^[a-z][a-z0-9.-]*(\[[^\]]+\])?$/;
// §12 is excluded from citations: its interim-class column is read separately as PLANNED, so a
// planned class stays reported as planned instead of passing silently as "cited".
function withoutSection12(md) {
  const start = md.search(/^##\s*12\./m);
  if (start === -1) return md;
  const rest = md.slice(start + 1);
  const end = rest.search(/^##\s/m);
  return md.slice(0, start) + (end === -1 ? "" : rest.slice(end));
}
function citedClasses(mdPath) {
  const out = new Set();
  if (!existsSync(mdPath)) return out;
  const md = withoutSection12(readFileSync(mdPath, "utf8"));
  const add = (tok) => {
    let t = tok.trim().replace(/^\./, "").replace(/[,;:)]+$/, "");
    if (/^[a-z][a-z0-9-]*:/.test(t)) t = t.replace(/^[a-z][a-z0-9-]*:/, ""); // md:w-full → w-full
    if (CLASS_SHAPE.test(t)) out.add(t);
  };
  for (const m of md.matchAll(/`([^`\n]+)`/g)) for (const tok of m[1].split(/\s+/)) add(tok);
  for (const m of md.matchAll(/class="([^"]+)"/g)) for (const tok of m[1].split(/\s+/)) add(tok);
  return out;
}

const COMPONENT = componentClasses();
const UTILITY = utilities();
const TOKENS = themeTokens();
const CITED_METHODOLOGY = citedClasses(methodologyPath);
const CITED_CLAUDE = citedClasses(claudeMdPath);
const CITED = new Set([...CITED_METHODOLOGY, ...CITED_CLAUDE]);

const STRUCTURAL = new Set(
  `flex inline-flex grid block inline inline-block hidden contents
   items-start items-center items-end items-stretch items-baseline
   justify-start justify-center justify-end justify-between justify-around justify-evenly
   self-start self-center self-end self-stretch self-auto
   content-start content-center content-end content-between
   place-items-center place-content-center
   shrink shrink-0 grow grow-0 min-w-0 min-h-0
   sr-only not-sr-only relative absolute fixed sticky static isolate
   top-0 bottom-0 left-0 right-0 inset-0 inset-x-0 inset-y-0
   mx-auto ml-auto mr-auto my-auto mt-auto mb-auto
   w-full h-full w-auto h-auto w-fit h-fit max-w-full min-w-full
   flex-1 flex-auto flex-none flex-col flex-row flex-wrap flex-nowrap flex-col-reverse flex-row-reverse
   overflow-hidden overflow-auto overflow-x-auto overflow-y-auto overflow-visible
   text-left text-center text-right truncate whitespace-nowrap whitespace-normal break-words
   cursor-pointer cursor-not-allowed cursor-default select-none pointer-events-none pointer-events-auto
   appearance-none outline-none list-none underline no-underline line-through tabular-nums
   transition transition-colors transition-opacity order-first order-last col-span-full
   invisible visible opacity-0 opacity-100 border-0 border-none`
    .split(/\s+/)
    .filter(Boolean),
);

const ALLOWED_VARIANTS = new Set([
  "md",
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "disabled",
  "checked",
  "first",
  "last",
  "not-first",
  "not-last",
  "aria-selected",
  "aria-expanded",
  "aria-invalid",
]);

const SPACING_GRAMMAR =
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|w|h|size|min-w|max-w|min-h|max-h|basis|inset|inset-x|inset-y|top|bottom|left|right|z|order|leading-none|border|border-t|border-r|border-b|border-l|border-x|border-y|outline|outline-offset|ring|ring-offset|rounded|rounded-t|rounded-r|rounded-b|rounded-l|rounded-tl|rounded-tr|rounded-br|rounded-bl|rounded-s|rounded-e|stroke|indent|columns|grid-cols|grid-rows|col-span|row-span|col-start|row-start)(-(\d+(\.\d+)?|full|auto|px|none|screen|fit|min|max|prose|\d+\/\d+))?$/;

const COLOR_PREFIXES = [
  "bg",
  "text",
  "border",
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "border-x",
  "border-y",
  "ring",
  "outline",
  "fill",
  "stroke",
  "decoration",
  "accent",
  "caret",
  "divide",
  "placeholder",
  "shadow",
  "inset-shadow",
  "from",
  "via",
  "to",
];

function deriveToken(base) {
  // Returns the token family a utility derives from, or null.
  for (const p of COLOR_PREFIXES) {
    if (base.startsWith(p + "-") && TOKENS.color.has(base.slice(p.length + 1))) return `color:${base.slice(p.length + 1)}`;
  }
  if (base.startsWith("text-") && TOKENS.text.has(base.slice(5))) return `text:${base.slice(5)}`;
  const r = base.match(/^rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-(.+)$/);
  if (r && TOKENS.radius.has(r[1])) return `radius:${r[1]}`;
  if (base.startsWith("shadow-") && TOKENS.shadow.has(base.slice(7))) return `shadow:${base.slice(7)}`;
  if (base.startsWith("font-") && TOKENS.font.has(base.slice(5))) return `font:${base.slice(5)}`;
  return null;
}

// ---- classification ----------------------------------------------------------------

function splitVariants(cls) {
  const variants = [];
  let rest = cls;
  for (;;) {
    if (rest.startsWith("[")) return { variants, base: rest, arbitraryVariant: true };
    const m = rest.match(/^([a-z][a-z0-9-]*(?:-\[[^\]]+\])?):(.+)$/);
    if (!m) break;
    variants.push(m[1]);
    rest = m[2];
  }
  return { variants, base: rest, arbitraryVariant: false };
}

function hardViolation(cls, base) {
  if (cls.includes("!")) return "important modifier";
  if (/\/\d+(\.\d+)?$/.test(base) || /\/\[[^\]]+\]$/.test(base)) return "opacity / fraction modifier on a token utility";
  if (/(?<!var)\(--/.test(cls)) return "Tailwind (--var) shorthand — write var(--token) explicitly";
  if (/\[#[0-9a-fA-F]{3,8}\]/.test(base) || /\[(rgb|hsl|oklch|color)/.test(base)) return "colour literal";
  if (/^(font|leading|tracking)-/.test(base) || /^(uppercase|lowercase|capitalize|normal-case)$/.test(base)) {
    return "type must come from a text-* token or a type-* utility";
  }
  if (/^text-(xs|sm|base|lg|xl|\dxl|\d+(\.\d+)?)$/.test(base)) return "raw type size (text is a token)";
  if (/^(text|bg|border|ring|outline|fill|stroke|shadow|rounded|font|leading|tracking)-\[/.test(base)) {
    return "arbitrary value on a token namespace";
  }
  return null;
}

function classify(cls) {
  const { variants, base, arbitraryVariant } = splitVariants(cls);
  if (arbitraryVariant) return { kind: "violation", reason: "arbitrary variant" };
  for (const v of variants) {
    if (!ALLOWED_VARIANTS.has(v)) return { kind: "violation", reason: `variant "${v}:" is not sanctioned (md:, hover:, focus-visible:, disabled: …)` };
  }
  if (PLANNED.has(base)) {
    const p = PLANNED.get(base);
    return { kind: "planned", source: `${p.ref ?? "§12"} · ${p.value ?? ""}`.trim() };
  }
  if (FORBIDDEN.has(base)) return { kind: "violation", reason: "forbidden by the surface profile" };

  if (COMPONENT.has(base)) return { kind: "component", source: "src/components" };
  if (UTILITY.has(base)) return { kind: "utility", source: "@utility" };

  const token = /\/\d/.test(base) ? null : deriveToken(base);
  const cited = CITED.has(base) || ALLOW.has(base);
  if (token) {
    if (cited) return { kind: "token", source: `${token} · cited` };
    return { kind: "unsanctioned", reason: `derives from ${token} but neither the methodology nor CLAUDE.md uses it — cite a § or recompose` };
  }
  // The methodology's own arbitrary classes (h-[92.5px], border-b-[length:var(--border-thin)]) are the rule.
  if (/\[[^\]]+\]/.test(base) && !cls.includes("!") && CITED_METHODOLOGY.has(base)) {
    return { kind: "arbitrary", source: "cited in methodology" };
  }

  const hv = hardViolation(cls, base);
  if (hv) return { kind: "violation", reason: hv };

  if (STRUCTURAL.has(base) || ALLOW.has(base)) return { kind: "structural", source: ALLOW.has(base) ? "profile allow" : "fixed list" };

  // The methodology is the authority: a class it writes literally is sanctioned whatever
  // namespace it looks like it belongs to. Keyword utilities (ring-inset, line-through,
  // overflow-hidden) carry no token, so without this they fall through to the namespace
  // fallbacks below and read as "no theme token behind this utility".
  if (cited) return { kind: "cited", source: CITED_METHODOLOGY.has(base) ? "methodology" : "CLAUDE.md" };

  if (/\[[^\]]+\]/.test(base)) return { kind: "violation", reason: "arbitrary value not present in the methodology" };
  if (SPACING_GRAMMAR.test(base)) {
    if (cited) return { kind: "cited", source: CITED_METHODOLOGY.has(base) ? "methodology" : "CLAUDE.md" };
    return { kind: "unsanctioned", reason: "native utility the methodology never uses — cite a § or use the methodology's value" };
  }
  if (/^(bg|text|border|ring|outline|fill|stroke|decoration|shadow|rounded)-/.test(base)) {
    return { kind: "unsanctioned", reason: "no theme token behind this utility (Tailwind default palette / scale)" };
  }
  return { kind: "unsanctioned", reason: "not a library class, token utility, or sanctioned layout utility" };
}

// ---- extraction -------------------------------------------------------------------

function walk(p, acc = []) {
  const st = statSync(p);
  if (st.isFile()) {
    acc.push(p);
    return acc;
  }
  for (const name of readdirSync(p)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    walk(join(p, name), acc);
  }
  return acc;
}

const files = walk(targetPath).filter((f) => [".svelte", ".html", ".css"].includes(extname(f)));
const isConcept = (f) => /concept.*\.html$/.test(basename(f));

const occurrences = []; // { cls, file, line }
const groups = []; // { classes: [base…], file, line } — one per class attribute / data-class
const issues = []; // { file, line, kind: "violation", reason, detail }

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function literalsInExpression(expr) {
  const out = [];
  for (const m of expr.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]);
  return out;
}

for (const file of files) {
  const rel = relative(process.cwd(), file);
  const text = readFileSync(file, "utf8");
  const ext = extname(file);

  if (ext === ".css") {
    if (basename(file) === "concept.css") continue;
    issues.push({ file: rel, line: 1, kind: "violation", reason: "stylesheet in the package — pages carry no CSS", detail: basename(file) });
    continue;
  }

  const concept = isConcept(file);
  const addClassList = (value, index) => {
    const line = lineOf(text, index);
    const group = { classes: [], file: rel, line };
    for (const tok of value.split(/\s+/).filter(Boolean)) {
      // Svelte template leftovers ({…}) never reach here; concept values may carry leading dots.
      const cls = tok.replace(/^\./, "");
      if (!/^[!]?[a-z\[]/i.test(cls)) continue;
      occurrences.push({ cls, file: rel, line });
      group.classes.push(splitVariants(cls).base);
    }
    if (group.classes.length) groups.push(group);
  };

  for (const m of text.matchAll(/<style[\s>]/gi)) {
    issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "<style> block — no custom CSS", detail: "<style>" });
  }
  for (const m of text.matchAll(/\sstyle\s*=\s*["'{]/g)) {
    issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "inline style attribute", detail: "style=" });
  }
  for (const m of text.matchAll(/\sstyle:[a-z-]+/g)) {
    issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "style: directive", detail: m[0].trim() });
  }
  for (const m of text.matchAll(/@apply\b/g)) {
    issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "@apply in page code", detail: "@apply" });
  }
  for (const m of text.matchAll(/daisyui|@material|bootstrap|shadcn|flowbite/gi)) {
    issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "external design system referenced", detail: m[0] });
  }

  if (concept) {
    for (const m of text.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) {
      issues.push({ file: rel, line: lineOf(text, m.index), kind: "violation", reason: "class= in a concept wireframe — real classes go in data-class, styling is concept.css", detail: m[1] });
    }
    for (const m of text.matchAll(/data-class\s*=\s*"([^"]*)"/g)) addClassList(m[1], m.index);
    continue;
  }

  for (const m of text.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) addClassList(m[1], m.index);
  for (const m of text.matchAll(/\sclass\s*=\s*'([^']*)'/g)) addClassList(m[1], m.index);
  for (const m of text.matchAll(/\sclass\s*=\s*\{([\s\S]*?)\}(?=\s|>|\/)/g)) {
    for (const lit of literalsInExpression(m[1])) addClassList(lit, m.index);
  }
  for (const m of text.matchAll(/\sclass:([a-z][a-z0-9-]*)/g)) addClassList(m[1], m.index);
}

// ---- classify + report ------------------------------------------------------------------

sealPlanned();
const byClass = new Map();
for (const o of occurrences) {
  if (!byClass.has(o.cls)) byClass.set(o.cls, { cls: o.cls, ...classify(o.cls), where: [] });
  byClass.get(o.cls).where.push(`${o.file}:${o.line}`);
}
const classes = [...byClass.values()].sort((a, b) => a.cls.localeCompare(b.cls));
const violations = classes.filter((c) => c.kind === "violation");
const unsanctioned = classes.filter((c) => c.kind === "unsanctioned");
const sanctioned = classes.filter((c) => !["violation", "unsanctioned"].includes(c.kind));
const planned = classes.filter((c) => c.kind === "planned");

for (const g of groups) {
  for (const c of COMPANIONS) {
    const hits = g.classes.filter((k) => c.re.test(k));
    if (hits.length && !g.classes.includes(c.requires)) {
      issues.push({ file: g.file, line: g.line, kind: "violation", reason: c.reason ?? `${hits[0]} requires ${c.requires} on the same element`, detail: `${hits[0]} without ${c.requires}` });
    }
  }
  for (const r of ELEMENT_RULES) {
    const when = g.classes.find((k) => r.whenRe.test(k));
    const with_ = g.classes.find((k) => r.withRe.test(k));
    if (when && with_) {
      issues.push({ file: g.file, line: g.line, kind: "violation", reason: r.reason ?? `${when} may not be combined with ${with_}`, detail: `${when} + ${with_}` });
    }
  }
}

// ---- advisory Tailwind compile pass -----------------------------------------------------

async function tailwindCheck() {
  if (opts["no-tailwind"]) return { checked: false, reason: "--no-tailwind" };
  const root = resolve(opts["tailwind-from"] ?? process.cwd());
  const pkgName = opts.package;
  try {
    const req = createRequire(join(root, "package.json"));
    const twPkgPath = req.resolve("tailwindcss/package.json");
    const twDir = dirname(twPkgPath);
    const entry = ["dist/lib.mjs", "dist/lib.js", "index.mjs"].map((f) => join(twDir, f)).find(existsSync);
    if (!entry) return { checked: false, reason: "tailwindcss found but no ESM entry" };
    const tw = await import(pathToFileURL(entry).href);
    if (!tw.__unstable__loadDesignSystem) return { checked: false, reason: "tailwindcss exports no __unstable__loadDesignSystem" };
    const sourceImport = pkgName ? `@import "${pkgName}/source";` : `@import "${pathToFileURL(join(libRoot, "src", "library.css")).href}";`;
    const ds = await tw.__unstable__loadDesignSystem(`@import "tailwindcss"; ${sourceImport}`, {
      base: root,
      loadStylesheet: async (id, base) => {
        let file;
        if (id === "tailwindcss") file = join(twDir, "index.css");
        else if (id.startsWith("tailwindcss/")) file = join(twDir, id.slice("tailwindcss/".length));
        else if (id.startsWith("file://")) file = new URL(id).pathname;
        else if (id.startsWith(".") || id.startsWith("/")) file = resolve(base, id);
        else file = createRequire(join(base, "__resolve__.js")).resolve(id);
        return { path: file, base: dirname(file), content: readFileSync(file, "utf8") };
      },
    });
    const list = sanctioned.filter((c) => !["component"].includes(c.kind)).map((c) => c.cls);
    const css = ds.candidatesToCss(list);
    const nonCompiling = list.filter((_, i) => css[i] === null);
    return { checked: true, tailwind: JSON.parse(readFileSync(twPkgPath, "utf8")).version, candidates: list.length, nonCompiling };
  } catch (err) {
    return { checked: false, reason: `tailwindcss not usable from ${relative(process.cwd(), root) || "."}: ${err.message.split("\n")[0]}` };
  }
}

const tailwind = await tailwindCheck();

const report = {
  target: relative(process.cwd(), targetPath) || ".",
  library: relative(process.cwd(), libRoot) || ".",
  methodology: relative(process.cwd(), methodologyPath),
  rules: {
    forbidden: [...FORBIDDEN],
    planned: [...PLANNED.values()].map((p) => p.class),
    monoTokens: [...MONO_TOKENS],
    ...(PLANNED_DIAGNOSTIC ? { plannedDiagnostic: PLANNED_DIAGNOSTIC } : {}),
  },
  files: files.map((f) => relative(process.cwd(), f)),
  vocabulary: {
    componentClasses: COMPONENT.size,
    utilities: [...UTILITY],
    tokens: { color: TOKENS.color.size, text: TOKENS.text.size, radius: TOKENS.radius.size, shadow: TOKENS.shadow.size },
    citedMethodology: CITED_METHODOLOGY.size,
    citedClaudeMd: CITED_CLAUDE.size,
  },
  summary: {
    classes: classes.length,
    sanctioned: sanctioned.length,
    unsanctioned: unsanctioned.length,
    violations: violations.length + issues.length,
  },
  classes,
  planned: planned.map((c) => ({ class: c.cls, ...PLANNED.get(splitVariants(c.cls).base), where: c.where })),
  issues,
  tailwind,
  verdict: violations.length + unsanctioned.length + issues.length === 0 ? "PASS" : "FAIL",
};

const defaultOut = join(statSync(targetPath).isDirectory() ? targetPath : dirname(targetPath), "class-audit.json");
const dest = resolveReport({ out: opts.out, noWrite: opts["no-write"], defaultPath: defaultOut });
const outPath = dest.path;
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

const lines = [];
lines.push(`CLASS-AUDIT: ${report.verdict} | CLASSES: ${classes.length} | SANCTIONED: ${sanctioned.length} | PLANNED: ${planned.length} | UNSANCTIONED: ${unsanctioned.length} | VIOLATIONS: ${violations.length + issues.length}`);
for (const c of violations) lines.push(`  VIOLATION   ${c.cls.padEnd(36)} ${c.reason}  @ ${c.where[0]}${c.where.length > 1 ? ` (+${c.where.length - 1})` : ""}`);
for (const i of issues) lines.push(`  VIOLATION   ${i.detail.padEnd(36)} ${i.reason}  @ ${i.file}:${i.line}`);
for (const c of planned) lines.push(`  PLANNED     ${c.cls.padEnd(36)} ${c.source}  @ ${c.where[0]}`);
if (PLANNED_DIAGNOSTIC) lines.push(`  §12 GAP     ${PLANNED_DIAGNOSTIC} (methodology format defect — report it; not a failure)`);
for (const c of unsanctioned) lines.push(`  UNSANCTIONED ${c.cls.padEnd(35)} ${c.reason}  @ ${c.where[0]}${c.where.length > 1 ? ` (+${c.where.length - 1})` : ""}`);
if (tailwind.checked) {
  lines.push(`  tailwind ${tailwind.tailwind}: ${tailwind.candidates} sanctioned utilities compiled; ${tailwind.nonCompiling.length} did not${tailwind.nonCompiling.length ? ` → ${tailwind.nonCompiling.join(" ")} (methodology/library defect — report it)` : ""}`);
} else {
  lines.push(`  tailwind check skipped: ${tailwind.reason}`);
}
lines.push(outPath ? `  report: ${relative(process.cwd(), outPath)}` : `  report not written: ${dest.reason}`);
printCapped(lines, 40);
process.exit(report.verdict === "PASS" ? 0 : 1);
