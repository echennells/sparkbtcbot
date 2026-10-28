import { describe, it, expect } from "vitest";
import * as sdk from "@buildonspark/spark-sdk";
import * as issuerSdk from "@buildonspark/issuer-sdk";

describe("SDK imports", () => {
  it("exports SparkWallet with static initialize", () => {
    expect(sdk.SparkWallet).toBeDefined();
    expect(typeof sdk.SparkWallet.initialize).toBe("function");
  });

  it("exports the Network enum with REGTEST and MAINNET", () => {
    expect(sdk.Network).toBeDefined();
    expect(sdk.Network.MAINNET).toBeDefined();
    expect(sdk.Network.REGTEST).toBeDefined();
    expect(sdk.Network.TESTNET).toBeDefined();
    expect(sdk.Network.SIGNET).toBeDefined();
    expect(sdk.Network.LOCAL).toBeDefined();
  });

  it("exports SparkSdkError and the validation/auth/network subclasses", () => {
    expect(sdk.SparkSdkError).toBeDefined();
    expect(sdk.SparkValidationError).toBeDefined();
    expect(sdk.SparkAuthenticationError).toBeDefined();
    expect(sdk.NetworkError).toBeDefined();
  });

  it("exports the bech32m address helpers used in the skill examples", () => {
    expect(typeof sdk.encodeSparkAddress).toBe("function");
    expect(typeof sdk.decodeSparkAddress).toBe("function");
  });
});

describe("SparkWallet method surface", () => {
  const expectedMethods = [
    "getBalance",
    "getSparkAddress",
    "getIdentityPublicKey",
    "getStaticDepositAddress",
    "getSingleUseDepositAddress",
    "claimStaticDeposit",
    "claimStaticDepositWithMaxFee",
    "createSatsInvoice",
    "createTokensInvoice",
    "createLightningInvoice",
    "fulfillSparkInvoice",
    "transfer",
    "transferTokens",
    "batchTransferTokens",
    "payLightningInvoice",
    "getLightningSendFeeEstimate",
    "getLightningSendRequest",
    "getWithdrawalFeeQuote",
    "withdraw",
    "signMessageWithIdentityKey",
    "validateMessageWithIdentityKey",
    "getTransfers",
    "cleanup",
    "cleanupConnections",
    "on",
    "off",
  ];

  it.each(expectedMethods)("SparkWallet.prototype has %s", (name) => {
    let proto = sdk.SparkWallet.prototype;
    let found = false;
    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) {
        found = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect(found, `expected SparkWallet to expose ${name}() — examples and SKILL.md depend on it`).toBe(true);
  });
});

describe("IssuerSparkWallet method surface", () => {
  const expectedIssuerMethods = [
    "createToken",
    "mintTokens",
    "burnTokens",
    "freezeTokens",
    "unfreezeTokens",
    "getIssuerTokenIdentifier",
    "getIssuerTokenMetadata",
    "getIssuerTokenBalance",
    "transferTokens",
  ];

  it("exports IssuerSparkWallet with static initialize", () => {
    expect(issuerSdk.IssuerSparkWallet).toBeDefined();
    expect(typeof issuerSdk.IssuerSparkWallet.initialize).toBe("function");
  });

  it.each(expectedIssuerMethods)("IssuerSparkWallet.prototype has %s", (name) => {
    let proto = issuerSdk.IssuerSparkWallet.prototype;
    let found = false;
    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) {
        found = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect(found, `expected IssuerSparkWallet to expose ${name}() — token-mint flows depend on it`).toBe(true);
  });
});

// The wrapper is what carries every guard (allowlist, fee ceilings, budget,
// dedup, leaf-vault). A field test showed an agent on the npm path copying the
// raw-SDK skeleton into every script because the wrapper could not be imported
// — the exports map blocked the deep path — so it is now a published subpath.
describe("sparkbtcbot-skill/agent subpath", () => {
  it("exports SparkAgent from the package (no copy-the-listing required)", async () => {
    const mod = await import("sparkbtcbot-skill/agent");
    expect(typeof mod.SparkAgent).toBe("function");
    expect(typeof mod.SparkAgent.create).toBe("function");
  });
});

// The ./agent subpath ships type declarations (skills/sparkbtcbot/scripts/
// spark-agent.d.ts; tests/unit/agent-types-parity.test.js holds them to the
// code). TypeScript takes the first condition that matches, so "types" must
// come before "import", and the file must be in what npm publishes.
describe("sparkbtcbot-skill/agent type declarations", () => {
  it("the exports map names them first, and they exist", async () => {
    const { readFile, access } = await import("node:fs/promises");
    const root = new URL("../../", import.meta.url);
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const agent = pkg.exports["./agent"];
    expect(agent.types).toBe("./skills/sparkbtcbot/scripts/spark-agent.d.ts");
    for (const [subpath, conditions] of Object.entries(pkg.exports)) {
      if (typeof conditions !== "object" || !("types" in conditions)) continue;
      expect(Object.keys(conditions)[0], `${subpath}: "types" first`).toBe("types");
      await access(new URL(conditions.types, root));
    }
  });

  it("npm pack ships them, with the declarations they import", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { posix } = await import("node:path");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });
    const shipped = new Set(JSON.parse(stdout)[0].files.map((f) => f.path));
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const typeFiles = Object.values(pkg.exports).filter((c) => typeof c === "object" && c.types).map((c) => posix.normalize(c.types));
    expect(typeFiles).toContain("skills/sparkbtcbot/scripts/spark-agent.d.ts");
    for (const file of typeFiles) {
      expect(shipped.has(file), `${file} is not in the tarball`).toBe(true);
      // a relative import in a shipped .d.ts resolves to a shipped .d.ts
      const text = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      for (const m of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) {
        const target = posix.normalize(posix.join(posix.dirname(file), `${m[1]}.d.ts`));
        expect(shipped.has(target), `${file} imports ${target}, which is not in the tarball`).toBe(true);
      }
    }
  }, 60_000);
});

// ToB review 2026-10-26: the ./agent module ran `import "dotenv/config"` on
// load, so importing the library loaded the HOST app's ./.env, where a planted
// file could switch off dedup, the backup or privacy, or TLS checks for fetch.
describe("importing sparkbtcbot-skill/agent has no .env side effect", () => {
  it("leaves a planted ./.env unread", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const agentPath = fileURLToPath(new URL("../../skills/sparkbtcbot/scripts/spark-agent.js", import.meta.url));
    const dir = await mkdtemp(join(tmpdir(), "agent-dotenv-"));
    try {
      await writeFile(join(dir, ".env"), "SPARK_LN_DEDUP=off\nNODE_TLS_REJECT_UNAUTHORIZED=0\n");
      const env = { ...process.env };
      delete env.SPARK_LN_DEDUP;
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--input-type=module", "-e",
        `await import(${JSON.stringify(agentPath)}); console.log(JSON.stringify([process.env.SPARK_LN_DEDUP ?? null, process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null]));`,
      ], { cwd: dir, env });
      expect(JSON.parse(stdout.trim().split("\n").at(-1))).toEqual([null, null]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

