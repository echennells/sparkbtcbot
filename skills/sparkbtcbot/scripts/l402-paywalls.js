import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
// light-bolt11-decoder is a single-maintainer package (fiatjaf). Pinned to an
// exact version in package.json. Used here only to extract the amount field
// for cost preview; the raw invoice string is what's passed to the Spark SDK
// for payment, so a malicious decoder can mislead pricing but cannot redirect
// funds. Re-audit on version bump.
import { decode } from "light-bolt11-decoder";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const network = process.env.SPARK_NETWORK || "MAINNET";

// L402 token cache — keyed by domain so tokens are reused across endpoints
const tokenCache = new Map();

/**
 * Parse a 402 challenge. Checks the WWW-Authenticate header first (L402/LSAT
 * spec-compliant, used by aperture, Tassandra, etc.), then falls back to the
 * JSON body (non-standard but common, used by Lightning Faucet, etc.).
 */
async function parseChallenge(response) {
  let invoice, macaroon;

  // Try WWW-Authenticate header first (spec-compliant)
  const wwwAuth = response.headers.get("www-authenticate") || "";
  // Prefer L402 prefix
  const l402 = wwwAuth.split("L402 macaroon=\"")[1];
  if (l402) {
    macaroon = l402.split('"')[0];
    invoice = l402.split('invoice="')[1]?.split('"')[0];
  }
  // Fall back to LSAT prefix (older spec name)
  if (!macaroon || !invoice) {
    const lsat = wwwAuth.split("LSAT macaroon=\"")[1];
    if (lsat) {
      macaroon = macaroon || lsat.split('"')[0];
      invoice = invoice || lsat.split('invoice="')[1]?.split('"')[0];
    }
  }

  // Fall back to JSON body (non-standard but common)
  if (!invoice || !macaroon) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      invoice = invoice || body.invoice || body.payment_request || body.pr;
      macaroon = macaroon || body.macaroon || body.token;
    }
  }

  if (!invoice || !macaroon) {
    throw new Error("Invalid L402 response: missing invoice or macaroon");
  }

  return { invoice, macaroon };
}

/**
 * Fetch content from an L402-protected endpoint.
 * If 402 Payment Required, pays the Lightning invoice and retries.
 * Caches tokens by domain so repeat requests don't pay again.
 */
async function fetchWithL402(wallet, url, options = {}) {
  const { method = "GET", headers = {}, body, maxFeeSats = 10 } = options;
  const domain = new URL(url).host;
  const reqHeaders = { "Content-Type": "application/json", ...headers };
  const reqBody = body ? JSON.stringify(body) : undefined;

  // Try cached token first
  const cached = tokenCache.get(domain);
  if (cached) {
    const response = await fetch(url, {
      method,
      headers: {
        ...reqHeaders,
        Authorization: `L402 ${cached.macaroon}:${cached.preimage}`,
      },
      body: reqBody,
    });

    if (response.status !== 402 && response.status !== 401) {
      const ct = response.headers.get("content-type") || "";
      const data = ct.includes("application/json")
        ? await response.json()
        : await response.text();
      return { paid: false, cached: true, data };
    }
    // Token expired or rejected — discard and pay again
    tokenCache.delete(domain);
    console.log("Cached token expired, paying for new one...");
  }

  // Step 1: Make initial request
  const initialResponse = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  // If not 402, return response directly
  if (initialResponse.status !== 402) {
    const ct = initialResponse.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await initialResponse.json()
      : await initialResponse.text();
    return { paid: false, data };
  }

  console.log("Got 402 Payment Required, parsing challenge...");

  // Step 2: Parse 402 challenge (body or WWW-Authenticate header)
  const { invoice, macaroon } = await parseChallenge(initialResponse);

  // Step 3: Decode invoice to get amount
  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  if (!amountSection?.value) {
    throw new Error("L402 invoice has no amount");
  }
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);
  console.log(`Invoice amount: ${amountSats} sats`);

  // Step 4: Pay the invoice
  console.log("Paying invoice...");
  const payResult = await wallet.payLightningInvoice({
    invoice,
    maxFeeSats,
  });

  // Get preimage (may need to poll if payment is async)
  let preimage = payResult.paymentPreimage;
  if (!preimage && payResult.status === "LIGHTNING_PAYMENT_INITIATED") {
    console.log("Payment initiated, polling for preimage...");
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const status = await wallet.getLightningSendRequest(payResult.id);
      if (status?.paymentPreimage) {
        preimage = status.paymentPreimage;
        break;
      }
      if (status?.status === "LIGHTNING_PAYMENT_FAILED") {
        throw new Error("L402 payment failed");
      }
    }
  }

  if (!preimage) {
    throw new Error("L402 payment succeeded but no preimage available");
  }

  // The preimage is the L402 authorization secret — it goes straight into the
  // Authorization header below. Never log it (not even a prefix): stdout from a
  // Bash-invoked script gets captured into the agent's transcript.
  console.log("Payment complete.");

  // Step 5: Retry with L402 authorization
  console.log("Fetching protected content...");
  const finalResponse = await fetch(url, {
    method,
    headers: {
      ...reqHeaders,
      Authorization: `L402 ${macaroon}:${preimage}`,
    },
    body: reqBody,
  });

  const ct = finalResponse.headers.get("content-type") || "";
  const data = ct.includes("application/json")
    ? await finalResponse.json()
    : await finalResponse.text();

  // Cache the token for reuse
  tokenCache.set(domain, { macaroon, preimage });

  return {
    paid: true,
    amountSats,
    preimage,
    macaroon,
    data,
  };
}

/**
 * Preview L402 cost without paying.
 */
async function previewL402(url) {
  const response = await fetch(url);

  if (response.status !== 402) {
    return { requiresPayment: false };
  }

  const { invoice } = await parseChallenge(response);
  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);

  return { requiresPayment: true, amountSats, invoice };
}

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network },
  });

  const { satsBalance } = await wallet.getBalance();
  console.log("Current balance:", satsBalance.available.toString(), "sats\n");

  // --- Preview L402 Cost ---
  const L402_TEST_URL = "https://tassandra.laisee.org/price/USD";
  console.log("=== Preview L402 Cost ===");
  console.log(`Checking ${L402_TEST_URL}...`);
  const preview = await previewL402(L402_TEST_URL);

  if (!preview.requiresPayment) {
    console.log("No payment required for this endpoint.\n");
  } else {
    console.log(`Payment required: ${preview.amountSats} sats`);
    console.log(`Invoice: ${preview.invoice.slice(0, 50)}...\n`);
  }

  // --- Fetch with L402 Payment ---
  // Uncomment to actually pay and fetch:
  //
  // console.log("=== Fetch with L402 Payment ===");
  // const result = await fetchWithL402(wallet, L402_TEST_URL, {
  //   maxFeeSats: 10,
  // });
  // console.log("Paid:", result.paid);
  // if (result.amountSats) console.log("Amount:", result.amountSats, "sats");
  // console.log("Data:", result.data);
  //
  // // Second request reuses the cached token — no payment
  // console.log("\n=== Fetch Again (cached token) ===");
  // const result2 = await fetchWithL402(wallet, "https://tassandra.laisee.org/price/EUR");
  // console.log("Paid:", result2.paid, "Cached:", result2.cached);
  // console.log("Data:", result2.data);

  wallet.cleanupConnections();
}

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module. realpathSync handles symlinked invocations
// (e.g. via ~/.claude/skills).
const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
