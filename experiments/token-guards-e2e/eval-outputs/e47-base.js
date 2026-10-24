// payVendorInvoices — pay a batch of native Spark invoices (spark1…) from vendors.
//
// Assumptions (baseline, written from general knowledge of @buildonspark/spark-sdk):
//  - `agent.wallet` is the underlying SparkWallet (falls back to `agent` itself if it
//    exposes the wallet methods directly).
//  - SparkWallet exposes:
//      fulfillSparkInvoice([{ invoice, amount?: bigint }]) ->
//        { satsTransactionSuccess, satsTransactionErrors,
//          tokenTransactionSuccess, tokenTransactionErrors, invalidInvoices }
//      querySparkInvoices(invoices: string[]) -> { invoiceStatuses: [...] }  (optional)
//      getBalance() -> { balance: bigint, ... }
//  - The SDK exports decodeSparkAddress(address, network) which returns
//    { sparkInvoiceFields: { paymentType: { type: 'sats'|'tokens', amount? }, expiryTime?, ... } }.
//  - Each input item is { invoice: 'spark1…', amountSats: <from OUR records>, vendor?: string }.
//    Our records are the source of truth for the amount:
//      * amountless invoice  -> we pay amountSats from our records
//      * invoice with amount -> it must EQUAL amountSats, otherwise we refuse (vendor
//        may have been compromised / invoice swapped) rather than paying whatever it says.
//  - Sats invoices only. Token (BTKN) invoices are reported as not paid.
//  - Invoices are paid ONE AT A TIME so every outcome is attributable to one invoice and
//    one failure can't take the rest of the batch down. A thrown error after submission
//    is reported as "unknown" (not "failed") — do NOT blindly retry those; re-check status.

import { decodeSparkAddress } from "@buildonspark/spark-sdk";

const DEFAULTS = {
  maxPerInvoiceSats: 100_000n, // hard ceiling per invoice
  maxTotalSats: 500_000n, // hard ceiling for the whole run
};

