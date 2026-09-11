/**
 * Resolve a CSS `@import` id to a file path, for Tailwind's loadStylesheet hook.
 *
 * Split out of class-audit so the one branch that has silently broken before can be tested
 * without a Tailwind install: a `file://` id must be decoded with fileURLToPath, never read
 * off URL.pathname. pathname keeps percent-encoding, so any repo whose path contains a
 * space produced ".../valiify%20shortapp%20library/..." and an ENOENT that was caught,
 * downgraded to an advisory, and left the audit printing PASS with no compile check at all.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export function stylesheetPath(id, { base, twDir }) {
  if (id === "tailwindcss") return join(twDir, "index.css");
  if (id.startsWith("tailwindcss/")) return join(twDir, id.slice("tailwindcss/".length));
  if (id.startsWith("file://")) return fileURLToPath(id);
  if (id.startsWith(".") || id.startsWith("/")) return resolve(base, id);
  return createRequire(join(base, "__resolve__.js")).resolve(id);
}

export { dirname };
