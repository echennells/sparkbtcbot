// references/agent-class.md tells an agent what each error code and each
// status() problem means and what to do next. Those tables are rendered from
// the registry (lib/agent-errors.js), so the retryable, blocking and nextStep
// an agent reads in the doc are the ones the code gives; only the "Meaning"
// and "Reported when" cells are written by hand. A code added, renamed or
// re-worded in the registry fails here until the doc is regenerated:
//   node tests/helpers/agent-errors-doc.js --write
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { AGENT_ERRORS, STATUS_PROBLEMS, CHECK_FIRST_TAIL } from "../../lib/agent-errors.js";
import {
  DOC_PATH, TODO, ERROR_TABLE_HEADER, STATUS_TABLE_HEADER, findTable, rewriteTables,
} from "../helpers/agent-errors-doc.js";

const REGEN = "run: node tests/helpers/agent-errors-doc.js --write";
const md = () => readFile(DOC_PATH, "utf8");
const codesOf = (rows) => rows.map((r) => r[0].replaceAll("`", ""));

describe("agent-class.md's error and status tables ↔ the registry", () => {
  it("the error table lists every registered code, once, in registry order", async () => {
    const { rows } = findTable(await md(), ERROR_TABLE_HEADER);
    expect(codesOf(rows), REGEN).toEqual(Object.keys(AGENT_ERRORS));
  });

  it("the status table lists every status() problem, most severe first", async () => {
    const { rows } = findTable(await md(), STATUS_TABLE_HEADER);
    expect(codesOf(rows), REGEN).toEqual(Object.keys(STATUS_PROBLEMS));
  });

  it("every retryable, blocking and nextStep cell is the registry's, word for word", async () => {
    const doc = await md();
    expect(rewriteTables(doc) === doc, `agent-class.md's tables differ from lib/agent-errors.js; ${REGEN}`).toBe(true);
  });

  it("every code has a hand-written meaning, and every problem when it is reported", async () => {
    const doc = await md();
    for (const header of [ERROR_TABLE_HEADER, STATUS_TABLE_HEADER]) {
      const missing = findTable(doc, header).rows.filter((r) => !r[2] || r[2] === TODO).map((r) => r[0]);
      expect(missing, `write the hand-written cell for ${missing.join(", ")} in agent-class.md`).toEqual([]);
    }
  });

  it("states the sentence every check-first nextStep ends with, as the code appends it", async () => {
    expect((await md()).includes(`"${CHECK_FIRST_TAIL}"`)).toBe(true);
  });

  it("the tables sit near the top, before the pointer to the class source", async () => {
    const doc = await md();
    const source = doc.indexOf("## The class source");
    expect(source).toBeGreaterThan(0);
    expect(findTable(doc, ERROR_TABLE_HEADER).start).toBeLessThan(source);
    expect(findTable(doc, STATUS_TABLE_HEADER).start).toBeLessThan(source);
  });
});
