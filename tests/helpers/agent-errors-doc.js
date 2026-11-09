// The two tables in references/agent-class.md that an agent acts on, the
// error codes and status()'s problems, are rendered from the registry
// (lib/agent-errors.js: AGENT_ERRORS and STATUS_PROBLEMS), so the doc says the
// same `retryable`, `blocking` and `nextStep` the code gives. Only one column
// is written by hand: "Meaning" for the errors, "Reported when" for status().
// agent-class-errors-doc.test.js fails when a rendered column drifts from the
// registry, a code is missing or extra, or a hand-written cell is empty. To
// rewrite the rendered columns (the hand-written ones are kept):
//   node tests/helpers/agent-errors-doc.js --write
// A new code gets a TODO in its hand-written cell, which the test refuses.
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_ERRORS, STATUS_PROBLEMS } from "../../lib/agent-errors.js";

export const DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/references/agent-class.md");
export const TODO = "TODO: say what this means";

export const ERROR_TABLE_HEADER = "| Code | `retryable` | Meaning | Default `nextStep` |";
export const STATUS_TABLE_HEADER = "| Problem | Effect | Reported when | `nextStep` |";

const escapeCell = (s) => String(s).replaceAll("|", "\\|");
const cells = (row) => row.slice(1, row.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/).map((c) => c.trim());

// The table under `header`: where it sits in the doc, and its body rows as
// cells. Throws when the doc has no such table, so a renamed header can't
// pass as "nothing to check".
export function findTable(md, header) {
  const start = md.indexOf(`${header}\n`);
  if (start < 0) throw new Error(`agent-class.md: no table with header ${JSON.stringify(header)}`);
  const lines = md.slice(start).split("\n");
  let n = 2; // header and separator
  while (n < lines.length && lines[n].startsWith("|")) n++;
  const text = lines.slice(0, n).join("\n") + "\n";
  return { start, end: start + text.length, rows: lines.slice(2, n).map(cells) };
}

const retryableCell = ({ retryable, lowerAllowed }) =>
  `\`${retryable}\`` + (lowerAllowed?.length ? ` (or ${lowerAllowed.map((v) => `\`${v}\``).join(", ")})` : "");

// handWritten: code → the hand-written cell; a code without one gets TODO.
function render(header, registry, handWritten, rowFor) {
  const lines = [header, `|${header.split("|").slice(1, -1).map(() => "---").join("|")}|`];
  for (const [code, entry] of Object.entries(registry)) {
    lines.push(`| ${rowFor(code, entry, handWritten.get(code) || TODO).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

export const renderErrorTable = (meanings) =>
  render(ERROR_TABLE_HEADER, AGENT_ERRORS, meanings, (code, e, meaning) =>
    [`\`${code}\``, retryableCell(e), meaning, escapeCell(e.nextStep)]);

export const renderStatusTable = (whens) =>
  render(STATUS_TABLE_HEADER, STATUS_PROBLEMS, whens, (code, p, when) =>
    [`\`${code}\``, p.blocking ? "**blocking**" : "degraded", when, escapeCell(p.nextStep)]);

// The doc's hand-written column (index `col`), by code.
export function handWritten(md, header, col) {
  return new Map(findTable(md, header).rows.map((r) => [r[0].replaceAll("`", ""), r[col]]));
}

// The doc with both tables rendered afresh from the registry, the
// hand-written cells kept.
export function rewriteTables(md) {
  let out = md;
  for (const [header, renderTable] of [[ERROR_TABLE_HEADER, renderErrorTable], [STATUS_TABLE_HEADER, renderStatusTable]]) {
    const { start, end } = findTable(out, header);
    out = out.slice(0, start) + renderTable(handWritten(out, header, 2)) + out.slice(end);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--write") {
    console.error("usage: node tests/helpers/agent-errors-doc.js --write");
    process.exit(2);
  }
  const md = await readFile(DOC_PATH, "utf8");
  await writeFile(DOC_PATH, rewriteTables(md));
  console.log("agent-class.md error and status tables rewritten from lib/agent-errors.js");
}
