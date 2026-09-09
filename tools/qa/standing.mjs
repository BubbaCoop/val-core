/**
 * Val QA — the standing checks every Val page gets, registered onto a harness
 * suite. Config-free by default (auto-discovers interactive elements, menus,
 * sticky elements); a small config sharpens them for the page at hand.
 *
 *   registerStandingChecks(suite, {
 *     states: [{ name: "empty", apply: null }, { name: "filled", apply: async (page) => … }],
 *     hover:  { exclude: ["#continue"] },                      // selectors with no hover state BY DESIGN
 *     menus:  [{ trigger: "#x-trigger", panel: "#x-listbox" }], // default: every [aria-expanded][aria-controls]
 *     disclosures: [{ id: "child-a", show: async (page) => …, hide: async (page) => … }],
 *     sticky: { selector: ".header" } | false,                 // default: auto-detect position:sticky
 *     resize: { widths: [1440, 1280, 1024] },
 *     keyboard: { focusTargetMap: { "input.text-field-input": ".text-field-box" } } | false,
 *     console: true,
 *     probes: <library probes module>                          // optional, see below
 *   });
 *
 * `probes` is the library-specific hook (val.config paths.qaProbes): an object
 * (or module namespace) that may provide hoverExclude: [selectors],
 * focusTargetMap: {…}, settleMs, menus, disclosures. Page config wins over it.
 *
 * S01 hover · S02 expand/collapse · S03 sticky · S04 resize · S05 keyboard · S06 console
 */
import { parkMouse, settle, tabPass, visible } from "./harness.mjs";

const HOVER_PROPS = ["color", "backgroundColor", "borderColor", "boxShadow", "outlineColor", "textDecorationLine", "transform", "opacity", "fill", "stroke"];

