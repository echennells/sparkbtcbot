// payVendorInvoices(agent, invoices) — pay vendors' native Spark invoices (spark1…) through SparkAgent.
//
// Assumptions:
// - `agent` is a SparkAgent from "sparkbtcbot-skill/agent". Every payment goes through
//   agent.fulfillInvoice, which applies the recipient allowlist, sealed policy (maxPerTxSats,
//   allowedOps, …), SPARK_DAILY_BUDGET_SATS, the audit log and the leaf-vault. This code never
//   touches the raw wallet. The caller creates the agent and calls cleanup().
// - Vendor invoices are SATS invoices. A token invoice, or a bare spark1 address (which is not an
//   invoice), is reported as not paid and never sent.
// - `invoices` is [{ invoice, amountSats?, ref? }]. `amountSats` is the amount in OUR records, in
//   whole sats. An amountless invoice needs it, because that is the amount we send. For an invoice
//   that carries an amount, `amountSats` is optional, but when you pass it, it must match the
//   invoice exactly; if the vendor's invoice disagrees with our records we don't pay it. Pass it for
//   every invoice when you can, because it is the only check here that catches an overcharge.
//   `ref` is your own id (bill number, vendor id) and comes back in the report.
// - One fulfillInvoice call per invoice, in order, so each invoice gets its own outcome and one bad
//   invoice can't block the rest. The code is built this way on purpose. It is NOT a fallback after a
//   batch gets denied: splitting a denied spend is exactly what maxPerTxSats and the budget are there to stop.
// - There are three outcomes, not two:
//     paid    — money was sent (transferId included).
//     notPaid — refused before anything was sent. Fix the cause (code/reason) and it's safe to try again.
//     unknown — PAYMENT_COMMITTED, or an error we can't classify: money MAY have left. Do NOT pay
//               these again (not here, not with a new invoice, not another way) until you have
//               checked agent.getTransfers(). An already-paid invoice sent again also ends up here.
// - This function never retries, and it never lowers an amount after a denial.
// - It saves nothing to disk. Write `paid` and `unknown` into your books before you run the same list again.
// - dryRun: true previews each payment (receiver + amount; allowlist and sealed rules still apply,
//   but the daily budget and exec hook don't). Nothing is signed.

import { getNetworkFromSparkAddress } from "@buildonspark/spark-sdk";
import { sparkInvoiceReceiver } from "sparkbtcbot-skill/agent";

// Codes SparkAgent throws BEFORE anything is sent, so nothing left the wallet.
const NOTHING_SENT_CODES = new Set([
  "POLICY_DENIED", // sealed policy / exec hook: relay err.reason, never retry smaller
  "RECIPIENT_NOT_ALLOWED", // receiver not in ~/.spark/recipients.allow
  "RECIPIENT_INVALID",
  "INVOICE_REFUSED", // SDK refused before sending (expired, restricted to another payer, …)
  "SPEND_BUDGET_EXCEEDED", // SPARK_DAILY_BUDGET_SATS / sealed dailyBudgetSats
  "SPEND_LEDGER_MISSING", // budget ledger fails closed
  "SPEND_LEDGER_BAD_SIGNATURE",
  "SPEND_LEDGER_UNREADABLE",
]);

