# PR A — branch `pr/esplora-submitpackage-verdict`

**Title:** `fix(esplora): surface submitpackage policy rejections returned with HTTP 200`

**Base:** `main` (applies cleanly, independent of #16)

---

## Body

Bitcoin Core's `submitpackage` reports policy rejections in the response body, not the HTTP status: a rejected package comes back **200** with `package_msg` set to e.g. `"transaction failed"` and a per transaction error string in `tx-results`. `handlePackageResponse` only checked `response.ok`, so every policy rejection (fee below the mempool floor, TRUC topology, spent inputs) was returned to callers as a successful submit.

`auto-exit` then logged `submitted package`, never found the transaction on chain, and misdiagnosed the rejection as a mempool eviction, rebuilding and resubmitting the same doomed package every round.

### How it showed up

Observed on a mainnet recovery this month. The tool printed this, in a loop, for hours:

```
Leaf 019ad975...: submitted package (parent 0ecb9efe..., 1 remaining after confirmation)
Still waiting for 0ecb9efe... to confirm
Leaf 019ad975...: package 0ecb9efe... disappeared from the mempool (likely evicted); will rebuild and resubmit
```

Nothing was ever evicted. The node was answering, every single time:

```json
{"package_msg":"transaction failed",
 "tx-results":{"b48fe16b...":{"txid":"0ecb9efe...","error":"bad-txns-inputs-missingorspent"}}}
```

The operator has no way to see that. `bad-txns-inputs-missingorspent` and "evicted during a fee spike" call for completely different responses, and the tool was reporting the second while the node said the first.

### The change

Parse the verdict and throw an `EsploraError` naming `package_msg` and each failing txid's error string. The error text carries the raw node message, so `auto-exit`'s existing rejection classifier (`missingorspent`, `TRUC`, `already in mempool`, ...) now sees real verdicts and can defer or fail leaves correctly instead of looping.

Responses without a `package_msg` field are left alone: absence of a verdict is not a rejection, so endpoints that answer with a bare txid list keep working.

### Tests

Two cases in `test/esplora.test.ts`, the first built from the actual mainnet response above:

- a 200 carrying `package_msg: "transaction failed"` plus a per transaction error now throws, and the message contains both the txid and `bad-txns-inputs-missingorspent`
- a 200 carrying `package_msg: "success"` still resolves to the parsed body

`tsc --noEmit` clean, unit suite green.

### Relationship to #16

None. This touches only `src/esplora.ts` and its test, which #16 does not modify; it cherry picks onto `main` cleanly and can merge in either order.
