# End-to-end on REGTEST through the shipped entry points, with HOME sandboxed
# so every ~/.spark default is real: setup → fund → set-policy (TTY) →
# --show (TTY) → agent program → reset-ledger (TTY) → agent again → sweep.
import os, pty, sys, time, select, subprocess, json, tempfile
CLI = "/workspace/skills/sparkbtcbot/scripts/cli.js"
E2E = "/workspace/.e2e-tmp"
W = tempfile.mkdtemp(prefix="spark-e2e-")
HOME = os.path.join(W, "home"); os.makedirs(HOME)
PASS = "e2e regtest passphrase 1234"
pf = os.path.join(W, "pass"); open(pf, "w").write(PASS + "\n"); os.chmod(pf, 0o600)
ENV = {"PATH": os.environ["PATH"], "HOME": HOME, "SPARK_NETWORK": "REGTEST", "SPARK_PASSPHRASE_FILE": pf}

def run(args, **kw):
    r = subprocess.run(["node", *args], cwd=W, env=ENV, capture_output=True, text=True, timeout=300, **kw)
    return r.returncode, r.stdout, r.stderr

def tty(args, answers):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(W); os.execvpe("node", ["node", *args], ENV)
    out = b""
    def until(pat, t=60):
        nonlocal out
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try: c = os.read(fd, 4096)
                except OSError: return False
                if not c: return False
                out += c
                if pat.encode() in out: return True
        return False
    for pat, ans in answers:
        if not until(pat): break
        os.write(fd, (ans + "\r").encode())
    until("\x00", 20)
    _, st = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(st), out.decode(errors="replace").replace("\r", "")

def section(t): print(f"\n===== {t}")

section("1. sparkbtcbot setup (fresh wallet, REGTEST, passphrase from file)")
code, so, se = run([CLI, "setup"])
print("exit", code); print("\n".join(l for l in (so + se).splitlines() if "sparkrt1" in l or "seed" in l.lower() or "privacy" in l.lower())[:800])
addr = next((w.strip(".,") for l in (so + se).splitlines() for w in l.split() if w.startswith("sparkrt1")), None)
print("address:", addr, "| seed.enc exists:", os.path.exists(os.path.join(HOME, ".spark", "seed.enc")))
assert code == 0 and addr

section("2. fund it: 8,000 sats + 20,000 SKILL base units")
code, so, se = run([f"{E2E}/fund.mjs", addr, "8000", "20000"])
print("exit", code, so.strip()[-300:], se.strip()[-300:] if code else "")
info = json.loads(so.strip().splitlines()[-1]); tok = info["tokenId"]; funded = info["fundedAddress"]

section("3. sparkbtcbot set-policy --file (real TTY ceremony)")
pol = os.path.join(W, "policy.json")
json.dump({"dailyBudgetSats": 3000, "maxPerTxSats": 2000, "tokenLimits": {tok: {"maxPerTx": "0.005", "dailyBudget": "0.008"}}}, open(pol, "w"))
code, o = tty([CLI, "set-policy", "--file", pol], [("Passphrase", PASS), ("Type 'yes'", "yes")])
print("exit", code); print("\n".join(l for l in o.splitlines() if l.strip() and "Passphrase" not in l)[-700:])

section("4. sparkbtcbot set-policy --show")
code, o = tty([CLI, "set-policy", "--show"], [("Passphrase", PASS)])
print("exit", code); print(o.split("Current sealed policy:")[-1].strip()[:600])

section("5. the agent program: limits, invoices, allowlist, audit")
time.sleep(5)
code, so, se = run([f"{E2E}/agent-run.mjs", "limits", tok, funded])
print("exit", code)
for l in so.splitlines():
    if l.startswith("{"): print(l[:400])
if code: print(se[-1500:])

section("6. sparkbtcbot reset-ledger (real TTY ceremony)")
os.remove(os.path.join(HOME, ".spark", "recipients.allow"))
code, o = tty([CLI, "reset-ledger"], [("Passphrase", PASS), ("Type 'yes'", "yes")])
print("exit", code); print("\n".join(l for l in o.splitlines() if "RESET" in l or "Reset." in l))

section("7. the agent again after the reset")
code, so, se = run([f"{E2E}/agent-run.mjs", "after-reset", tok, funded])
for l in so.splitlines():
    if l.startswith("{"): print(l[:400])
if code: print(se[-1500:])

section("8. sweep the e2e wallet back to the funded wallet")
code, so, se = run([f"{E2E}/agent-run.mjs", "sweep", tok, funded])
for l in so.splitlines():
    if l.startswith('{"step":"swept'): print(l)
print("sandbox:", W)