export async function payVendorInvoices(agent, invoices, { dryRun = false } = {}) {
  if (!Array.isArray(invoices)) {
    throw new TypeError("payVendorInvoices: `invoices` must be an array of { invoice, amountSats?, ref? }");
  }

  const report = {
    paid: [],
    notPaid: [],
    unknown: [],
    ...(dryRun ? { previewed: [] } : {}),
    // The limits in force (sealed policy, live budget, allowlist path), read before any spend.
    limits: await agent.policy(),
  };

  // Decode invoices against the network the wallet is actually on. An invoice for a different
  // network is refused, not converted.
  const { address: ownAddress } = await agent.getIdentity();
  const network = getNetworkFromSparkAddress(ownAddress);

  const seen = new Set(); // one attempt per invoice per run, whatever that attempt's outcome
  for (const [index, item] of invoices.entries()) {
    const ref = item?.ref ?? index;
    const invoice = typeof item?.invoice === "string" ? item.invoice.trim() : "";
    const notPaid = (code, reason, extra = {}) => report.notPaid.push({ ref, invoice, code, reason, ...extra });

    const plan = planPayment(invoice, item?.amountSats, network);
    if (!plan.ok) {
      notPaid(plan.code, plan.reason);
      continue;
    }
    if (seen.has(invoice) || seen.has(plan.invoiceId)) {
      notPaid("DUPLICATE", "same invoice appears earlier in this list; paying once only");
      continue;
    }
    seen.add(invoice);
    seen.add(plan.invoiceId);

    // For an amount-bearing invoice the embedded amount is authoritative (already checked
    // against our records). Only an amountless one gets our amount, as the bigint the SDK expects.
    const entry = plan.amountless ? { invoice, amount: BigInt(plan.amountSats) } : { invoice };
    const base = { ref, invoice, to: plan.to, amountSats: plan.amountSats, amountless: plan.amountless };

    let result;
    try {
      result = await agent.fulfillInvoice([entry], { dryRun });
    } catch (err) {
      classifyFailure(err, base, report);
      continue;
    }

    if (dryRun) {
      report.previewed.push({ ...base, preview: result });
      continue;
    }
    const successes = result?.satsTransactionSuccess ?? [];
    const hit = successes.find((s) => s.invoice === invoice) ?? successes[0];
    if (hit) {
      report.paid.push({ ...base, transferId: hit.transferResponse?.id ?? null });
    } else {
      // The wrapper returned without an error but also without a success entry. Treat it as not
      // proven either way and reconcile it; never assume unpaid.
      report.unknown.push({ ...base, reason: "fulfillInvoice returned no success entry for this invoice; check agent.getTransfers()" });
    }
  }

  report.totals = {
    paidSats: report.paid.reduce((sum, p) => sum + p.amountSats, 0),
    unknownSats: report.unknown.reduce((sum, u) => sum + u.amountSats, 0),
    counts: { paid: report.paid.length, notPaid: report.notPaid.length, unknown: report.unknown.length },
  };
  return report;
}

// Local checks before the wallet sees anything: decode it, sats only, amount vs our records, expiry.
function planPayment(invoice, recordAmount, network) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!invoice) return fail("MISSING_INVOICE", "entry has no invoice string");

  let receiver;
  try {
    receiver = sparkInvoiceReceiver(invoice, network); // { identityPublicKey, address, invoiceFields }
  } catch (err) {
    return fail("INVALID_INVOICE", `not a valid ${network} Spark invoice: ${err?.message ?? err}`);
  }
  const fields = receiver.invoiceFields;
  if (!fields) {
    return fail("NOT_AN_INVOICE", "this is a bare Spark address, not an invoice; ask the vendor for an invoice");
  }
  const paymentType = fields.paymentType;
  if (paymentType?.type !== "sats") {
    return paymentType?.type === "tokens"
      ? fail("TOKEN_INVOICE_UNSUPPORTED", "token invoice; this function pays sats invoices only")
      : fail("NO_PAYMENT_TYPE", "invoice names no payment type");
  }
  if (fields.expiryTime instanceof Date && fields.expiryTime.getTime() <= Date.now()) {
    return fail("EXPIRED", `invoice expired at ${fields.expiryTime.toISOString()}; ask the vendor for a new one`);
  }

  let record = null;
  if (recordAmount != null) {
    record = toPositiveSats(recordAmount);
    if (record === null) return fail("BAD_RECORD_AMOUNT", `amountSats from our records is not a positive whole number of sats: ${String(recordAmount)}`);
  }

  const common = { ok: true, to: receiver.address, invoiceId: fields.id };
  if (paymentType.amount == null) {
    if (record === null) {
      return fail("AMOUNT_REQUIRED", "amountless invoice and no amountSats in our records; not guessing an amount");
    }
    return { ...common, amountless: true, amountSats: record };
  }
  const embedded = Number(paymentType.amount);
  if (!Number.isSafeInteger(embedded) || embedded <= 0) {
    return fail("INVALID_AMOUNT", `invoice carries an unusable amount (${String(paymentType.amount)})`);
  }
  if (record !== null && record !== embedded) {
    return fail("AMOUNT_MISMATCH", `invoice asks ${embedded} sats but our records say ${record} sats; not paying`);
  }
  return { ...common, amountless: false, amountSats: embedded };
}

