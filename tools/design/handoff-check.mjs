#!/usr/bin/env node
/**
 * Design tool — handoff package check.
 *
 * Everything about a design handoff that a script can settle, so the verifier agent
 * spends its turns on the things only a reader can judge. Run it on a run directory
 * that has an approved concept and a built 05-package/:
 *
 *   node <tools-dir>/design/handoff-check.mjs <run-dir> [--package 05-package] [--out json]
 *
 * Checks, in order (any FAIL exits 1):
 *   approval    04-approval.md names a concept file and its sha256 still matches — an edit
 *               after the human gate voids the approval
 *   compile     every .svelte compiles (svelte/compiler, runes mode); a11y warnings are findings
 *   blocks      every data-block in the approved concept appears in the package, and the
 *               block's data-class set is a SUBSET of the classes on the matching element
 *               (an empty <section data-block> would otherwise satisfy coverage)
 *   contract    contract.json validates against contract.schema.json
 *   states      every data-states token in the concept is a contract state, and every state
 *               names a prop the package actually destructures
 *   copy        every contract copy string appears verbatim in the package
 *   icons       every contract icon exists in the library sprite
 *   files       the route file, mapping.md, contract.json and HANDOFF.md exist
 *   handoff     HANDOFF.md carries its required section headings
 *   shell       no load path / sprite inlining inside the package (that lives at the app shell)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, extname, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs, fail, printCapped } from "../lib/args.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const runDir = positional[0];
if (!runDir) fail("Usage: node <tools-dir>/design/handoff-check.mjs <run-dir> [--package 05-package] [--sprite path] [--out json]");
const runPath = resolve(runDir);
if (!existsSync(runPath)) fail(`Run directory not found: ${runDir}`);
const pkgDir = join(runPath, opts.package ?? "05-package");

const findings = [];
const add = (check, severity, message, detail) => findings.push({ check, severity, message, ...(detail ? { detail } : {}) });
const fatal = (check, message, detail) => add(check, "fail", message, detail);
const warn = (check, message, detail) => add(check, "warn", message, detail);

// ---- helpers -------------------------------------------------------------------------------

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, acc) : acc.push(p);
  }
  return acc;
}
const classAttrs = (text) => {
  const out = [];
  for (const m of text.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) out.push({ value: m[1], index: m.index });
  for (const m of text.matchAll(/\sclass\s*=\s*'([^']*)'/g)) out.push({ value: m[1], index: m.index });
  for (const m of text.matchAll(/\sclass\s*=\s*\{([\s\S]*?)\}(?=\s|>|\/)/g)) {
    for (const lit of m[1].matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push({ value: lit[2], index: m.index });
  }
  return out;
};

/**
 * Prop names a file destructures from $props().
 *
 * Brace- and quote-aware on purpose: a naive /\{([^}]*)\}/ plus split(",") truncates the
 * list at the first comma inside a string or an object/array default — so a perfectly
 * ordinary `let { entity = "Northgate Logistics, INC", rows = [] } = $props()` would
 * report only `entity`, and every state driven by a later prop would read as unreachable.
 * The tool must not push authors into rewriting working code to satisfy it.
 */
function destructuredProps(src) {
  const out = new Set();
  const closerFor = { "{": "}", "[": "]", "(": ")" };
  for (const m of src.matchAll(/(?:let|const)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, quote = null, i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (closerFor[c]) depth++;
      else if (c === "}" || c === "]" || c === ")") { depth--; if (depth === 0) break; }
    }
    if (i >= src.length) continue;
    if (!/^\s*(?::[^=]*)?=\s*\$props\(\)/.test(src.slice(i + 1, i + 80))) continue;

    const inner = src.slice(open + 1, i);
    const parts = [];
    let cur = "", d = 0, q = null;
    for (let j = 0; j < inner.length; j++) {
      const c = inner[j];
      if (q) { cur += c; if (c === "\\") cur += inner[++j] ?? ""; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
      if (closerFor[c]) d++;
      else if (c === "}" || c === "]" || c === ")") d--;
      if (c === "," && d === 0) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);

    for (const part of parts) {
      const t = part.trim().replace(/^\.\.\./, "");
      if (!t) continue;
      // `a`, `a = default`, `a: local`, `a: local = default` — record both the incoming
      // name and the local binding, since a contract expression may name either.
      const key = t.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) out.add(key);
      const alias = t.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)/);
      if (alias) out.add(alias[1]);
    }
  }
  return out;
}

