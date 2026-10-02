import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptionValues, mergeVariants } from "./lib/registry-merge.mjs";

const GENERATOR = join(dirname(fileURLToPath(import.meta.url)), "generate-registry.mjs");

test("an empty option is dropped without misaligning the values after it", () => {
  assert.deepEqual(parseOptionValues(`"", "check", "user"`), ["check", "user"]);
  assert.deepEqual(parseOptionValues(`'', 'a', \`b\``), ["a", "b"]);
});

test("numeric options are read, as strings", () => {
  assert.deepEqual(parseOptionValues(`1, 3, 5`), ["1", "3", "5"]);
  assert.deepEqual(parseOptionValues(`"sm", 2, -1.5`), ["sm", "2", "-1.5"]);
});

test("a digit inside a string is part of the string, not a number", () => {
  assert.deepEqual(parseOptionValues(`"trash-2", "h1"`), ["trash-2", "h1"]);
});

test("mergeVariants keeps hand-added axes and lets regenerated axes win", () => {
  assert.deepEqual(
    mergeVariants({ size: ["sm", "md"] }, { size: ["old"], error: ["true", "false"] }),
    { size: ["sm", "md"], error: ["true", "false"] },
  );
  assert.deepEqual(mergeVariants(undefined, undefined), {});
});

test("the generator end to end: empty, numeric and hand-added axes", () => {
  const root = mkdtempSync(join(tmpdir(), "val-registry-"));
  try {
    mkdirSync(join(root, "stories/components"), { recursive: true });
    mkdirSync(join(root, "src/components"), { recursive: true });
    mkdirSync(join(root, "val/registry"), { recursive: true });
    writeFileSync(join(root, "src/components/widget.css"), "");
    writeFileSync(
      join(root, "stories/components/Widget.stories.ts"),
      `const meta = {
  title: "Components/Widget",
  argTypes: {
    icon: {
      control: "select",
      options: ["", "check", "user"],
    },
    rows: {
      control: "select",
      options: [1, 3, 5],
    },
  },
};
export default meta;
export const Default: Story = {};
`,
    );
    const out = join(root, "val/registry/components.json");
    writeFileSync(
      out,
      JSON.stringify({ Widget: { variants: { error: ["true", "false"] }, behaviors: [], tokens: [] } }),
    );
    execFileSync("node", [GENERATOR, root], { stdio: "pipe" });
    const { variants } = JSON.parse(readFileSync(out, "utf8")).Widget;
    assert.deepEqual(variants, {
      icon: ["check", "user"],
      rows: ["1", "3", "5"],
      error: ["true", "false"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