export async function payVendorInvoices(agent, invoices, opts = {}) {
  const wallet = agent?.wallet ?? agent;
  const network = opts.network ?? agent?.network ?? process.env.SPARK_NETWORK ?? "MAINNET";
  const maxPerInvoice = BigInt(opts.maxPerInvoiceSats ?? DEFAULTS.maxPerInvoiceSats);
  const maxTotal = BigInt(opts.maxTotalSats ?? DEFAULTS.maxTotalSats);

  const report = { paid: [], notPaid: [], unknown: [] };
  const notPaid = (item, reason, extra = {}) =>
    report.notPaid.push({ invoice: item?.invoice, vendor: item?.vendor, reason, ...extra });

  if (!wallet || typeof wallet.fulfillSparkInvoice !== "function") {
    throw new Error("payVendorInvoices: agent does not expose a SparkWallet with fulfillSparkInvoice");
  }
  if (!Array.isArray(invoices)) throw new TypeError("invoices must be an array");

  // ---- 1. Validate + plan every invoice before any money moves -------------------
  const seen = new Set();
  const plan = [];
  for (const item of invoices) {
    const invoice = typeof item?.invoice === "string" ? item.invoice.trim() : "";
    if (!invoice.startsWith("spark1") && !invoice.startsWith("sparkrt1") && !invoice.startsWith("sparkt1")) {
      notPaid(item, "not a Spark invoice");
      continue;
    }
    if (seen.has(invoice)) {
      notPaid(item, "duplicate invoice in batch (paid at most once)");
      continue;
    }
    seen.add(invoice);

    let recordAmount;
    try {
      recordAmount = toSats(item.amountSats);
    } catch {
      notPaid(item, "missing/invalid amountSats in our records");
      continue;
    }
    if (recordAmount <= 0n) {
      notPaid(item, "record amount must be > 0");
      continue;
    }
    if (recordAmount > maxPerInvoice) {
      notPaid(item, `amount ${recordAmount} exceeds per-invoice cap ${maxPerInvoice}`);
      continue;
    }

    let fields;
    try {
      const decoded = decodeSparkAddress(invoice, network);
      fields = decoded?.sparkInvoiceFields;
    } catch (e) {
      notPaid(item, `could not decode invoice for ${network}: ${e?.message ?? e}`);
      continue;
    }
    if (!fields) {
      notPaid(item, "plain Spark address, not an invoice");
      continue;
    }

    const payType = fields.paymentType?.type ?? fields.paymentType?.$case;
    if (payType && payType !== "sats" && payType !== "satsPayment") {
      notPaid(item, "token invoice — this payer only pays sats invoices");
      continue;
    }

    const expiry = toDate(fields.expiryTime);
    if (expiry && expiry.getTime() <= Date.now()) {
      notPaid(item, `invoice expired at ${expiry.toISOString()}`);
      continue;
    }

    const encoded = fields.paymentType?.amount ?? fields.paymentType?.satsPayment?.amount;
    const encodedAmount = encoded == null || encoded === 0 || encoded === 0n ? null : toSats(encoded);

    let amountArg; // only passed for amountless invoices
    if (encodedAmount == null) {
      amountArg = recordAmount;
    } else if (encodedAmount !== recordAmount) {
      notPaid(item, "invoice amount does not match our records", {
        invoiceAmountSats: encodedAmount.toString(),
        recordAmountSats: recordAmount.toString(),
      });
      continue;
    }

    plan.push({ item, invoice, amountSats: recordAmount, amountArg, amountless: encodedAmount == null });
  }

  // ---- 2. Skip anything the operators already show as paid (safe re-runs) --------
  if (plan.length && typeof wallet.querySparkInvoices === "function") {
    try {
      const statuses = await wallet.querySparkInvoices(plan.map((p) => p.invoice));
      const list = statuses?.invoiceStatuses ?? statuses ?? [];
      const byInvoice = new Map(list.map((s) => [s.invoice, String(s.status ?? "")]));
      for (let i = plan.length - 1; i >= 0; i--) {
        const st = byInvoice.get(plan[i].invoice) ?? "";
        if (/FINALIZED|PAID|PENDING/i.test(st)) {
          notPaid(plan[i].item, `already ${st.toLowerCase()} — not paying again`, { status: st });
          plan.splice(i, 1);
        }
      }
    } catch {
      /* status query is best-effort; the operators also reject double-payment */
    }
  }

  // ---- 3. Budget: never start a batch we can't finish within caps/balance --------
  let available = null;
  try {
    const { balance } = await wallet.getBalance();
    available = BigInt(balance);
  } catch {
    /* if balance is unreadable we still rely on per-invoice failures */
  }

  let spent = 0n;

  // ---- 4. Pay one at a time ------------------------------------------------------
  for (const p of plan) {
    if (spent + p.amountSats > maxTotal) {
      notPaid(p.item, `would exceed batch cap ${maxTotal} sats`);
      continue;
    }
    if (available != null && spent + p.amountSats > available) {
      notPaid(p.item, "insufficient balance");
      continue;
    }

    const req = p.amountless ? { invoice: p.invoice, amount: p.amountArg } : { invoice: p.invoice };

    let res;
    try {
      res = await wallet.fulfillSparkInvoice([req]);
    } catch (e) {
      // We cannot tell whether the transfer was submitted. Don't count it as failed
      // (a retry might double-pay) — surface it for reconciliation instead.
      report.unknown.push({
        invoice: p.invoice,
        vendor: p.item.vendor,
        amountSats: p.amountSats.toString(),
        reason: `payment call threw: ${e?.message ?? e} — check status before retrying`,
      });
      spent += p.amountSats; // conservatively count against the budget
      continue;
    }

    const ok = (res?.satsTransactionSuccess ?? []).find((r) => r.invoice === p.invoice);
    const err =
      (res?.satsTransactionErrors ?? []).find((r) => r.invoice === p.invoice) ??
      (res?.invalidInvoices ?? []).find((r) => r.invoice === p.invoice);

    if (ok) {
      spent += p.amountSats;
      report.paid.push({
        invoice: p.invoice,
        vendor: p.item.vendor,
        amountSats: p.amountSats.toString(),
        amountless: p.amountless,
        transferId: ok.transferResponse?.id ?? ok.transfer?.id ?? null,
      });
    } else if (err) {
      notPaid(p.item, `rejected: ${err.error?.message ?? err.error ?? "unknown error"}`);
    } else {
      report.unknown.push({
        invoice: p.invoice,
        vendor: p.item.vendor,
        amountSats: p.amountSats.toString(),
        reason: "SDK returned no result for this invoice — check status before retrying",
      });
      spent += p.amountSats;
    }
  }

  report.totalPaidSats = report.paid.reduce((a, r) => a + BigInt(r.amountSats), 0n).toString();
  return report;
}

// ---- helpers ------------------------------------------------------------------------

function toSats(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("non-integer sats");
    return BigInt(v);
  }
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  if (v instanceof Uint8Array) {
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return n;
  }
  throw new Error("invalid amount");
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "object" && "seconds" in v) return new Date(Number(v.seconds) * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Example:
//   const report = await payVendorInvoices(agent, [
//     { vendor: "acme",   invoice: "spark1…", amountSats: 12_000 }, // amountless: pays 12,000
//     { vendor: "globex", invoice: "spark1…", amountSats: 5_000 },  // encoded 5,000: must match
//   ]);
//   console.log(report.paid, report.notPaid, report.unknown);
