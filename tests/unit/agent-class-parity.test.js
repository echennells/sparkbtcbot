// Two-way parity between the shipped SparkAgent and its drop-in reference doc.
// This drift class has bitten three times: a stale vault integration that threw
// at runtime, `dryRun`/withdraw fixes missing from the doc, and L402/invoice
// methods advertised in the doc that did not exist on the shipped class (or
// vice versa). The doc's code listing is regenerated FROM the shipped file;
// these pins make any future divergence a test failure instead of an incident.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const MD_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/references/agent-class.md");

const publicMethods = () =>
  Object.getOwnPropertyNames(SparkAgent.prototype).filter((n) => n !== "constructor");

describe("agent-class.md ↔ shipped SparkAgent parity", () => {
  it("every method named in 'Methods at a glance' exists on the shipped class", async () => {
    const md = await readFile(MD_PATH, "utf8");
    const index = md.slice(md.indexOf("## Methods at a glance"), md.indexOf("```javascript"));
    const advertised = [...index.matchAll(/`(?:await )?(?:SparkAgent\.)?([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((m) => m[1]);
    expect(advertised.length).toBeGreaterThan(10); // the parser found the list
    const real = new Set([...publicMethods(), "create"]); // create is static
    const phantom = advertised.filter((name) => !real.has(name));
    expect(phantom, `advertised in the doc index but missing on SparkAgent: ${phantom}`).toEqual([]);
  });

  it("every public method of the shipped class appears in the doc's code listing", async () => {
    const md = await readFile(MD_PATH, "utf8");
    const missing = publicMethods().filter((name) => !new RegExp(`^  (?:async )?${name}\\(`, "m").test(md));
    expect(missing, `shipped methods absent from the doc listing: ${missing}`).toEqual([]);
  });

  it("every method defined in the doc's code listing exists on the shipped class", async () => {
    const md = await readFile(MD_PATH, "utf8");
    const code = md.slice(md.indexOf("```javascript"), md.indexOf("\n```", md.indexOf("```javascript")));
    const defined = [...code.matchAll(/^  (?:async )?([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((m) => m[1]);
    expect(defined.length).toBeGreaterThan(10);
    const real = new Set([...publicMethods(), "create", "constructor"]);
    const phantom = defined.filter((name) => !real.has(name));
    expect(phantom, `defined in the doc listing but missing on SparkAgent: ${phantom}`).toEqual([]);
  });
});
