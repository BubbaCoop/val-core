#!/usr/bin/env node
/**
 * Val tool — render 04-build/index.html and capture a full-page PNG at the
 * run's export scale.
 *
 * Usage: node <tools-dir>/screenshot.mjs <run-dir>
 *
 * Reads:  <run-dir>/manifest.json   (input.frame.w, input.exportScale)
 *         <run-dir>/04-build/index.html
 * Writes: <run-dir>/06-accuracy/build@2x.png
 *         <run-dir>/06-accuracy/console.log   (always; empty if no errors)
 *
 * Exits non-zero if the page fails to load.
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: node <tools-dir>/screenshot.mjs <run-dir>");
  process.exit(1);
}

const runPath = resolve(runDir);
const manifestPath = join(runPath, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`No manifest.json in ${runPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const frame = manifest?.input?.frame;
const exportScale = manifest?.input?.exportScale ?? 2;

if (!frame || !frame.w) {
  console.error(
    "manifest.json input.frame.w is missing — the extraction stage must record the frame dimensions first.",
  );
  process.exit(1);
}

const htmlPath = join(runPath, "04-build", "index.html");
if (!existsSync(htmlPath)) {
  console.error(`No build page at ${htmlPath}`);
  process.exit(1);
}

const outDir = join(runPath, "06-accuracy");
mkdirSync(outDir, { recursive: true });

const consoleLines = [];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: frame.w, height: frame.h || 800 },
    deviceScaleFactor: exportScale,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleLines.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleLines.push(`[pageerror] ${err.message}`);
  });

  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Wait for webfonts so text renders in its final face before capture.
  await page.evaluate(() => document.fonts.ready);
  // One settle frame for any load-triggered transitions.
  await page.waitForTimeout(150);

  await page.screenshot({
    path: join(outDir, "build@2x.png"),
    fullPage: true,
  });

  writeFileSync(join(outDir, "console.log"), consoleLines.join("\n"));

  console.log(
    `Captured ${join(outDir, "build@2x.png")} at ${frame.w}px viewport × ${exportScale}x` +
      (consoleLines.length
        ? ` — ${consoleLines.length} console error(s), see console.log`
        : " — no console errors"),
  );
} catch (err) {
  // Still record whatever console output we saw before the failure.
  try {
    writeFileSync(join(outDir, "console.log"), consoleLines.join("\n"));
  } catch {}
  console.error(`Page failed to load: ${err.message}`);
  process.exit(1);
} finally {
  await browser.close();
}
