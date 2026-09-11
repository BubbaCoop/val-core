/**
 * Where a tool's JSON report goes — and when it must not be written at all.
 *
 * These tools are checks, and running a check must not mutate what it is checking. The
 * default report path sits beside the target, which is right when you audit your own run
 * and wrong the moment you point the tool at someone else's: a tracked fixture in another
 * repo picks up an unexplained diff, and the next `git status` is a puzzle.
 *
 * Rule:
 *   --no-write      never write
 *   --out <path>    explicit intent; always written, wherever it points
 *   (neither)       write beside the target ONLY if that lands inside the current working
 *                   directory. Outside it, skip and say why.
 *
 * An agent running a tool from its own repo root is unaffected — its run directory is
 * always inside the working directory.
 */
import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Compare real paths, not spellings. On macOS `process.cwd()` reports
 * /private/var/... while an argument naming the same directory reads /var/...,
 * and a run directory reached through any symlink hits the same mismatch — which
 * would silently classify a perfectly ordinary in-tree run as "outside".
 */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function resolveReport({ out, noWrite, defaultPath, cwd = process.cwd() }) {
  if (noWrite) return { path: null, reason: "--no-write" };
  if (out) return { path: resolve(out) };
  const dest = resolve(defaultPath);
  // The report file itself may not exist yet; resolve the directory that will hold it.
  const destReal = join(real(dirname(dest)), basename(dest));
  const rel = relative(real(cwd), destReal);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside) return { path: dest };
  return {
    path: null,
    reason: `target is outside the working directory — not writing ${dest}. A check does not write into a tree you are only inspecting; pass --out <path>, or run from that repo.`,
  };
}
