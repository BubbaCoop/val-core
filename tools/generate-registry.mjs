#!/usr/bin/env node
/**
 * Val registry generator — walks a library repo's Storybook stories and
 * component sources and writes the component registry JSON.
 *
 * Usage: node <tools-dir>/generate-registry.mjs [repo-root]
 *
 * repo-root defaults to the current working directory. Paths are read from
 * <repo-root>/val/config.json (paths.storiesDir, paths.componentsDir,
 * paths.componentRegistry) and fall back to the Valiify library layout:
 *   stories/components/<PascalName>.stories.ts
 *   src/components/<kebab-name>.css
 *   val/registry/components.json
 *
 * This file lives in @valiify/val-core and is reached through the val/tools
 * symlink, so it must never locate the repo from its own import.meta.url.
 *
 * Merge contract: on regeneration, hand-added `behaviors`, `tokens`,
 * `figmaNodeIds`, and `figmaNames` (Figma set-name aliases for components
 * whose Figma names don't equal the registry key — "Button / Standard",
 * "Box action", "Application Status"…) in an existing components.json are
 * MERGED (union), never overwritten. Generated fields (path, story,
 * variants, props) are refreshed.
 *
 * Extraction is deliberately partial rather than clever: variants come from
 * argTypes `options` arrays, props from argTypes/args keys, behaviors from
 * behavior-shaped sentences in story docs descriptions where present.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());

// ---- config -------------------------------------------------------------------

const DEFAULT_PATHS = {
  storiesDir: "stories/components",
  componentsDir: "src/components",
  componentRegistry: "val/registry/components.json",
};

let paths = { ...DEFAULT_PATHS };
const configPath = join(repoRoot, "val", "config.json");
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  paths = { ...paths, ...(config.paths ?? {}) };
} else {
  console.warn(
    `WARNING: ${configPath} not found — using default Valiify layout paths.`,
  );
}

const storiesDir = join(repoRoot, paths.storiesDir);
const componentsDirRel = paths.componentsDir.replace(/\/$/, "");
const outPath = join(repoRoot, paths.componentRegistry);

if (!existsSync(storiesDir)) {
  console.error(`Stories directory not found: ${storiesDir}`);
  process.exit(1);
}

// ---- helpers ----------------------------------------------------------------

/** PascalCase -> kebab-case, matching the libraries' css file naming. */
function kebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Storybook export name -> story id fragment (AllVariants -> all-variants). */
function storyIdFragment(exportName) {
  return kebab(exportName);
}

/**
 * Extract a balanced { ... } block that starts at the first `{` at or after
 * `startIdx`. Returns the inner text (without the outer braces) or null.
 * String-literal aware enough for these story files.
 */
