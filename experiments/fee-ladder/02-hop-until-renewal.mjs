// Experiment 02 (hosted REGTEST): bounce a leaf between two ladder-ON wallets
// until its refund timelock runs low and the wallet renews it. Questions:
//   - after renewal, is the refund anchored again (renewal emits no refund ladder)?
//   - does renewal sign node-hop fee variants (enableDirectNodeFeeLadder)?
//   - do the fee steps sent at the earlier claim still match the leaf's refund?
import dotenv from "dotenv";
dotenv.config({ path: "/workspace/.env", quiet: true });
import { writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import {
  SparkWallet, SigningService, TransferService, getTxFromRawTxBytes, getTxId,
  isEphemeralAnchorOutput, getCurrentTimelock,
} from "@buildonspark/spark-sdk";

const AMOUNT = Number(process.argv[2] ?? 4096);
const MAX_HOPS = Number(process.argv[3] ?? 24);
const OPTS = { network: "REGTEST", optimizationOptions: { auto: false } };
const events = [];

const origLadder = SigningService.prototype.buildAnchorlessRefundAndLadder;
SigningService.prototype.buildAnchorlessRefundAndLadder = async function (...args) {
  const r = await origLadder.apply(this, args);
  const firstRung = r?.ladder?.rungs?.[0] && getTxFromRawTxBytes(r.ladder.rungs[0].signedTx);
  events.push({ kind: "claim-ladder", leafId: args[2].leaf.id, rungs: r?.ladder?.rungs?.length ?? 0,
    rungsSpend: firstRung ? bytesToHex(firstRung.getInput(0).txid) : null });
  return r;
};
for (const m of ["renewRefundTxn", "renewNodeTxn", "renewZeroTimelockNodeTxn"]) {
  const o = TransferService.prototype[m];
  TransferService.prototype[m] = async function (node, ...rest) {
    events.push({ kind: "renew", method: m, leafId: node.id,
      refundTimelockBefore: getCurrentTimelock(getTxFromRawTxBytes(node.refundTx).getInput(0).sequence),
      nodeTimelockBefore: getCurrentTimelock(getTxFromRawTxBytes(node.nodeTx).getInput(0).sequence) });
    return o.call(this, node, ...rest);
  };
}
const origJobs = TransferService.prototype.createRenewRefundSigningJobs;
TransferService.prototype.createRenewRefundSigningJobs = async function (...args) {
  const r = await origJobs.apply(this, args);
  events.push({ kind: "renew-signing-jobs", refundJobs: r.signingJobs.length, nodeHopLadderJobs: r.ladderJobs.length });
  return r;
};

const describe = (l) => {
  const refund = getTxFromRawTxBytes(l.refundTx);
  const outs = [...Array(refund.outputsLength).keys()].map((i) => refund.getOutput(i));
  return { leafId: l.id, value: l.value, refundTxid: getTxId(refund),
    anchored: outs.some((o) => isEphemeralAnchorOutput(o.script, o.amount)),
    refundTimelock: getCurrentTimelock(refund.getInput(0).sequence),
    nodeTimelock: getCurrentTimelock(getTxFromRawTxBytes(l.nodeTx).getInput(0).sequence) };
};
const settle = async (w, want) => {
  for (let i = 0; i < 40; i++) {
    const b = (await w.getBalance()).satsBalance;
    if (b.incoming === 0n && b.available >= BigInt(want)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("transfer did not settle");
};

const { wallet: funded } = await SparkWallet.initialize({ mnemonicOrSeed: process.env.SPARK_TEST_MNEMONIC.trim(), options: OPTS });
const fundedAddr = await funded.getSparkAddress();
const { wallet: C } = await SparkWallet.initialize({ options: OPTS });
const { wallet: D } = await SparkWallet.initialize({ options: OPTS });
const addr = new Map([[C, await C.getSparkAddress()], [D, await D.getSparkAddress()]]);

await funded.transfer({ receiverSparkAddress: addr.get(C), amountSats: AMOUNT });
await settle(C, AMOUNT);
const hops = [];
let [from, to] = [C, D];
for (let hop = 0; hop < MAX_HOPS; hop++) {
  const before = events.length;
  const leaves = (await from.getLeaves()).map(describe); // getLeaves runs the renewal check
  const renewedNow = events.slice(before).filter((e) => e.kind !== "claim-ladder");
  hops.push({ hop, holder: from === C ? "C" : "D", leaves, renewals: renewedNow });
  console.log(`hop ${hop} ${from === C ? "C" : "D"}:`, leaves.map((l) => `${l.value}${l.anchored ? "A" : "-"}r${l.refundTimelock}/n${l.nodeTimelock}`).join(" "), renewedNow.length ? `RENEW ${JSON.stringify(renewedNow)}` : "");
  if (renewedNow.some((e) => e.kind === "renew")) {
    const after = (await from.getLeaves()).map(describe);
    hops.push({ hop, holder: from === C ? "C" : "D", afterRenewal: after });
    console.log(`  after renewal:`, after.map((l) => `${l.value}${l.anchored ? "A" : "-"}r${l.refundTimelock}/n${l.nodeTimelock}`).join(" "));
    // One more claim, to see the next owner's format.
    await from.transfer({ receiverSparkAddress: addr.get(to), amountSats: AMOUNT });
    await settle(to, AMOUNT);
    const next = (await to.getLeaves()).map(describe);
    hops.push({ hop: hop + 1, holder: to === C ? "C" : "D", nextClaim: next });
    console.log(`  next claim:`, next.map((l) => `${l.value}${l.anchored ? "A" : "-"}r${l.refundTimelock}/n${l.nodeTimelock}`).join(" "));
    [from, to] = [to, from];
    break;
  }
  await from.transfer({ receiverSparkAddress: addr.get(to), amountSats: AMOUNT });
  await settle(to, AMOUNT);
  [from, to] = [to, from];
}

const left = (await from.getBalance()).satsBalance.available;
if (left > 0n) await from.transfer({ receiverSparkAddress: fundedAddr, amountSats: Number(left) });
for (const w of [C, D, funded]) await w.cleanup();
const out = new URL(`./results/02-hop-until-renewal-${AMOUNT}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ sdk: "0.13.0", amount: AMOUNT, hops, events, returnedSats: String(left), at: new Date().toISOString() }, null, 2) + "\n");
console.log("returned", String(left));
