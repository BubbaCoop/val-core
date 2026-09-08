/**
 * Minimal `--flag value` / `--flag=value` / `--flag` parser shared by the Val
 * tools. No dependencies; positional arguments are returned in order.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("--")) {
      opts[name] = true;
      continue;
    }
    opts[name] = next;
    i++;
  }
  return { positional, opts };
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** Print at most `max` lines; append a one-line elision note when truncated. */
export function printCapped(lines, max = 40) {
  const shown = lines.slice(0, max);
  for (const l of shown) console.log(l);
  if (lines.length > max) console.log(`… ${lines.length - max} more line(s) in the written report`);
}
