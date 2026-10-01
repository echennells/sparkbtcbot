// Invoices created on REGTEST, decoded and checked field by field. These used
// to assert only `typeof encoded === "string" || encoded === undefined`, which
// passed whatever the SDK returned; now each invoice must decode to the wallet
// that made it, with the amount, memo, token and expiry it was given.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { decodeSparkAddress, encodeBech32mTokenIdentifier } from "@buildonspark/spark-sdk";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";
import { getOrCreateIssuerToken, cleanupAllIssuers } from "../helpers/issuer.js";
import { decodeInvoiceSats } from "../../lib/bolt11.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

describe("invoices (REGTEST)", () => {
  let wallet;
  let identity;
  let tokenId;

  beforeAll(async () => {
    ({ wallet } = await createTestWallet());
    identity = await wallet.getIdentityPublicKey();
    // Mint a fresh token from a throwaway issuer so we have a real token id
    // to reference when constructing token invoices. The receiving wallet
    // does NOT need to own the token to create an invoice for it.
    const issuerMnemonic = generateMnemonic(wordlist);
    ({ tokenId } = await getOrCreateIssuerToken({
      mnemonic: issuerMnemonic,
      tokenName: "InvoiceTest",
      tokenTicker: "INVTEST",
    }));
  }, 90_000);

  afterAll(async () => {
    await cleanupAllWallets();
    await cleanupAllIssuers();
  });

  const decode = (invoice) => decodeSparkAddress(invoice, "REGTEST");

  it("a Spark sats invoice decodes to this wallet, with its amount and memo", async () => {
    const invoice = await wallet.createSatsInvoice({ amount: 1000, memo: "test sats invoice" });
    expect(invoice).toMatch(/^sparkrt1/);
    const { identityPublicKey, sparkInvoiceFields: f } = decode(invoice);
    expect(identityPublicKey).toBe(identity);
    expect(f.paymentType).toEqual({ type: "sats", amount: 1000 });
    expect(f.memo).toBe("test sats invoice");
    // longer than the bare address it is shaped like
    expect(invoice.length).toBeGreaterThan((await wallet.getSparkAddress()).length);
  });

  it("an amountless sats invoice carries no amount (the payer must supply one)", async () => {
    const invoice = await wallet.createSatsInvoice({ memo: "you choose" });
    const { paymentType } = decode(invoice).sparkInvoiceFields;
    expect(paymentType.type).toBe("sats");
    expect(paymentType.amount).toBeUndefined();
  });

  it("an invoice with an expiry carries it", async () => {
    const expiry = new Date(Date.now() + 3_600_000);
    const invoice = await wallet.createSatsInvoice({ amount: 10, expiryTime: expiry });
    const { expiryTime } = decode(invoice).sparkInvoiceFields;
    expect(Math.abs(new Date(expiryTime).getTime() - expiry.getTime())).toBeLessThan(1000);
  });

  it("a bare Spark address decodes with no invoice fields", async () => {
    const decoded = decode(await wallet.getSparkAddress());
    expect(decoded.identityPublicKey).toBe(identity);
    expect(decoded.sparkInvoiceFields).toBeUndefined();
  });

  it("a Spark token invoice names the token and amount", async () => {
    expect(tokenId).toMatch(/^btknrt1/);
    const invoice = await wallet.createTokensInvoice({ amount: 100n, tokenIdentifier: tokenId, memo: "test token invoice" });
    const { identityPublicKey, sparkInvoiceFields: f } = decode(invoice);
    expect(identityPublicKey).toBe(identity);
    expect(f.paymentType.type).toBe("tokens");
    expect(f.paymentType.amount).toBe(100n);
    // the decoder returns the token as raw hex; it must be the same token
    const asBech32 = encodeBech32mTokenIdentifier({
      tokenIdentifier: Uint8Array.from(Buffer.from(f.paymentType.tokenIdentifier, "hex")),
      network: "REGTEST",
    });
    expect(asBech32).toBe(tokenId);
  });

  it("a BOLT11 Lightning invoice carries its amount", async () => {
    const request = await wallet.createLightningInvoice({ amountSats: 1000, memo: "test lightning invoice", expirySeconds: 3600 });
    const bolt11 = request.invoice.encodedInvoice;
    expect(bolt11).toMatch(/^lnbcrt/);
    expect(decodeInvoiceSats(bolt11)).toBe(1000);
  });

  it("a Lightning invoice with an embedded Spark address still decodes as BOLT11", async () => {
    const request = await wallet.createLightningInvoice({
      amountSats: 500,
      memo: "spark-aware",
      expirySeconds: 3600,
      includeSparkAddress: true,
    });
    expect(request.invoice.encodedInvoice).toMatch(/^lnbcrt/);
    expect(decodeInvoiceSats(request.invoice.encodedInvoice)).toBe(500);
  });
});
