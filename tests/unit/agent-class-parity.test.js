// Two-way parity between the shipped SparkAgent and its reference doc's method
// list. The doc used to carry a full copy of the class as well, regenerated
// from the shipped file; that copy grew with the class to 210 KB, was the
// bulk of the references, and duplicated a file the package ships and agents
// import (sparkbtcbot-skill/agent). It was removed on 2026-11-09: the doc
// lists the methods and points at scripts/spark-agent.js. These pins keep the
// list honest both ways (methods once advertised that didn't exist crashed a
// deployed bot), and stop a copy of the class from coming back.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const MD_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/references/agent-class.md");

const publicMethods = () =>
  Object.getOwnPropertyNames(SparkAgent.prototype).filter((n) => n !== "constructor");
const glance = (md) => {
  const start = md.indexOf("## Methods at a glance");
  return md.slice(start, md.indexOf("\n## ", start + 1));
};
const advertised = (md) => [...glance(md).matchAll(/`(?:await )?(?:SparkAgent\.)?([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((m) => m[1]);

describe("agent-class.md ↔ shipped SparkAgent parity", () => {
  it("every method named in 'Methods at a glance' exists on the shipped class", async () => {
    const names = advertised(await readFile(MD_PATH, "utf8"));
    expect(names.length).toBeGreaterThan(10); // the parser found the list
    const real = new Set([...publicMethods(), "create"]); // create is static
    const phantom = names.filter((name) => !real.has(name));
    expect(phantom, `advertised in the doc index but missing on SparkAgent: ${phantom}`).toEqual([]);
  });

  it("every public method of the shipped class is named in 'Methods at a glance'", async () => {
    const names = new Set(advertised(await readFile(MD_PATH, "utf8")));
    const missing = publicMethods().filter((name) => !names.has(name));
    expect(missing, `shipped methods absent from the doc's method list: ${missing}`).toEqual([]);
  });

  it("the doc carries no copy of the class: it points at the shipped file", async () => {
    const md = await readFile(MD_PATH, "utf8");
    expect(md).not.toMatch(/export class SparkAgent/);
    expect(md).toMatch(/scripts\/spark-agent\.js/);
  });
});
