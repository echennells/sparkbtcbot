// Scans added lines on stdin for secrets. Flags any run of >=12 BIP39 words
// (labelling the public test phrases), plus key/token/credential patterns.
import { wordlist } from "/workspace/node_modules/@scure/bip39/wordlists/english.js";
const W = new Set(wordlist);
const PUBLIC = [/^(abandon ){11}about$/, /^(zoo ){11}wrong$/, /^(abandon ){23}art$/];
const PAT = {
  hex64: /\b[0-9a-f]{64}\b/gi, macaroon: /\bAgE[A-Za-z0-9+/_-]{30,}/g, anthropic: /sk-ant-[A-Za-z0-9_-]+/g,
  github: /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, slack: /xox[abpr]-[A-Za-z0-9-]+/g, aws: /\bAKIA[0-9A-Z]{16}\b/g,
  pem: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, jwt: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, bearer: /Bearer [A-Za-z0-9._~+/-]{20,}/g,
  urlcred: /https?:\/\/[^\s/:@]+:[^\s/@]+@/g, email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, xprv: /\b[xtz]prv[1-9A-HJ-NP-Za-km-z]{100,}/g,
  wif: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, nsec: /\bnsec1[02-9ac-hj-np-z]{58}\b/g,
};
let file = "", out = [];
for (const line of (await new Promise((r) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => r(d)); })).split("\n")) {
  if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const toks = line.toLowerCase().match(/[a-z]+/g) || [];
  for (let i = 0, run = []; i <= toks.length; i++) {
    if (i < toks.length && W.has(toks[i])) { run.push(toks[i]); continue; }
    if (run.length >= 12) { const p = run.join(" "); out.push(`${PUBLIC.some((r) => r.test(p)) ? "public-test-phrase" : "BIP39-RUN"} ${file}: ${p.slice(0, 60)}…`); }
    run = [];
  }
  for (const [k, re] of Object.entries(PAT)) for (const m of line.matchAll(re)) out.push(`${k} ${file}: ${m[0].slice(0, 20)}…`);
}
console.log(out.length ? [...new Set(out)].join("\n") : "no findings");
