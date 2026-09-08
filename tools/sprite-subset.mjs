#!/usr/bin/env node
/**
 * Val tool — emit only the <symbol>s a page uses from an icon sprite, so the
 * build inlines 5 symbols instead of 2,000 (a prior page shipped a 536KB
 * index.html because the whole sprite was inlined).
 *
 * Usage: node <tools-dir>/sprite-subset.mjs <sprite.svg> (--used-by <html> | --ids a,b,c) [flags]
 *
 *   --used-by <html>   collect ids from href="#id" / xlink:href="#id" in the page
 *   --ids a,b,c        explicit ids (may be combined with --used-by)
 *   --out <file>       write the subset here (default: stdout)
 *   --id <svgId>       id attribute of the emitted <svg> (default val-sprite)
 *
 * Exits 1 when a requested id is not in the sprite (the page references a glyph
 * the library does not ship — a sprite gap to report, not to paper over).
 * Note: symbols that reference shared <defs> (gradients, filters) are rare in
 * icon sprites; if the source has a <defs> block it is carried over verbatim.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, fail } from "./lib/args.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const spritePath = positional[0];
if (!spritePath || (!opts["used-by"] && !opts.ids)) {
  fail("Usage: node <tools-dir>/sprite-subset.mjs <sprite.svg> (--used-by <html> | --ids a,b,c) [--out file] [--id val-sprite]");
}
if (!existsSync(resolve(spritePath))) fail(`Sprite not found: ${spritePath}`);
const sprite = readFileSync(resolve(spritePath), "utf8");

const symbols = new Map();
for (const m of sprite.matchAll(/<symbol\b[^>]*\bid=["']([^"']+)["'][^>]*>[\s\S]*?<\/symbol>/g)) {
  symbols.set(m[1], m[0]);
}
if (!symbols.size) fail(`No <symbol id="…"> elements found in ${spritePath}`);

const wanted = new Set();
if (opts["used-by"]) {
  const htmlPath = resolve(opts["used-by"]);
  if (!existsSync(htmlPath)) fail(`Page not found: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");
  // Ignore any sprite already inlined in the page: only <use> references count.
  for (const m of html.matchAll(/<use\b[^>]*\b(?:xlink:)?href=["']#([^"'#]+)["']/g)) wanted.add(m[1]);
}
if (opts.ids) for (const id of String(opts.ids).split(",").map((s) => s.trim()).filter(Boolean)) wanted.add(id);

const missing = [...wanted].filter((id) => !symbols.has(id));
const found = [...wanted].filter((id) => symbols.has(id)).sort();

const defs = sprite.match(/<defs\b[\s\S]*?<\/defs>/)?.[0] ?? "";
const svgId = opts.id ?? "val-sprite";
const out =
  `<svg xmlns="http://www.w3.org/2000/svg" id="${svgId}" aria-hidden="true" style="display:none">` +
  (defs ? `\n  ${defs}` : "") +
  found.map((id) => `\n  ${symbols.get(id)}`).join("") +
  `\n</svg>\n`;

if (opts.out) writeFileSync(resolve(opts.out), out);
else process.stdout.write(out);

const kb = (n) => `${Math.round((n / 1024) * 10) / 10}KB`;
console.error(
  `${found.length} of ${symbols.size} symbols kept (${kb(out.length)} of ${kb(sprite.length)})` +
    (missing.length ? `\nMISSING from sprite: ${missing.join(", ")} — a sprite gap; mark the page markup val:gap and propose the glyph` : ""),
);
process.exit(missing.length ? 1 : 0);
