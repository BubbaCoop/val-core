/** Unit tests for <tools-dir>/lib/stylesheet-path.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stylesheetPath } from "./stylesheet-path.mjs";

const twDir = "/tmp/node_modules/tailwindcss";

test("a file: URL whose path contains a space round-trips to the real path", () => {
  // The regression: URL.pathname keeps percent-encoding, so this came back as
  // ".../valiify%20shortapp%20library/src/library.css" and readFileSync threw ENOENT —
  // which class-audit caught, downgraded to an advisory, and still reported PASS.
  const real = "/Users/someone/Desktop/valiify shortapp library/src/library.css";
  const id = pathToFileURL(real).href;
  assert.ok(id.includes("%20"), "precondition: the URL form really is percent-encoded");
  assert.equal(stylesheetPath(id, { base: "/anywhere", twDir }), real);
});

test("other percent-encoded characters decode too", () => {
  for (const real of [
    "/tmp/a b/c.css",
    "/tmp/name(1)/lib.css",
    "/tmp/prize #2/lib.css",
    "/tmp/ünïcode dir/lib.css",
  ]) {
    assert.equal(stylesheetPath(pathToFileURL(real).href, { base: "/x", twDir }), real, real);
  }
});

test("a plain path with no encoding is unchanged", () => {
  const real = "/tmp/plain/library.css";
  assert.equal(stylesheetPath(pathToFileURL(real).href, { base: "/x", twDir }), real);
});

test("tailwindcss ids resolve inside the tailwind package", () => {
  assert.equal(stylesheetPath("tailwindcss", { base: "/x", twDir }), join(twDir, "index.css"));
  assert.equal(stylesheetPath("tailwindcss/theme.css", { base: "/x", twDir }), join(twDir, "theme.css"));
});

test("relative and absolute ids resolve against the base", () => {
  assert.equal(stylesheetPath("./parts/a.css", { base: "/tmp/base", twDir }), "/tmp/base/parts/a.css");
  assert.equal(stylesheetPath("/abs/a.css", { base: "/tmp/base", twDir }), "/abs/a.css");
});

test("a relative id resolves correctly when the base itself contains a space", () => {
  assert.equal(
    stylesheetPath("./src/library.css", { base: "/Users/x/valiify shortapp library", twDir }),
    "/Users/x/valiify shortapp library/src/library.css",
  );
});
