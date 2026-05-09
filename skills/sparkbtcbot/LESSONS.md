# Security lessons from comparable agent skills

Reference: [getAlby/hub-skill](https://github.com/getAlby/hub-skill) and [nunchuk-io/agent-skills](https://github.com/nunchuk-io/agent-skills). Both ship Claude skills that give an AI agent access to a Bitcoin wallet **without putting the mnemonic in the agent's hands**. Their patterns are what `sparkbtcbot` should be moving toward.

---

## What Alby Hub does

**The agent never sees a mnemonic.** It invokes a CLI (`npx @getalby/hub-cli`) that talks to a separately-running hub. The hub holds the seed.

Layered access tokens, in order of priority:
1. `-t <jwt>` inline flag (highest, but **leaks into shell history**)
2. `HUB_TOKEN` env var
3. `~/.hub-cli/token.jwt` on disk (lowest, written by `--save`)

JWT tokens have **scopes** (`readonly` vs full) and **TTLs** — they expire. Get a fresh one with `unlock` without restarting the node.

The killer feature: **NWC scoped sub-apps**. Instead of giving an agent the JWT (full hub control), the user creates an NWC connection *per app or purpose* with explicit:
- **scope filter** — `--scopes "pay_invoice,get_balance"` (no `make_invoice`, no `sign_message`)
- **spending budget** — `--max-amount 10000`
- **budget renewal** — `daily | weekly | monthly | yearly | never`
- **isolation** — `--isolated` creates a sub-wallet with a *separate balance*; even a fully-compromised connection can't drain the main hub

Then a *separate* skill (`alby-bitcoin-payments`) consumes the NWC string for the actual payment flows. Two-skill pattern: one for setup/management, one for use.

Explicit Claude-facing security rules in SKILL.md:
- "**DO NOT** print the connection secret to any logs or otherwise reveal it outside of that direct handover."
- "**NEVER** share a connection secret, or any part of it … every part can be used to gain wallet access."
- "**DO NOT** read the token file. Check for its existence only if you need to."
- "Do not dump the environment (`env`, `printenv`) in a way that exposes `HUB_TOKEN` in the conversation."

---

## What Nunchuk does

**API-key + multisig + hardware separation.** The agent authenticates to Nunchuk's API with `nunchuk auth login --api-key`. The keys themselves can live on:
- **Coldcard HSM** — hardware device, agent submits PSBTs and the device approves/denies based on its rules
- **Platform Key** — Nunchuk-managed HSM occupying one signer slot
- **Software keys** — only as part of a multisig where one signature alone is insufficient

Spending controls happen at *wallet creation*, not in the SDK:
- "Create a 2-of-3 wallet with a **100 USD daily spending limit**"
- "Create a 2-of-3 wallet with a **24-hour signing delay**"
- Per-signer policies: signer A unlimited + signer B requires 24h delay

Two-step transaction flow:
1. `nunchuk tx create` — agent constructs the transaction
2. `nunchuk tx sign` — requires the actual key custodian to approve (Coldcard prompts physically, Platform Key enforces its policy, etc.)
3. `nunchuk tx broadcast` — only after signing satisfies the multisig threshold

Net effect: the agent can *propose* arbitrary transactions all day, but the multisig + signing-delay + spending-limit machinery ensures it can't unilaterally drain funds.

---

## How `sparkbtcbot` compares today

| Concern | Alby Hub | Nunchuk | sparkbtcbot |
|---|---|---|---|
| Where does the seed live? | Hub process, separate from agent | Hardware / Nunchuk HSM | **Encrypted at rest (`~/.spark/seed.enc`, scrypt + AES-256-GCM); agent reads passphrase from env and decrypts at boot** |
| Per-app scoping? | NWC scopes per connection | Per-signer policies | **None — full custody once decrypted** |
| Spending limits? | `--max-amount`, `--budget-renewal` | `--limit-amount … --limit-interval DAILY` | **None — agent can spend everything** |
| Revocation? | Delete NWC app, regenerate JWT | Revoke API key, change signer | **Sweep funds to new mnemonic (only option)** |
| Two-step approval? | N/A (NWC token enforces budget) | Yes — sign step is separate | **No — one-shot `wallet.transfer()`** |
| Read-only mode? | `--permission readonly` token | Inspect-only commands | **Possible (`SparkReadonlyClient` exists in SDK) but not surfaced** |
| Isolated sub-wallets? | `--isolated` | Multisig per wallet | **`accountNumber` provides separation, but an agent with the mnemonic has all account numbers** |
| Explicit "DO NOT" rules for Claude? | Yes, multiple | Implicit (CLI never returns secrets) | **Yes — covers mnemonic, passphrase, seed file, `env`/`printenv`** |

`sparkbtcbot` now enforces encrypted-at-rest as the floor (no plaintext-mnemonic mode) and points to [`sparkbtcbot-proxy`](https://github.com/echennells/sparkbtcbot-proxy) for production. The encryption layer closes the `.env`-leak class of attacks; the remaining gaps (scoping, limits, revocation, two-step approval) still require the proxy. **Alby and Nunchuk solve those at a different layer — neither is reachable purely inside the agent's process.**

---

## Concrete changes for `sparkbtcbot`

In rough priority order:

### 1. Reframe the default

Restructure SKILL.md so the **proxy / scoped-token pattern is the default** path. Direct-mnemonic becomes the explicit dev-only fallback, called out the same way Alby calls out `--save` token storage. Today the doc shows direct mnemonic as the happy path and bolts production guidance on as an aside.

### 2. Add hard "DO NOT" rules for Claude

Mirror Alby's wording, adapted to our context:

- **DO NOT** print the mnemonic to any output, logs, or chat — even if the user asks to verify it. If verification is needed, derive the address and compare addresses, not seed phrases.
- **DO NOT** read `.env` back into the conversation. Read it via `dotenv` programmatically; never `cat .env` or echo its contents.
- **DO NOT** run `env`, `printenv`, or `echo $SPARK_MNEMONIC` in the conversation.
- **DO NOT** include the mnemonic in test wallets, fixtures, or git history. REGTEST throwaway mnemonics excepted, but say "throwaway, regtest only" inline so an LLM later doesn't lift it for mainnet use.

These are skill-author rules — they tell Claude what not to do *while the skill is loaded*. Alby has them; we don't.

### 3. Document SparkReadonlyClient

The Spark SDK exports `SparkReadonlyClient` for read-only access without an identity key. Today's skill doesn't mention it. Add a `references/readonly.md` showing how to give an agent visibility-only access to a wallet for monitoring/dashboarding without spending capability. Closest analog to Alby's `--permission readonly`.

### 4. Two-step transfer pattern

Add a wrapper pattern to `references/agent-class.md` that splits transfer into propose → confirm:

```javascript
class SparkAgent {
  async proposeTransfer({ to, amountSats, memo }) {
    // returns { proposalId, expectedFee, expiresAt } — does NOT execute
  }
  async confirmTransfer(proposalId) {
    // executes only after explicit confirmation
  }
}
```

For autonomous agents with no human in the loop, this still adds value — a stale `proposalId` means a confused agent can't accidentally double-spend. For human-in-the-loop usage it's the obvious gate.

### 5. Application-level spending caps wrapper

A small idiomatic example showing a `RateLimitedSparkWallet` wrapper:

```javascript
class CappedWallet {
  constructor(wallet, { maxPerTx, maxPerDay }) { ... }
  async transfer({ amountSats, ... }) {
    if (amountSats > this.maxPerTx) throw new SpendingLimitError(...);
    if (this.spentToday + amountSats > this.maxPerDay) throw new SpendingLimitError(...);
    // ...
  }
}
```

We tell users this is required ("Implement application-level spending controls — cap per-transaction and daily amounts in your agent logic since the SDK won't do it for you") but we don't *give* them an example. Alby and Nunchuk make this trivial; we should at least show the wrapper.

### 6. Sweep-to-cold pattern

Add a recipe in `references/extras.md`: when balance exceeds threshold T, automatically `wallet.transfer()` the surplus to a `COLD_SPARK_ADDRESS` env var the agent can read but doesn't control. Today we say "Regularly sweep earned funds to a more secure wallet" but we don't show the code. Concrete pattern reduces hot-wallet exposure.

### 7. Mnemonic compatibility / WDK warning — keep, sharpen

Already in SKILL.md (commit e7aacee). Still correct. Worth tightening to also mention `@lightsparkdev/wallet-sdk` as a separate non-portable seed source, since the eval set's near-misses surface that confusion.

---

## What the proxy gives that this skill alone can't

Worth being explicit so users know what's still on the proxy side:

| Feature | Achievable in this skill alone? |
|---|---|
| Scoped tokens (read-only / invoice-only / full) | No — needs a proxy server holding the mnemonic |
| Bearer-token revocation without sweep | No |
| Audit logs of every wallet operation | No |
| Per-token rate limits enforced server-side | No |
| Cross-instance shared wallet view | No |

The skill can implement *application-level* spending caps and read-only views (#4–6 above), but they all run inside the agent's process. A compromised agent process bypasses them. Real defense in depth = mnemonic on a different process, behind an authenticated API. That's the proxy.
