# Architecture & Comparisons

Load when the user wants to understand how Spark works, weigh it against Lightning/on-chain, or reason about fees.

## How It Works

1. Users hold their own keys (BIP39 mnemonic) — fully self-custodial.
2. Transactions are cooperatively signed by a threshold of Signing Operators (SOs).
3. Funds live in Bitcoin UTXOs organized in hierarchical trees.
4. Users can always exit to L1 unilaterally if operators go offline.

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
| **Lightning to Spark** (receive) | 0.15% (charged via route hints; a live 2026-08 receive was credited in full — treat as worst case) |
| **Spark to Lightning** (send) | 0.25% + Lightning routing fees |
| **L1 deposit to Spark** | On-chain tx fee (paid by user) **plus an SSP claim spread** at claim time — cannot be computed in advance; preview with `getClaimStaticDepositQuote` and claim with an explicit `maxFee` |
| **Cooperative exit to L1** | On-chain broadcast fee + SSP fee: `sats_per_vbyte × (111 × 2 + tx_vbytes)` |
| **Unilateral exit to L1** | On-chain tx fee (paid by user) |

Cooperative exit fees don't scale with withdrawal amount, so they're proportionally higher for smaller withdrawals. Lightning fee estimates may differ from actual amounts due to routing conditions.

## Key Advantage for Agents

A single mnemonic provides identity, wallet, and payment capabilities — no separate identity system, no wallet provider accounts, no channel management. Spark-to-Spark transfers are free, making it significantly cheaper than Lightning routing fees, on-chain miner fees (200+ sats), or card processing (2-3%). For agents doing frequent microtransactions, zero fees mean no value lost to overhead.

## Tools

| Tool | Purpose | URL |
|------|---------|-----|
| Spark SDK | TypeScript wallet SDK | https://www.npmjs.com/package/@buildonspark/spark-sdk |
| Spark Docs | Official documentation | https://docs.spark.money |
| Sparkscan | Block explorer | https://sparkscan.io |
| Spark CLI | Command-line interface | https://docs.spark.money/tools/cli |
