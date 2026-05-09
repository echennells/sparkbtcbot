# Message Signing, Events, Errors, Issuance

Smaller topics consolidated into one reference. Load when working on any of: signing/verifying messages, listening for transfer/deposit events, handling SDK errors, or minting new tokens.

## Message Signing

Spark wallets can sign and verify messages using their identity key. Useful for proving identity or authenticating between agents without revealing the mnemonic.

### Sign

```javascript
const signature = await wallet.signMessageWithIdentityKey("I am agent-007");
// Optional: pass `true` as a 2nd arg for compact (64-byte) encoding instead of DER.
```

### Verify (own signature only)

`validateMessageWithIdentityKey` validates against the *calling wallet's own* identity key — there is no parameter for verifying against an external public key.

```javascript
const isValid = await wallet.validateMessageWithIdentityKey("I am agent-007", signature);
```

### Verify someone else's signature

For external verification, use `secp256k1.verify` directly:

```javascript
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes } from "@noble/curves/utils";

const valid = secp256k1.verify(
  hexToBytes(signature),
  sha256(new TextEncoder().encode("I am agent-007")),
  hexToBytes(theirPublicKeyHex),
);
```

## Event Listeners

The wallet emits events for real-time updates. Useful for agents that need to react to incoming payments.

```javascript
wallet.on("transfer:claimed", (transferId, balance) => {
  console.log(`transfer ${transferId} received. balance: ${balance}`);
});

wallet.on("deposit:confirmed", (depositId, balance) => {
  console.log(`deposit ${depositId} confirmed. balance: ${balance}`);
});

wallet.on("token-balance:update", (event) => {
  // event.tokenBalances is the updated TokenBalanceMap
});

wallet.on("stream:connected", () => console.log("connected"));
wallet.on("stream:disconnected", (reason) => console.log("disconnected:", reason));
```

The `SparkWalletEvent` enum exports the canonical event names (`SparkWalletEvent.BalanceUpdate`, `SparkWalletEvent.TransferClaimed`, etc.) — prefer these over string literals for forward-compatibility.

## Error Handling

```javascript
import {
  ValidationError,
  NetworkError,
  AuthenticationError,
  ConfigurationError,
  RPCError,
} from "@buildonspark/spark-sdk";

try {
  await wallet.transfer({ receiverSparkAddress: "sp1p...", amountSats: 1000 });
} catch (err) {
  if (err instanceof ValidationError)     console.log("invalid input:", err.message);
  else if (err instanceof NetworkError)   console.log("network issue:", err.message);
  else if (err instanceof AuthenticationError) console.log("auth failed:", err.message);
  else if (err instanceof ConfigurationError)  console.log("config problem:", err.message);
  else if (err instanceof RPCError)       console.log("RPC error:", err.message);
  else throw err;
}
```

Error types:
- **ValidationError** — invalid parameters, malformed addresses
- **NetworkError** — connection failures, timeouts
- **AuthenticationError** — key/token issues
- **ConfigurationError** — missing config, initialization problems
- **RPCError** — gRPC communication failures

All inherit from `SparkSdkError`, which has a `context` property carrying additional debug fields.

## Token Issuance (`@buildonspark/issuer-sdk`)

Minting new tokens requires the separate `IssuerSparkWallet`. Spark splits wallet and issuer concerns deliberately — the wallet SDK has no `createToken` method because issuance requires holding the issuer key (a different security boundary).

```bash
npm install @buildonspark/issuer-sdk
```

### Mint a token

```javascript
import { IssuerSparkWallet } from "@buildonspark/issuer-sdk";
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
const { wallet } = await IssuerSparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options: { network: "REGTEST" },
});

// One token per wallet — check first
let tokenId;
try {
  tokenId = await wallet.getIssuerTokenIdentifier();
} catch {}

if (!tokenId) {
  await wallet.createToken({
    tokenName: "ExampleToken",
    tokenTicker: "EXMPL",
    maxSupply: 1_000_000_000_000n,
    decimals: 6,
    isFreezeable: false,
  });
  tokenId = await wallet.getIssuerTokenIdentifier();
}

await wallet.mintTokens(1_000n);  // mint 0.001 token at 6 decimals to issuer's own balance
// Then transfer with wallet.transferTokens(...) just like any token
```

### Other issuer operations

- `wallet.burnTokens(amount)` — destroy supply you hold
- `wallet.freezeTokens(...)` / `wallet.unfreezeTokens(...)` — only if `isFreezeable: true` at create time
- `wallet.getIssuerTokenBalance()` — issuer-side balance accounting
- `wallet.getIssuerTokenDistribution()` — supply distribution across holders

The issuance flow shown here is intended for testing and experimentation. Production token issuance is out of scope for this skill — that's a different problem with different operational requirements (custody, supply policy, key rotation, regulatory considerations).
