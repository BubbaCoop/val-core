/**
 * Tests for tools/lib/fingerprint.mjs and tools/frame-fingerprint.mjs.
 *
 * Fixture: tools/figma/plain-text-field.snapshot.json is a real snapshot — the Short App's
 * "Annual Revenue" Plain Text Field instance (199:12076, file PA5pr1Q8KLfbjTxdAbFm0V), taken
 * 2026-10-16 by running tools/figma/structure-snapshot.js verbatim through use_figma. Its "$"
 * glyph fill binds Neutral/Base (VariableID:1:117, #6F7276); Text/Tertiary (VariableID:1:73)
 * has the same value in that file, so rebinding one to the other is invisible in pixels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, diffFingerprints, canonical, asFingerprint } from "./lib/fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(join(HERE, "figma", "plain-text-field.snapshot.json"), "utf8"));
const GLYPH = "I199:12076;1:298;202:382";
const NEUTRAL_BASE = "VariableID:1:117";
const TEXT_TERTIARY = "VariableID:1:73";

const clone = () => structuredClone(SNAPSHOT);
const node = (s, id) => s.nodes.find((n) => n.id === id);

test("the same snapshot fingerprints identically, whatever its key order", () => {
  const shuffled = clone();
  shuffled.nodes = shuffled.nodes.reverse().map((n) => Object.fromEntries(Object.entries(n).reverse()));
  assert.equal(fingerprint(clone()).hash, fingerprint(shuffled).hash);
});

test("a same-colour variable rebind changes the fingerprint and names the field", () => {
  const rebound = clone();
  const g = node(rebound, GLYPH);
  g.boundVariables.fills = [TEXT_TERTIARY];
  g.fillBindings = [{ color: TEXT_TERTIARY }];
  const a = fingerprint(clone());
  const b = fingerprint(rebound);
  assert.notEqual(a.hash, b.hash);
  const d = diffFingerprints(a, b);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].id, GLYPH);
  assert.deepEqual(
    d.changed[0].fields.map((f) => f.field),
    ["boundVariables", "fillBindings"],
  );
  assert.deepEqual(d.changed[0].fields[0].before, { fills: [NEUTRAL_BASE] });
});

test("an auto-layout padding change is structural", () => {
  const s = clone();
  node(s, "I199:12076;1:297").layout.paddingLeft = 16;
  const d = diffFingerprints(fingerprint(clone()), fingerprint(s));
  assert.equal(d.changed[0].fields[0].field, "layout");
});

test("a variant property change is structural", () => {
  const s = clone();
  node(s, "199:12076").componentProperties.Filled.value = "yes";
  assert.equal(diffFingerprints(fingerprint(clone()), fingerprint(s)).changed[0].fields[0].field, "componentProperties");
});

test("an instance swapped to another main component is structural", () => {
  const s = clone();
  node(s, "I199:12076;1:298").mainComponent = "1:999";
  assert.equal(diffFingerprints(fingerprint(clone()), fingerprint(s)).changed[0].fields[0].field, "mainComponent");
});

test("a removed binding (height token detached to a raw value) is structural", () => {
  const s = clone();
  delete node(s, "I199:12076;1:297").boundVariables.height;
  const d = diffFingerprints(fingerprint(clone()), fingerprint(s));
  assert.deepEqual(d.changed[0].fields[0].after, { fills: ["VariableID:1:68"], strokes: ["VariableID:1:82"] });
});

test("an added or removed child is structural", () => {
  const s = clone();
  s.nodes = s.nodes.filter((n) => n.id !== "I199:12076;1:299");
  const d = diffFingerprints(fingerprint(clone()), fingerprint(s));
  assert.equal(d.removed[0].id, "I199:12076;1:299");
});

test("a layer rename is NOT structural — names are reported, not hashed", () => {
  const s = clone();
  node(s, "I199:12076;1:298").name = "DollarIcon";
  assert.equal(fingerprint(clone()).hash, fingerprint(s).hash);
  assert.equal(fingerprint(s).names["I199:12076;1:298"], "DollarIcon");
});

test("canonical() sorts keys at every depth and keeps array order", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: 0 } }), '{"a":{"c":0,"d":[2,1]},"b":1}');
});

test("asFingerprint accepts a stored fingerprint and rejects an unknown version", () => {
  const fp = fingerprint(clone());
  assert.equal(asFingerprint(JSON.parse(JSON.stringify(fp))).hash, fp.hash);
  assert.throws(() => asFingerprint({ ...fp, version: 99 }), /re-fingerprint/);
});

test("duplicate node ids are refused — a snapshot that lists one twice is malformed", () => {
  const s = clone();
  s.nodes.push(s.nodes[0]);
  assert.throws(() => fingerprint(s), /duplicate node id/);
});

test("frame-fingerprint CLI writes the fingerprint and prints its status line", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-"));
  const out = join(dir, "fingerprint.json");
  const r = spawnSync(
    process.execPath,
    [join(HERE, "frame-fingerprint.mjs"), join(HERE, "figma", "plain-text-field.snapshot.json"), "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^FINGERPRINT: [0-9a-f]{12} \| FRAME: 199:12076 \| NODES: 8 \| INSTANCES: 2 \| BOUND: 4/);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).hash, fingerprint(clone()).hash);
});
