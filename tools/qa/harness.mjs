/**
 * Val QA harness — the Playwright plumbing every Val QA spec needs, so the QA
 * agent writes only the behavior and requirement tests.
 *
 *   import { createSuite, statesFromManifest } from "<tools-dir>/qa/harness.mjs";
 *   import { registerStandingChecks } from "<tools-dir>/qa/standing.mjs";
 *
 *   const suite = createSuite({ runDir: import.meta.dirname });
 *   registerStandingChecks(suite, { states: statesFromManifest(suite.runDir) });
 *   suite.test("B01", "behaviors[0] …", async (page, ctx, api) => { … });
 *   await suite.run();     // writes 05-qa-report.md + 05-qa-report.json, exits 1 on failure
 *
 * Every test gets a FRESH browser context (no state leakage), console /
 * pageerror / failed-request collectors, `document.fonts.ready`, and — when the
 * page exposes it — `window.valPage`. The helpers encode the probe lessons that
 * cost a prior run 10 of its 11 first-run failures: park the mouse before
 * reading a rest style, accept outline OR box-shadow as a focus ring, never
 * page.fill() before a Tab pass, settle past the library's transitions.
 *
 * Plain Node + `playwright` (no @playwright/test).
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";

export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));

export class Ctx {
  constructor(id) {
    this.id = id;
    this.failures = [];
    this.notes = [];
    this.audit = [];
    this.errors = [];
    this.logs = [];
  }
  check(cond, selector, expected, actual) {
    if (!cond) this.failures.push({ selector, expected, actual: fmt(actual) });
    return !!cond;
  }
  eq(actual, expected, selector, what) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) this.failures.push({ selector, expected: `${what}: ${fmt(expected)}`, actual: fmt(actual) });
    return ok;
  }
  near(actual, expected, tol, selector, what) {
    const ok = typeof actual === "number" && Math.abs(actual - expected) <= tol;
    if (!ok) this.failures.push({ selector, expected: `${what}: ${expected} (±${tol})`, actual: fmt(actual) });
    return ok;
  }
  note(s) {
    this.notes.push(s);
  }
  /** Record a probe correction — goes to the report's "Spec audit" section. */
  probeFixed(s) {
    this.audit.push(s);
  }
}

// ---- page + helpers ------------------------------------------------------------------

export async function openPage(browser, ctx, url, { viewport = DEFAULT_VIEWPORT, dsf = 1, waitForValPage = "auto", timeout = 30000 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dsf });
  const page = await context.newPage();
  page.on("console", (m) => {
    ctx.logs.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") ctx.errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => ctx.errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => ctx.errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => {
    if (r.status() >= 400) ctx.errors.push(`http ${r.status()}: ${r.url()}`);
  });
  await page.goto(url, { waitUntil: "networkidle", timeout });
  await page.evaluate(() => document.fonts.ready);
  if (waitForValPage === true) await page.waitForFunction(() => !!window.valPage, null, { timeout: 5000 });
  else if (waitForValPage === "auto") {
    try {
      await page.waitForFunction(() => !!window.valPage, null, { timeout: 300 });
    } catch {}
  }
  return { page, context };
}

export const settle = (page, ms = 260) => page.waitForTimeout(ms);
export const style = (page, sel, prop, pseudo = null) => page.$eval(sel, (el, [prop, pseudo]) => getComputedStyle(el, pseudo)[prop], [prop, pseudo]);
export const rect = (page, sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, docTop: r.top + window.scrollY };
  });
/** Resolve a CSS custom property to the browser's computed colour string. */
export const resolveVar = (page, name) =>
  page.evaluate((n) => {
    const d = document.createElement("div");
    d.style.color = `var(${n})`;
    document.body.appendChild(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  }, name);
export const rotation = (page, sel) =>
  page.$eval(sel, (el) => {
    const cs = getComputedStyle(el);
    if (cs.rotate && cs.rotate !== "none") return Math.abs(parseFloat(cs.rotate));
    const t = cs.transform;
    if (!t || t === "none") return 0;
    const m = t.match(/matrix\(([^)]+)\)/);
    if (!m) return 0;
    const [a, b] = m[1].split(",").map(Number);
    return Math.abs(Math.round((Math.atan2(b, a) * 180) / Math.PI));
  });
