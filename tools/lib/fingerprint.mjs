/**
 * Structural fingerprint of a Figma frame, from a structure snapshot written by
 * tools/figma/structure-snapshot.js (run read-only through use_figma).
 *
 * What it covers: the node tree (parent + child order + type + visibility), instance main
 * components and their variant/instance properties, every variable binding (node, paint,
 * effect), style ids, and auto-layout container and child props. What it ignores: layer
 * names (a rename changes nothing a later stage consumes) and anything that only shows up as
 * pixels — the pixel diff owns those. The point is the case pixels cannot see: a fill rebound
 * from one variable to another with the same value renders identically and is still a change,
 * because figma.json would carry the stale binding into every later stage.
 */
import { createHash } from "node:crypto";

export const FINGERPRINT_VERSION = 1;
const HASHED = [
  "parent", "index", "type", "visible", "mainComponent", "componentProperties",
  "boundVariables", "fillBindings", "strokeBindings", "effectBindings", "styles",
  "layout", "childLayout",
];

/** Deterministic JSON: object keys sorted at every depth, array order kept. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** snapshot { version, frame, nodes[] } → fingerprint { version, frame, hash, nodes{id: entry}, names{id: name} } */
export function fingerprint(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) {
    throw new Error("fingerprint: expected a structure snapshot with a nodes[] array");
  }
  const nodes = {};
  const names = {};
  for (const n of snapshot.nodes) {
    if (!n.id) throw new Error("fingerprint: snapshot node without an id");
    if (nodes[n.id]) throw new Error(`fingerprint: duplicate node id ${n.id}`);
    const entry = {};
    for (const k of HASHED) if (n[k] !== undefined) entry[k] = n[k];
    nodes[n.id] = entry;
    if (n.name !== undefined) names[n.id] = n.name;
  }
  const ids = Object.keys(nodes).sort();
  const hash = sha(canonical({ v: FINGERPRINT_VERSION, frame: snapshot.frame, nodes: ids.map((id) => [id, nodes[id]]) }));
  return { version: FINGERPRINT_VERSION, frame: snapshot.frame, hash, nodeCount: ids.length, nodes, names };
}

/** Accept either a stored fingerprint or a raw snapshot. */
export function asFingerprint(obj) {
  if (obj && Array.isArray(obj.nodes)) return fingerprint(obj);
  if (obj && obj.hash && obj.nodes && typeof obj.nodes === "object") {
    if (obj.version !== FINGERPRINT_VERSION) {
      throw new Error(`fingerprint: version ${obj.version} is not ${FINGERPRINT_VERSION} — re-fingerprint the snapshot`);
    }
    return obj;
  }
  throw new Error("fingerprint: neither a structure snapshot nor a fingerprint");
}

/** Per-node structural diff: which nodes appeared, disappeared, or changed which fields. */
export function diffFingerprints(a, b) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const id of Object.keys(a.nodes)) {
    if (!b.nodes[id]) {
      removed.push({ id, name: a.names?.[id] });
      continue;
    }
    const fields = [];
    const keys = new Set([...Object.keys(a.nodes[id]), ...Object.keys(b.nodes[id])]);
    for (const k of [...keys].sort()) {
      const x = a.nodes[id][k];
      const y = b.nodes[id][k];
      if (canonical(x) !== canonical(y)) fields.push({ field: k, before: x ?? null, after: y ?? null });
    }
    if (fields.length) changed.push({ id, name: b.names?.[id] ?? a.names?.[id], fields });
  }
  for (const id of Object.keys(b.nodes)) if (!a.nodes[id]) added.push({ id, name: b.names?.[id] });
  return { same: a.hash === b.hash, added, removed, changed };
}
