// Experiment 01 (hosted REGTEST): what an SDK 0.13 claim with the refund ladder
// ON produces, verified transaction by transaction, and whether SDK 0.13's own
// exit helper can build an exit for those leaves.
//
// Captures the fee steps ("rungs") the wallet hands the operators by wrapping
// SigningService.buildAnchorlessRefundAndLadder, the one place they are built.
// Funds come from the shared REGTEST test wallet (SPARK_TEST_MNEMONIC in
// /workspace/.env); everything is returned at the end. No secrets are written.
import dotenv from "dotenv";
dotenv.config({ path: "/workspace/.env", quiet: true });
import { writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { schnorr } from "@noble/curves/secp256k1";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2wpkh, TEST_NETWORK } from "@scure/btc-signer";
import {
  SparkWallet, SigningService, TransferService, getTxFromRawTxBytes, getTxId, getSigHashFromTx,
  isEphemeralAnchorOutput, constructUnilateralExitFeeBumpPackages, Network, getCurrentTimelock,
} from "@buildonspark/spark-sdk";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const AMOUNT = Number(process.argv[2] ?? 20000);
const OPTS = { network: "REGTEST", optimizationOptions: { auto: false } };
const report = { sdk: "0.13.0", network: "REGTEST", amount: AMOUNT, startedAt: new Date().toISOString() };

// --- capture what the wallet sends the operators
const captured = new Map(); // leafId -> { ladderOn, rungs: [hex] }
const orig = SigningService.prototype.buildAnchorlessRefundAndLadder;
SigningService.prototype.buildAnchorlessRefundAndLadder = async function (...args) {
  const r = await orig.apply(this, args);
  const leaf = args[2];
  captured.set(leaf.leaf.id, {
    ladderOn: this.config.getEnableCpfpRefundLadder(),
    rungTableVersion: r?.ladder?.rungTableVersion ?? null,
    rungs: r ? r.ladder.rungs.map((x) => bytesToHex(x.signedTx)) : [],
  });
  return r;
};

// Renewals: the wallet re-signs a leaf whose refund timelock is under 200 blocks
// every time it loads leaves. Log which leaves, and in which wallet.
const renewals = [];
for (const m of ["renewRefundTxn", "renewNodeTxn", "renewZeroTimelockNodeTxn"]) {
  const o = TransferService.prototype[m];
  TransferService.prototype[m] = async function (node, ...rest) {
    renewals.push({ method: m, leafId: node.id, value: node.value, ladderOn: this.config.getEnableCpfpRefundLadder(),
      refundTimelockBefore: getCurrentTimelock(getTxFromRawTxBytes(node.refundTx).getInput(0).sequence) });
    return o.call(this, node, ...rest);
  };
}