export function registerStandingChecks(suite, cfg = {}) {
  const probes = cfg.probes ?? {};
  const states = cfg.states?.length ? cfg.states : [{ name: "default", apply: null }];
  const settleMs = cfg.settleMs ?? probes.settleMs ?? suite.settleMs ?? 260;
  const hoverExclude = [...(probes.hoverExclude ?? []), ...(cfg.hover?.exclude ?? [])];
  const menus = cfg.menus ?? probes.menus ?? null;
  const disclosures = cfg.disclosures ?? probes.disclosures ?? [];
  const widths = cfg.resize?.widths ?? [1440, 1280, 1024];
  const focusTargetMap = cfg.keyboard?.focusTargetMap ?? probes.focusTargetMap ?? {};

  const applyState = async (page, st) => {
    if (st.apply) {
      await st.apply(page);
      await page.evaluate(() => document.activeElement?.blur?.());
      await settle(page, settleMs);
    }
  };

  // ---- S01 hover --------------------------------------------------------------------------------
  suite.test("S01", "STANDING hover — every enabled interactive element shows a computed-style change on hover", async (page, ctx) => {
    let probed = 0;
    for (const st of states) {
      await applyState(page, st);
      const targets = await page.evaluate(
        ([exclude]) => {
          const unique = (el) => {
            if (el.id) return `#${CSS.escape(el.id)}`;
            const parts = [];
            let cur = el;
            while (cur && cur !== document.body && parts.length < 6) {
              const parent = cur.parentElement;
              const idx = parent ? [...parent.children].indexOf(cur) + 1 : 1;
              parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
              if (parent?.id) {
                parts.unshift(`#${CSS.escape(parent.id)}`);
                break;
              }
              cur = parent;
            }
            return parts.join(" > ");
          };
          const out = [];
          for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=option], [tabindex]:not([tabindex="-1"])')) {
            if (el.disabled || el.closest("[hidden]") || el.closest("svg") || el.getClientRects().length === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            const sel = unique(el);
            if (exclude.some((x) => el.matches(x))) continue;
            out.push(sel);
          }
          return [...new Set(out)];
        },
        [hoverExclude],
      );
      for (const sel of targets) {
        await parkMouse(page);
        await settle(page, settleMs);
        const before = await snapshotStyles(page, sel);
        if (!before) continue;
        let hovered = true;
        try {
          await page.hover(sel, { timeout: 2000 });
        } catch {
          hovered = false;
        }
        await settle(page, settleMs);
        const after = hovered ? await snapshotStyles(page, sel) : null;
        probed++;
        if (!hovered) {
          ctx.check(false, `${sel} (${st.name})`, "element is hoverable", "hover() timed out — covered or off-screen");
          continue;
        }
        const changed = after && JSON.stringify(before) !== JSON.stringify(after);
        ctx.check(changed, `${sel} (${st.name})`, "hover changes a computed style on the element or an ancestor (colour, background, border, shadow, outline, underline, transform, opacity)", changed ? "changed" : "no visible delta — add to hover.exclude only if the design has no hover state here");
      }
    }
    ctx.note(`hover probes executed: ${probed} across ${states.length} state(s)`);
  });

  // ---- S02 expand / collapse ---------------------------------------------------------------------------
  suite.test("S02", "STANDING expand/collapse — every menu and conditional child cycles both directions", async (page, ctx) => {
    await applyState(page, states[states.length - 1]);
    const found = menus ?? (await page.$$eval("[aria-expanded][aria-controls]", (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ trigger: e.id ? `#${CSS.escape(e.id)}` : null, panel: `#${CSS.escape(e.getAttribute("aria-controls"))}` })).filter((m) => m.trigger)));
    for (const m of found) {
      await page.click(m.trigger);
      await settle(page, settleMs);
      const openOk = (await visible(page, m.panel)) && (await page.getAttribute(m.trigger, "aria-expanded")) === "true";
      ctx.check(openOk, m.panel, "expands on click (panel visible, aria-expanded=true)", openOk ? "ok" : "did not expand");
      await page.click(m.trigger);
      await settle(page, settleMs);
      let closed = !(await visible(page, m.panel));
      if (!closed) {
        await page.keyboard.press("Escape");
        await settle(page, settleMs);
        closed = !(await visible(page, m.panel));
        if (closed) ctx.note(`${m.panel}: closes on Escape but not on a second trigger click`);
      }
      ctx.check(closed, m.panel, "collapses on second click (or Escape)", closed ? "ok" : "stayed open");
    }
    for (const d of disclosures) {
      const sel = d.selector ?? `#${d.id}`;
      await d.show(page);
      await settle(page, settleMs);
      ctx.check(await visible(page, sel), sel, "child expands", "hidden");
      await d.hide(page);
      await settle(page, settleMs);
      ctx.check(!(await visible(page, sel)), sel, "child collapses", "shown");
      await d.show(page);
      await settle(page, settleMs);
      ctx.check(await visible(page, sel), sel, "child re-expands", "hidden");
    }
    ctx.note(`${found.length} menu(s), ${disclosures.length} disclosure(s) cycled`);
    if (!found.length && !disclosures.length) ctx.note("no menus or disclosures found — pass cfg.menus / cfg.disclosures if the page has them");
  });

  // ---- S03 sticky ---------------------------------------------------------------------------------------
  suite.test("S03", "STANDING scroll — sticky elements stay pinned while the page scrolls", async (page, ctx) => {
    if (cfg.sticky === false) {
      ctx.note("sticky check disabled by config");
      return;
    }
    await applyState(page, states[states.length - 1]);
    let stickies = cfg.sticky?.selector ? [cfg.sticky.selector] : await page.$$eval("body *", (els) => els.filter((e) => getComputedStyle(e).position === "sticky" && e.getClientRects().length).map((e) => (e.id ? `#${CSS.escape(e.id)}` : e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(/\s+/)[0] : ""))));
    stickies = [...new Set(stickies)];
    if (!stickies.length) {
      ctx.note("no position:sticky element on this page — check n/a");
      return;
    }
    let scrollable = await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);
    if (!scrollable) {
      await page.setViewportSize({ width: suite.viewport.width, height: 500 });
      await settle(page, settleMs);
      scrollable = await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);
    }
    ctx.check(scrollable, "window", "page is scrollable for the sticky check", scrollable);
    for (const sel of stickies) {
      const top0 = await page.$eval(sel, (el) => parseFloat(getComputedStyle(el).top) || 0);
      for (const y of [300, 100000]) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await settle(page, 150);
        const r = await page.$eval(sel, (el) => el.getBoundingClientRect());
        ctx.near(r.top, top0, 0.5, sel, `pinned at top ${top0} after scrollTo(${y})`);
        ctx.check(r.height > 0 && r.width > 0, sel, "visible while scrolled", `${r.width}x${r.height}`);
      }
    }
    ctx.note(`sticky: ${stickies.join(", ")}`);
  });

  // ---- S04 resize -----------------------------------------------------------------------------------------
  suite.test("S04", `STANDING resize ${widths.join("/")} — no horizontal overflow, no element past the viewport edge`, async (page, ctx) => {
    for (const st of states) {
      await applyState(page, st);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 900 });
        await settle(page, settleMs);
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          over: [...document.querySelectorAll("body *")]
            .filter((el) => {
              if (el.closest("svg") || el.closest("[hidden]")) return false;
              const cs = getComputedStyle(el);
              if (cs.display === "none" || cs.position === "fixed") return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
            })
            .map((el) => (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`))
            .slice(0, 6),
        }));
        const tag = `${st.name}@${w}`;
        ctx.check(m.sw <= m.cw, `html (${tag})`, "no horizontal overflow", `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
        ctx.eq(m.over, [], `elements (${tag})`, "no element past viewport edges");
      }
      await page.setViewportSize(suite.viewport);
    }
  });

  // ---- S05 keyboard --------------------------------------------------------------------------------------------
  if (cfg.keyboard !== false) {
    suite.test("S05", "STANDING keyboard — Tab reaches every visible enabled control in DOM order with a visible focus state (each state on a fresh page)", async (_page, ctx, api) => {
      for (const st of states) {
        const p = await api.open();
        if (st.apply) {
          await st.apply(p);
          await p.evaluate(() => document.activeElement?.blur?.());
          await settle(p, settleMs);
        }
        const r = await tabPass(p, ctx, { label: st.name, focusTargetMap });
        ctx.note(`${st.name}: ${r.seq.length} Tab stop(s)`);
      }
    });
  }

  // ---- S06 console -----------------------------------------------------------------------------------------------
  if (cfg.console !== false) {
    suite.afterAll((results, ctxs) => {
      const errors = ctxs.flatMap((c) => c.errors.map((e) => ({ test: c.id, error: e })));
      return {
        id: "S06",
        name: "STANDING zero console errors / page errors / failed requests across all tests",
        ok: errors.length === 0,
        failures: errors.slice(0, 20).map((e) => ({ selector: e.test, expected: "no console/page/request error", actual: e.error })),
        notes: [`${ctxs.length} test context(s) observed`],
      };
    });
  }
}

async function snapshotStyles(page, sel) {
  try {
    return await page.$eval(
      sel,
      (el, props) => {
        const out = [];
        let cur = el;
        for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
          const cs = getComputedStyle(cur);
          out.push(props.map((p) => cs[p]));
          cur = cur.parentElement;
        }
        // first child too — buttons often paint hover on an inner span/svg
        const fc = el.firstElementChild;
        if (fc) {
          const cs = getComputedStyle(fc);
          out.push(props.map((p) => cs[p]));
        }
        return out;
      },
      HOVER_PROPS,
    );
  } catch {
    return null;
  }
}
