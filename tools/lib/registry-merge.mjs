/**
 * Pure helpers for generate-registry.mjs, split out so they can be tested
 * without running the generator.
 */

/**
 * The values of one literal `options: [ ... ]` array, as strings. Each quoted
 * string is matched whole (so `""` cannot pair its closing quote with the next
 * value's opening one) and numbers are read too (`options: [1, 3, 5]`). An
 * empty string is a control's "none" choice, not a variant, and is dropped.
 */
export function parseOptionValues(arrayBody) {
  const token = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|(-?\d+(?:\.\d+)?)/g;
  const values = [];
  for (const t of arrayBody.matchAll(token)) {
    const v = t[1] ?? t[2] ?? t[3] ?? t[4];
    if (v !== "") values.push(v);
  }
  return values;
}

/**
 * Regenerated axes win; an axis only the previous registry has is kept. Figma
 * boolean axes (an Error or Search variant) have no story `options` array to
 * derive from, so they can only be hand-added — and must survive a rerun.
 * Remove a stale axis by editing the JSON.
 */
export function mergeVariants(next = {}, prev = {}) {
  const merged = { ...next };
  for (const [axis, values] of Object.entries(prev)) {
    if (!(axis in merged)) merged[axis] = values;
  }
  return merged;
}