export const visible = (page, sel) => page.locator(sel).first().isVisible();
export const isDisabled = (page, sel) => page.$eval(sel, (el) => el.disabled);
export const value = (page, sel) => page.$eval(sel, (el) => el.value);
export const checked = (page, sel) => page.$eval(sel, (el) => el.checked);
/** A focus ring may be an outline OR a box-shadow. */
export const ringOn = (page, sel) =>
  page.$eval(sel, (el) => {
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
  });
export const ringDesc = (page, sel) =>
  page.$eval(sel, (el) => {
    const cs = getComputedStyle(el);
    return `outline ${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}; box-shadow ${cs.boxShadow}`;
  });
/** Move the pointer to empty page margin so `:hover` is not left on the last element. */
export async function parkMouse(page) {
  const vp = page.viewportSize() ?? DEFAULT_VIEWPORT;
  await page.mouse.move(2, Math.floor(vp.height / 2));
}
export const activeDesc = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return "body";
    if (a.id) return a.id;
    if (a.type === "radio") return `${a.name}=${a.value}`;
    const cls = String(a.className || "").split(/\s+/).filter(Boolean)[0];
    return cls ? `${a.tagName.toLowerCase()}.${cls}` : a.tagName.toLowerCase();
  });

/**
 * Rendered-ink measurement of one element: screenshots it (at the page's own
 * device scale) and returns the non-background bounding box in DEVICE px plus
 * the darkest colour. `bg` defaults to the top-left pixel.
 */
export async function inkBBox(page, sel, { bg = null, threshold = 60 } = {}) {
  const buf = await page.locator(sel).first().screenshot();
  const png = PNG.sync.read(buf);
  const d = png.data;
  const base = bg ?? [d[0], d[1], d[2]];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let dark = Infinity;
  let darkest = null;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (Math.abs(r - base[0]) + Math.abs(g - base[1]) + Math.abs(b - base[2]) > threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      if (r + g + b < dark) {
        dark = r + g + b;
        darkest = [r, g, b];
      }
    }
  }
  const ink = x1 >= 0 ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
  return { width: png.width, height: png.height, bg: base, ink, darkest };
}

/**
 * Tab through the page from `body` and assert (a) the focus order equals the
 * DOM order of visible, enabled focusables (radio groups count once) and (b)
 * every stop shows a computed-style delta on its focus target. Call it on a
 * FRESH page with nothing focused — never after page.fill().
 *
 * `focusTargetMap` maps a focusable's selector to the ancestor that paints the
 * ring (e.g. { "input.text-field-input": ".text-field-box" }).
 */
