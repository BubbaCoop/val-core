#!/usr/bin/env node
/**
 * Val tool — fingerprint a frame's structure snapshot so a later re-run can compare it.
 * Costs no model tokens.
 *
 * Usage: node <tools-dir>/frame-fingerprint.mjs <structure-snapshot.json> [--out fingerprint.json]
 *
 * The snapshot comes from tools/figma/structure-snapshot.js, run read-only through use_figma.
 * val-figma stores the result beside each extraction as
 * 01-extraction/[frames/<state>/]fingerprint.json; frame-diff.mjs compares two of them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs, fail } from "./lib/args.mjs";
import { fingerprint } from "./lib/fingerprint.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const src = positional[0];
if (!src) fail("Usage: node frame-fingerprint.mjs <structure-snapshot.json> [--out fingerprint.json]");
if (!existsSync(src)) fail(`frame-fingerprint: no such file ${src}`);

let fp;
try {
  fp = fingerprint(JSON.parse(readFileSync(src, "utf8")));
} catch (e) {
  fail(`frame-fingerprint: ${e.message}`);
}
if (opts.out) writeFileSync(opts.out, JSON.stringify(fp, null, 2) + "\n");

const entries = Object.values(fp.nodes);
const bindings = entries.filter((n) => n.boundVariables || n.fillBindings || n.strokeBindings || n.effectBindings).length;
const instances = entries.filter((n) => n.type === "INSTANCE").length;
console.log(
  `FINGERPRINT: ${fp.hash.slice(0, 12)} | FRAME: ${fp.frame} | NODES: ${fp.nodeCount} | INSTANCES: ${instances} | BOUND: ${bindings}`,
);
