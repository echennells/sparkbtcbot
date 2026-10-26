// The persisted per-invoice transferId store (lib/transfer-ids.js): the
// contract is ONE dedup identity per invoice, minted write-ahead and durable
// across processes, so a Lightning retry can reuse it and the SDK's cross-rail
// dedup (spark-sdk >=0.10) makes a double-pay impossible. The store must fail
// CLOSED on anything ambiguous — an unreadable entry, a disagreeing explicit
// id — because minting a fresh id for an invoice that may already have a
// payment in flight is exactly the failure it exists to prevent.
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransferIdStore, invoiceDedupKey } from "../../lib/transfer-ids.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README —
// decodable, so it keys by payment hash. Long expired, which must NOT stop
// dedup (a retry can trail expiry; TTL only affects pruning).
const DECODABLE =
  "lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567";
const UNDECODABLE = "lnbc1notarealinvoice";

const tmp = () => mkdtemp(join(tmpdir(), "transfer-ids-"));
let n = 0;
const mint = () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;

describe("idForInvoice", () => {
  it("mints once and returns the SAME id for every later attempt at the invoice", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const first = await store.idForInvoice(DECODABLE, mint);
    const second = await store.idForInvoice(DECODABLE, mint);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.transferId).toBe(first.transferId);
  });

  it("keys by payment hash, so the same invoice in different CASE still dedupes", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const a = await store.idForInvoice(DECODABLE, mint);
    const b = await store.idForInvoice(DECODABLE.toUpperCase(), mint);
    expect(b.transferId).toBe(a.transferId);
  });

  it("different invoices get different ids", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const a = await store.idForInvoice(DECODABLE, mint);
    const b = await store.idForInvoice(UNDECODABLE, mint);
    expect(b.transferId).not.toBe(a.transferId);
  });

  it("dedupes an UNDECODABLE invoice too (hash of the string, not no-dedup)", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const a = await store.idForInvoice(UNDECODABLE, mint);
    const b = await store.idForInvoice(UNDECODABLE, mint);
    expect(b.transferId).toBe(a.transferId);
    expect(invoiceDedupKey(UNDECODABLE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("survives a 'process restart' (a second store over the same dir)", async () => {
    const dir = await tmp();
    const first = await createTransferIdStore({ dir }).idForInvoice(DECODABLE, mint);
    const second = await createTransferIdStore({ dir }).idForInvoice(DECODABLE, mint);
    expect(second).toMatchObject({ transferId: first.transferId, reused: true });
  });

  it("concurrent racers converge on ONE id (the exclusive-link EEXIST path)", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.idForInvoice(DECODABLE, mint)),
    );
    const ids = new Set(results.map((r) => r.transferId));
    expect(ids.size).toBe(1);
  });

  it("records an explicit id, and REFUSES a later disagreeing one", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const explicit = mint();
    const first = await store.idForInvoice(DECODABLE, mint, { explicitId: explicit });
    expect(first.transferId).toBe(explicit);
    // agreeing explicit id is fine (idempotent retry with the same id)
    await expect(store.idForInvoice(DECODABLE, mint, { explicitId: explicit })).resolves.toMatchObject({
      transferId: explicit,
      reused: true,
    });
    await expect(store.idForInvoice(DECODABLE, mint, { explicitId: mint() })).rejects.toThrow(
      /disagrees with the id already recorded/i,
    );
  });

  it("fails CLOSED on an unreadable entry instead of minting a fresh id", async () => {
    const dir = await tmp();
    const store = createTransferIdStore({ dir });
    await store.idForInvoice(DECODABLE, mint);
    const [file] = await readdir(dir);
    await writeFile(join(dir, file), "{corrupted");
    await expect(store.idForInvoice(DECODABLE, mint)).rejects.toThrow(/unreadable or invalid dedup entry/i);
  });
});

describe("prune", () => {
  it("removes only entries whose recorded expiry passed; never unreadable ones", async () => {
    const dir = await tmp();
    let now = Date.now();
    const store = createTransferIdStore({ dir, clock: () => now });
    // DECODABLE's invoice expired years ago -> entry TTL is just the settle
    // grace, so advancing the clock past it makes the entry prunable.
    await store.idForInvoice(DECODABLE, mint);
    await writeFile(join(dir, "not-an-entry.json"), "{corrupted");
    now += 25 * 60 * 60 * 1000; // +25h > the 24h settle grace (hold-invoice headroom)
    const removed = await store.prune();
    expect(removed).toBe(1);
    const left = await readdir(dir);
    expect(left).toEqual(["not-an-entry.json"]); // unreadable file untouched
  });

  it("keeps an entry whose invoice could still be paid (undecodable => week TTL)", async () => {
    const dir = await tmp();
    let now = Date.now();
    const store = createTransferIdStore({ dir, clock: () => now });
    const { transferId } = await store.idForInvoice(UNDECODABLE, mint);
    now += 2 * 60 * 60 * 1000;
    expect(await store.prune()).toBe(0);
    await expect(store.idForInvoice(UNDECODABLE, mint)).resolves.toMatchObject({ transferId });
  });
});

