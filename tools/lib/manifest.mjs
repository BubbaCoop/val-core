/**
 * Run-manifest helpers shared by the Val tools.
 *
 * Understands both manifest shapes:
 *   0.1.x  input.figmaUrl + input.frame { id, name, w, h } + input.exportScale
 *   0.2+   input.frames[] { url, id, name, state, w, h, reference }
 *          (frames[0] is the primary and still mirrored into input.frame)
 *
 * Directory contract (frames[0] keeps the 0.1.x layout so nothing breaks):
 *   frames[0]  → 01-extraction/            06-accuracy/
 *   frames[n]  → 01-extraction/frames/<state>/   06-accuracy/frames/<state>/
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function loadRun(runDir) {
  const runPath = resolve(runDir);
  const manifestPath = join(runPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json in ${runPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { runPath, manifest, frames: resolveFrames(manifest) };
}

export function resolveFrames(manifest) {
  const input = manifest?.input ?? {};
  const legacy = input.frame ?? {};
  let frames =
    Array.isArray(input.frames) && input.frames.length
      ? input.frames.map((f) => ({ ...f }))
      : [
          {
            url: input.figmaUrl ?? null,
            id: legacy.id ?? null,
            name: legacy.name ?? null,
            state: "default",
            w: legacy.w ?? null,
            h: legacy.h ?? null,
            reference: null,
          },
        ];
  return frames.map((f, i) => ({
    ...f,
    index: i,
    state: f.state ?? (i === 0 ? "default" : `state-${i}`),
    // The primary frame may still carry its geometry only in the legacy mirror.
    w: f.w ?? (i === 0 ? legacy.w ?? null : null),
    h: f.h ?? (i === 0 ? legacy.h ?? null : null),
  }));
}

/** `key` may be undefined (primary), a numeric index, or a state name. */
export function selectFrame(frames, key) {
  if (key === undefined || key === null || key === "") return frames[0];
  if (/^\d+$/.test(String(key))) {
    const f = frames[Number(key)];
    if (!f) throw new Error(`No frame at index ${key} (manifest has ${frames.length})`);
    return f;
  }
  const f = frames.find((x) => x.state === key || x.id === key);
  if (!f) {
    throw new Error(
      `No frame with state "${key}" — manifest states: ${frames.map((x) => x.state).join(", ")}`,
    );
  }
  return f;
}

export function extractionDir(runPath, frame) {
  return frame.index === 0
    ? join(runPath, "01-extraction")
    : join(runPath, "01-extraction", "frames", frame.state);
}

export function accuracyDir(runPath, frame) {
  return frame.index === 0
    ? join(runPath, "06-accuracy")
    : join(runPath, "06-accuracy", "frames", frame.state);
}

/** The scale the orchestrator reconciled at Gate 1 (defaults to 2 as before). */
export function exportScale(manifest) {
  return manifest?.input?.exportScale ?? 2;
}

/** Resolve a manifest-relative path: absolute, run-relative, then cwd-relative. */
export function resolveRunPath(runPath, p) {
  if (!p) return null;
  if (isAbsolute(p)) return p;
  const inRun = join(runPath, p);
  if (existsSync(inRun)) return inRun;
  const inCwd = resolve(p);
  if (existsSync(inCwd)) return inCwd;
  return inRun;
}

/**
 * The best reference for a frame: the requester's true-2x export when the
 * extraction recorded one, else the frame's own MCP export at the achieved
 * scale. Returns { path, scale, source }.
 */
export function referenceFor(runPath, frame, manifest) {
  const ref = frame.reference;
  if (ref && ref.path) {
    return {
      path: resolveRunPath(runPath, ref.path),
      scale: ref.scale ?? 2,
      source: "requester-reference",
    };
  }
  return {
    path: join(extractionDir(runPath, frame), "exports", "page@2x.png"),
    scale: exportScale(manifest),
    source: "extraction-export",
  };
}

/** The device scale a comparison for this frame should run at. */
export function comparisonScale(frame, manifest) {
  return frame.reference?.scale ?? exportScale(manifest);
}

export function loadLayout(runPath, frame) {
  const p = join(extractionDir(runPath, frame), "layout.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Find a layout region by Figma node id across the frame's layout.json. */
export function regionByNode(layout, figmaNode) {
  return (layout?.regions ?? []).find((r) => r.figmaNode === figmaNode) ?? null;
}
