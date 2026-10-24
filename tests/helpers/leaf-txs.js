// Real pre-signed transactions for mock wallet leaves. The leaf-vault gate
// parses each leaf's nodeTx and refundTx (the exit tool has to), so stand-in
// bytes like [1, 2, 3] no longer pass it. Both come from the hosted-REGTEST
// backups in tests/fixtures/leaf-vault/.
import { readFileSync } from "node:fs";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const leaf = (fixture, id) => {
  const bundle = JSON.parse(readFileSync(new URL(`../fixtures/leaf-vault/${fixture}.json`, import.meta.url), "utf8"));
  const l = id ? bundle.leaves.find((x) => x.id === id) : bundle.leaves[0];
  return TreeNode.decode(Buffer.from(l.treeNodeHex, "hex"));
};

const anchored = leaf("regtest-ladder-off");
// The ladder-on backup's 1,024-sat leaf: its refund has no anchor.
const anchorless = leaf("regtest-ladder-on", "01a0eda1-bc88-7efa-81cb-ae42aa56dec3");

// Spread into a mock leaf: { id, status, value, ...LEAF_TXS }.
export const LEAF_TXS = Object.freeze({ nodeTx: anchored.nodeTx, refundTx: anchored.refundTx });
export const ANCHORLESS_LEAF_TXS = Object.freeze({ nodeTx: anchorless.nodeTx, refundTx: anchorless.refundTx });
