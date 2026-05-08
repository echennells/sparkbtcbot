# Encrypted seed at rest

Optional alternative to keeping `SPARK_MNEMONIC` in plaintext in `.env`. Load this when the user wants better protection against env-var or `.env` leaks, or when they're deploying somewhere that the seed file can sit on disk separately from the runtime config.

## What it does

The mnemonic is encrypted with a passphrase you provide and stored in a single file (default: `~/.spark/seed.enc`, mode 0600). Your application reads `SPARK_PASSPHRASE` from env, decrypts the file once at boot, and uses the mnemonic in memory. The mnemonic itself never touches `.env`.

## Threat model — what changes vs plaintext .env

| Leak vector | Plaintext `.env` (default) | Encrypted seed |
|---|---|---|
| `.env` accidentally committed to git | Funds drained | Attacker has passphrase only — useless without seed file |
| Env-var dump in logs | Funds drained | Attacker has passphrase only — useless without seed file |
| Casual `cat .env` snooping | Funds drained | Same — passphrase only, useless |
| Server backup that captures env vars only | Funds drained | Useless without seed file |
| Server backup that captures full disk | Funds drained | Both files, attacker can decrypt — only passphrase strength saves you |
| Memory dump while wallet running | Funds drained | Funds drained (mnemonic is in process memory after decrypt) |

Net: the most common leak vectors (env-var leaks, `.env` on git, log captures) become non-fatal. To drain funds an attacker needs **either** the seed file plus the passphrase together, **or** to dump the running process's memory.

## Crypto choices

- **scrypt** for key derivation: N=2^17, r=8, p=1. Memory-hard, OWASP-blessed for password hashing. Roughly 100ms on a modern CPU; intentionally slow to make brute-force expensive.
- **AES-256-GCM** for encryption: 256-bit key, 96-bit IV, 128-bit auth tag. Authenticated — wrong passphrase or tampered ciphertext is detected.
- All from Node's built-in `node:crypto`. Zero extra dependencies.

File format (49+ bytes):
```
1   byte   version (0x01)
1   byte   kdf id (0x01 = scrypt)
1   byte   cipher id (0x01 = aes-256-gcm)
1   byte   reserved (0x00)
16  bytes  salt
12  bytes  iv (gcm nonce)
16  bytes  auth tag
N   bytes  ciphertext
```

The version + KDF id + cipher id at the start means the file is self-describing; future versions can be added without breaking old files.

## Setup

One-time, three modes:

```bash
# 1. Generate a fresh wallet (creates a new mnemonic via the SDK)
SPARK_NETWORK=MAINNET SPARK_PASSPHRASE="..." \
  node skills/sparkbtcbot/scripts/setup-encrypted-seed.js

# 2. Encrypt an existing mnemonic from SPARK_MNEMONIC env var
SPARK_MNEMONIC="word1 word2 ..." SPARK_PASSPHRASE="..." \
  node skills/sparkbtcbot/scripts/setup-encrypted-seed.js

# 3. Encrypt an existing mnemonic via stdin paste
SPARK_PASSPHRASE="..." \
  node skills/sparkbtcbot/scripts/setup-encrypted-seed.js --import
```

After setup completes:

1. The seed file is at `~/.spark/seed.enc` (override with `SPARK_SEED_PATH`)
2. Replace `SPARK_MNEMONIC=...` in your `.env` with `SPARK_PASSPHRASE=...`
3. If a fresh mnemonic was generated, the script prints it once — **save it offline immediately**, that's your recovery path

The script verifies by initializing a wallet from the encrypted seed and printing the resulting Spark address — useful as a sanity check that the right wallet loaded.

## App usage

```javascript
import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options: { network: process.env.SPARK_NETWORK || "MAINNET" },
});
// `mnemonic` falls out of scope; only `wallet` is retained
```

The decrypt happens once at boot (~250ms scrypt). After that, performance is identical to plaintext-mnemonic loading. Do not call `loadMnemonicFromEnv()` per request — decrypt once, hold the wallet.

## Recovery scenarios

| Scenario | What's needed | Action |
|---|---|---|
| Lose `.env` (passphrase) | Mnemonic backup | Re-run setup with `--import`, paste mnemonic, choose new passphrase |
| Lose `seed.enc` | Mnemonic backup | Re-run setup with `--import`, paste mnemonic |
| Lose entire machine | Mnemonic backup | Install on new machine, re-run setup with `--import` |
| Lose mnemonic backup | Have passphrase + `seed.enc` | Decrypt to recover mnemonic, save offline this time |
| Lose all three | None | Funds gone — same as plaintext-mnemonic case |

The mnemonic remains the ultimate backup. Encryption defends in-flight files; it doesn't replace offline backup.

## What this does not do

- **Doesn't protect against memory dumps** of the running process — the mnemonic is in memory after `loadMnemonicFromEnv()` returns. To attack this you need shell on the host with the same UID as the agent.
- **Doesn't protect against the host being compromised** while running — same as above.
- **Doesn't replace the proxy** for production setups where you want scoped, revocable bearer tokens. The proxy keeps the seed on a separate server entirely. Encryption-at-rest is the next-best when running the SDK directly is unavoidable.
- **Doesn't apply to the proxy** (sparkbtcbot-proxy stores the seed in Vercel encrypted env vars, which is functionally similar; the proxy doesn't need this layer).

## When to use which

| Setup | Best when |
|---|---|
| Plaintext `SPARK_MNEMONIC` in `.env` | Local dev only, REGTEST throwaway, learning |
| **Encrypted seed at rest** | Single-host production agent, modest balances, you accept that an attacker who pwns the host gets funds |
| sparkbtcbot-proxy | Production with non-trivial balances, multi-agent, or you want revocable scoped access |
