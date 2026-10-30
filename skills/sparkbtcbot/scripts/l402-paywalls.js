// Paying for an HTTP API behind an L402 paywall, with the SparkAgent wrapper.
//
//   npm run example:l402                      preview the price; pays nothing
//   npm run example:l402 -- --pay [maxSats]   pay (default ceiling 100 sats) and fetch
//
// agent.fetchL402 owns the whole purchase: the price ceiling, the fee cap, the
// budget and the user's spending limits, the dedup store, and the hold on disk
// that makes a retry (in this process or a new one) present the pass it paid
// for instead of buying again. This file used to hand-roll that flow on the raw
// SDK, and every post-payment failure there (a cut body, a non-JSON body, a
// refused pass, no preimage yet) lost the paid pass so the next call bought
// another (ToB review 2026-10-28). Don't copy a raw flow; call fetchL402.
//
// fetchL402Cached adds the one thing fetchL402 doesn't do: reuse a pass across
// requests to the same origin. It pays only through fetchL402.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { SparkAgent } from "./spark-agent.js";

const network = process.env.SPARK_NETWORK || "MAINNET";
const DEMO_URL = "https://tassandra.laisee.org/price/USD";

// https origin -> "L402 <macaroon>:<preimage>". A bearer credential: never log it.
const tokenCache = new Map();

export async function fetchL402Cached(agent, url, options = {}) {
  const { method = "GET", headers = {}, body } = options ?? {};
  const { protocol, origin } = new URL(url);
  // Keyed by origin and https only: a pass bought over https must never ride a
  // plain http:// request to the same host.
  if (protocol !== "https:") throw new Error(`refusing to send an L402 pass over ${protocol}//`);
  const cached = tokenCache.get(origin);
  if (cached) {
    const response = await fetch(url, {
      method,
      // Authorization last, so a caller header cannot clobber the credential.
      headers: { "Content-Type": "application/json", ...headers, Authorization: cached },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status !== 402 && response.status !== 401) {
      const ct = response.headers.get("content-type") || "";
      const data = ct.includes("json") ? await response.json() : await response.text();
      return { paid: false, cached: true, status: response.status, data };
    }
    tokenCache.delete(origin); // expired or refused: buy through the wrapper again
  }
  const result = await agent.fetchL402(url, options);
  // Cache a recovered pass too (paid: false, recovered: true): an earlier call
  // bought it, and not caching it meant the next request bought another.
  if (result.macaroon && result.preimage) tokenCache.set(origin, `L402 ${result.macaroon}:${result.preimage}`);
  return result;
}

async function main(args = process.argv.slice(2)) {
  const pay = args[0] === "--pay";
  const maxAmountSats = pay ? Number(args[1] ?? 100) : undefined;
  const mnemonic = await loadMnemonicFromEnv();
  // Pay-then-exit: no background leaf optimizer (references/wallet.md → Cleanup).
  const { agent } = await SparkAgent.create(mnemonic, network, { optimizeLeaves: false });
  try {
    const { sats, incomingSats } = await agent.getBalance();
    console.log(`Balance: ${sats} sats spendable${incomingSats !== "0" ? `, ${incomingSats} arriving` : ""}\n`);

    const preview = await agent.previewL402(DEMO_URL);
    if (!preview.requiresPayment) {
      console.log(`${DEMO_URL} needs no payment.`);
      return;
    }
    console.log(`${DEMO_URL} costs ${preview.amountSats} sats (pass valid until ${preview.tokenExpiresAt ?? "not stated"}).`);
    if (!pay) {
      console.log("Preview only. Run with --pay [maxSats] to buy it.");
      return;
    }
    // Errors carry code, retryable and nextStep: PAYMENT_COMMITTED means the
    // money may have left. Calling again presents the held pass, never buys twice.
    const first = await fetchL402Cached(agent, DEMO_URL, { maxAmountSats });
    console.log("Paid:", first.paid, "| status:", first.status, "| data:", first.data);
    const again = await fetchL402Cached(agent, "https://tassandra.laisee.org/price/EUR", { maxAmountSats });
    console.log("Second request:", again.cached ? "reused the cached pass" : `paid ${again.paid}`, "| data:", again.data);
  } catch (err) {
    console.error(`Stopped: ${err.message}${err.code ? ` [${err.code}, retryable: ${err.retryable}]` : ""}${err.nextStep ? `\nNext: ${err.nextStep}` : ""}`);
    process.exitCode = 1;
  } finally {
    await agent.cleanup();
  }
}

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module. realpathSync handles symlinked invocations
// (e.g. via ~/.claude/skills); if argv[1] doesn't resolve to a real file it
// can't be this script.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
