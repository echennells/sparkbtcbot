// The REGTEST silent-payment withdrawal test trusts tests/helpers/
// silent-payment.js to say whether an output belongs to a receiver. Pin that
// helper to the BIP-352 test vectors, so a pass there means the SSP's output
// is right and not that two bugs agree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { silentPaymentAddress, scanTransaction, createSilentPaymentReceiver } from "../helpers/silent-payment.js";

const vectors = JSON.parse(readFileSync(new URL("../fixtures/bip352/receiving-subset.json", import.meta.url), "utf8"));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const int = (hex) => BigInt(`0x${hex}`);

// The vectors' inputs as the esplora JSON the helper reads.
const asTx = (s) => ({
  vin: s.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: ["", i.pubkey], prevout: { scriptpubkey_type: "v0_p2wpkh" } })),
  vout: s.outputs.map((x) => ({ scriptpubkey: `5120${x}`, value: 0 })),
});

describe("tests/helpers/silent-payment.js against the BIP-352 vectors", () => {
  it("has vectors to check", () => {
    expect(vectors.addresses.length).toBeGreaterThanOrEqual(20);
    expect(vectors.scans.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectors.addresses.map((a) => [a.comment, a]))("address: %s", (_, a) => {
    expect(silentPaymentAddress("MAINNET", int(a.scan), int(a.spend))).toBe(a.address);
  });

  it.each(vectors.scans.map((s) => [s.comment, s]))("scan: %s", (_, s) => {
    const found = scanTransaction(asTx(s), { scanKey: int(s.scan), spendKey: int(s.spend) });
    expect(found).not.toBeNull();
    const want = s.expected.find((o) => o.pub_key === found.outputKey);
    expect(want, `found ${found.outputKey}, not an expected output`).toBeTruthy();
    expect((found.privateKey - int(s.spend) + N) % N).toBe(int(want.priv_key_tweak));
  });

  it("finds nothing for another receiver", () => {
    const s = vectors.scans[0];
    const other = createSilentPaymentReceiver("MAINNET");
    expect(scanTransaction(asTx(s), other)).toBeNull();
  });

  it("refuses an input type it doesn't model instead of reporting no match", () => {
    const tx = asTx(vectors.scans[0]);
    tx.vin[0].prevout.scriptpubkey_type = "v1_p2tr";
    expect(() => scanTransaction(tx, createSilentPaymentReceiver("MAINNET"))).toThrow(/not a P2WPKH spend/);
  });

  it("uses the SDK's regtest prefix", () => {
    expect(createSilentPaymentReceiver("REGTEST").address).toMatch(/^sprt1q/);
    expect(createSilentPaymentReceiver("MAINNET").address).toMatch(/^sp1q/);
  });
});