function balancedBlock(src, startIdx) {
  const open = src.indexOf("{", startIdx);
  if (open === -1) return null;
  let depth = 0;
  let inString = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Parse `options: [ ... ]` arrays inside an argTypes block, keyed by arg. */
function parseArgTypes(argTypesBlock) {
  const variants = {};
  const props = [];
  // Top-level entries look like `argName: {`.
  const entryRe = /(?:^|\n)\s{4}(\w+):\s*{/g;
  let m;
  while ((m = entryRe.exec(argTypesBlock))) {
    const argName = m[1];
    props.push(argName);
    const entryBody = balancedBlock(argTypesBlock, m.index + m[0].length - 1);
    if (!entryBody) continue;
    const optMatch = entryBody.match(/options:\s*\[([\s\S]*?)\]/);
    if (optMatch) {
      const values = [...optMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(
        (v) => v[1],
      );
      if (values.length) variants[argName] = values;
    }
  }
  return { variants, props };
}

/** Keys of the meta-level `args: { ... }` block. */
function parseArgsKeys(argsBlock) {
  return [...argsBlock.matchAll(/(?:^|\n)\s{4}(\w+):/g)].map((m) => m[1]);
}

/**
 * Pull behavior-shaped sentences out of a docs description, where present.
 * Anything that doesn't match stays out — partial beats invented.
 */
function extractBehaviors(text) {
  if (!text) return [];
  const behaviorRe =
    /\b(click|hover|toggle|rotat|expand|collaps|keyboard|focus|press|scroll|slide|dismiss|open|close)\w*/i;
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^[-*>\s]+/, "").trim())
    .filter((l) => l.length > 15 && l.length < 200 && behaviorRe.test(l))
    .slice(0, 8);
}

// ---- Code Connect scan --------------------------------------------------------

function findCodeConnectFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findCodeConnectFiles(full, found);
    else if (/\.figma\.(ts|tsx|js|jsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const codeConnectFiles = findCodeConnectFiles(repoRoot);
const codeConnectMap = {}; // componentName -> [nodeIds]
for (const file of codeConnectFiles) {
  const src = readFileSync(file, "utf8");
  const name = basename(file).replace(/\.figma\.\w+$/, "");
  const nodeIds = [
    ...src.matchAll(/node-id=([\d:%-]+)/g),
    ...src.matchAll(/figma\.com\/[^"'`]*?node-id=([\d:%-]+)/g),
  ].map((m) => decodeURIComponent(m[1]).replace("-", ":"));
  if (nodeIds.length) {
    codeConnectMap[name] = [...new Set(nodeIds)];
  }
}

// ---- walk stories ------------------------------------------------------------

const storyFiles = readdirSync(storiesDir).filter((f) =>
  f.endsWith(".stories.ts"),
);

const registry = {};
const warnings = [];

for (const file of storyFiles) {
  const componentName = file.replace(/\.stories\.ts$/, "");
  const src = readFileSync(join(storiesDir, file), "utf8");

  // Component source path — flat css file in the Valiify libraries.
  const cssPath = `${componentsDirRel}/${kebab(componentName)}.css`;
  if (!existsSync(join(repoRoot, cssPath))) {
    warnings.push(
      `${componentName}: expected source ${cssPath} not found — path left as-is, verify by hand`,
    );
  }

  // Story id: title "Components/X" + first story export.
  const titleMatch = src.match(/title:\s*["']([^"']+)["']/);
  const titlePath = (titleMatch?.[1] ?? `Components/${componentName}`)
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/\s+/g, "-");
  const firstExport = src.match(/export const (\w+):\s*Story/);
  const story = firstExport
    ? `${titlePath}--${storyIdFragment(firstExport[1])}`
    : null;
  if (!story) {
    warnings.push(`${componentName}: no story export found in ${file}`);
  }

  // argTypes -> variants + props
  let variants = {};
  let props = [];
  const argTypesIdx = src.search(/argTypes:\s*{/);
  if (argTypesIdx !== -1) {
    const block = balancedBlock(src, argTypesIdx);
    if (block) {
      const parsed = parseArgTypes(block);
      variants = parsed.variants;
      props = parsed.props;
    }
  }
  // meta-level args keys union into props
  const argsIdx = src.search(/\n  args:\s*{/);
  if (argsIdx !== -1) {
    const block = balancedBlock(src, argsIdx);
    if (block) {
      for (const key of parseArgsKeys(block)) {
        if (!props.includes(key)) props.push(key);
      }
    }
  }

  // behaviors from docs component description, where present
  let behaviors = [];
  const descIdx = src.search(/description:\s*{\s*\n?\s*component:\s*`/);
  if (descIdx !== -1) {
    const start = src.indexOf("`", descIdx);
    const end = src.indexOf("`", start + 1);
    if (start !== -1 && end !== -1) {
      behaviors = extractBehaviors(src.slice(start + 1, end));
    }
  }

  registry[componentName] = {
    path: cssPath,
    story,
    figmaNodeIds: codeConnectMap[componentName] ?? [],
    variants,
    behaviors,
    props,
    tokens: [],
  };
}

// ---- merge with existing (never clobber hand-added enrichment) ---------------

if (existsSync(outPath)) {
  const existing = JSON.parse(readFileSync(outPath, "utf8"));
  for (const [name, prev] of Object.entries(existing)) {
    if (!registry[name]) {
      // Component vanished from stories but has a hand-maintained entry: keep it.
      registry[name] = prev;
      warnings.push(
        `${name}: present in existing registry but no story found — entry preserved unchanged`,
      );
      continue;
    }
    const next = registry[name];
    for (const field of ["behaviors", "tokens", "figmaNodeIds", "figmaNames"]) {
      const merged = [...new Set([...(next[field] ?? []), ...(prev[field] ?? [])])];
      next[field] = merged;
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(registry, null, 2) + "\n");

// ---- report -------------------------------------------------------------------

const total = Object.keys(registry).length;
const unmapped = Object.entries(registry)
  .filter(([, e]) => e.figmaNodeIds.length === 0)
  .map(([n]) => n);

console.log(`Wrote ${outPath} — ${total} components.`);
if (codeConnectFiles.length === 0) {
  console.warn(
    "\nWARNING: no Code Connect (*.figma.ts) files found in this repo.",
  );
}
if (unmapped.length) {
  console.warn(
    `WARNING: ${unmapped.length} component(s) have no figmaNodeIds mapping:\n  ` +
      unmapped.join(", "),
  );
  console.warn(
    "Name-matching against Figma happens at run time in val-components; " +
      "add explicit ids here (hand-edits survive regeneration) or via Code Connect.",
  );
}
for (const w of warnings) console.warn(`WARNING: ${w}`);
