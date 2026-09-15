// Spark wallets are PUBLICLY readable by default (balance + full history by
// address, no auth). The runtime turns the per-wallet privacy setting on at
// setup and on every SparkAgent boot. These pins cover the SDK-free policy
// (lib/wallet-privacy.js) and the boot wiring: a wallet already private makes
// no write; a public one is written and the operators' echo is verified; a
// typo'd option or a pre-0.11 SDK fails loud instead of silently leaving the
// wallet public; SPARK_PRIVACY=off is the only way to skip it; and a failure
// at boot warns without blocking the wallet.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureWalletPrivacy, privacyPreferenceFromEnv } from "../../lib/wallet-privacy.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { SparkWallet } from "@buildonspark/spark-sdk";

const settings = (privateEnabled, extra = {}) => ({ ownerIdentityPublicKey: "02ab", privateEnabled, ...extra });

function fakeWallet({ current, echo } = {}) {
  return {
    getWalletSettings: vi.fn().mockResolvedValue(current),
    setPrivacyEnabled: vi.fn(async (v) => (echo === undefined ? settings(v) : echo)),
  };
}

describe("privacyPreferenceFromEnv", () => {
  for (const off of ["off", "OFF", " false ", "0", "no"]) {
    it(`SPARK_PRIVACY=${JSON.stringify(off)} opts out`, () => {
      expect(privacyPreferenceFromEnv({ SPARK_PRIVACY: off })).toBe(false);
    });
  }
  for (const on of [undefined, "", "on", "true", "1", "yes", "offf", "disable"]) {
    it(`SPARK_PRIVACY=${JSON.stringify(on)} means ON (a typo must not expose the wallet)`, () => {
      expect(privacyPreferenceFromEnv({ SPARK_PRIVACY: on })).toBe(true);
    });
  }
});

describe("ensureWalletPrivacy", () => {
  it("writes when the wallet has no settings row yet (operators' default is public)", async () => {
    const w = fakeWallet({ current: undefined });
    const r = await ensureWalletPrivacy(w);
    expect(w.setPrivacyEnabled).toHaveBeenCalledWith(true);
    expect(r).toEqual({ changed: true, settings: settings(true) });
  });

  it("writes when the wallet is public", async () => {
    const w = fakeWallet({ current: settings(false) });
    const r = await ensureWalletPrivacy(w);
    expect(w.setPrivacyEnabled).toHaveBeenCalledTimes(1);
    expect(r.changed).toBe(true);
    expect(r.settings.privateEnabled).toBe(true);
  });

  it("is idempotent: an already-private wallet makes one read and no write", async () => {
    const w = fakeWallet({ current: settings(true, { viewerIdentityPublicKey: "03cd" }) });
    const r = await ensureWalletPrivacy(w);
    expect(w.getWalletSettings).toHaveBeenCalledTimes(1);
    expect(w.setPrivacyEnabled).not.toHaveBeenCalled();
    expect(r).toEqual({ changed: false, settings: settings(true, { viewerIdentityPublicKey: "03cd" }) });
  });

  it("{ enabled: false } turns privacy off for a private wallet, and is a no-op for a public one", async () => {
    const priv = fakeWallet({ current: settings(true) });
    expect((await ensureWalletPrivacy(priv, { enabled: false })).changed).toBe(true);
    expect(priv.setPrivacyEnabled).toHaveBeenCalledWith(false);
    const pub = fakeWallet({ current: settings(false) });
    expect((await ensureWalletPrivacy(pub, { enabled: false })).changed).toBe(false);
    expect(pub.setPrivacyEnabled).not.toHaveBeenCalled();
  });

  it("throws when the operators' echo does not carry the requested state (a write that did not take)", async () => {
    const w = fakeWallet({ current: settings(false), echo: settings(false) });
    await expect(ensureWalletPrivacy(w)).rejects.toThrow(/did not record the change/);
  });

  it("rejects a misspelled option instead of silently applying the default", async () => {
    const w = fakeWallet({ current: settings(false) });
    await expect(ensureWalletPrivacy(w, { enable: false })).rejects.toThrow(/unknown option "enable"/);
    expect(w.getWalletSettings).not.toHaveBeenCalled();
    await expect(ensureWalletPrivacy(w, { enabled: "off" })).rejects.toThrow(/must be a boolean/);
  });

  it("fails loud on a wallet without the settings API (pre-0.11 SDK) rather than assuming private", async () => {
    await expect(ensureWalletPrivacy({})).rejects.toThrow(/spark-sdk >= 0.11/);
    await expect(ensureWalletPrivacy({ getWalletSettings: async () => undefined })).rejects.toThrow(/setPrivacyEnabled/);
  });

  it("propagates a read failure (network) unchanged", async () => {
    const w = { getWalletSettings: vi.fn().mockRejectedValue(new Error("UNAVAILABLE")), setPrivacyEnabled: vi.fn() };
    await expect(ensureWalletPrivacy(w)).rejects.toThrow("UNAVAILABLE");
    expect(w.setPrivacyEnabled).not.toHaveBeenCalled();
  });
});

describe("SparkAgent.create enables wallet privacy at boot", () => {
  const saved = { p: process.env.SPARK_PRIVACY, v: process.env.SPARK_LEAF_VAULT };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, val] of [["SPARK_PRIVACY", saved.p], ["SPARK_LEAF_VAULT", saved.v]]) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  });
  const boot = async (wallet) => {
    process.env.SPARK_LEAF_VAULT = "off"; // vault not under test; a bare fake wallet suffices
    vi.spyOn(SparkWallet, "initialize").mockResolvedValue({ wallet, mnemonic: undefined });
    return SparkAgent.create("word ".repeat(12).trim(), "REGTEST");
  };

  it("turns privacy on for a public wallet (the default case)", async () => {
    delete process.env.SPARK_PRIVACY;
    const w = fakeWallet({ current: settings(false) });
    await boot(w);
    expect(w.setPrivacyEnabled).toHaveBeenCalledWith(true);
  });

  it("does not touch the setting when SPARK_PRIVACY=off", async () => {
    process.env.SPARK_PRIVACY = "off";
    const w = fakeWallet({ current: settings(false) });
    await boot(w);
    expect(w.getWalletSettings).not.toHaveBeenCalled();
    expect(w.setPrivacyEnabled).not.toHaveBeenCalled();
  });

  it("a failure warns loudly but does not block the wallet", async () => {
    delete process.env.SPARK_PRIVACY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = { getWalletSettings: vi.fn().mockRejectedValue(new Error("UNAVAILABLE")), setPrivacyEnabled: vi.fn() };
    const { agent } = await boot(w);
    expect(agent).toBeInstanceOf(SparkAgent);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/wallet privacy is NOT enabled: UNAVAILABLE/);
    expect(warn.mock.calls[0][0]).toMatch(/SPARK_PRIVACY=off/);
  });

  it("a fake wallet without the settings API (pre-0.11 SDK shape) warns rather than crashing boot", async () => {
    delete process.env.SPARK_PRIVACY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent } = await boot({});
    expect(agent).toBeInstanceOf(SparkAgent);
    expect(warn.mock.calls[0][0]).toMatch(/spark-sdk >= 0\.11/);
  });
});
