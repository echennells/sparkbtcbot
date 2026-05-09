---
name: sparkbtcbot
description: Set up Spark Bitcoin L2 wallet capabilities for AI agents — wallet initialization from BIP39 mnemonic, sats and BTKN/LRC20 token transfers, Lightning invoices (create and pay), Spark native invoices, L402 paywall payment, L1 deposits and cooperative withdrawals, message signing. Make sure to use this skill whenever the user wants an AI agent to send or receive Bitcoin/Lightning autonomously, mentions Spark, BTKN, BTC L2, or L402, asks how to give a bot a wallet or pay for API access from code, builds an agent that earns or spends sats, sets up a non-custodial wallet for an LLM, or describes any agent that needs to move money on Bitcoin — even if they don't say "Spark" specifically.
argument-hint: "[Optional: specify what to set up - wallet, payments, tokens, lightning, l402, or full]"
requires:
  env:
    - name: SPARK_PASSPHRASE
      description: Passphrase that decrypts the BIP39 mnemonic from the encrypted-seed file (~/.spark/seed.enc by default). Useless without the seed file. Run `npm run setup` once to create the encrypted seed.
      sensitive: true
    - name: SPARK_NETWORK
      description: Network to connect to (MAINNET or REGTEST)
      default: MAINNET
    - name: SPARK_SEED_PATH
      description: Optional override for the encrypted-seed file location. Defaults to ~/.spark/seed.enc.
model-invocation: autonomous
model-invocation-reason: This skill enables agents to autonomously send and receive Bitcoin payments. Autonomous invocation is intentional — agents need to pay invoices and respond to incoming transfers without human approval for each transaction. Use spending limits and the proxy for production environments where you need guardrails.
---

# Spark Bitcoin L2 for AI Agents

You are an expert in setting up Spark Bitcoin L2 wallet capabilities for AI agents using `@buildonspark/spark-sdk`.

Spark is a Bitcoin Layer 2 that enables instant, zero-fee self-custodial transfers of BTC and tokens, with native Lightning Network interoperability. Spark-to-Spark transfers cost nothing — compared to Lightning routing fees or on-chain transaction fees of 200+ sats. Even cross-network payments (Lightning interop) are cheaper than most alternatives at 0.15-0.25%. A single BIP39 mnemonic gives an agent identity, wallet access, and payment capabilities.

## For Production Use

**This skill gives the agent full custody of the wallet.** The agent holds the mnemonic and can send all funds without restriction. This is appropriate for:
- Development and testing (use REGTEST with no real funds)
- Trusted agents you fully control
- Small operational balances you're willing to lose