export async function tabPass(page, ctx, { label = "tab", focusTargetMap = {}, maxSteps = 200 } = {}) {
  const start = await activeDesc(page);
  ctx.eq(start, "body", `Tab start (${label})`, "nothing focused before the pass");
  await page.evaluate(() => window.scrollTo(0, 0));

  const expected = await page.evaluate(() => {
    const desc = (a) => {
      if (a.id) return a.id;
      if (a.type === "radio") return `${a.name}=${a.value}`;
      const cls = String(a.className || "").split(/\s+/).filter(Boolean)[0];
      return cls ? `${a.tagName.toLowerCase()}.${cls}` : a.tagName.toLowerCase();
    };
    const out = [];
    const groups = new Set();
    for (const el of document.querySelectorAll("button, input, textarea, select, a[href], [tabindex], [contenteditable]")) {
      if (el.disabled || el.type === "hidden" || el.tabIndex < 0 || el.closest("[hidden]") || el.getClientRects().length === 0) continue;
      if (el.type === "radio") {
        if (groups.has(el.name)) continue;
        groups.add(el.name);
        const ch = document.querySelector(`input[type="radio"][name="${el.name}"]:checked`);
        out.push(desc(ch || el));
        continue;
      }
      out.push(desc(el));
    }
    return out;
  });

  const snapshot = () =>
    page.evaluate((map) => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      let target = a;
      for (const [sel, anc] of Object.entries(map)) {
        if (a.matches(sel)) {
          target = a.closest(anc) || a;
          break;
        }
      }
      const cs = getComputedStyle(target);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow, borderColor: cs.borderColor, backgroundColor: cs.backgroundColor };
    }, focusTargetMap);
  const baseline = await page.evaluate((map) => {
    const out = {};
    const desc = (a) => {
      if (a.id) return a.id;
      if (a.type === "radio") return `${a.name}=${a.value}`;
      const cls = String(a.className || "").split(/\s+/).filter(Boolean)[0];
      return cls ? `${a.tagName.toLowerCase()}.${cls}` : a.tagName.toLowerCase();
    };
    for (const el of document.querySelectorAll("button, input, textarea, select, a[href], [tabindex], [contenteditable]")) {
      if (el.type === "hidden") continue;
      let target = el;
      for (const [sel, anc] of Object.entries(map)) {
        if (el.matches(sel)) {
          target = el.closest(anc) || el;
          break;
        }
      }
      const cs = getComputedStyle(target);
      out[desc(el)] = { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow, borderColor: cs.borderColor, backgroundColor: cs.backgroundColor };
    }
    return out;
  }, focusTargetMap);

  const seq = [];
  const noFocusStyle = [];
  for (let i = 0; i < Math.min(maxSteps, expected.length + 3); i++) {
    await page.keyboard.press("Tab");
    await settle(page, 320);
    const d = await activeDesc(page);
    if (d === "body") break;
    seq.push(d);
    const now = await snapshot();
    const base = baseline[d];
    if (!now || !base || JSON.stringify(now) === JSON.stringify(base)) noFocusStyle.push(d);
    if (seq.length > expected.length + 1) break;
  }
  ctx.eq(seq, expected, `Tab order (${label})`, "focus order equals DOM order of visible, enabled focusables");
  ctx.eq(noFocusStyle, [], `focus style (${label})`, "every Tab stop shows a computed-style delta (outline, box-shadow, border or background)");
  return { expected, seq, noFocusStyle };
}

// ---- states ------------------------------------------------------------------------------

/**
 * Build the standing checks' `states` from the run manifest: the primary frame
 * is the page as loaded; every other frame is applied through
 * window.valPage.applyState(<state>).
 */
export function statesFromManifest(runDir) {
  const p = join(resolve(runDir), "manifest.json");
  if (!existsSync(p)) return [{ name: "default", apply: null }];
  const m = JSON.parse(readFileSync(p, "utf8"));
  const frames = Array.isArray(m?.input?.frames) && m.input.frames.length ? m.input.frames : [{ state: "default" }];
  return frames.map((f, i) => ({
    name: f.state ?? (i === 0 ? "default" : `state-${i}`),
    apply: i === 0 ? null : async (page) => page.evaluate((s) => window.valPage.applyState(s), f.state ?? `state-${i}`),
  }));
}

// ---- suite ----------------------------------------------------------------------------------

