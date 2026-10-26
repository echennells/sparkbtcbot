// fetchL402 against a real L402 server on hosted REGTEST: the scenarios in
// tests/helpers/l402-regtest-scenarios.mjs (an ordinary purchase, delivery
// failing in transit then recovered, a refused pass and forgetL402, a POST
// re-sent only with resend and the same body, a token about to die, an
// invoice already expired, the budget counting each purchase once, and the
// shop's view). The server needs HTTPS (fetchL402 refuses anything else), so
// this makes a throwaway localhost certificate and runs the scenarios in a
// child process that trusts it. Needs the funded mnemonic and openssl; costs
// a few hundred REGTEST sats, which the shop wallet sends back.
import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFundedMnemonic } from "../../helpers/wallet.js";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeIt = getFundedMnemonic() && hasOpenssl ? describe : describe.skip;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../helpers/l402-regtest-scenarios.mjs");

describeIt("fetchL402 against a local L402 server (REGTEST, real payments)", () => {
  it("every scenario passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l402-cert-"));
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE",
      ], { stdio: "ignore" });
      const { code, out } = await new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT], {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"), L402_TEST_CERT_DIR: dir },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        child.on("close", (c) => resolve({ code: c, out }));
      });
      const lines = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
      const failed = lines.filter((l) => l.check && !l.ok);
      expect(failed, out.slice(-2_000)).toEqual([]);
      expect(lines.at(-1)?.summary, out.slice(-2_000)).toMatch(/^15\/15 passed$/);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 480_000);
});
