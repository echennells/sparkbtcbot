# SDK 0.13 fee ladders: what the client does (hosted REGTEST, 2026-10-01)

Branch `sdk-013-fee-ladders`. Client side only: what a 0.13 wallet signs, sends and
holds. The operator side (storage, who can publish, watchtower behaviour) needs a lab
with the matching operator build; the public operator code has no ladder support.

## Experiments

| Script | What it does |
|---|---|
| `01-claim-ladder.mjs [sats]` | Funds a fresh ladder-ON wallet. Captures the fee steps it builds, verifies every one, runs SDK 0.13's own exit helper on the leaves, then moves the funds to a ladder-OFF wallet. |
| `02-hop-until-renewal.mjs [sats] [hops]` | Bounces one leaf between two ladder-ON wallets until its refund timelock runs low and the wallet renews it. |

Results are in `results/`. Funds come from the shared REGTEST test wallet and are returned
at the end of each run.

## Findings

1. **Refund ladder at claim (default ON).** Leaves of 1,024 sats and up get an anchorless
   refund: one output, zero fee, signed by the operators. The wallet also builds a fee
   ladder. Leaves of 512 sats and under keep the anchored refund. With 1 sat/vB as the
   floor, a 512-sat leaf can't fund a relayable step.
2. **The fee steps are fully signed and valid.** Run 01 (20,000 sats) checked every step
   of every leaf (32 in all):
   - each is a v3 transaction with one input (the refund's output 0) and one output back
     to the owner's key, sequence `0xfffffffd`;
   - each carries a key-path Schnorr signature that verifies against the owner's key;
   - rung table version 1.

   | Leaf | Steps | Lowest fee | Top fee | Left to the owner by the top step |
   |---|---|---|---|---|
   | 16,384 sats | 20 | 222 sats | 16,054 sats (98.0%) | 330 sats |
   | 4,096 sats | 13 | — | — | 330 sats |
   | 1,024 sats | 6 | 222 sats | 694 sats (67.8%) | 330 sats |

   Steps grow by about 1.25–1.30x each. The lowest fee is about 222 vB × 1 sat/vB, the
   size of the refund-plus-step package.
3. **Every claim sends a new ladder.** In run 02, one 4,096-sat leaf produced a fresh
   13-step ladder at each of the 24 claims, each spending that hop's refund. The operators
   receive one ladder per claim, so over a leaf's life they hold ladders for its past
   refunds too.
   - Past refunds have longer timelocks than the current one. Using one of them is the
     ordinary previous-owner race.
4. **Renewal re-anchors and signs the node-hop ladder.** When a held leaf's refund timelock
   drops below 200 blocks, the wallet runs `renewRefundTxn` the next time it loads its
   leaves.
   - The refund is re-signed **anchored** (timelock reset to 2,000), and the node timelock
     drops 100 (2,000 → 1,900).
   - **16 node-hop fee variants** are signed (`enableDirectNodeFeeLadder`, live on hosted
     regtest).
   - The fee steps sent at that leaf's last claim now spend a superseded refund.
   - The next owner's claim makes the refund anchorless again, with a new ladder.
   - Run 01's first pass caught this by accident: a 1,024-sat leaf with ladder steps but an
     anchored refund.
5. **The refund timelock drops 100 blocks per hop.** Run 02 went 900 → 800 → … → 200,
   renewed, then 1,900 → 1,800 → … Leaf IDs survive transfers.
6. **A ladder-OFF wallet re-anchors everything it receives.** In run 01, every leaf moved to
   a wallet with `enableCpfpRefundLadder: false` came back anchored, and no ladder was built.
7. **SDK 0.13's own exit helper** (`constructUnilateralExitFeeBumpPackages`) handles
   anchorless refunds only when given a signer.
   - Without one it throws `Refund for leaf … has no fee-bump anchor; pass a signer that
     implements signTaprootKeySpendWithDerivation`.
   - Given the wallet's signer, anchorless leaves get a pre-signed fee-paying child, and
     anchored leaves still get an anchor PSBT.
   - Blink's tool (SDK 0.8.6) fails on any such backup (checked earlier the same day).

## Open (needs the lab with a 0.13-matching operator build)

- Does every operator store every ladder it receives? How are they protected?
- Can one operator's stored data publish a top step without the others?
- Does the watchtower publish refund steps when a leaf goes on-chain? Which step does it pick?
- Can the owner outbid or pre-empt a top step under Core's TRUC and package rules?
  This needs a chain we can mine, but no operators.
- Do deposits get a ladder too? `StartDepositTreeCreationRequest` carries a `refundLadder`
  field. This needs L1 regtest funds.
