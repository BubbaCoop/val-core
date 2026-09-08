#!/usr/bin/env node
/**
 * Val tool — render 04-build/index.html and capture a full-page PNG.
 *
 * Usage: node <tools-dir>/screenshot.mjs <run-dir> [flags]
 *
 *   --frame <state|index>   which manifest input.frames[] entry (default: primary)
 *   --state <name>          call window.valPage.applyState(<name>) before capture
 *                           (default: the frame's state for frames[n>0])
 *   --setup <script.mjs>    ESM module whose default export is
 *                           async (page, { frame, manifest }) => {} — run before capture
 *   --scale <n>             device scale factor (default: the frame's reference
 *                           scale, else manifest input.exportScale)
 *   --out <dir>             output directory (default: 06-accuracy/ for the
 *                           primary, 06-accuracy/frames/<state>/ otherwise)
 *   --height <px>           viewport height (default: frame h, else 800)
 *
 * Reads:  <run-dir>/manifest.json, <run-dir>/04-build/index.html
 * Writes: <out>/build@2x.png, <out>/console.log (always), <out>/capture.json
 *
 * Exits non-zero if the page fails to load, or if a state is requested and the
 * page does not expose window.valPage.applyState.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, fail } from "./lib/args.mjs";
import { loadRun, selectFrame, accuracyDir, comparisonScale } from "./lib/manifest.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2));
const runDir = positional[0];
if (!runDir) fail("Usage: node <tools-dir>/screenshot.mjs <run-dir> [--frame s] [--state name] [--setup script.mjs] [--scale n] [--out dir] [--height px]");

let run;
try {
  run = loadRun(runDir);
} catch (e) {
  fail(e.message);
}
const { runPath, manifest, frames } = run;
const frame = selectFrame(frames, opts.frame);

const width = frame.w ?? manifest?.input?.frame?.w;
if (!width) {
  fail(
    "manifest input.frames[].w (or input.frame.w) is missing — the extraction stage must record the frame dimensions first.",
  );
}
const height = opts.height ? Number(opts.height) : frame.h || 800;
const scale = opts.scale ? Number(opts.scale) : comparisonScale(frame, manifest);
const state = opts.state ?? (frame.index > 0 ? frame.state : null);

const htmlPath = join(runPath, "04-build", "index.html");
if (!existsSync(htmlPath)) fail(`No build page at ${htmlPath}`);

const outDir = opts.out ? resolve(opts.out) : accuracyDir(runPath, frame);
mkdirSync(outDir, { recursive: true });

const consoleLines = [];
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleLines.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);

  if (state) {
    const ok = await page.evaluate((s) => {
      if (!window.valPage || typeof window.valPage.applyState !== "function") return false;
      window.valPage.applyState(s);
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      return true;
    }, state);
    if (!ok) {
      throw new Error(
        `state "${state}" requested but the page does not expose window.valPage.applyState — the build must implement the valPage contract for multi-state screens`,
      );
    }
  }
  if (opts.setup) {
    const mod = await import(pathToFileURL(resolve(opts.setup)).href);
    if (typeof mod.default !== "function") throw new Error(`${opts.setup} must default-export an async (page, ctx) function`);
    await mod.default(page, { frame, manifest, runPath });
  }

  // One settle frame for any state/load-triggered transitions.
  await page.waitForTimeout(150);
  const dims = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  }));

  const outPng = join(outDir, "build@2x.png");
  await page.screenshot({ path: outPng, fullPage: true });
  writeFileSync(join(outDir, "console.log"), consoleLines.join("\n"));
  writeFileSync(
    join(outDir, "capture.json"),
    JSON.stringify(
      { frame: frame.id ?? null, state: state ?? frame.state, scale, viewport: { width, height }, pageCssPx: dims, consoleErrors: consoleLines.length },
      null,
      2,
    ),
  );

  console.log(
    `Captured ${outPng} at ${width}px viewport × ${scale}x` +
      (state ? ` state=${state}` : "") +
      ` page=${dims.w}x${dims.h}` +
      (consoleLines.length ? ` — ${consoleLines.length} console error(s), see console.log` : " — no console errors"),
  );
} catch (err) {
  try {
    writeFileSync(join(outDir, "console.log"), consoleLines.join("\n"));
  } catch {}
  console.error(`Page failed to load: ${err.message}`);
  process.exit(1);
} finally {
  await browser.close();
}
