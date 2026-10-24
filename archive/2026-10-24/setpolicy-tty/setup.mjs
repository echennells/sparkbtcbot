import { saveEncryptedMnemonic, deriveLedgerHmacKey } from "/workspace/lib/encrypted-seed.js";
import { initSignedLedger, createSpendLedger } from "/workspace/lib/spend-ledger.js";
const dir = process.argv[2];
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: "correct horse battery staple", path: `${dir}/seed.enc`, policy: { dailyBudgetSats: 50000 } });
const hmacKey = deriveLedgerHmacKey(MNEMONIC);
await initSignedLedger({ path: `${dir}/ledger.json`, hmacKey });
await createSpendLedger({ path: `${dir}/ledger.json`, budgetSats: 50000, hmacKey, bound: true }).record(49000, "spark_transfer");
console.log("setup ok");
