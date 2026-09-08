#!/usr/bin/env node
/**
 * Val tool — the build gate's geometry self-check as one command.
 *
 * Usage: node <tools-dir>/geometry-check.mjs <run-dir> [flags]
 *
 *   --frame <state|index>   check one frame (default: primary)
 *   --all                   check every frame in manifest input.frames[]
 *   --tolerance <px>        allowed |Δ| per edge in CSS px (default 2)
 *   --regions <json>        selector map (default: <run-dir>/04-build/regions.json)
 *   --layout <json>         layout override (default: the frame's 01-extraction layout.json)
 *   --out <dir>             where to write reports (default: <run-dir>/04-build/)
 *
 * For each frame: renders 04-build/index.html at the frame's w×h (state driven
 * through window.valPage.applyState for frames[n>0]), then asserts
 *   (a) page size equals the frame and there is no scroll at load,
 *   (b) every region in layout.json lands within ±tolerance of its x/y/w/h,
 *   (c) zero console / page errors.
 *
 * Selector resolution for a layout region, in order:
 *   regions.json[frame.state][figmaNode] → regions.json[figmaNode]
 *   → [data-val-node="<figmaNode>"] in the page.
 * regions.json is written by the build agent: { "<figmaNode>": "<selector>", …,
 * "<state>": { "<figmaNode>": "<selector>" } } (per-state block optional).
 *
 * Writes: <out>/geometry-<state>.json and geometry-<state>.md. Prints ≤ 30
 * lines. Exit 1 on any failure, unmapped region, console error or size miss.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, fail, printCapped } from "./lib/args.mjs";
import { loadRun, selectFrame, loadLayout } from "./lib/manifest.mjs";

const { positional, opts } = parseArgs(process.argv.slice(2), { booleans: ["all"] });
const runDir = positional[0];
if (!runDir) fail("Usage: node <tools-dir>/geometry-check.mjs <run-dir> [--frame s | --all] [--tolerance px] [--regions json] [--layout json] [--out dir]");

let run;
try {
  run = loadRun(runDir);
} catch (e) {
  fail(e.message);
}
const { runPath, frames } = run;
const tolerance = opts.tolerance ? Number(opts.tolerance) : 2;
const targets = opts.all ? frames : [selectFrame(frames, opts.frame)];
const htmlPath = join(runPath, "04-build", "index.html");
if (!existsSync(htmlPath)) fail(`No build page at ${htmlPath}`);
const outDir = opts.out ? resolve(opts.out) : join(runPath, "04-build");
mkdirSync(outDir, { recursive: true });

const regionsPath = opts.regions ? resolve(opts.regions) : join(runPath, "04-build", "regions.json");
const regionsMap = existsSync(regionsPath) ? JSON.parse(readFileSync(regionsPath, "utf8")) : {};

function selectorFor(frame, figmaNode) {
  const perState = regionsMap[frame.state];
  if (perState && typeof perState === "object" && perState[figmaNode]) return { selector: perState[figmaNode], via: "regions.json" };
  if (typeof regionsMap[figmaNode] === "string") return { selector: regionsMap[figmaNode], via: "regions.json" };
  return { selector: `[data-val-node="${figmaNode}"]`, via: "data-val-node" };
}

const browser = await chromium.launch();
let anyFail = false;
const summaryLines = [];
try {
  for (const frame of targets) {
    const layout = opts.layout ? JSON.parse(readFileSync(resolve(opts.layout), "utf8")) : loadLayout(runPath, frame);
    if (!layout) {
      anyFail = true;
      summaryLines.push(`✗ ${frame.state}: no layout.json for this frame (expected at 01-extraction${frame.index ? `/frames/${frame.state}` : ""}/layout.json) — val-figma must produce it, or pass --layout`);
      continue;
    }
    const width = frame.w ?? layout.w;
    const height = frame.h ?? layout.h;
    if (!width || !height) {
      anyFail = true;
      summaryLines.push(`✗ ${frame.state}: frame w/h unknown (manifest frames[] and layout.json both lack them)`);
      continue;
    }

    const errors = [];
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.push(`[console.error] ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    if (frame.index > 0) {
      const ok = await page.evaluate((s) => {
        if (!window.valPage?.applyState) return false;
        window.valPage.applyState(s);
        document.activeElement?.blur?.();
        return true;
      }, frame.state);
      if (!ok) errors.push(`[contract] window.valPage.applyState missing — cannot drive state "${frame.state}"`);
    }
    await page.waitForTimeout(150);

    const dims = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      cw: document.documentElement.clientWidth,
      ch: document.documentElement.clientHeight,
    }));
    const noScroll = dims.w <= dims.cw && dims.h <= dims.ch;
    const sizeOk = Math.abs(dims.w - width) <= tolerance && Math.abs(dims.h - height) <= tolerance;

    const rows = [];
    for (const r of layout.regions ?? []) {
      const { selector, via } = selectorFor(frame, r.figmaNode);
      let box = null;
      try {
        const loc = page.locator(selector).first();
        if ((await loc.count()) > 0) box = await loc.boundingBox();
      } catch {}
      if (!box) {
        rows.push({ figmaNode: r.figmaNode, name: r.name, kind: r.kind ?? null, selector, via, status: "unmapped", expected: r, measured: null, delta: null });
        continue;
      }
      const m = { x: round2(box.x), y: round2(box.y), w: round2(box.width), h: round2(box.height) };
      const d = { dx: round2(m.x - r.x), dy: round2(m.y - r.y), dw: round2(m.w - r.w), dh: round2(m.h - r.h) };
      const ok = Object.values(d).every((v) => Math.abs(v) <= tolerance);
      rows.push({ figmaNode: r.figmaNode, name: r.name, kind: r.kind ?? null, selector, via, status: ok ? "ok" : "fail", expected: { x: r.x, y: r.y, w: r.w, h: r.h }, measured: m, delta: d });
    }
    await context.close();

    const failRows = rows.filter((x) => x.status === "fail");
    const unmapped = rows.filter((x) => x.status === "unmapped");
    const okCount = rows.length - failRows.length - unmapped.length;
    const frameOk = sizeOk && noScroll && !failRows.length && !unmapped.length && !errors.length;
    if (!frameOk) anyFail = true;

    const result = {
      frame: frame.id ?? null,
      state: frame.state,
      tolerance,
      viewport: { width, height },
      page: { ...dims, noScroll, sizeOk },
      regions: rows,
      counts: { ok: okCount, fail: failRows.length, unmapped: unmapped.length },
      consoleErrors: errors,
      verdict: frameOk ? "PASS" : "FAIL",
    };
    writeFileSync(join(outDir, `geometry-${frame.state}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, `geometry-${frame.state}.md`), toMarkdown(result));

    summaryLines.push(
      `${frameOk ? "✓" : "✗"} ${frame.state}: page ${dims.w}x${dims.h} (frame ${width}x${height}) scroll:${noScroll ? "none" : "YES"} | regions ${okCount} ok / ${failRows.length} fail / ${unmapped.length} unmapped | console errors ${errors.length}`,
    );
    for (const x of failRows.slice(0, 12)) {
      summaryLines.push(`    ✗ ${x.name} (${x.figmaNode}) ${x.selector} — Δ dx ${x.delta.dx} dy ${x.delta.dy} dw ${x.delta.dw} dh ${x.delta.dh}`);
    }
    for (const x of unmapped.slice(0, 6)) {
      summaryLines.push(`    ? ${x.name} (${x.figmaNode}) — no element for ${x.selector} (${x.via})`);
    }
    for (const e of errors.slice(0, 3)) summaryLines.push(`    ! ${e}`);
  }
} finally {
  await browser.close();
}

summaryLines.push(`Reports: ${outDir}/geometry-<state>.{json,md}`);
printCapped(summaryLines, 30);
process.exit(anyFail ? 1 : 0);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toMarkdown(r) {
  const lines = [
    `# Geometry check — ${r.state}${r.frame ? ` (${r.frame})` : ""}`,
    "",
    `Viewport ${r.viewport.width}x${r.viewport.height} · page ${r.page.w}x${r.page.h} · scroll at load: ${r.page.noScroll ? "none ✓" : "YES ✗"} · tolerance ±${r.tolerance}px · **${r.verdict}**`,
    "",
    "| Region | Node | Selector | Expected x,y,w,h | Measured | Δ | ✓/✗ |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const x of r.regions) {
    const e = x.expected;
    const exp = `${e.x},${e.y},${e.w},${e.h}`;
    const meas = x.measured ? `${x.measured.x},${x.measured.y},${x.measured.w},${x.measured.h}` : "NOT FOUND";
    const d = x.delta ? `${x.delta.dx},${x.delta.dy},${x.delta.dw},${x.delta.dh}` : "—";
    lines.push(`| ${x.name} | ${x.figmaNode} | \`${x.selector}\` | ${exp} | ${meas} | ${d} | ${x.status === "ok" ? "✓" : x.status === "fail" ? "✗" : "?"} |`);
  }
  lines.push("", `Console errors: ${r.consoleErrors.length ? r.consoleErrors.join("; ") : "none"}`);
  return lines.join("\n") + "\n";
}