/** Minimal draft-07 subset validator (type, required, additionalProperties, properties, items, enum, pattern). */
function validate(value, node, path, errors) {
  if (node.enum) {
    if (!node.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${node.enum.join(" | ")}`);
    return;
  }
  if (node.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return errors.push(`${path}: expected object`);
    for (const req of node.required ?? []) if (value[req] === undefined) errors.push(`${path}.${req}: required`);
    if (node.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!node.properties?.[k]) errors.push(`${path}.${k}: unknown key`);
    }
    for (const [k, sub] of Object.entries(node.properties ?? {})) if (value[k] !== undefined) validate(value[k], sub, `${path}.${k}`, errors);
  } else if (node.type === "array") {
    if (!Array.isArray(value)) return errors.push(`${path}: expected array`);
    if (node.items) value.forEach((item, i) => validate(item, node.items, `${path}[${i}]`, errors));
  } else if (node.type === "string") {
    if (typeof value !== "string") return errors.push(`${path}: expected string`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: "${value}" does not match ${node.pattern}`);
  } else if (node.type === "integer" || node.type === "number") {
    if (typeof value !== "number") errors.push(`${path}: expected ${node.type}`);
  } else if (node.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
  }
}

// ---- 1. approval ----------------------------------------------------------------------------

let conceptPath = null;
const approvalPath = join(runPath, "04-approval.md");
if (!existsSync(approvalPath)) {
  fatal("approval", "04-approval.md is missing — the package was built without a human gate");
} else {
  const approval = readFileSync(approvalPath, "utf8");
  const named = approval.match(/`([^`]*concept\.v\d+\.html)`/);
  const hash = approval.match(/`([0-9a-f]{64})`/);
  if (!named) fatal("approval", "04-approval.md names no concept file");
  else {
    conceptPath = join(runPath, named[1].startsWith("02-concept") ? named[1] : join("02-concept", basename(named[1])));
    if (!existsSync(conceptPath)) {
      fatal("approval", `approved concept not found: ${named[1]}`);
      conceptPath = null;
    } else if (!hash) {
      fatal("approval", "04-approval.md carries no sha256");
    } else {
      const actual = createHash("sha256").update(readFileSync(conceptPath)).digest("hex");
      if (actual !== hash[1]) {
        fatal("approval", "concept has changed since approval — the hash does not match; re-approve before building", `approved ${hash[1].slice(0, 12)}… · now ${actual.slice(0, 12)}…`);
      }
    }
  }
}

// ---- 2. compile -----------------------------------------------------------------------------

const pkgFiles = walk(pkgDir);
const svelteFiles = pkgFiles.filter((f) => extname(f) === ".svelte");
if (!svelteFiles.length) fatal("compile", `no .svelte files under ${relative(runPath, pkgDir)}`);

let compile;
try {
  ({ compile } = await import("svelte/compiler"));
} catch {
  warn("compile", "svelte/compiler not resolvable — compile check skipped");
}
const propsByFile = new Map();
if (compile) {
  for (const f of svelteFiles) {
    const rel = relative(runPath, f);
    const src = readFileSync(f, "utf8");
    try {
      const { warnings } = compile(src, { filename: basename(f), runes: true, generate: "client" });
      for (const w of warnings ?? []) {
        if (/^a11y/.test(w.code ?? "")) warn("compile", `${rel}: ${w.code} — ${w.message}`);
      }
    } catch (e) {
      fatal("compile", `${rel} does not compile`, (e.message ?? String(e)).split("\n")[0]);
    }
    propsByFile.set(rel, destructuredProps(src));
  }
}
const allProps = new Set([...propsByFile.values()].flatMap((s) => [...s]));

// ---- 3. blocks ------------------------------------------------------------------------------

const svelteText = svelteFiles.map((f) => readFileSync(f, "utf8")).join("\n");
let conceptBlocks = [];
const conceptCopy = new Map();
if (conceptPath) {
  const concept = readFileSync(conceptPath, "utf8");
  const seen = new Set();
  for (const m of concept.matchAll(/<section\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = attrs.match(/data-block="([^"]+)"/)?.[1];
    if (!id || seen.has(id)) continue; // a block may appear once per viewport
    seen.add(id);
    conceptBlocks.push({
      id,
      region: attrs.match(/data-region="([^"]+)"/)?.[1] ?? null,
      classes: (attrs.match(/data-class="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean).map((c) => c.replace(/^\./, "")),
      states: (attrs.match(/data-states="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean),
      copy: (attrs.match(/data-copy="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean),
      blocked: attrs.match(/data-blocked="([^"]+)"/)?.[1] ?? null,
    });
  }
  // Take the element's full text content: a copy string may be split across child elements
  // (the eyebrow renders "STEP n OF m" and the section name as separate spans), and stopping
  // at the first "<" would compare a fragment against the whole string.
  for (const m of concept.matchAll(/<(\w+)[^>]*data-copy-id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const id = m[2];
    const text = m[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text && !conceptCopy.has(id)) conceptCopy.set(id, text);
  }

  for (const b of conceptBlocks) {
    if (b.blocked) {
      fatal("blocks", `${b.id} is still data-blocked="${b.blocked}" in the approved concept — it cannot be built`);
      continue;
    }
    const re = new RegExp(`data-block=["']${b.id}["']`);
    if (!re.test(svelteText)) {
      fatal("blocks", `${b.id} has no implementation — no element carries data-block="${b.id}"`);
      continue;
    }
    // the element carrying the id must use a superset of the block's data-class
    let elementClasses = null;
    for (const f of svelteFiles) {
      const text = readFileSync(f, "utf8");
      const m = text.match(new RegExp(`<[a-zA-Z][^>]*data-block=["']${b.id}["'][^>]*>`));
      if (!m) continue;
      elementClasses = new Set(classAttrs(m[0]).flatMap((c) => c.value.split(/\s+/)).filter(Boolean));
      break;
    }
    if (elementClasses) {
      // component classes may sit on descendants; only the block's own layout classes must be on the root.
      const missing = b.classes.filter((c) => !elementClasses.has(c) && !new RegExp(`["'\\s]${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"'\`]`).test(svelteText));
      if (missing.length) fatal("blocks", `${b.id}: data-class not found anywhere in the package`, missing.join(" "));
    }
  }
}

