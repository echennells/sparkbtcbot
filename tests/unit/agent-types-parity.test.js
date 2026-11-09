// The ./agent type declarations (skills/sparkbtcbot/scripts/spark-agent.d.ts)
// and the error contract's types (lib/index.d.ts), held to the shipped code
// without TypeScript (no new devDependency). The declarations are read with
// regexes, on the format rules the .d.ts header states; spark-agent.js with a
// small scanner that finds each function's body, the codes it raises and the
// helpers it calls. The checks:
//   1. the declared members are the runtime members (prototype incl.
//      constructor, statics), both ways
//   2. each member has exactly one @sideEffect read|receive|spend|unlock, and @throws
//      lines (or `@throws none`)
//   3. every @throws code is in AgentErrorCode
//   4. the module's function exports are its `export declare` functions, each tagged
//   5. `@dryRun read` exactly where the code takes dryRun
//   6. each member lists every code its body raises,
//   7. and every code its helpers raise (followed through the file's own
//      helpers, with a table for the lib calls)
//   8. each option interface has exactly the keys the code accepts
//   9. every code the sources raise or compare is in AgentErrorCode, which is
//      exactly the registry's codes, and the codes that predate the contract
//      are all still there
//  10. every type name the .d.ts imports exists in the installed SDK's
//      declarations or in lib/index.d.ts
// Plus: the side-effect tags the spec decided, "spend" exactly where a send's
// failure is judged (#spendFailed), lib/index.d.ts against lib/index.js's
// exports, and a syntax smoke under Node's own type stripping.
import { describe, it, expect } from "vitest";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_ERRORS, STATUS_PROBLEMS, RETRYABLE_VALUES } from "../../lib/agent-errors.js";
import * as agentModule from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import * as libModule from "../../lib/index.js";

const { SparkAgent } = agentModule;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DTS_PATH = "skills/sparkbtcbot/scripts/spark-agent.d.ts";
const LIB_DTS_PATH = "lib/index.d.ts";
const AGENT_JS_PATH = "skills/sparkbtcbot/scripts/spark-agent.js";

const dts = await readFile(join(ROOT, DTS_PATH), "utf8");
const libDts = await readFile(join(ROOT, LIB_DTS_PATH), "utf8");
const agentJs = await readFile(join(ROOT, AGENT_JS_PATH), "utf8");

