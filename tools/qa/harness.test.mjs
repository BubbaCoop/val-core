/**
 * Browser tests for the QA harness + standing checks. Skipped when Chromium is
 * not installed. A small two-state page with hover styles, a focus ring, an
 * aria-expanded menu, a sticky header and window.valPage.applyState — every
 * standing check should pass; a behavior test using the helpers should pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, statesFromManifest } from "./harness.mjs";
import { registerStandingChecks } from "./standing.mjs";

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

const PAGE = `<!doctype html><html><head><style>
  :root{--color-primary:rgb(30,77,140);--color-hover:rgb(60,120,200);--color-ring:rgb(255,140,0)}
  body{margin:0;font:14px sans-serif}
  header{position:sticky;top:0;height:48px;background:#eee}
  main{padding:20px;width:600px;margin:0 auto}
  .tall{height:1800px}
  button{background:var(--color-primary);color:#fff;border:0;padding:8px 12px;transition:background .15s}
  button:hover:not(:disabled){background:var(--color-hover)}
  input,textarea{border:1px solid #999} input:hover,textarea:hover{border-color:#000}
  a{color:var(--color-primary)} a:hover{text-decoration:underline;color:var(--color-hover)}
  :focus-visible{outline:2px solid var(--color-ring);outline-offset:2px}
  #panel{padding:8px;border:1px solid #ccc}
</style></head><body>
<header></header>
<main>
  <button id="m-trigger" aria-expanded="false" aria-controls="panel">Menu</button>
  <div id="panel" hidden><button id="opt">Option</button></div>
  <input id="name" placeholder="name">
  <a id="link" href="#x">Link</a>
  <section id="extra" hidden><textarea id="notes"></textarea></section>
  <button id="go" disabled>Go</button>
  <div class="tall"></div>
</main>
<script>
  const t = document.getElementById("m-trigger"), p = document.getElementById("panel");
  t.addEventListener("click", () => { const open = t.getAttribute("aria-expanded") === "true"; t.setAttribute("aria-expanded", String(!open)); p.hidden = open; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { t.setAttribute("aria-expanded", "false"); p.hidden = true; } });
  window.valPage = {
    applyState(name) { document.getElementById("extra").hidden = name !== "filled"; if (name === "filled") document.getElementById("name").value = "Ada"; },
    setValue(id, v) { document.getElementById(id).value = v; },
    getState() { return { name: document.getElementById("name").value }; },
  };
</script></body></html>`;

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), "val-qa-harness-"));
  mkdirSync(join(dir, "04-build"));
  writeFileSync(join(dir, "04-build", "index.html"), PAGE);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ input: { frames: [{ state: "empty", w: 1200, h: 800 }, { state: "filled", w: 1200, h: 900 }] } }));
  return dir;
}

test("standing checks pass on a well-behaved two-state page; helpers work in a behavior test", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  const dir = makeRun();
  const suite = createSuite({ runDir: dir, viewport: { width: 1200, height: 800 }, title: "fixture" });
  const states = statesFromManifest(dir);
  assert.equal(states.length, 2);
  assert.equal(states[0].apply, null);
  registerStandingChecks(suite, { states, hover: { exclude: ["#opt"] } });

  suite.test("B01", "menu opens and its option is reachable", async (page, ctx, api) => {
    await page.click("#m-trigger");
    await api.settle(page);
    ctx.eq(await api.visible(page, "#panel"), true, "#panel", "visible after click");
    ctx.eq(await page.getAttribute("#m-trigger", "aria-expanded"), "true", "#m-trigger", "aria-expanded");
    await api.parkMouse(page);
    await api.settle(page);
    const rest = await api.style(page, "#m-trigger", "backgroundColor");
    ctx.eq(rest, await api.resolveVar(page, "--color-primary"), "#m-trigger", "rest background is the primary token (mouse parked)");
    await page.hover("#m-trigger");
    await api.settle(page);
    ctx.eq(await api.style(page, "#m-trigger", "backgroundColor"), await api.resolveVar(page, "--color-hover"), "#m-trigger", "hover background");
    await page.keyboard.press("Tab");
    await api.settle(page, 350);
    ctx.check(await api.ringOn(page, "#opt"), "#opt", "focus ring on Tab", await api.ringDesc(page, "#opt"));
    const ink = await api.inkBBox(page, "#m-trigger");
    ctx.check(ink.ink && ink.ink.w > 10, "#m-trigger", "rendered label ink measurable", ink.ink);
  });

  const { passed, failed, results } = await suite.run({ exitOnFailure: false });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  for (const id of ["S01", "S02", "S03", "S04", "S05", "S06", "B01"]) {
    assert.equal(byId[id]?.result, "PASS", `${id} should pass: ${JSON.stringify(byId[id]?.failures?.slice(0, 3))}`);
  }
  assert.equal(failed, 0);
  assert.equal(passed, 7);
  assert.ok(existsSync(join(dir, "05-qa-report.md")));
  const md = readFileSync(join(dir, "05-qa-report.md"), "utf8");
  assert.match(md, /7 \/ 7 passed/);
  assert.match(md, /## Spec audit/);
  const notes = byId.S05.notes.join(" ");
  assert.match(notes, /empty: 3 Tab stop/, "empty state: menu, input, link (disabled Go skipped)");
  assert.match(notes, /filled: 4 Tab stop/, "filled state adds the textarea");
});

test("--only style scoping skips unlisted tests", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("chromium not installed");
    return;
  }
  const dir = makeRun();
  const suite = createSuite({ runDir: dir, viewport: { width: 1200, height: 800 } });
  suite.test("A", "a", async () => {});
  suite.test("B", "b", async (page, ctx) => ctx.check(false, "x", "never runs", "ran"));
  const { results } = await suite.run({ only: ["A"], exitOnFailure: false });
  assert.equal(results.find((r) => r.id === "A").result, "PASS");
  assert.equal(results.find((r) => r.id === "B").result, "SKIP");
});
