import { deriveLedgerHmacKey, loadSeedPayload } from "/workspace/lib/encrypted-seed.js";
import { createSpendLedger } from "/workspace/lib/spend-ledger.js";
const dir = process.argv[2];
const p = await loadSeedPayload({ passphrase: "correct horse battery staple", path: `${dir}/seed.enc` });
const s = await createSpendLedger({ path: `${dir}/ledger.json`, budgetSats: p.policy.dailyBudgetSats, hmacKey: deriveLedgerHmacKey(p.mnemonic), bound: true }).status();
console.log("sealed:", JSON.stringify(p.policy));
console.log("ledger verifies; spentSats =", s.spentSats);
