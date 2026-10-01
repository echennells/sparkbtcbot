// Token amounts in the two forms this project uses, converted exactly. Every
// value is a decimal string or a bigint, never a float.
//   human:      "25.5" — what an operator writes in tokenLimits and reads back
//   base units: 25500000n — what the SDK moves and the ledger counts (for a
//               6-decimal token)
// A token's decimals come from its metadata, which the wallet has for every
// token it holds (and it can only send a token it holds). SDK-free.

const HUMAN_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

// Normalize a positive human amount ("25.00" → "25", "0.50" → "0.5"). Takes a
// decimal string or a finite JSON number; refuses exponents, signs, zero.
export function parseHumanAmount(value) {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !HUMAN_RE.test(raw.trim())) return null;
  let [int, frac = ""] = raw.trim().split(".");
  frac = frac.replace(/0+$/, "");
  int = int.replace(/^0+(?=\d)/, "");
  if (/^0*$/.test(int) && frac === "") return null; // zero
  return frac ? `${int}.${frac}` : int;
}

// Base units for a human amount at `decimals`. Returns null when the amount has
// more decimal places than the token does: there is no exact conversion, and a
// limit must never be rounded into something the operator didn't write.
export function toBaseUnits(human, decimals) {
  if (!Number.isSafeInteger(decimals) || decimals < 0) return null;
  const [int, frac = ""] = String(human).split(".");
  if (frac.length > decimals) return null;
  return BigInt(int + frac.padEnd(decimals, "0"));
}

// The human form of a base-unit amount (bigint, or a decimal string).
export function formatUnits(baseUnits, decimals) {
  const s = BigInt(baseUnits).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return s;
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
