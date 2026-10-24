import os, pty, sys, time, select
dir, args = sys.argv[1], sys.argv[2:]
env = dict(os.environ, SPARK_SEED_PATH=f"{dir}/seed.enc", SPARK_SPEND_LEDGER_PATH=f"{dir}/ledger.json")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(dir)
    os.execvpe("node", ["node", "/workspace/skills/sparkbtcbot/scripts/set-policy.js", *args], env)
out = b""
def read_until(pat, timeout=20):
    global out
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: chunk = os.read(fd, 4096)
            except OSError: return False
            if not chunk: return False
            out += chunk
            if pat.encode() in out: return True
    return False
if read_until("Passphrase"):
    os.write(fd, b"correct horse battery staple\r")
    if read_until("Type 'yes'"):
        os.write(fd, b"yes\r")
read_until("\x00", timeout=10)  # drain to exit
_, status = os.waitpid(pid, 0)
print(out.decode(errors="replace").replace("\r", ""))
print("EXIT:", os.waitstatus_to_exitcode(status))
