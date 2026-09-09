#!/usr/bin/env node
/**
 * Starting point for a Val run's 05-qa.spec.mjs. Copy into the run directory,
 * fix the two import paths for your repo's tools dir (val/tools by default is
 * two levels up from val/runs/<run>/), then add one test per behaviors.json
 * entry and one per writeup-only requirement. The standing checks come free.
 *
 *   node 05-qa.spec.mjs            # full suite
 *   node 05-qa.spec.mjs --only S01,S04,B03   # scoped re-run
 */
import { createSuite, statesFromManifest } from "../../tools/qa/harness.mjs";
import { registerStandingChecks } from "../../tools/qa/standing.mjs";

const RUN_DIR = import.meta.dirname;
const suite = createSuite({ runDir: RUN_DIR, title: "05 — QA report" });

registerStandingChecks(suite, {
  states: statesFromManifest(RUN_DIR),
  // hover: { exclude: ["#continue"] },      // only for elements with no hover state BY DESIGN
  // menus: [{ trigger: "#x-trigger", panel: "#x-listbox" }],
  // disclosures: [{ id: "child-a", show: async (p) => …, hide: async (p) => … }],
  // keyboard: { focusTargetMap: { "input.text-field-input": ".text-field-box" } },
});

// One test per behaviors.json entry — perform the trigger, assert the outcome
// through the DOM and computed styles (tokens resolved live via api.resolveVar).
suite.test("B01", "behaviors[0] <node> — <what it does>", async (page, ctx, api) => {
  // await page.click("#trigger"); await api.settle(page);
  // ctx.eq(await api.style(page, "#panel", "display"), "block", "#panel", "opens");
  ctx.note("replace with the real behavior test");
});

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7)?.split(",") ?? (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : null);
await suite.run({ only });