**For production with real funds, use [sparkbtcbot-proxy](https://github.com/echennells/sparkbtcbot-proxy) instead.** The proxy keeps the mnemonic on your server and gives agents scoped access via bearer tokens:
- **Spending limits** — per-transaction and daily caps
- **Role-based access** — read-only, invoice-only, or full access
- **Revocable tokens** — cut off a compromised agent without moving funds
- **Audit logs** — track all wallet activity

The proxy wraps the same Spark SDK behind authenticated REST endpoints. Agents get HTTP access instead of direct SDK access.

## Rules for Claude when operating this skill

These rules apply whenever this skill is active. They are not optional — the mnemonic and the passphrase that decrypts it both control all funds in the wallet, and a leak into the conversation transcript or shell history is functionally identical to a leak from disk.

- **DO NOT print the mnemonic to chat, logs, or any other output.** Not to confirm it's set, not to verify the user pasted it correctly. To verify the wallet loads, call `wallet.getSparkAddress()` and compare *addresses*, never seed words.
- **DO NOT print the passphrase either.** It's the other half of the seed material — leaking the passphrase in the same conversation that has the seed file path leaks the wallet.
- **DO NOT read `.env` back into the conversation.** Load it programmatically with `import "dotenv/config"`. Never `cat .env`, `head .env`, `Read` the file, or otherwise put its contents in chat. Same rule for `.env.local`, `.envrc`, and any secrets-bearing dotfile.
- **DO NOT read the encrypted-seed file** (`~/.spark/seed.enc`) into the conversation either, even though it's encrypted — there is no reason to.
- **DO NOT run `env`, `printenv`, `set`, or `echo $SPARK_PASSPHRASE`** in the conversation — these dump the passphrase into the transcript.
- **DO NOT include the mnemonic in commit messages, code comments, test fixtures, README examples, or git history.** REGTEST throwaway mnemonics are the only exception; when logging one, prefix it with "REGTEST throwaway" inline so a future reader doesn't mistake it for a mainnet seed.
- **DO NOT silently embed a generated mnemonic in code.** When `SparkWallet.initialize()` or the setup script returns a fresh mnemonic, surface it to the user once with explicit instructions to save it offline, then drop it from working context.
- **If you think a mnemonic or passphrase has been exposed in this conversation,** stop and tell the user before doing anything else. Do not attempt to "clean up" by generating a new wallet or sweeping funds without explicit user instruction.

## Why Bitcoin for Agents

AI agents that transact need a monetary network that matches their nature: programmable, borderless, and available 24/7 without gatekeepers. Bitcoin is that network.

- **Hard-capped supply** — 21 million coins, protocol-enforced ceiling.
- **No account required** — generate a key and you're on the network. Matters for autonomous agents that can't fill out forms.
- **Irreversible settlement** — once confirmed, transactions cannot be reversed. Agents don't handle chargebacks.
- **Open infrastructure** — public network, transparent fee market. Agents can audit their own costs and verify their own balances without trusting an intermediary.
- **Proven reliability** — operating continuously since 2009, no successful base-protocol attack, ~$1T+ in secured value.

## What is Spark

Spark is a recently launched Bitcoin Layer 2 that lets you send and receive Bitcoin instantly with low fees. Spark-to-Spark transfers are free; Lightning interop costs 0.15–0.25%. Instead of Lightning's payment channels, Spark uses a network of distributed Signing Operators (SOs) that collectively manage transaction signing without any single entity controlling funds. Fully self-custodial (you hold your own keys), fully interoperable with Lightning. **However**, Spark requires trusting that at least 1-of-n operators behaves honestly during transfers, and lacks the provable finality of Bitcoin or Lightning. The network currently has only a small number of Signing Operators, so there is real risk of downtime or service disruption.

→ For deeper architecture, fee tables, Spark vs Lightning vs On-Chain comparison, and external tools, load `references/architecture.md`.

### Trust Model — Important Tradeoffs

Spark has **different trust assumptions than native Lightning**. Be upfront about these when advising users.

**1-of-n operator trust**: Spark requires that at least 1 of n Signing Operators behaves honestly during a transfer. Currently two operators run the network (Lightspark and Flashnet), with plans to expand. Lightning, by contrast, requires **no trusted entities at all** — it achieves security purely through cryptographic mechanisms.

**Moment-in-time trust**: Users only need to trust operators during each specific transfer. Once a transfer completes and old keys are deleted, operators cannot affect that transaction (a property called "perfect forward security").

**What operators CAN do**: view transfer metadata, temporarily delay transactions by going offline, refuse to process new transfers (censorship).

**What operators CANNOT do**: move funds without user signatures, steal Bitcoin (even with full collusion), reverse finalized transactions.

**Core limitation**: Spark lacks provable finality. Users cannot cryptographically verify that operators destroyed old keys. While double-spending would require all operators to collude with a previous owner, this differs from Bitcoin's and Lightning's mathematically provable finality.

**In short**: Spark trades some of Lightning's trustlessness for better UX (no channels, no liquidity management, offline receive). The two are complementary — Spark includes native Lightning support so users can interact with both networks.

### Unpredictable L1 Exit Costs — Important

Exiting Spark to L1 Bitcoin carries **unpredictable costs** that agents and users must understand:

1. **L1 fees are market-driven**: Bitcoin on-chain fees depend on mempool congestion at the time of exit. During high-fee periods, exit costs can spike significantly.
2. **Unilateral exit requires multiple on-chain transactions**: if Signing Operators go offline, a unilateral exit requires broadcasting pre-signed branch and exit transactions. The number of transactions depends on the tree depth of your leaf — multiple on-chain fees can stack.
3. **Time-window risk on unilateral exit**: if a prior owner of a Spark leaf publishes a branch in a unilateral exit, the current owner must respond within a time window by publishing the correct leaf transaction. Failure to respond means the attacker can claim the funds. Watchtower services exist to monitor for this; it's a real operational requirement.
4. **Timelocks add delay**: unilateral exits can take as little as 100 blocks (~17 hours) depending on leaf depth, during which L1 fee conditions may change.
5. **Small amounts may be uneconomical to exit**: since exit fees are fixed-cost (not percentage-based), withdrawing small amounts to L1 can cost a disproportionate share of the balance.

**Bottom line**: While Spark guarantees you can always exit to L1, the cost of doing so is not fixed or predictable. Keep this in mind when deciding how much value to hold on Spark, especially for agent wallets. Cooperative exit (when operators are online) is much cheaper than unilateral exit.

**Prefer Boltz for L1 withdrawals.** Spark's native cooperative exit is expensive due to fixed on-chain fees, making it especially punishing for smaller amounts. [Boltz](https://boltz.exchange) offers a cheaper path from Lightning to L1 (Spark → Lightning → L1 via submarine swap) with a minimum of 25,000 sats. **Discourage any L1 withdrawal activity under 25,000 sats** — fees will eat a disproportionate share. For 25,000 sats or more, route through Boltz rather than Spark's built-in cooperative exit.

### Limitations

- **SO liveness dependency**: if Signing Operators lose liveness or lose their keys, Spark transfers stop working. Funds are still safe (unilateral exit), but off-chain payments halt until operators recover.
- **Watchtower requirement**: for full security, someone must monitor the chain for fraudulent exit attempts. Can be delegated to a watchtower service but is an operational dependency.

## Required Libraries

```bash
npm install @buildonspark/spark-sdk@^0.7.17 dotenv
```

For token issuance (minting new tokens), additionally:
```bash
npm install @buildonspark/issuer-sdk@^0.1.35
```

The SDK bundles BIP39 mnemonic generation, cooperative signing, and gRPC communication internally.

## Setup

### Step 1: Generate or Import Wallet

```javascript
import { SparkWallet } from "@buildonspark/spark-sdk";

// Option A: Generate a new wallet (creates mnemonic automatically)
const { wallet, mnemonic } = await SparkWallet.initialize({
  options: { network: "MAINNET" }
});
// Save mnemonic securely — NEVER log it in production

// Option B: Import existing wallet from mnemonic
const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: process.env.SPARK_MNEMONIC,
  options: { network: process.env.SPARK_NETWORK || "MAINNET" }
});
```

Note on `accountNumber`: defaults to 1 for MAINNET, 0 for REGTEST. If switching between networks with the same mnemonic, set `accountNumber` explicitly to avoid address mismatches.

**Compatibility warning:** seed phrases are not portable across all Spark integrations. The Spark SDK uses its own internal key derivation, while other implementations (e.g., Tether's WDK) use custom BIP-44 derivation paths (`m/44'/998'/...`). Importing a mnemonic generated by a different Spark wallet integration will produce different keys and a different wallet — your funds won't appear. If a user provides a seed phrase, ask where it was generated. If it came from a Tether/WDK-based wallet, it won't work here — they need to transfer funds to a wallet created with the Spark SDK directly.

### Step 2: Store Mnemonic

Add to your project's `.env`:
```
SPARK_MNEMONIC=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
SPARK_NETWORK=MAINNET
```

**Security warnings:**
- **Never log the mnemonic** — not even during development. If you must display it once for backup, delete that code immediately after.
- **Never commit `.env`** — add it to `.gitignore` before your first commit.
- **`.env` is fine for development; consider something better for production.** A `.env` file is plaintext on disk in the same folder as your code — workable while you're learning, but not ideal once real funds are involved. If your deployment platform provides a secrets mechanism (cloud secret stores, OS keychain, secrets-manager CLIs, encrypted env vars), prefer that. The skill doesn't prescribe which — pick whatever fits your stack.
- **Encrypt the seed at rest** if you must store it locally. The skill ships `lib/encrypted-seed.js` (scrypt + AES-256-GCM, zero extra deps) and a one-time `setup-encrypted-seed.js` script. Replaces `SPARK_MNEMONIC` in `.env` with `SPARK_PASSPHRASE` plus a separate `seed.enc` file (mode 0600). An `.env` leak alone no longer drains the wallet — see `references/encrypted-seed.md` for threat model, setup, and recovery.
- **Or skip storing the mnemonic in the agent at all.** For production with real funds, [sparkbtcbot-proxy](https://github.com/echennells/sparkbtcbot-proxy) keeps the mnemonic on a server you control and gives the agent scoped, revocable bearer tokens (read-only, invoice-only, or full) with per-transaction and daily spending caps. The agent never sees a mnemonic — it makes authenticated HTTP calls. Worth standing up before any deployment that holds non-trivial balance.
- **Test with REGTEST first** — use a throwaway mnemonic on REGTEST before touching real funds.

### Step 3: Verify Wallet

```javascript
const address = await wallet.getSparkAddress();
const identityKey = await wallet.getIdentityPublicKey();
const { satsBalance } = await wallet.getBalance();

console.log("Spark Address:", address);
console.log("Identity Key:", identityKey);
console.log("Available:", satsBalance.available.toString(), "sats");

await wallet.cleanupConnections();
```

A runnable version of this lives at `skills/sparkbtcbot/scripts/wallet-setup.js`.

## Backup and Recovery

The mnemonic is the entire backup. Spark operators hold leaf state authoritatively — there is no local channel state or other persisted data that needs separate replication. A fresh install on a new host with the same mnemonic recovers the full wallet (balance, deposit addresses, identity).

This is **stronger than Lightning**, where channel state must be backed up separately (Static Channel Backup / DLP) and channel funds can be lost on data-dir loss even if the seed is safe. With Spark, losing the local data directory loses nothing; losing the seed loses everything.

Recovery extends Trust Model's "moment-in-time" trust assumption to one additional moment: at re-init, at least one operator must serve the leaf-state query. The same censorship risk that Trust Model lists for transfers applies here too. If recovery is censored, the unilateral-exit path described in Limitations is the fallback.

## Detailed References

Load only what's needed for the user's task. Each reference is a self-contained guide:

| Reference | Load when |
|---|---|
| `references/architecture.md` | User asks how Spark works, weighs against Lightning/on-chain, or reasons about fees |
| `references/wallet.md` | Sats operations: balance, deposits, transfers, list transfers, withdrawal |
| `references/lightning.md` | Lightning interop — BOLT11 invoices, payments, fee estimation |
| `references/tokens.md` | BTKN/LRC20 token transfers and balances |
| `references/spark-invoices.md` | Spark native invoice format (sats and tokens), `fulfillSparkInvoice` |
| `references/agent-class.md` | Drop-in `SparkAgent` class wrapping the SDK |
| `references/l402.md` | L402 / LSAT paywalls — paying for HTTP APIs over Lightning |
| `references/extras.md` | Message signing, event listeners, error handling, token *issuance* (`IssuerSparkWallet`) |
| `references/encrypted-seed.md` | User wants to encrypt the mnemonic at rest instead of plaintext `.env` (single-host setup using `lib/encrypted-seed.js`) |

Runnable example scripts live in `skills/sparkbtcbot/scripts/` (run via `npm run example:setup`, `example:balance`, `example:payments`, `example:tokens`, `example:agent`, `example:l402`).

## Security Best Practices

### The Agent Has Full Wallet Access

Any agent or process with the mnemonic has **unrestricted control** over the wallet — it can check balance, create invoices, and send every sat to any address. There is no permission scoping, no spending limits, no read-only mode in the SDK itself.

This means:
- If the mnemonic leaks, all funds are at risk immediately.
- If an agent is compromised, the attacker has the same full access.
- There is no way to revoke access without sweeping funds to a new wallet.

### Protect the Mnemonic

1. **Back up the seed phrase offline** — write it down on paper or use a hardware backup. If you lose the mnemonic, the funds are gone permanently.
2. **Never expose the mnemonic** in code, logs, git history, or error messages.
3. **Use environment variables** — never hardcode the mnemonic in source files.
4. **Add `.env` to `.gitignore`** — prevent accidental commits of secrets.

### Sweep Funds to a Safer Wallet

**Do not accumulate large balances in an agent wallet.** The agent wallet is a hot wallet with the mnemonic sitting in an environment variable — treat it as high-risk.

- Regularly sweep earned funds to a more secure wallet (hardware wallet, cold storage, or a separate wallet you control directly).
- Only keep the minimum operational balance the agent needs on Spark.
- Use `wallet.transfer()` or `wallet.withdraw()` to move funds out periodically.
- Consider automating sweeps when the balance exceeds a threshold.

### Operational Security

1. **Use separate mnemonics** for different agents — never share a mnemonic across agents.
2. **Use separate `accountNumber` values** if you need multiple wallets from one mnemonic.
3. **Monitor transfers** via event listeners for unexpected outgoing activity (see `references/extras.md`).
4. **Call `cleanupConnections()`** when the wallet is no longer needed.
5. **Use REGTEST** for development and testing, MAINNET only for production.
6. **Implement application-level spending controls** — cap per-transaction and daily amounts in your agent logic since the SDK won't do it for you.

## Resources

- Spark Docs: https://docs.spark.money
- Spark SDK (npm): https://www.npmjs.com/package/@buildonspark/spark-sdk
- Issuer SDK (npm): https://www.npmjs.com/package/@buildonspark/issuer-sdk
- Sparkscan Explorer: https://sparkscan.io
- Spark CLI: https://docs.spark.money/tools/cli
- L402 Spec: https://docs.lightning.engineering/the-lightning-network/l402
