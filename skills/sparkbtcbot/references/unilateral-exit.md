# Unilateral exit (operatorless recovery)

Get your Bitcoin off Spark and back onto L1 **without the operators** — the last-resort
path if the Spark Service Provider and signing operators are permanently gone.

> **The load-bearing fact:** a Spark seed phrase **cannot** unilaterally exit on its own.
> Exit requires the tree of pre-signed node/refund transactions ("leaf material") that
> the operators hand your wallet at claim/transfer time and it holds *in memory*. If the
> operators disappear and you kept no local copy of that material, the money is stuck.
> So unilateral exit is a **two-part** capability:
>
> 1. **`scripts/leaf-vault.js`** — continuously mirrors the leaf material to disk (`~/.spark/leaf-vault/current.json`).
> 2. **`scripts/unilateral-exit.js`** — broadcasts that material to L1 with no operators involved.
>
> The vault is the backup; this is the restore. One is useless without the other.

## When you'd run it

Only when cooperative exit (`wallet.withdraw`, which needs the SSP) is impossible —
i.e. the operators are unreachable and not coming back. In every normal case, use the
cooperative path; it's cheaper and instant.

## Prerequisites

- **A current leaf-vault** — run the leaf-vault (`enableLeafVault(wallet)` or the CLI)
  while the operators are still up, so the material is on disk. Verify it any time with
  `node scripts/leaf-vault.js verify`.
- **A bitcoind you can broadcast from** — your own node, or any Bitcoin Core RPC you trust.
- **An external L1 fee UTXO you control** — the pre-signed exit txs are **zero-fee** and
  carry an ephemeral anchor; the fee is paid by CPFP from a UTXO you fund separately. You
  need its private key so this tool can sign the fee-bump child.

## Configuration (env)

| Variable | Meaning |
|---|---|
| `SPARK_BITCOIN_RPC_URL` | bitcoind JSON-RPC base URL (e.g. `http://127.0.0.1:8332`) — **required** |
| `SPARK_BITCOIN_RPC_USER` / `_PASS` | RPC credentials |
| `SPARK_BITCOIN_RPC_WALLET` | wallet name for wallet RPCs (auto-fund / mining) |
| `SPARK_NETWORK` | `MAINNET` (default) `\| REGTEST \| TESTNET \| SIGNET \| LOCAL` |
| `SPARK_LEAF_VAULT_PATH` | vault file (default `~/.spark/leaf-vault/current.json`) |
| `SPARK_EXIT_FEE_PRIVKEY` | hex privkey whose P2WPKH address holds a funded UTXO for CPFP fees |
| `SPARK_EXIT_FEERATE` | target sat/vByte for the CPFP bump (default `2`) |
| `SPARK_EXIT_REGTEST_MINE` | `true` to mine blocks + use `generateblock` — **regtest/devnet testing only** |

## Usage

```bash
# 1) preview — rebuilds every exit chain OFFLINE and shows the packages, broadcasts nothing
SPARK_BITCOIN_RPC_URL=http://127.0.0.1:8332 SPARK_BITCOIN_RPC_USER=… SPARK_BITCOIN_RPC_PASS=… \
SPARK_EXIT_FEE_PRIVKEY=<hex> \
node scripts/unilateral-exit.js --dry-run

# 2) real exit
SPARK_BITCOIN_RPC_URL=… SPARK_BITCOIN_RPC_USER=… SPARK_BITCOIN_RPC_PASS=… \
SPARK_EXIT_FEE_PRIVKEY=<hex> \
node scripts/unilateral-exit.js
```

## What it does

For each leaf in the vault:

1. **Rebuild the leaf→root chain offline** — `buildUnilateralExitChain` with **no client**.
   The operators are never contacted; the chain comes entirely from the vault.
2. **Build CPFP fee-bump packages** — `constructUnilateralExitFeeBumpPackages` produces,
   per leaf, an ordered list of `{ tx, feeBumpPsbt }`: the pre-signed 0-fee tx plus a child
   that pays the fee from your external UTXO and spends the tx's ephemeral anchor.
3. **Broadcast the node tx(s)** as a package (parent + signed CPFP child).
4. **Wait the refund's CSV timelock** — the refund tx spends the node output after a
   relative timelock (up to ~2000 blocks for a fresh leaf, decrementing per prior transfer).
5. **Broadcast the refund** — the sats land at your L1 address.

## The CSV wait is real

The refund can't confirm until its relative timelock elapses — **up to ~2000 blocks
(~2 weeks on mainnet)** for a never-transferred leaf. The tool polls for the height; you
can stop it after the node txs are broadcast and re-run once the timelock is near.

## Caveats / limitations (read before relying on this)

- **Experimental, last-resort.** Prefer cooperative exit whenever the SSP is reachable.
- **Depends on SDK internals.** The vault reaches into `protected` SDK internals
  (`wallet.leafManager` and the `TreeNode` proto codec) — guarded by a fail-loud
  self-check, but pin the SDK version and re-verify on upgrade. See `leaf-vault.js`.
- **Ephemeral-anchor relay policy.** The exit txs use a 0-value P2A anchor + TRUC (v3)
  CPFP. Bitcoin Core **v28.0** may reject the anchor as `dust` at the *relay* layer (the
  txs are still consensus-valid); newer/relaxed-policy nodes relay it. If your node
  rejects it, broadcast from a node with ephemeral-dust/package relay, or (regtest only)
  use `SPARK_EXIT_REGTEST_MINE=true`.
- **You must fund the fee.** No external UTXO → no exit. Size it for the whole chain.
- **Many leaves** share one fee UTXO by chaining the CPFP children; provide adequate value.

## Verification status

The full loop — **mint a leaf → snapshot the vault → reconstruct offline with operators
stopped → broadcast → clear the CSV → recover to L1** — has been exercised end-to-end on a
local Spark devnet (own operators + regtest bitcoind). The recovery data, tx construction,
and signing are proven; the only step not exercised on a live public mempool is
`submitpackage` relay of the ephemeral-anchor package (rejected as `dust` by the devnet's
v28.0 node — a relay-policy quirk, not a validity problem).