// Public API since before the contract: these names never change.
const EXISTING_CODES = [
  "PAYMENT_COMMITTED", "PAYMENT_ALREADY_SETTLED", "LIGHTNING_PAYMENT_FAILED", "INVOICE_EXPIRED", "INVOICE_REFUSED",
  "SPEND_BUDGET_EXCEEDED", "SPEND_LEDGER_MISSING", "SPEND_LEDGER_BAD_SIGNATURE", "SPEND_LEDGER_UNREADABLE",
  "RECIPIENT_NOT_ALLOWED", "RECIPIENT_INVALID", "DEPOSIT_NOT_FOUND", "DEPOSIT_LOOKUP_INCOMPLETE",
  "SINGLE_USE_DEPOSITS_UNAVAILABLE", "NO_SEED", "NO_PASSPHRASE", "BAD_PASSPHRASE", "L402_TOKEN_EXPIRED",
  "LEAF_VAULT_FATAL", "LEAF_VAULT_ANCHORLESS", "EEXIST",
];
// Node's own error codes, which the sources compare against (never raise).
const OS_CODES = new Set(["ENOENT", "EEXIST", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ESRCH"]);
const SIDE_EFFECTS = new Set(["read", "receive", "spend", "unlock"]);

// --- Reading the declarations ---

// The members of `export declare class SparkAgent`, by name ("static create"
// for a static), each with its signatures and the doc block above the first.
function declaredMembers() {
  const lines = dts.split("\n");
  const start = lines.findIndex((l) => /^export declare class SparkAgent \{$/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^\}$/.test(l));
  const members = new Map();
  let doc = null;
  let buf = null;
  let sig = null;
  for (const line of lines.slice(start + 1, end)) {
    if (buf) {
      buf.push(line);
      if (line.includes("*/")) { doc = buf.join("\n"); buf = null; }
      continue;
    }
    if (/^  \/\*\*/.test(line)) {
      buf = [line];
      if (line.includes("*/")) { doc = line; buf = null; }
      continue;
    }
    if (sig) {
      sig.text += `\n${line}`; // a signature written over several lines
      if (/;\s*$/.test(line)) sig = null;
      continue;
    }
    const m = line.match(/^  (static\s+)?([A-Za-z]\w*)\s*[(<]/);
    if (m) {
      const name = m[1] ? `static ${m[2]}` : m[2];
      if (!members.has(name)) members.set(name, []);
      const entry = { doc, text: line };
      members.get(name).push(entry);
      if (!/;\s*$/.test(line)) sig = entry;
      doc = null;
    } else if (line.trim()) {
      doc = null; // a doc block belongs to the signature right under it
    }
  }
  return { members, found: start >= 0 && end > start };
}

// `export declare function` blocks with the doc above each.
function declaredFunctions() {
  const out = new Map();
  for (const m of dts.matchAll(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*\nexport declare function (\w+)/g)) out.set(m[2], m[1]);
  return out;
}

const tagsOf = (doc) => ({
  side: [...(doc ?? "").matchAll(/@sideEffect\s+(\S+)/g)].map((m) => m[1]),
  dryRun: [...(doc ?? "").matchAll(/@dryRun\s+(\S+)/g)].map((m) => m[1]),
  throws: [...(doc ?? "").matchAll(/@throws\s+(?:\{(\w+)\}\s+)?([A-Za-z]\w*)/g)].map((m) => ({ type: m[1] ?? null, code: m[2] })),
});

// The string members of `export type <name> = "A" | "B" …;`, in order.
function unionOf(text, name) {
  const at = text.indexOf(`export type ${name} =`);
  if (at < 0) return [];
  const body = text.slice(at, text.indexOf(";", at)).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Keys of `export interface <name> [extends <base>] { … }` (multi-line form),
// with the base's keys; null when there is no such interface.
function interfaceKeys(name) {
  const m = dts.match(new RegExp(`export interface ${name}(?: extends (\\w+))? \\{([\\s\\S]*?)\\n\\}`));
  if (!m) return null;
  const body = m[2].replace(/\/\*\*[\s\S]*?\*\//g, "");
  const keys = new Set([...body.matchAll(/^\s*(\w+)\??:/gm)].map((x) => x[1]));
  if (m[1]) for (const k of interfaceKeys(m[1]) ?? []) keys.add(k);
  return keys;
}

// --- Reading the code ---

// The arguments of the call whose "(" is at `open`, split at its top-level
// commas. Skips strings and template literals (with their ${…}), so a comma,
// quote or paren inside a message doesn't count.
function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = skipString(text, i, c);
    else if (c === "`") i = skipTemplate(text, i);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) {
        args.push(text.slice(start, i));
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}
function skipString(t, i, quote) {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === quote) return i;
  }
  return i;
}
function skipTemplate(t, i) {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") { i++; continue; }
    if (t[i] === "`") return i;
    if (t[i] === "$" && t[i + 1] === "{") {
      let depth = 0;
      for (i++; i < t.length; i++) {
        const c = t[i];
        if (c === '"' || c === "'") i = skipString(t, i, c);
        else if (c === "`") i = skipTemplate(t, i);
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
      }
    }
  }
  return i;
}
// A code literal: UPPER_SNAKE, never ending in "_" (that's a prefix).
const CODE = String.raw`"([A-Z][A-Z0-9_]*[A-Z0-9])"`;
const literalCodes = (s) => [...(s ?? "").matchAll(new RegExp(CODE, "g"))].map((m) => m[1]);
const argLiterals = (text, callee, index) => {
  const out = [];
  for (const m of text.matchAll(new RegExp(`\\b${callee}\\(`, "g"))) out.push(...literalCodes(callArgs(text, m.index + m[0].length - 1)[index]));
  return out;
};

// Codes a piece of source raises itself: annotateError's code argument (a
// literal or a ternary of literals; a variable is followed by the helper
// table instead), `code: "…"` / `code = "…"` (code tables, defaults),
// transfer-ids' frame() code, storageError(), new PaymentCommittedError().
function codesRaised(text) {
  const codes = new Set([...argLiterals(text, "annotateError", 1), ...argLiterals(text, "frame", 2)]);
  for (const m of text.matchAll(/\bcode(?: =|:)\s*"([A-Z][A-Z0-9_]*[A-Z0-9])"/g)) codes.add(m[1]);
  if (/\bstorageError\(/.test(text)) codes.add("STORAGE_ERROR");
  if (/\bnew PaymentCommittedError\(/.test(text)) codes.add("PAYMENT_COMMITTED");
  return codes;
}

// spark-agent.js as units: each module-level function (or arrow const) and
// each class member, by name ("#x" for a private one), comments stripped.
const duplicateUnits = [];
function sourceUnits() {
  const units = new Map();
  let cur = null;
  let inClass = false;
  const add = (unit) => {
    if (units.has(unit.name)) duplicateUnits.push(unit.name);
    units.set(unit.name, unit);
    return unit;
  };
  for (const raw of agentJs.split("\n")) {
    if (/^\s*\/\//.test(raw)) continue;
    const line = raw.replace(/\s+\/\/\s.*$/, "");
    if (/^export class SparkAgent\b/.test(line)) { inClass = true; cur = null; continue; }
    if (inClass && /^\}/.test(line)) { inClass = false; cur = null; continue; }
    let m;
    if (inClass && (m = line.match(/^  (static )?(?:async )?(#?[A-Za-z]\w*)\(/))) {
      cur = add({ name: m[2], member: true, text: [line] });
      continue;
    }
    if (!inClass && /^[A-Za-z]/.test(line)) {
      m = line.match(/^(?:export )?(?:async )?function (\w+)\(/) ?? line.match(/^(?:export )?const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>/);
      cur = m ? add({ name: m[1], member: false, text: [line] }) : null;
      continue;
    }
    if (cur) cur.text.push(line);
  }
  for (const u of units.values()) u.text = u.text.join("\n");
  return units;
}
const units = sourceUnits();

// The units a unit calls: module functions by name, private members as
// this.#x(, public ones as this.x(, the constructor as new SparkAgent(.
function callees(unit) {
  const out = new Set();
  for (const [name, u] of units) {
    if (name === unit.name) continue;
    const called = !u.member
      ? new RegExp(`(?<![\\w.#$])${name}\\(`).test(unit.text)
      : name === "constructor"
        ? /\bnew SparkAgent\(/.test(unit.text)
        : unit.text.includes(`this.${name}(`);
    if (called) out.add(name);
  }
  return out;
}

// What the lib calls in spark-agent.js raise, each checked below against the
// lib file it names. preSendCode names the code of an SDK pre-send refusal:
// INSUFFICIENT_FUNDS is the one every send can meet; the others it can name
// (INVOICE_INVALID, FEE_OVER_LIMIT, …) are listed where they apply.
const LEDGER_READ = ["SPEND_LEDGER_MISSING", "SPEND_LEDGER_BAD_SIGNATURE", "SPEND_LEDGER_UNREADABLE", "STORAGE_ERROR"];
const LIB_CALLS = [
  [/\bclassifySdkError\(/, ["SPARK_UNAVAILABLE", "SPARK_REFUSED"], "lib/payment-outcome.js"],
  [/\bpreSendCode\(/, ["INSUFFICIENT_FUNDS"], "lib/payment-outcome.js"],
  [/\bloadRecipientsAllowlist\(/, ["STORAGE_ERROR"], "lib/recipients-allowlist.js"],
  [/\bassertRecipientAllowed\(/, ["RECIPIENT_NOT_ALLOWED", "RECIPIENT_INVALID"], "lib/recipients-allowlist.js"],
  [/\bcreateSpendLedger\(/, ["BAD_INPUT"], "lib/spend-ledger.js"],
  [/\bledger\.(?:reserve|assertCanSpend)\(/, ["SPEND_BUDGET_EXCEEDED", ...LEDGER_READ], "lib/spend-ledger.js"],
  [/\bledger\.(?:record|status)\(/, LEDGER_READ, "lib/spend-ledger.js"],
  [/\breadLimits\(/, ["LIMITS_UNREADABLE"], "lib/spending-limits.js"],
  [/\.#l402Store\.(?:read|list)\(/, ["L402_HOLD_UNREADABLE", "STORAGE_ERROR"], "lib/l402-holds.js"],
  [/\.#l402Store\.(?:claim|put|remove|removeSync|count)\(/, ["STORAGE_ERROR"], "lib/l402-holds.js"],
  [/\.#lnDedup\.idForInvoice\(/, ["TRANSFER_ID_CONFLICT", "CONCURRENT_PAYMENT_ATTEMPT", "DEDUP_ENTRY_UNREADABLE", "STORAGE_ERROR"], "lib/transfer-ids.js"],
  [/\bsparkWalletOptions\(/, ["BAD_INPUT"], "lib/wallet-options.js"],
];

// Calls whose every error the caller catches and replaces with its own
// (which its body raises, so they are counted there).
const CAUGHT = new Set([
  "#resumeL402 → payAndSettle", // each failure becomes LIGHTNING_PAYMENT_FAILED (kept hold) or PAYMENT_COMMITTED
]);
// Codes a callee raises that can't come out of this member.
const NOT_FROM = {
  "#activeLedger": { BAD_INPUT: "createSpendLedger gets no budget there, so its one check can't fail" },
  "#syncL402": { STORAGE_ERROR: "a failed write warns and keeps the copy in memory" },
  "#l402HeldSummary": { L402_HOLD_UNREADABLE: "listed as reason \"unreadable\"", STORAGE_ERROR: "an unlistable store lists nothing" },
  "#budgetStatus": {
    LIMITS_UNREADABLE: "status() reports an unreadable limits file as a problem; it doesn't throw",
    SPEND_LEDGER_MISSING: "reported as a problem", SPEND_LEDGER_BAD_SIGNATURE: "reported as a problem",
    SPEND_LEDGER_UNREADABLE: "reported as a problem", STORAGE_ERROR: "reported as SPEND_LEDGER_UNREADABLE",
  },
  fetchL402: {
    PREIMAGE_MISMATCH: "the URL is held as L402_NO_PROOF and PAYMENT_COMMITTED thrown",
    PAYMENT_ALREADY_SETTLED: "the purchase is held and PAYMENT_COMMITTED thrown",
    PAYMENT_HASH_MISMATCH: "fetchL402 never passes expectedPaymentHash",
    AMOUNT_MISMATCH: "fetchL402 never passes amountSats",
    TRANSFER_ID_CONFLICT: "fetchL402 never passes transferId",
  },
};

// Every code a unit can raise: its own, its lib calls', and its callees'.
const requiredMemo = new Map();
function requiredCodes(name, { exempt = true } = {}) {
  const key = `${name}|${exempt}`;
  if (requiredMemo.has(key)) return requiredMemo.get(key);
  requiredMemo.set(key, new Set()); // a cycle contributes nothing more
  const unit = units.get(name);
  const codes = codesRaised(unit.text);
  for (const [re, list] of LIB_CALLS) if (re.test(unit.text)) list.forEach((c) => codes.add(c));
  for (const callee of callees(unit)) {
    if (CAUGHT.has(`${name} → ${callee}`)) continue;
    for (const c of requiredCodes(callee)) codes.add(c);
  }
  if (exempt) for (const c of Object.keys(NOT_FROM[name] ?? {})) codes.delete(c);
  requiredMemo.set(key, codes);
  return codes;
}

function reaches(name, target, seen = new Set()) {
  if (name === target) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  return [...callees(units.get(name))].some((c) => reaches(c, target, seen));
}

const unitOf = (member) => member.replace(/^static /, "");
const { members, found: classFound } = declaredMembers();
const functions = declaredFunctions();

const runtimeMembers = [
  ...Object.getOwnPropertyNames(SparkAgent.prototype),
  ...Object.getOwnPropertyNames(SparkAgent).filter((n) => !["length", "name", "prototype"].includes(n)).map((n) => `static ${n}`),
];
const errorCodes = unionOf(libDts, "AgentErrorCode");
const problemCodes = unionOf(libDts, "StatusProblemCode");

describe("spark-agent.d.ts ↔ the shipped SparkAgent", () => {
  it("declares every runtime member (constructor and statics too), and nothing else", () => {
    expect(classFound, "no `export declare class SparkAgent {` … `}` block").toBe(true);
    expect(duplicateUnits, "spark-agent.js: two functions or members with one name").toEqual([]);
    expect(runtimeMembers).toContain("status"); // the runtime list is the real one
    const missing = runtimeMembers.filter((n) => !members.has(n));
    const phantom = [...members.keys()].filter((n) => !runtimeMembers.includes(n));
    expect(missing, "on the class, not declared").toEqual([]);
    expect(phantom, "declared, not on the class").toEqual([]);
  });

  it("declares every module export as a function, each tagged, and nothing else", () => {
    const declared = [...dts.matchAll(/^export declare (?:function|class|const) (\w+)/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(agentModule).sort());
    for (const name of Object.keys(agentModule).filter((n) => n !== "SparkAgent")) {
      const t = tagsOf(functions.get(name));
      expect(t.side, `${name}: one @sideEffect`).toHaveLength(1);
      expect(SIDE_EFFECTS.has(t.side[0]), name).toBe(true);
      expect(t.throws.length, `${name}: @throws lines or "@throws none"`).toBeGreaterThan(0);
    }
  });

  it("gives every member exactly one @sideEffect and its @throws lines, on the first signature", () => {
    const problems = [];
    for (const [name, sigs] of members) {
      const t = tagsOf(sigs[0].doc);
      if (t.side.length !== 1 || !SIDE_EFFECTS.has(t.side[0])) problems.push(`${name}: @sideEffect ${t.side.join(",") || "missing"}`);
      if (!t.throws.length) problems.push(`${name}: no @throws (write "@throws none" when it throws nothing of its own)`);
      if (t.throws.some((x) => x.code === "none") && t.throws.length > 1) problems.push(`${name}: "@throws none" with codes`);
      for (const x of t.throws) {
        if (x.code === "none") continue;
        const want = x.code === "PAYMENT_COMMITTED" ? "PaymentCommittedError" : "AgentError";
        if (x.type !== want) problems.push(`${name}: @throws {${x.type}} ${x.code}, want {${want}}`);
      }
      const codes = t.throws.map((x) => x.code);
      if (new Set(codes).size !== codes.length) problems.push(`${name}: a code listed twice`);
      for (const s of sigs.slice(1)) if (tagsOf(s.doc).side.length) problems.push(`${name}: a doc block on an overload`);
    }
    expect(problems).toEqual([]);
  });

  it("follows the spec's side-effect decisions, and tags spend exactly what reaches #spendFailed", () => {
    const side = (name) => tagsOf(members.get(name)?.[0].doc).side[0];
    const decided = {
      "static create": "receive", // opening the wallet claims inbound transfers
      constructor: "read",
      cleanup: "read",
      forgetL402: "unlock", // lifts a double-pay hold: the doc says only on the user's say-so
      getSingleUseDepositAddress: "receive",
      getWithdrawalFeeQuote: "read",
      claimDeposit: "receive",
      withdraw: "spend",
      signMessage: "read",
      status: "read",
    };
    for (const [name, tag] of Object.entries(decided)) expect(side(name), name).toBe(tag);
    expect(members.get("forgetL402")[0].doc).toMatch(/user's say-so/);
    // Every send's failure is judged in one place; whatever reaches it can send.
    const sends = [...members.keys()].filter((n) => reaches(unitOf(n), "#spendFailed")).sort();
    const tagged = [...members.keys()].filter((n) => side(n) === "spend").sort();
    expect(tagged).toEqual(sends);
    expect(sends).toEqual(expect.arrayContaining(["transfer", "payLightningInvoice", "payAndSettle", "fetchL402", "withdraw"]));
  });

  it("lists only codes in AgentErrorCode", () => {
    const union = new Set(errorCodes);
    const docs = [...[...members].map(([n, s]) => [n, s[0].doc]), ...functions];
    const unknown = docs.flatMap(([name, doc]) => tagsOf(doc).throws.filter((x) => x.code !== "none" && !union.has(x.code)).map((x) => `${name}: ${x.code}`));
    expect(unknown).toEqual([]);
  });

  it("tags @dryRun read exactly where the code takes dryRun", () => {
    const problems = [];
    for (const [name, sigs] of members) {
      const text = units.get(unitOf(name)).text;
      // In the signature, or in the options bag the body destructures (F29).
      const takes = /\bdryRun\s*=\s*false\b/.test(text.split("\n")[0]) || /const \{[^\n]*\bdryRun\s*=\s*false\b[^\n]*\} = options;/.test(text) ||
        /\bpayOptions\.dryRun\b/.test(text);
      const tagged = tagsOf(sigs[0].doc).dryRun;
      if (takes !== (tagged.length === 1 && tagged[0] === "read")) problems.push(`${name}: takes dryRun ${takes}, tagged ${tagged.join(",") || "none"}`);
    }
    expect(problems).toEqual([]);
  });

  it("lists every code a member or module function raises, itself or through its helpers", () => {
    const missing = [];
    const check = (name, unit, doc) => {
      const listed = new Set(tagsOf(doc).throws.map((x) => x.code));
      for (const c of requiredCodes(unit)) if (!listed.has(c)) missing.push(`${name}: raises ${c}`);
    };
    for (const [name, sigs] of members) check(name, unitOf(name), sigs[0].doc);
    for (const [name, doc] of functions) check(name, name, doc);
    expect(missing).toEqual([]);
    // The follow-through works: these arrive only through helpers.
    for (const [unit, code] of [
      ["transfer", "RECIPIENT_NOT_ALLOWED"], ["transfer", "SPEND_BUDGET_EXCEEDED"], ["transfer", "PAYMENT_COMMITTED"],
      ["getBalance", "SPARK_UNAVAILABLE"], ["payAndSettle", "TRANSFER_ID_CONFLICT"], ["fetchL402", "LIGHTNING_PAYMENT_FAILED"],
      ["create", "POLICY_NOT_LOADED"], ["claimDeposit", "DEPOSIT_LOOKUP_INCOMPLETE"],
    ]) expect(requiredCodes(unit).has(code), `${unit} → ${code}`).toBe(true);
  });

  it("keeps the follow-through tables honest", async () => {
    // Each lib call's codes are raised in the lib file it names.
    for (const [re, codes, file] of LIB_CALLS) {
      const raised = codesRaised(await readFile(join(ROOT, file), "utf8"));
      for (const c of codes) expect(raised.has(c), `${re} → ${c} (${file})`).toBe(true);
      expect(re.test(agentJs), `${re} is no longer called`).toBe(true);
    }
    // Each caught call still happens, inside a try that has a catch; each
    // exemption still removes something.
    for (const edge of CAUGHT) {
      const [caller, callee] = edge.split(" → ");
      const text = units.get(caller).text;
      expect(callees(units.get(caller)).has(callee), edge).toBe(true);
      const at = text.indexOf(`this.${callee}(`);
      const tryAt = text.lastIndexOf("try {", at);
      const catchAt = text.indexOf("} catch (", at);
      expect(tryAt >= 0 && catchAt > at, `${edge}: not inside try … catch`).toBe(true);
      expect(/\}\s*(?:catch|finally)\b/.test(text.slice(tryAt, at)), `${edge}: the try closes before the call`).toBe(false);
      expect(text.slice(at, catchAt).includes("try {"), `${edge}: the catch belongs to another try`).toBe(false);
    }
    for (const [name, codes] of Object.entries(NOT_FROM)) {
      const own = codesRaised(units.get(name).text);
      const through = requiredCodes(name, { exempt: false });
      for (const c of Object.keys(codes)) {
        expect(own.has(c), `${name} raises ${c} itself`).toBe(false);
        expect(through.has(c), `${name}: the ${c} exemption no longer removes anything`).toBe(true);
      }
    }
  });

  it("declares each option bag with exactly the keys the code accepts", () => {
    const sourceKeys = (unit) => {
      const sig = unit.text.split("\n")[0];
      let src = unit.text.match(/const \{([^\n]*)\} = options(?: \?\? \{\})?;/)?.[1];
      if (src === undefined) {
        const params = sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")")).replace(/\{\s*\}/g, "");
        src = params.match(/\{([^{}]*)\}/)?.[1];
      }
      if (src === undefined) {
        return /\boptions\b/.test(sig) ? { keys: new Set([...unit.text.matchAll(/\boptions\.(\w+)/g)].map((m) => m[1])), rest: null } : null;
      }
      const parts = src.replace(/\{\s*\}/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      return {
        keys: new Set(parts.filter((p) => !p.startsWith("...")).map((p) => p.split(/[\s=:]/)[0])),
        rest: parts.find((p) => p.startsWith("..."))?.slice(3) ?? null,
      };
    };
    const problems = [];
    const compare = (label, accepted, declared) => {
      if (!declared) return problems.push(`${label}: no interface`);
      for (const k of accepted) if (!declared.has(k)) problems.push(`${label}: the code accepts ${k}, the interface doesn't declare it`);
      for (const k of declared) if (!accepted.has(k)) problems.push(`${label}: the interface declares ${k}, the code ignores or refuses it`);
    };
    let checked = 0;
    for (const [name, sigs] of members) {
      const unit = units.get(unitOf(name));
      // A public wrapper that hands its whole options object to a private
      // member (fetchL402 → #fetchL402Run) accepts what that member accepts.
      const ownBag = /const \{[^\n]*\} = options/.test(unit.text);
      const delegate = !ownBag && unit.text.match(/this\.(#\w+)\([^)]*\boptions\)/)?.[1];
      const src = sourceKeys(delegate && units.has(delegate) ? units.get(delegate) : unit);
      if (!src) continue;
      checked++;
      const accepted = new Set(src.keys);
      // payAndSettle passes the rest on to payLightningInvoice, which is strict
      if (src.rest === "payOptions" && unit.text.includes(`this.payLightningInvoice(bolt11, { ...payOptions`)) {
        for (const k of sourceKeys(units.get("payLightningInvoice")).keys) accepted.add(k);
      }
      const iface = name === "constructor" ? "SparkAgentOptions" : `${unitOf(name)[0].toUpperCase()}${unitOf(name).slice(1)}Options`;
      compare(`${name} (${iface})`, accepted, interfaceKeys(iface));
      if (!sigs.some((s) => s.text.includes(iface))) problems.push(`${name}: its signature doesn't take ${iface}`);
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    // The entries inside the array arguments.
    const batch = units.get("batchTransferTokens").text.match(/const \{([^}]*)\} = t \?\? \{\};/)[1];
    compare("batchTransferTokens entry (BatchTokenEntry)",
      new Set(batch.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("..."))), interfaceKeys("BatchTokenEntry"));
    compare("fulfillInvoice entry (FulfillInvoiceEntry)",
      new Set([...units.get("fulfillInvoice").text.matchAll(/\bentry\??\.(\w+)/g)].map((m) => m[1])), interfaceKeys("FulfillInvoiceEntry"));
    expect(problems).toEqual([]);
  });

  it("imports only type names the installed SDK and lib/index.d.ts export, type-only", async () => {
    const sdkDir = join(ROOT, "node_modules/@buildonspark/spark-sdk");
    const sdkPkg = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
    const exported = async (rel) => {
      const text = await readFile(join(sdkDir, rel), "utf8");
      return new Set((text.match(/export \{[^}]*\}/g) ?? []).join(",").replace(/export \{|\}/g, "").split(",")
        .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()).filter(Boolean));
    };
    // The declarations a Node ESM consumer gets for each specifier.
    const sdkTypes = {
      "@buildonspark/spark-sdk": await exported(sdkPkg.exports["."].import.node.types),
      "@buildonspark/spark-sdk/types": await exported(sdkPkg.exports["./types"].import.types),
    };
    const problems = [];
    let seen = 0;
    for (const m of dts.matchAll(/^(import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/gm)) {
      const [, kind, typeOnly, list, from] = m;
      if (!typeOnly) problems.push(`${kind} from "${from}" is not type-only`);
      for (const name of list.split(",").map((s) => s.trim()).filter(Boolean)) {
        seen++;
        if (sdkTypes[from]) {
          if (!sdkTypes[from].has(name)) problems.push(`${from} has no type ${name} (installed SDK)`);
        } else if (from === "../../../lib/index.js") {
          if (!new RegExp(`^export (?:declare )?(?:class|interface|type|function|const) ${name}\\b`, "m").test(libDts)) problems.push(`lib/index.d.ts has no ${name}`);
        } else problems.push(`unexpected import source ${from}`);
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(problems).toEqual([]);
    expect(dts).not.toMatch(/^import (?!type\b)/m);
  });
});

describe("lib/index.d.ts: the error contract's types", () => {
  it("AgentErrorCode is exactly the registry's codes; StatusProblemCode is STATUS_PROBLEMS, in severity order", () => {
    expect([...errorCodes].sort()).toEqual(Object.keys(AGENT_ERRORS).sort());
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
    expect(problemCodes).toEqual(Object.keys(STATUS_PROBLEMS));
    expect(unionOf(libDts, "Retryable")).toEqual([...RETRYABLE_VALUES]);
  });

  it("keeps every code that predates the contract, all UPPER_SNAKE", () => {
    expect(errorCodes).toEqual(expect.arrayContaining(EXISTING_CODES));
    for (const c of [...errorCodes, ...problemCodes]) expect(c).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  });

  it("has every code the sources raise or compare against", async () => {
    const libFiles = (await readdir(join(ROOT, "lib"))).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`);
    const union = new Set(errorCodes);
    const problems = [];
    let raisedCount = 0;
    for (const f of [...libFiles, AGENT_JS_PATH, "skills/sparkbtcbot/scripts/leaf-vault.js"]) {
      const text = (await readFile(join(ROOT, f), "utf8")).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      for (const c of codesRaised(text)) {
        raisedCount++;
        if (!union.has(c)) problems.push(`${f} raises ${c}`);
      }
      for (const m of text.matchAll(/\bcode\s*[!=]==?\s*"([A-Z][A-Z0-9_]*[A-Z0-9])"/g)) {
        if (!union.has(m[1]) && !OS_CODES.has(m[1])) problems.push(`${f} compares against ${m[1]}`);
      }
    }
    expect(raisedCount).toBeGreaterThan(60);
    // status() problems: what it adds, and what #budgetStatus hands it
    const statusText = ["status", "#budgetStatus"].map((n) => units.get(n).text).join("\n");
    const added = [...statusText.matchAll(/problems\.add\("([A-Z][A-Z0-9_]*[A-Z0-9])"\)/g), ...statusText.matchAll(/problem:[^\n]*?"([A-Z][A-Z0-9_]*[A-Z0-9])"/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(8);
    for (const c of added) if (!problemCodes.includes(c)) problems.push(`status() reports ${c}`);
    expect(problems).toEqual([]);
  });

  it("declares every export of lib/index.js, and nothing it doesn't export", () => {
    const declaredValues = [...libDts.matchAll(/^export (?:declare )?(?:function|const|class|let) (\w+)/gm)].map((m) => m[1]);
    const runtime = Object.keys(libModule);
    expect(runtime.filter((n) => !declaredValues.includes(n)), "exported, not declared").toEqual([]);
    expect([...new Set(declaredValues)].filter((n) => !runtime.includes(n)), "declared, not exported").toEqual([]);
  });

  it("AgentError carries the contract fields; PaymentCommittedError is always check-first with a nextStep", () => {
    const agentError = libDts.match(/export interface AgentError<[^>]*> extends Error \{([\s\S]*?)\n\}/)?.[1].replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(agentError).toBeDefined();
    for (const k of ["code", "retryable", "nextStep"]) expect(agentError).toMatch(new RegExp(`^\\s*${k}:`, "m"));
    for (const k of ["field", "osCode", "sendId", "invoiceHash", "reason"]) expect(agentError).toMatch(new RegExp(`^\\s*${k}\\?:`, "m"));
    const pce = libDts.match(/export class PaymentCommittedError extends Error implements AgentError<"PAYMENT_COMMITTED"> \{([\s\S]*?)\n\}/)?.[1];
    expect(pce).toBeDefined();
    expect(pce).toMatch(/^\s*code: "PAYMENT_COMMITTED";/m);
    expect(pce).toMatch(/^\s*retryable: "check-first";/m);
    expect(pce).toMatch(/^\s*nextStep: string;/m);
    // every reason the code sets is in the declared union
    const declared = pce.match(/reason\?:([^;]*);/)[1];
    const set = new Set([...agentJs.matchAll(/\breason(?: =|:)\s*"([A-Z][A-Z0-9_]*[A-Z0-9])"/g)].map((m) => m[1]));
    expect(set.size).toBeGreaterThanOrEqual(6);
    for (const r of set) expect(declared, r).toContain(`"${r}"`);
  });

  it("uses only erasable syntax: string unions, no enums or namespaces", () => {
    for (const text of [dts, libDts]) expect(text).not.toMatch(/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:enum|namespace|module)\s/m);
  });
});

// Node's own type stripping (the default from Node 22.18) refuses invalid or
// non-erasable TypeScript. A .d.ts is all ambient, so it strips to nothing
// once each top-level value declaration says `declare` (which a .d.ts
// implies). In a child process: vitest would transpile the file itself.
describe.skipIf(!process.features?.typescript)("the declarations parse under Node's type stripping", () => {
  it.each([DTS_PATH, LIB_DTS_PATH])("%s", async (rel) => {
    const dir = await mkdtemp(join(tmpdir(), "dts-strip-"));
    try {
      const text = (await readFile(join(ROOT, rel), "utf8")).replace(/^export (function|const|class|let) /gm, "export declare $1 ");
      const probe = join(dir, "probe.mts");
      await writeFile(probe, text);
      await promisify(execFile)(process.execPath, [probe], { cwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