const waitLeaves = async (w, want) => {
  for (let i = 0; i < 40; i++) {
    const leaves = await w.getLeaves();
    if (leaves.reduce((s, l) => s + l.value, 0) >= want) return leaves;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return w.getLeaves();
};

// One leaf, checked: refund shape, and every captured rung.
function analyzeLeaf(leaf) {
  const refund = getTxFromRawTxBytes(leaf.refundTx);
  const outs = [...Array(refund.outputsLength).keys()].map((i) => refund.getOutput(i));
  const anchored = outs.some((o) => isEphemeralAnchorOutput(o.script, o.amount));
  const row = {
    leafId: leaf.id, value: leaf.value, refundAnchored: anchored, refundOutputs: outs.length,
    refundTimelock: getCurrentTimelock(refund.getInput(0).sequence),
    renewedAfterClaim: renewals.some((r) => r.leafId === leaf.id),
    refundVersion: refund.version, refundSigned: Boolean(refund.getInput(0).finalScriptWitness?.length),
  };
  const cap = captured.get(leaf.id);
  row.ladderBuilt = Boolean(cap && cap.rungs.length);
  if (!row.ladderBuilt) return row;
  const refundTxid = getTxId(refund);
  const ownerScript = outs[0].script;
  const value = outs[0].amount;
  const xonly = ownerScript.slice(2, 34);
  const fees = [];
  const problems = [];
  cap.rungs.forEach((hex, i) => {
    const rung = getTxFromRawTxBytes(hexToBytes(hex));
    const inp = rung.getInput(0);
    if (rung.version !== 3) problems.push(`rung ${i}: version ${rung.version}`);
    if (rung.inputsLength !== 1 || rung.outputsLength !== 1) problems.push(`rung ${i}: ${rung.inputsLength} in / ${rung.outputsLength} out`);
    if (bytesToHex(inp.txid) !== refundTxid || inp.index !== 0) problems.push(`rung ${i}: does not spend refund:0`);
    if (inp.sequence !== 0xfffffffd) problems.push(`rung ${i}: sequence ${inp.sequence}`);
    const out = rung.getOutput(0);
    if (bytesToHex(out.script) !== bytesToHex(ownerScript)) problems.push(`rung ${i}: pays a different script`);
    fees.push(value - out.amount);
    const wit = inp.finalScriptWitness;
    if (!wit || wit.length !== 1 || wit[0].length !== 64) { problems.push(`rung ${i}: not a key-path signature`); return; }
    const sighash = getSigHashFromTx(rung, 0, { script: ownerScript, amount: value });
    if (!schnorr.verify(wit[0], sighash, xonly)) problems.push(`rung ${i}: signature does not verify`);
  });
  Object.assign(row, {
    rungTableVersion: cap.rungTableVersion,
    rungs: cap.rungs.length,
    feeMin: String(fees[0]), feeMax: String(fees.at(-1)),
    topLeavesSats: String(value - fees.at(-1)),
    topFeeShare: `${((Number(fees.at(-1)) / Number(value)) * 100).toFixed(2)}%`,
    stepRatios: fees.slice(1).map((f, i) => (Number(f) / Number(fees[i])).toFixed(3)).filter((_, i, a) => i === 0 || i === a.length - 1),
    allRungsFullySignedAndValid: problems.length === 0,
    problems,
  });
  return row;
}

const { wallet: funded } = await SparkWallet.initialize({ mnemonicOrSeed: process.env.SPARK_TEST_MNEMONIC.trim(), options: OPTS });
const fundedAddr = await funded.getSparkAddress();
const { wallet: A } = await SparkWallet.initialize({ options: OPTS }); // ladder ON (0.13 default)

// 1. Claim with the ladder on.
await funded.transfer({ receiverSparkAddress: await A.getSparkAddress(), amountSats: AMOUNT });
const leavesA = await waitLeaves(A, AMOUNT);
report.claim = leavesA.map(analyzeLeaf).sort((a, b) => b.value - a.value);

// 2. SDK 0.13's own exit helper on those leaves: with the wallet's signer, and without.
const sk = secp256k1.utils.randomSecretKey();
const pk = secp256k1.getPublicKey(sk, true);
const utxo = { txid: "ab".repeat(32), vout: 0, value: 5_000_000n, script: bytesToHex(p2wpkh(pk, TEST_NETWORK).script), publicKey: bytesToHex(pk) };
const nodeHexes = leavesA.map((l) => bytesToHex(TreeNode.encode(l).finish()));
const sparkClient = await A.connectionManager.createSparkClient(A.config.getCoordinatorAddress());
report.exitHelper = {};
try {
  await constructUnilateralExitFeeBumpPackages(nodeHexes, [utxo], { satPerVbyte: 2 }, Network.REGTEST, sparkClient);
  report.exitHelper.withoutSigner = "built (unexpected)";
} catch (e) { report.exitHelper.withoutSigner = `threw: ${e.message.slice(0, 160)}`; }
try {
  const chains = await constructUnilateralExitFeeBumpPackages(nodeHexes, [utxo], { satPerVbyte: 2 }, Network.REGTEST, sparkClient, undefined, A.config.signer);
  report.exitHelper.withSigner = chains.map((c) => {
    const last = c.txPackages.at(-1);
    return { leafId: c.leafId, packages: c.txPackages.length, refundStep: last.feeBumpTx ? "pre-signed child (anchorless)" : last.feeBumpPsbt ? "anchor PSBT" : "none" };
  });
} catch (e) { report.exitHelper.withSigner = `threw: ${e.message.slice(0, 200)}`; }

// 3. Does a leaf go back to the anchored format when a ladder-OFF wallet receives it?
report.renewalsDuringClaim = renewals.splice(0);
captured.clear(); // leaf ids survive transfers; B's leaves must not inherit A's capture
const { wallet: B } = await SparkWallet.initialize({ options: { ...OPTS, enableCpfpRefundLadder: false } });
await A.transfer({ receiverSparkAddress: await B.getSparkAddress(), amountSats: AMOUNT });
const leavesB = await waitLeaves(B, AMOUNT);
report.reclaimedLadderOff = leavesB.map((l) => ({ value: l.value, ...(({ refundAnchored, ladderBuilt, refundTimelock }) => ({ refundAnchored, ladderBuilt, refundTimelock }))(analyzeLeaf(l)) })).sort((a, b) => b.value - a.value);
report.renewalsInLadderOffWallet = renewals.splice(0);

// Return the funds.
const b = (await B.getBalance()).satsBalance.available;
if (b > 0n) await B.transfer({ receiverSparkAddress: fundedAddr, amountSats: Number(b) });
report.returnedSats = String(b);
for (const w of [A, B, funded]) await w.cleanup();
report.finishedAt = new Date().toISOString();
const out = new URL(`./results/01-claim-ladder-${AMOUNT}.json`, import.meta.url);
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