// Hardening from the 2026-08-31 ToB audit (sharp-edges F4/F6/F9, differential
// LOW-2): the store must fail LOUD on misuse — a persisted non-UUID id wedges
// the invoice at the SDK with no hint of the entry file; positional misuse
// silently ignored at the exact retry moment is how a guard becomes a no-op.
describe("audit hardening", () => {
  it("rejects a non-UUID mint result instead of persisting an id the SDK will refuse", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    await expect(store.idForInvoice(DECODABLE, () => "not-a-uuid-at-all")).rejects.toThrow(/must return a UUID string/i);
    await expect(readdir(store.dir)).resolves.toEqual([]); // nothing persisted
  });

  it("accepts a UUID OBJECT from mint (e.g. the SDK's generateTransferId) via toString", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const obj = { toString: () => "0198F00D-0000-7000-8000-00000000AAAA" };
    const { transferId } = await store.idForInvoice(DECODABLE, () => obj);
    expect(transferId).toBe("0198f00d-0000-7000-8000-00000000aaaa"); // normalized lowercase
  });

  it("fails CLOSED on a well-formed entry holding a non-UUID id (names the file)", async () => {
    const dir = await tmp();
    const store = createTransferIdStore({ dir });
    await store.idForInvoice(DECODABLE, mint);
    const [file] = await readdir(dir);
    await writeFile(join(dir, file), JSON.stringify({ v: 1, transferId: "garbage" }));
    await expect(store.idForInvoice(DECODABLE, mint)).rejects.toThrow(/unreadable or invalid dedup entry/i);
  });

  it("throws loud on positional misuse instead of silently ignoring an id in mint's seat", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    await store.idForInvoice(DECODABLE, mint); // entry exists — the dangerous silent case
    await expect(store.idForInvoice(DECODABLE, mint())).rejects.toThrow(/mint FUNCTION/i);
    await expect(store.idForInvoice(DECODABLE, mint, "some-id")).rejects.toThrow(/options object/i);
    await expect(store.idForInvoice(undefined, mint)).rejects.toThrow(/BOLT11 string first/i);
    await expect(store.idForInvoice(DECODABLE, mint, { explicitId: 12345 })).rejects.toThrow(/explicitId must be a UUID string/i);
  });

  it("REFUSES an explicitId already recorded for a DIFFERENT invoice (cross-invoice replay)", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    const { transferId: idA } = await store.idForInvoice(DECODABLE, mint);
    await expect(store.idForInvoice(UNDECODABLE, mint, { explicitId: idA })).rejects.toThrow(
      /already recorded for a DIFFERENT invoice/i,
    );
  });

  it("rejects a broken clock at construction (a Date-returning clock breaks TTLs silently)", () => {
    expect(() => createTransferIdStore({ clock: () => new Date() })).toThrow(/clock must be a function returning a finite ms timestamp/i);
    expect(() => createTransferIdStore({ clock: 123 })).toThrow(/clock/i);
  });

  it("forget() removes the entry so a terminally-failed invoice can be re-paid fresh", async () => {
    const dir = await tmp();
    const store = createTransferIdStore({ dir });
    const first = await store.idForInvoice(DECODABLE, mint);
    expect(await store.forget(DECODABLE)).toBe(true);
    const second = await store.idForInvoice(DECODABLE, mint);
    expect(second.transferId).not.toBe(first.transferId);
    expect(await store.forget(UNDECODABLE)).toBe(false); // nothing there — no throw
  });

  it("frames a store fs failure with the fix (path, not SPARK_LN_DEDUP=off)", async () => {
    const dir = await tmp();
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "a plain file where the store dir should be");
    const store = createTransferIdStore({ dir: join(blocked, "sub") });
    await expect(store.idForInvoice(DECODABLE, mint)).rejects.toThrow(/transfer-ids: cannot .*SPARK_LN_DEDUP_PATH/s);
  });
});

describe("entry file", () => {
  it("is one small JSON per invoice with the id, a prefix for humans, and the expiry", async () => {
    const dir = await tmp();
    const store = createTransferIdStore({ dir });
    const { transferId } = await store.idForInvoice(DECODABLE, mint);
    const entry = JSON.parse(await readFile(join(dir, `${invoiceDedupKey(DECODABLE)}.json`), "utf8"));
    expect(entry).toMatchObject({ v: 1, transferId, invoice: DECODABLE.slice(0, 24) });
    expect(typeof entry.expiresAt).toBe("number");
  });
});

describe("peek", () => {
  it("returns the recorded id without minting, and null when nothing is recorded", async () => {
    const store = createTransferIdStore({ dir: await tmp() });
    expect(await store.peek(DECODABLE)).toBeNull();
    expect(await readdir(store.dir).catch(() => [])).toEqual([]); // peeking wrote nothing
    const { transferId } = await store.idForInvoice(DECODABLE, mint);
    expect(await store.peek(DECODABLE)).toMatchObject({ transferId });
    expect(await store.peek("")).toBeNull();
  });
});
