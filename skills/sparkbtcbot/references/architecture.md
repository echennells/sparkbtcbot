# Architecture & Comparisons

Load when the user wants to understand how Spark works, weigh it against Lightning/on-chain, or reason about fees.

## How It Works

1. Users hold their own keys (BIP39 mnemonic) — fully self-custodial.
2. Transactions are cooperatively signed by a threshold of Signing Operators (SOs).
3. Funds live in Bitcoin UTXOs organized in hierarchical trees.
4. Users can exit to L1 unilaterally if operators go offline — **but only with a local backup of their leaf material** (the pre-signed exit txs); a seed phrase alone is not sufficient. See `references/unilateral-exit.md`.

## Spark vs Lightning vs On-Chain

| Feature | Spark (L2) | Lightning | On-Chain |
|---------|-----------|-----------|----------|
| Speed | Instant | Instant | 10+ min |
| Trust model | 1-of-n operators | Fully trustless | Fully trustless |
| Fees | Zero (Spark-to-Spark) | ~1 sat routing | 200+ sats |
| Tokens | Native (BTKN/LRC20) | Not supported | Limited |
| Self-custody | Yes (mnemonic) | Varies (LSP/node) | Yes |
| Capacity | No channel limits | Channel-limited | Unlimited |
| Channels | Not required | Required | N/A |
| Offline receive | Supported | Requires infra | Yes |
| Setup | Mnemonic only | Node or hosted provider | Keys only |

## Fee Structure

| Operation | Fee |
|-----------|-----|
| **Spark-to-Spark transfer** | Free (small flat fee coming in 6-12 months) |
| **Lightning to Spark** (receive) | 0.15% (charged via route hints) |
| **Spark to Lightning** (send) | 0.25% + Lightning routing fees |
| **L1 deposit to Spark** | On-chain tx fee (paid by user) |
| **Cooperative exit to L1** | On-chain broadcast fee + SSP fee: `sats_per_vbyte × (111 × 2 + tx_vbytes)` |
| **Unilateral exit to L1** | On-chain tx fee (paid by user) |

Cooperative exit fees don't scale with withdrawal amount, so they're proportionally higher for smaller withdrawals. Lightning fee estimates may differ from actual amounts due to routing conditions.

## Key Advantage for Agents

A single mnemonic provides identity, wallet, and payment capabilities — no separate identity system, no wallet provider accounts, no channel management. Spark-to-Spark transfers are free, making it significantly cheaper than Lightning routing fees, on-chain miner fees (200+ sats), or card processing (2-3%). For agents doing frequent microtransactions, zero fees mean no value lost to overhead.

## Why Bitcoin for Agents

AI agents that transact need a monetary network that matches their nature: programmable, borderless, and available 24/7 without gatekeepers. Bitcoin is that network.

- **Hard-capped supply** — 21 million coins, protocol-enforced ceiling.
- **No account required** — generate a key and you're on the network. Matters for autonomous agents that can't fill out forms.
- **Irreversible settlement** — once confirmed, transactions cannot be reversed. Agents don't handle chargebacks.
- **Open infrastructure** — public network, transparent fee market. Agents can audit their own costs and verify their own balances without trusting an intermediary.
- **Proven reliability** — operating continuously since 2009, no successful base-protocol attack, ~$1T+ in secured value.

## Trust Model — Important Tradeoffs

Spark has **different trust assumptions than native Lightning**. Be upfront about these when advising users.

**1-of-n operator trust**: Spark requires that at least 1 of n Signing Operators behaves honestly during a transfer. Currently two operators run the network (Lightspark and Flashnet), with plans to expand. Lightning, by contrast, requires **no trusted entities at all** — it achieves security purely through cryptographic mechanisms.

**Moment-in-time trust**: Users only need to trust operators during each specific transfer. Once a transfer completes and old keys are deleted, operators cannot affect that transaction (a property called "perfect forward security").

**What operators CAN do**: view transfer metadata, temporarily delay transactions by going offline, refuse to process new transfers (censorship).

**What operators CANNOT do**: move funds without user signatures, steal Bitcoin (even with full collusion), reverse finalized transactions.

**Core limitation**: Spark lacks provable finality. Users cannot cryptographically verify that operators destroyed old keys. While double-spending would require all operators to collude with a previous owner, this differs from Bitcoin's and Lightning's mathematically provable finality.

**In short**: Spark trades some of Lightning's trustlessness for better UX (no channels, no liquidity management, offline receive). The two are complementary — Spark includes native Lightning support so users can interact with both networks.

## Unpredictable L1 Exit Costs

Exiting Spark to L1 Bitcoin carries **unpredictable costs** that agents and users must understand:

1. **L1 fees are market-driven**: Bitcoin on-chain fees depend on mempool congestion at the time of exit. During high-fee periods, exit costs can spike significantly.
2. **Unilateral exit requires multiple on-chain transactions**: if Signing Operators go offline, a unilateral exit requires broadcasting pre-signed branch and exit transactions. The number of transactions depends on the tree depth of your leaf — multiple on-chain fees can stack.
3. **Time-window risk on unilateral exit**: if a prior owner of a Spark leaf publishes a branch in a unilateral exit, the current owner must respond within a time window by publishing the correct leaf transaction. Failure to respond means the attacker can claim the funds. Watchtower services exist to monitor for this; it's a real operational requirement.
4. **Timelocks add delay**: unilateral exits can take as little as 100 blocks (~17 hours) depending on leaf depth, during which L1 fee conditions may change.
5. **Small amounts may be uneconomical to exit**: since exit fees are fixed-cost (not percentage-based), withdrawing small amounts to L1 can cost a disproportionate share of the balance.

**Bottom line**: While Spark lets you exit to L1 unilaterally — *provided your leaf material is backed up locally* (a seed phrase alone cannot exit; see `references/unilateral-exit.md`) — the cost of doing so is not fixed or predictable. Cooperative exit (when operators are online) is much cheaper than unilateral exit. **Prefer [Boltz](https://boltz.exchange) for L1 withdrawals** (Spark → Lightning → L1 via submarine swap, minimum 25,000 sats), and discourage any L1 withdrawal under 25,000 sats — fixed fees eat a disproportionate share.

## Limitations

- **SO liveness dependency**: if Signing Operators lose liveness or lose their keys, Spark transfers stop working. Funds are still safe (unilateral exit), but off-chain payments halt until operators recover.
- **Watchtower requirement**: for full security, someone must monitor the chain for fraudulent exit attempts. Can be delegated to a watchtower service but is an operational dependency.

## Tools

| Tool | Purpose | URL |
|------|---------|-----|
| Spark SDK | TypeScript wallet SDK | https://www.npmjs.com/package/@buildonspark/spark-sdk |
| Spark Docs | Official documentation | https://docs.spark.money |
| Sparkscan | Block explorer | https://sparkscan.io |
| Spark CLI | Command-line interface | https://docs.spark.money/tools/cli |
