// Options for every SparkWallet this package opens. SDK-free.
//
// Since SDK 0.13, two fee ladders are on by default:
//   enableCpfpRefundLadder    — at every claim, leaves of ~1,024 sats and up get
//                               an anchorless refund, and the wallet sends the
//                               operators up to 24 fee steps signed with the leaf
//                               key. The top step pays all but 330 sats to miners.
//   enableDirectNodeFeeLadder — at refund renewal, fee variants of the
//                               operators' direct exit transaction are signed.
// Both stay OFF here (decision 2026-10-01; unilateral-exit.md → fee ladders):
//   - a backup holding an anchorless refund can't be exited by today's exit
//     tool (Blink's spark-unilateral-exit fails on the whole backup);
//   - the operators store the fee steps as fully signed, broadcastable
//     transactions. How they protect them, and whether one operator's copy is
//     enough to use them, isn't public yet.
// Off is reversible (flip it and the next claims change); steps already
// handed over can't be recalled. A wallet that claims with these off
// re-anchors whatever it receives.
//
// The settings belong to the wallet OBJECT, not the wallet: every program
// that opens the same seed decides for itself. That is why every entry point
// here builds its options through this one function.

export const FEE_LADDERS_OFF = Object.freeze({
  enableCpfpRefundLadder: false,
  enableDirectNodeFeeLadder: false,
});

// The SDK's network names. Anything else doesn't fail in the SDK: undefined
// picks REGTEST endpoints and a lowercase name or an object picks LOCAL ones,
// so a typo'd SPARK_NETWORK would quietly open a wallet somewhere else.
const NETWORKS = Object.freeze(["MAINNET", "TESTNET", "SIGNET", "REGTEST", "LOCAL"]);

// SparkWallet.initialize options: `extra` plus the network, with the ladders
// forced off (applied last, so an `extra` can't switch them back on by
// accident).
export function sparkWalletOptions(network, extra = {}) {
  if (!NETWORKS.includes(network)) {
    throw new TypeError(
      `sparkWalletOptions: network must be one of ${NETWORKS.join(", ")}, got ${JSON.stringify(network) ?? String(network)}. ` +
      `It's the first argument: sparkWalletOptions("MAINNET", { ...other options }).`,
    );
  }
  return { ...extra, network, ...FEE_LADDERS_OFF };
}
