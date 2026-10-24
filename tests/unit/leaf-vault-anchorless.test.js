// SDK 0.13's refund fee ladder (enableCpfpRefundLadder, on by default) gives
// claimed leaves of ~1,024 sats and up an ANCHORLESS refund. The exit tool the
// backup is for fee-bumps every refund through its anchor and fails on the
// whole backup when one is missing, so verifyVault must say so. Both fixtures
// are real hosted-REGTEST backups (experiments/fee-ladder), pruned to two
// leaves and their ancestors.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { verifyVault } from "../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { FEE_LADDERS_OFF, sparkWalletOptions } from "../../lib/wallet-options.js";
import * as lib from "../../lib/index.js";

const fixture = (name) => fileURLToPath(new URL(`../fixtures/leaf-vault/${name}.json`, import.meta.url));

describe("verifyVault: anchorless refunds", () => {
  it("fails a backup taken with the ladder ON, naming the anchorless leaf", async () => {
    const r = await verifyVault(fixture("regtest-ladder-on"));
    expect(r).toMatchObject({
      ok: false,
      leafCount: 2,
      failed: [], // it still reconstructs to a root; that isn't the problem
      anchorless: ["01a0eda1-bc88-7efa-81cb-ae42aa56dec3"], // the 1,024-sat leaf; the 512 kept its anchor
    });
    expect(r.reason).toMatch(/1 leaf\/leaves have an anchorless refund/);
    expect(r.reason).toMatch(/re-anchors the leaves it receives/);
  });

  it("passes a backup taken with the ladder OFF", async () => {
    const r = await verifyVault(fixture("regtest-ladder-off"));
    expect(r).toMatchObject({ ok: true, leafCount: 2, failed: [], anchorless: [] });
  });
});

describe("sparkWalletOptions: both fee ladders off", () => {
  it("adds the network and turns both ladders off", () => {
    expect(sparkWalletOptions("REGTEST")).toEqual({
      network: "REGTEST",
      enableCpfpRefundLadder: false,
      enableDirectNodeFeeLadder: false,
    });
  });

  it("keeps other options, and an extra can't switch a ladder back on", () => {
    const o = sparkWalletOptions("MAINNET", {
      optimizationOptions: { auto: false },
      enableCpfpRefundLadder: true,
      enableDirectNodeFeeLadder: true,
    });
    expect(o).toEqual({
      optimizationOptions: { auto: false },
      network: "MAINNET",
      enableCpfpRefundLadder: false,
      enableDirectNodeFeeLadder: false,
    });
  });

  it("FEE_LADDERS_OFF is frozen and exported from the package entry", () => {
    expect(Object.isFrozen(FEE_LADDERS_OFF)).toBe(true);
    expect(lib.FEE_LADDERS_OFF).toBe(FEE_LADDERS_OFF);
    expect(lib.sparkWalletOptions).toBe(sparkWalletOptions);
  });
});

// The options belong to the wallet object, so one entry point that forgets
// them hands the operators fee ladders and leaves anchorless refunds behind.
describe("every wallet this package opens, or tells you to open, passes sparkWalletOptions", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const calls = (text) => [...text.matchAll(/\b(?:Issuer)?SparkWallet\.initialize\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);

  it("in the shipped scripts", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = `${root}skills/sparkbtcbot/scripts/`;
    let found = 0;
    for (const f of (await readdir(dir)).filter((n) => n.endsWith(".js"))) {
      for (const body of calls(await readFile(dir + f, "utf8"))) {
        found++;
        expect(body, `${f}: SparkWallet.initialize without sparkWalletOptions`).toMatch(/options: sparkWalletOptions\(/);
      }
    }
    expect(found).toBeGreaterThanOrEqual(7);
  });

  it("in the reference docs' code", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = `${root}skills/sparkbtcbot/references/`;
    let found = 0;
    for (const f of (await readdir(dir)).filter((n) => n.endsWith(".md"))) {
      for (const body of calls(await readFile(dir + f, "utf8"))) {
        found++;
        expect(body, `${f}: SparkWallet.initialize without sparkWalletOptions`).toMatch(/options: sparkWalletOptions\(/);
      }
    }
    expect(found).toBeGreaterThanOrEqual(4);
  });
});
