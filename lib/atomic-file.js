// The one reviewed atomic file writer for everything this skill persists —
// recovery bundles, seed.enc, mnemonic backup files. Crash-safe and
// concurrency-safe by construction:
//
//   UNIQUE temp (pid + random) opened O_EXCL ("wx") → write → chmod → fsync
//   → close → atomic publish → parent-directory fsync.
//
// The unique O_EXCL temp matters under concurrency: concurrent writers (boot +
// event + timer snapshots in one process, or two processes) must never share an
// inode, or one writer's O_TRUNC corrupts the other mid-write and a rename
// publishes spliced bytes (H-3). The chmod on the open handle gives the exact
// mode regardless of umask, with no post-publish window. The directory fsync
// makes the publish durable — the file fsync alone does not persist the new
// directory entry across power loss.
//
// Publish modes:
//   exclusive: false (default) — rename(2): atomically REPLACE whatever is at
//     `path`. For data that is continuously refreshed (the leaf-vault bundle).
//   exclusive: true — link(2): atomically create-or-EEXIST, NEVER replace. This
//     is a kernel-atomic exclusivity gate with no check-then-act window — two
//     concurrent creators cannot both win, so a wallet's only encrypted backup
//     cannot be silently swapped. On filesystems without hard links
//     (EPERM/ENOTSUP/EXDEV/EINVAL) it falls back to an access() pre-check +
//     rename, accepting a small TOCTOU window there.
//
// Any failure best-effort unlinks the temp: a stray .tmp must never accumulate,
// and a partial file must never sit at the destination path.
import { open, rename, unlink, link, access } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWriteFile(path, data, { mode = 0o600, exclusive = false } = {}) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fh = null;
  try {
    fh = await open(tmp, "wx", mode); // wx = O_CREAT|O_EXCL|O_WRONLY — unique inode per call
    await fh.writeFile(data);
    await fh.chmod(mode); // exact mode regardless of umask
    await fh.sync();
    await fh.close();
    fh = null;
    if (exclusive) {
      try {
        await link(tmp, path); // kernel-atomic: EEXIST if path exists, never replaces
      } catch (err) {
        if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"].includes(err?.code)) throw err;
        await assertAbsent(path); // no hard links here — precheck+rename fallback
        await rename(tmp, path);
      }
    } else {
      await rename(tmp, path); // atomic commit point
    }
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* the unlink below is what matters */ } }
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await unlink(tmp).catch(() => {}); // link(2) leaves the temp name; after rename this is a no-op
  try {
    const dh = await open(dirname(path), "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* some platforms/filesystems reject directory fsync — best-effort */ }
  return path;
}

async function assertAbsent(path) {
  try {
    await access(path);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const e = new Error(`EEXIST: file already exists, ${path}`);
  e.code = "EEXIST";
  throw e;
}
