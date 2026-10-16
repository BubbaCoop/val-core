// Val — READ-ONLY structure snapshot of one Figma frame, for the use_figma tool.
// Agents pass this file's text verbatim, replacing __FRAME_ID__ with the frame's node id
// (e.g. 199:12008). It reads and returns; it never sets a property, creates, or deletes.
// The result is the input to tools/frame-fingerprint.mjs.
//
// Per node: tree position, type, visibility, instance main component + variant/instance
// properties, every variable binding (node-level, paint-level, effect-level) as variable ids,
// style ids, and auto-layout container/child props. Names are recorded for reporting only;
// the fingerprint ignores them. Absolute geometry and resolved colours are deliberately
// absent — the pixel diff owns what renders; this owns what it is bound to.

const FRAME_ID = "__FRAME_ID__";

const frame = await figma.getNodeByIdAsync(FRAME_ID);
if (!frame) throw new Error(`structure-snapshot: no node ${FRAME_ID}`);
let page = frame;
while (page && page.type !== "PAGE") page = page.parent;
if (page) await figma.setCurrentPageAsync(page);

const mixed = (v) => (typeof v === "symbol" ? "mixed" : v);

function aliases(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(aliases);
  if (typeof v === "object") {
    if (v.type === "VARIABLE_ALIAS") return v.id;
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const a = aliases(v[k]);
      if (a !== undefined) out[k] = a;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function paintBindings(paints) {
  if (!Array.isArray(paints)) return undefined;
  const out = paints.map((p) => aliases(p.boundVariables) ?? null);
  return out.some((x) => x) ? out : undefined;
}

const LAYOUT_KEYS = [
  "layoutMode", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight",
  "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems",
  "primaryAxisSizingMode", "counterAxisSizingMode", "layoutWrap", "itemReverseZIndex",
];
const CHILD_KEYS = ["layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "layoutGrow", "layoutAlign"];
const STYLE_KEYS = ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"];

const nodes = [];
async function walk(node, parentId, index) {
  const rec = { id: node.id, parent: parentId, index, type: node.type, name: node.name };
  if ("visible" in node) rec.visible = node.visible;

  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    rec.mainComponent = main ? main.id : null;
    const props = {};
    for (const [k, p] of Object.entries(node.componentProperties ?? {})) props[k] = { type: p.type, value: p.value };
    if (Object.keys(props).length) rec.componentProperties = props;
  }

  const bound = aliases(node.boundVariables);
  if (bound) rec.boundVariables = bound;
  const fills = "fills" in node ? paintBindings(mixed(node.fills) === "mixed" ? [] : node.fills) : undefined;
  if (fills) rec.fillBindings = fills;
  const strokes = "strokes" in node ? paintBindings(node.strokes) : undefined;
  if (strokes) rec.strokeBindings = strokes;
  if ("effects" in node && Array.isArray(node.effects)) {
    const eff = node.effects.map((e) => aliases(e.boundVariables) ?? null);
    if (eff.some((x) => x)) rec.effectBindings = eff;
  }

  const styles = {};
  for (const k of STYLE_KEYS) if (k in node && node[k]) styles[k] = mixed(node[k]);
  if (Object.keys(styles).length) rec.styles = styles;

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    const l = {};
    for (const k of LAYOUT_KEYS) if (k in node) l[k] = mixed(node[k]);
    rec.layout = l;
  }
  if (node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE") {
    const c = {};
    for (const k of CHILD_KEYS) if (k in node) c[k] = mixed(node[k]);
    rec.childLayout = c;
  }

  nodes.push(rec);
  if ("children" in node) {
    for (let i = 0; i < node.children.length; i++) await walk(node.children[i], node.id, i);
  }
}

await walk(frame, null, 0);
return { version: 1, frame: frame.id, frameName: frame.name, nodes };
