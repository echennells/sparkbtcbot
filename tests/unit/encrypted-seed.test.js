import { describe, it, expect, afterEach } from "vitest";
import { saveEncryptedMnemonic, loadMnemonic } from "../../lib/encrypted-seed.js";
import { rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const SAMPLE = "gift monkey author panel east casual sudden surface talent all broken lonely";
const STRONG_PP = "correct horse battery staple pikachu";

let toCleanUp = [];
afterEach(() => {
  for (const p of toCleanUp) {
    try { rmSync(p); } catch {}
  }
  toCleanUp = [];
});

function tmp(name) {
  const path = `${tmpdir()}/spark-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  toCleanUp.push(path);
  return path;
}

describe("encrypted-seed", () => {
  it("round-trips a mnemonic", async () => {
    const path = tmp("roundtrip.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path });
    const got = await loadMnemonic({ passphrase: STRONG_PP, path });
    expect(got).toBe(SAMPLE);
  }, 30_000);

  it("writes mode 0600 on the encrypted file", async () => {
    const path = tmp("perms.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  it("rejects passphrases shorter than 12 characters", async () => {
    const path = tmp("short.enc");
    await expect(
      saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: "tooshort", path }),
    ).rejects.toThrow(/at least 12/);
  });

  it("rejects empty mnemonic", async () => {
    const path = tmp("empty.enc");
    await expect(
      saveEncryptedMnemonic({ mnemonic: "", passphrase: STRONG_PP, path }),
    ).rejects.toThrow(/non-empty/);
  });

  it("returns NO_SEED when file is missing", async () => {
    const path = tmp("missing.enc");
    await expect(
      loadMnemonic({ passphrase: STRONG_PP, path }),
    ).rejects.toMatchObject({ code: "NO_SEED" });
  });

  it("returns BAD_PASSPHRASE when passphrase is wrong", async () => {
    const path = tmp("bad-pp.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path });
    await expect(
      loadMnemonic({ passphrase: "totallydifferent", path }),
    ).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
  }, 30_000);

  it("uses a different ciphertext on each save (random salt + iv)", async () => {
    const path1 = tmp("rand-1.enc");
    const path2 = tmp("rand-2.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path: path1 });
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path: path2 });
    const a = readFileSync(path1);
    const b = readFileSync(path2);
    expect(a.equals(b)).toBe(false);
  }, 60_000);

  it("rejects a corrupted file", async () => {
    const path = tmp("corrupt.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path });
    // Flip a byte in the ciphertext region (after the 48-byte header)
    const buf = readFileSync(path);
    buf[60] ^= 0xff;
    await import("node:fs/promises").then((fs) => fs.writeFile(path, buf));
    await expect(
      loadMnemonic({ passphrase: STRONG_PP, path }),
    ).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
  }, 30_000);

  it("file format starts with the version byte 0x01", async () => {
    const path = tmp("version.enc");
    await saveEncryptedMnemonic({ mnemonic: SAMPLE, passphrase: STRONG_PP, path });
    const buf = readFileSync(path);
    expect(buf[0]).toBe(0x01); // version
    expect(buf[1]).toBe(0x01); // kdf = scrypt
    expect(buf[2]).toBe(0x01); // cipher = aes-256-gcm
  }, 30_000);
});