// ---- 4. contract ----------------------------------------------------------------------------

const contractPath = join(pkgDir, "contract.json");
let contract = null;
if (!existsSync(contractPath)) {
  fatal("contract", "contract.json is missing");
} else {
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch (e) {
    fatal("contract", "contract.json is not valid JSON", e.message);
  }
  if (contract) {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "contract.schema.json"), "utf8"));
    const errors = [];
    validate(contract, schema, "contract", errors);
    for (const e of errors) fatal("contract", e);
    const contractIds = new Set((contract.blocks ?? []).map((b) => b.id));
    for (const b of conceptBlocks) if (!contractIds.has(b.id)) fatal("contract", `${b.id} is missing from contract.blocks`);
  }
}

// ---- 5. states ------------------------------------------------------------------------------

if (contract) {
  const declared = new Set((contract.states ?? []).map((s) => s.id));
  const conceptStates = new Set(conceptBlocks.flatMap((b) => b.states));
  // rest/hover/focus/pressed are CSS-only displays the library owns; they need no prop.
  const cssOnly = /^(rest|hover|focus|focus-visible|pressed|active|open|collapsed|expanded|selected|checked)$/;
  for (const s of conceptStates) {
    if (cssOnly.test(s)) continue;
    if (!declared.has(s)) fatal("states", `concept state "${s}" is not in contract.states`);
  }
  for (const s of contract.states ?? []) {
    const expr = s.prop ?? s.when ?? "";
    const names = [...expr.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
    if (!names.some((n) => allProps.has(n))) {
      fatal("states", `state "${s.id}" is not reachable — nothing in "${expr}" names a prop the package destructures`, `props: ${[...allProps].join(", ") || "none found"}`);
    }
  }
}

// ---- 6. copy --------------------------------------------------------------------------------

// The concept is the approved specification. Verifying only that contract copy appears in the
// markup lets a package built from a SUPERSEDED concept pass: ids line up, blocks line up, and
// the stale string is present in both contract and markup. So reconcile against the concept.
if (contract) {
  const contractCopy = new Map((contract.copy ?? []).map((c) => [c.id, c]));
  for (const b of conceptBlocks) {
    for (const id of b.copy) {
      if (!contractCopy.has(id)) {
        fatal("copy", `${b.id}: the approved concept declares copy ${id}, which is not in contract.copy`, "the package may have been built from a superseded concept");
      }
    }
  }
  for (const [id, text] of conceptCopy) {
    const row = contractCopy.get(id);
    const norm = (x) => x.replace(/\s+/g, " ").trim();
    if (row && row.text && norm(row.text) !== norm(text)) {
      fatal("copy", `copy ${id} differs from the approved concept`, `concept: ${JSON.stringify(text.slice(0, 40))} · contract: ${JSON.stringify(row.text.slice(0, 40))}`);
    }
  }
}

if (contract) {
  for (const c of contract.copy ?? []) {
    if (c.verbatimInMarkup === false) continue;
    if (!c.text) continue;
    // Search the MARKUP only — contract.json quotes every string, so searching the whole
    // package would make this check pass trivially.
    if (!svelteText.includes(c.text)) fatal("copy", `copy ${c.id} does not appear verbatim in the markup`, c.text.slice(0, 60));
  }
}

// ---- 7. icons -------------------------------------------------------------------------------

if (contract && (contract.icons ?? []).length) {
  const sprite = opts.sprite ? resolve(opts.sprite) : null;
  if (sprite && existsSync(sprite)) {
    const spriteText = readFileSync(sprite, "utf8");
    for (const id of contract.icons) {
      if (!new RegExp(`id=["']${id}["']`).test(spriteText)) fatal("icons", `sprite has no symbol #${id}`);
    }
  } else {
    warn("icons", "sprite not given (--sprite) — icon existence not checked");
  }
  for (const id of contract.icons) {
    if (!new RegExp(`href=["']#${id}["']`).test(svelteText)) warn("icons", `contract lists icon #${id} but no element references it`);
  }
}

// ---- 8/9. files + HANDOFF -------------------------------------------------------------------

for (const f of ["mapping.md", "contract.json", "HANDOFF.md"]) {
  if (!existsSync(join(pkgDir, f))) fatal("files", `${f} is missing from the package`);
}
if (!pkgFiles.some((f) => /\+page\.svelte$/.test(f) || /routes?\//.test(f))) {
  warn("files", "no +page.svelte found — the package carries components only");
}
const handoffPath = join(pkgDir, "HANDOFF.md");
if (existsSync(handoffPath)) {
  const handoff = readFileSync(handoffPath, "utf8");
  const required = [
    /status and provenance/i, /load path/i, /public api/i, /markup contract/i, /behaviou?r spec/i,
    /payload/i, /deviations/i, /library defects|gaps to raise/i, /tests/i, /evidence/i, /gotchas/i,
    /open questions/i, /methodology rules applied/i, /unsure/i,
  ];
  const headings = handoff.split("\n").filter((l) => /^#{1,3} /.test(l)).join("\n");
  for (const re of required) if (!re.test(headings)) fatal("handoff", `HANDOFF.md has no section matching ${re}`);
}

// ---- 10. shell ------------------------------------------------------------------------------

for (const f of pkgFiles.filter((f) => [".svelte", ".css", ".js", ".ts"].includes(extname(f)))) {
  const rel = relative(runPath, f);
  const text = readFileSync(f, "utf8");
  if (/@import\s+["'][^"']*(tailwindcss|\/source|\/fonts|@fontsource)/.test(text)) {
    fatal("shell", `${rel} carries the stylesheet load path — that lives in the app shell (src/app.css), not the package`);
  }
  if (/sprite\.svg(\?raw|\?url)?["']/.test(text) && !/\+layout\.svelte$/.test(f)) {
    fatal("shell", `${rel} loads the icon sprite — the sprite is inlined once at the shell (+layout.svelte)`);
  }
  if (extname(f) === ".css") fatal("shell", `${rel}: the package carries no stylesheets`);
}

// ---- report ----------------------------------------------------------------------------------

const fails = findings.filter((f) => f.severity === "fail");
const warns = findings.filter((f) => f.severity === "warn");
const report = {
  runDir: relative(process.cwd(), runPath) || ".",
  package: relative(runPath, pkgDir),
  concept: conceptPath ? relative(runPath, conceptPath) : null,
  counts: {
    svelteFiles: svelteFiles.length,
    conceptBlocks: conceptBlocks.length,
    contractBlocks: contract?.blocks?.length ?? 0,
    states: contract?.states?.length ?? 0,
    copy: contract?.copy?.length ?? 0,
    props: allProps.size,
  },
  findings,
  verdict: fails.length ? "FAIL" : "PASS",
};
const outPath = resolve(opts.out ?? join(runPath, "handoff-check.json"));
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

const lines = [`HANDOFF-CHECK: ${report.verdict} | BLOCKS: ${report.counts.contractBlocks}/${report.counts.conceptBlocks} | STATES: ${report.counts.states} | COPY: ${report.counts.copy} | FAILURES: ${fails.length} | WARNINGS: ${warns.length}`];
for (const f of fails) lines.push(`  FAIL  [${f.check}] ${f.message}${f.detail ? ` — ${f.detail}` : ""}`);
for (const f of warns) lines.push(`  warn  [${f.check}] ${f.message}${f.detail ? ` — ${f.detail}` : ""}`);
lines.push(`  report: ${relative(process.cwd(), outPath)}`);
printCapped(lines, 40);
process.exit(report.verdict === "PASS" ? 0 : 1);
