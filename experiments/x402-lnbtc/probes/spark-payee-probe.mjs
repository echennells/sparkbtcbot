// Two throwaway REGTEST wallets (fresh random seeds, never funded). Who signs
// their Lightning invoices, and can wallet B commit an arbitrary request hash?
import { SparkWallet } from "@buildonspark/spark-sdk";
import { recoverPayee, descriptionHash } from "./bolt11-payee.mjs";

const SPEC_REQUEST_HASH = "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018";
const runs = [
  ["A", { memo: "x402 probe" }],
  ["B", { descriptionHash: SPEC_REQUEST_HASH, expirySeconds: 300 }],
];
for (const [label, opts] of runs) {
  const { wallet } = await SparkWallet.initialize({
    options: { network: "REGTEST", optimizationOptions: { auto: false } },
  });
  try {
    const identity = await wallet.getIdentityPublicKey();
    const r = await wallet.createLightningInvoice({ amountSats: 25, ...opts });
    const inv = r.invoice.encodedInvoice;
    console.log(`wallet ${label} identity  : ${identity}`);
    console.log(`wallet ${label} invoice   : ${inv.slice(0, 40)}…`);
    console.log(`wallet ${label} SIGNED BY : ${recoverPayee(inv)}`);
    console.log(`wallet ${label} desc hash : ${descriptionHash(inv) ?? "(inline memo)"}\n`);
  } finally {
    await wallet.cleanup();
  }
}