export function createSuite({ runDir, pageUrl, reportPath, viewport = DEFAULT_VIEWPORT, dsf = 1, settleMs = 260, title = "Val QA" } = {}) {
  const dir = runDir ? resolve(runDir) : process.cwd();
  const url = pageUrl ?? pathToFileURL(join(dir, "04-build", "index.html")).href;
  const report = reportPath ?? join(dir, "05-qa-report.md");
  const tests = [];
  const afterAll = [];

  const suite = {
    runDir: dir,
    pageUrl: url,
    viewport,
    dsf,
    settleMs,
    test(id, name, fn, { skip = false } = {}) {
      tests.push({ id, name, fn, skip });
    },
    /** fn(results, ctxs) → optional extra row { id, name, ok, failures } */
    afterAll(fn) {
      afterAll.push(fn);
    },
    async run({ only = null, exitOnFailure = true } = {}) {
      const browser = await chromium.launch();
      const results = [];
      const ctxs = [];
      const started = Date.now();
      try {
        for (const t of tests) {
          if (only && !only.includes(t.id)) {
            results.push({ id: t.id, name: t.name, result: "SKIP", failures: [], notes: ["not in --only"], audit: [] });
            continue;
          }
          if (t.skip) {
            results.push({ id: t.id, name: t.name, result: "SKIP", failures: [], notes: [typeof t.skip === "string" ? t.skip : "skipped"], audit: [] });
            continue;
          }
          const ctx = new Ctx(t.id);
          ctxs.push(ctx);
          const api = makeApi(browser, ctx, suite);
          let opened = null;
          try {
            opened = await openPage(browser, ctx, url, { viewport, dsf });
            await t.fn(opened.page, ctx, api);
          } catch (e) {
            ctx.failures.push({ selector: "(test)", expected: "no exception", actual: e.message });
          } finally {
            try {
              await opened?.context.close();
            } catch {}
            for (const c of api._extraContexts) {
              try {
                await c.close();
              } catch {}
            }
          }
          results.push({ id: t.id, name: t.name, result: ctx.failures.length ? "FAIL" : "PASS", failures: ctx.failures, notes: ctx.notes, audit: ctx.audit });
        }
        for (const fn of afterAll) {
          const row = await fn(results, ctxs);
          if (row) results.push({ id: row.id, name: row.name, result: row.ok ? "PASS" : "FAIL", failures: row.failures ?? [], notes: row.notes ?? [], audit: [] });
        }
      } finally {
        await browser.close();
      }
      const failed = results.filter((r) => r.result === "FAIL");
      const ran = results.filter((r) => r.result !== "SKIP");
      const md = renderReport({ title, results, ran, failed, url, seconds: Math.round((Date.now() - started) / 100) / 10 });
      writeFileSync(report, md);
      writeFileSync(report.replace(/\.md$/, ".json"), JSON.stringify({ results, consoleErrors: ctxs.flatMap((c) => c.errors.map((e) => ({ test: c.id, error: e }))) }, null, 2));
      console.log(`QA: ${failed.length ? "FAIL" : "PASS"} | TESTS: ${ran.length} | FAILURES: ${failed.length} — ${report}`);
      for (const r of failed.slice(0, 10)) console.log(`  ✗ ${r.id} ${r.name}: ${r.failures[0]?.expected ?? ""} — got ${r.failures[0]?.actual ?? ""}`);
      if (exitOnFailure && failed.length) process.exitCode = 1;
      return { passed: ran.length - failed.length, failed: failed.length, results };
    },
  };
  return suite;
}

function makeApi(browser, ctx, suite) {
  const api = {
    browser,
    settle: (page, ms = suite.settleMs) => settle(page, ms),
    style,
    rect,
    resolveVar,
    rotation,
    visible,
    isDisabled,
    value,
    checked,
    ringOn,
    ringDesc,
    parkMouse,
    activeDesc,
    inkBBox,
    tabPass: (page, opts) => tabPass(page, ctx, opts),
    _extraContexts: [],
    /** Open another fresh page in the same test (e.g. one per state for a Tab pass). */
    async open(opts = {}) {
      const o = await openPage(browser, ctx, suite.pageUrl, { viewport: suite.viewport, dsf: suite.dsf, ...opts });
      api._extraContexts.push(o.context);
      return o.page;
    },
  };
  return api;
}

function renderReport({ title, results, ran, failed, url, seconds }) {
  const lines = [`# ${title}`, "", `Page: ${url} · ${ran.length} test(s) · ${seconds}s`, "", "| # | Test | Result |", "|---|---|---|"];
  for (const r of results) lines.push(`| ${r.id} | ${r.name.replace(/\|/g, "\\|")} | ${r.result} |`);
  lines.push("", `**${ran.length - failed.length} / ${ran.length} passed.**`, "", "## Failures", "");
  if (!failed.length) lines.push("None.");
  for (const r of failed) {
    lines.push(`### ${r.id} — ${r.name}`, "", "| Selector | Expected | Actual |", "|---|---|---|");
    for (const f of r.failures) lines.push(`| \`${f.selector}\` | ${String(f.expected).replace(/\|/g, "\\|")} | ${String(f.actual).replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  const audit = results.flatMap((r) => r.audit.map((a) => `- ${r.id}: ${a}`));
  lines.push("## Spec audit (probe corrections — expectations never loosened)", "", ...(audit.length ? audit : ["None."]), "");
  const notes = results.flatMap((r) => r.notes.map((n) => `- ${r.id}: ${n}`));
  if (notes.length) lines.push("## Notes", "", ...notes, "");
  return lines.join("\n");
}