function toPositiveSats(v) {
  let n;
  if (typeof v === "bigint") n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN;
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) n = Number(v.trim());
  else n = v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Nothing-sent errors go to notPaid. PAYMENT_COMMITTED and anything unrecognised go to unknown:
// when in doubt, never tell the caller "not paid", because that invites paying again.
function classifyFailure(err, base, report) {
  const code = err?.code;

  if (code === "PAYMENT_COMMITTED") {
    // With a batch of one, the invoice is either in err.paid or its outcome is unknown.
    const paidHere = (err.paid ?? []).find((p) => p.invoice === base.invoice);
    if (paidHere) {
      report.paid.push({ ...base, transferId: paidHere.id ?? null });
      return;
    }
    const failed = (err.failed ?? []).find((f) => f.invoice === base.invoice);
    report.unknown.push({
      ...base,
      code,
      settled: err.settled ?? null,
      reason: failed?.reason || err.message,
      next: "Do NOT pay again by any method; check agent.getTransfers() for this receiver/amount first.",
    });
    return;
  }

  // SparkAgent passes a SparkValidationError through unchanged only when it proves nothing was sent.
  if (NOTHING_SENT_CODES.has(code) || err?.name === "SparkValidationError") {
    const reason =
      code === "POLICY_DENIED"
        ? err.reason // relay the policy's own reason; don't retry smaller
        : code === "INVOICE_REFUSED"
          ? err.invalidInvoices?.find((i) => i.invoice === base.invoice)?.reason || err.message
          : err.message;
    report.notPaid.push({
      ref: base.ref,
      invoice: base.invoice,
      code: code ?? "SPARK_VALIDATION",
      reason,
      ...(err?.rule ? { rule: err.rule } : {}),
      amountSats: base.amountSats,
    });
    return;
  }

  report.unknown.push({
    ...base,
    code: code ?? "UNCLASSIFIED",
    reason: String(err?.message ?? err),
    next: "Unrecognised failure, treated as possibly sent. Check agent.getTransfers() before paying again.",
  });
}

// Usage (one-shot script; a long-running bot keeps its agent open and skips cleanup):
//
//   import "dotenv/config";
//   import { loadMnemonicFromEnv } from "sparkbtcbot-skill";
//   import { SparkAgent } from "sparkbtcbot-skill/agent";
//
//   const mnemonic = await loadMnemonicFromEnv(); // SPARK_PASSPHRASE (or _FILE) decrypts ~/.spark/seed.enc
//   const { agent } = await SparkAgent.create(mnemonic, process.env.SPARK_NETWORK || "MAINNET", { optimizeLeaves: false });
//   try {
//     const report = await payVendorInvoices(agent, [
//       { ref: "acme-INV-091", invoice: "spark1…" },                    // amount in the invoice
//       { ref: "globex-77", invoice: "spark1…", amountSats: 12_500 },  // amountless: our records
//     ]);
//     // Save report.paid and report.unknown to your books BEFORE doing anything else.
//     // report.notPaid[].reason says why (policy denial, allowlist, budget, amount mismatch, expired…).
//   } finally {
//     await agent.cleanup();
//   }
