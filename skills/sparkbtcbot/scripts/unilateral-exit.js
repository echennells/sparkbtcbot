// Unilateral exit — recover Spark funds to L1 with NO operators, using only the
// leaf-vault backup (scripts/leaf-vault.js) and an external L1 fee UTXO for CPFP.
// This is the companion to the leaf-vault: the vault BACKS UP the pre-signed exit
// txs; this tool BROADCASTS them. It never contacts the Spark operators — the exit
// chain is rebuilt offline from the vault.
//
// Flow per leaf: rebuild the leaf->root chain offline -> constructUnilateralExit-
// FeeBumpPackages -> for each package broadcast the (pre-signed, 0-fee) tx with a
// CPFP child that pays the fee from your external UTXO -> wait the refund's CSV
// timelock -> broadcast the refund -> funds land on L1.
//
// Config (env):
//   SPARK_BITCOIN_RPC_URL     bitcoind JSON-RPC base URL (e.g. http://127.0.0.1:8332)  [required]
//   SPARK_BITCOIN_RPC_USER    RPC username
//   SPARK_BITCOIN_RPC_PASS    RPC password
//   SPARK_BITCOIN_RPC_WALLET  wallet name for wallet RPCs (auto-fund / mining)
//   SPARK_NETWORK             MAINNET (default) | REGTEST | TESTNET | SIGNET | LOCAL
//   SPARK_LEAF_VAULT_PATH     vault file (default ~/.spark/leaf-vault/current.json)
//   SPARK_EXIT_FEE_PRIVKEY    hex privkey whose P2WPKH address holds a funded UTXO for CPFP fees
//   SPARK_EXIT_FEERATE        target sat/vByte for the CPFP bump (default 2)
//   SPARK_EXIT_REGTEST_MINE   "true" to mine blocks + use generateblock (regtest/devnet testing only)
// CLI: `node unilateral-exit.js [--dry-run]`
import { buildUnilateralExitChain, constructUnilateralExitFeeBumpPackages, getP2WPKHAddressFromPublicKey, Network } from "@buildonspark/spark-sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Transaction } from "@scure/btc-signer";
import { readVault, validateSnapshotShape } from "../../../lib/leaf-vault.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const { TreeNode } = await import(
  pathToFileURL(join(dirname(require.resolve("@buildonspark/spark-sdk")), "proto", "spark.js")).href
);
const decodeNode = (hex) => TreeNode.decode(Uint8Array.from(Buffer.from(hex, "hex")));
const toHex = (u) => Buffer.from(u).toString("hex");
const parseRaw = (h) => Transaction.fromRaw(Buffer.from(h, "hex"), { allowUnknownInputs: true, allowUnknownOutputs: true });

export function loadConfig(env = process.env, argv = process.argv) {
  const cfg = {
    vaultPath: env.SPARK_LEAF_VAULT_PATH || join(homedir(), ".spark", "leaf-vault", "current.json"),
    network: (env.SPARK_NETWORK || "MAINNET").toUpperCase(),
    rpcUrl: env.SPARK_BITCOIN_RPC_URL,
    rpcUser: env.SPARK_BITCOIN_RPC_USER,
    rpcPass: env.SPARK_BITCOIN_RPC_PASS,
    rpcWallet: env.SPARK_BITCOIN_RPC_WALLET || null,
    feePrivkeyHex: env.SPARK_EXIT_FEE_PRIVKEY || null,
    feeRate: Number(env.SPARK_EXIT_FEERATE || 2),
    regtestMine: env.SPARK_EXIT_REGTEST_MINE === "true",
    dryRun: argv.includes("--dry-run"),
  };
  if (cfg.regtestMine && !cfg.rpcWallet) cfg.rpcWallet = "default"; // wallet needed for auto-fund/mining
  if (Network[cfg.network] === undefined) throw new Error(`unknown SPARK_NETWORK ${cfg.network}`);
  return cfg;
}

function makeRpc(cfg) {
  const base = (cfg.rpcUrl || "").replace(/\/$/, "");
  return async function btc(method, params = []) {
    const url = cfg.rpcWallet ? `${base}/wallet/${cfg.rpcWallet}` : base;
    const headers = { "content-type": "text/plain" };
    if (cfg.rpcUser) headers.authorization = "Basic " + Buffer.from(`${cfg.rpcUser}:${cfg.rpcPass}`).toString("base64");
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "1.0", id: "exit", method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`bitcoind ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  };
}

// Partially sign a CPFP fee-bump PSBT with the fee-UTXO key; the parent's keyless
// P2A anchor input is finalized by bitcoind. Returns a base64 PSBT.
export function partialSignFeeBump(psbtHex, priv) {
  const tx = Transaction.fromPSBT(Buffer.from(psbtHex, "hex"), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
  tx.sign(priv);
  return Buffer.from(tx.toPSBT()).toString("base64");
}

async function resolveFeeUtxo(cfg, btc) {
  if (cfg.feePrivkeyHex) {
    const priv = Uint8Array.from(Buffer.from(cfg.feePrivkeyHex, "hex"));
    const pub = secp256k1.getPublicKey(priv, true);
    const addr = getP2WPKHAddressFromPublicKey(pub, Network[cfg.network]);
    const scan = await btc("scantxoutset", ["start", [`addr(${addr})`]]);
    const u = (scan.unspents || []).sort((a, b) => b.amount - a.amount)[0];
    if (!u) throw new Error(`no UTXO at fee address ${addr} — fund it first (needs to cover the CPFP fee)`);
    return { priv, utxo: { txid: u.txid, vout: u.vout, value: BigInt(Math.round(u.amount * 1e8)), script: u.scriptPubKey, publicKey: toHex(pub) } };
  }
  if (cfg.regtestMine) {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, true);
    const addr = getP2WPKHAddressFromPublicKey(pub, Network[cfg.network]);
    const txid = await btc("sendtoaddress", [addr, 0.001]);
    await mineBlocks(cfg, btc, 1);
    const raw = await btc("getrawtransaction", [txid, true]);
    const o = raw.vout.find((v) => v.scriptPubKey?.address === addr);
    return { priv, utxo: { txid, vout: o.n, value: BigInt(Math.round(o.value * 1e8)), script: o.scriptPubKey.hex, publicKey: toHex(pub) } };
  }
  throw new Error("no fee UTXO: set SPARK_EXIT_FEE_PRIVKEY (hex) to a key whose P2WPKH address holds a funded UTXO for CPFP fees");
}

async function mineBlocks(cfg, btc, n) {
  const addr = await btc("getnewaddress", ["", "bech32"]);
  return btc("generatetoaddress", [n, addr]);
}

async function waitForHeight(cfg, btc, target) {
  if (cfg.regtestMine) {
    const cur = await btc("getblockcount");
    if (target > cur) await mineBlocks(cfg, btc, target - cur + 1);
    return;
  }
  for (;;) {
    const cur = await btc("getblockcount");
    if (cur >= target) return;
    console.log(`   waiting for CSV: height ${cur}/${target} (~${target - cur} blocks) — this can take a while on mainnet`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function broadcastPackage(cfg, btc, parentHex, childHex) {
  const txs = childHex ? [parentHex, childHex] : [parentHex];
  if (cfg.regtestMine) {
    const addr = await btc("getnewaddress", ["", "bech32"]);
    return btc("generateblock", [addr, txs]); // consensus-checked, bypasses dust relay policy on regtest
  }
  return btc("submitpackage", [txs]);
}

export async function runUnilateralExit(cfg = loadConfig()) {
  if (!cfg.rpcUrl) throw new Error("set SPARK_BITCOIN_RPC_URL (and _USER/_PASS) to a bitcoind you can broadcast from");
  const btc = makeRpc(cfg);

  const vault = await readVault(cfg.vaultPath);
  const shape = validateSnapshotShape(vault);
  if (!shape.ok) throw new Error(`vault invalid (${shape.reason}) — cannot exit`);
  if (vault.leafIds.length === 0) { console.log("vault is empty (no leaves) — nothing to exit."); return { exited: 0 }; }
  console.log(`vault: ${vault.leafIds.length} leaf/leaves, network ${vault.network}, updated ${vault.updatedAt}`);

  const info = await btc("getblockchaininfo");
  console.log(`bitcoind: ${info.chain}, height ${info.blocks}${cfg.dryRun ? "  [DRY RUN]" : ""}`);

  // Rebuild every leaf's chain OFFLINE (no operators) and collect node protobuf hexes.
  const reMap = new Map(vault.nodes.map((n) => [n.id, decodeNode(n.hex)]));
  const hexById = new Map(vault.nodes.map((n) => [n.id, n.hex]));
  const nodeHexStrings = [];
  for (const leafId of vault.leafIds) {
    const chain = await buildUnilateralExitChain(reMap.get(leafId), reMap, undefined, undefined);
    if (!chain.length) throw new Error(`leaf ${leafId} does not reconstruct offline — vault is incomplete`);
    for (const n of chain) if (!nodeHexStrings.includes(hexById.get(n.id))) nodeHexStrings.push(hexById.get(n.id));
  }
  console.log(`reconstructed ${vault.leafIds.length} exit chain(s) offline — operators NOT contacted`);

  const { priv, utxo } = await resolveFeeUtxo(cfg, btc);
  console.log(`fee UTXO ${utxo.txid.slice(0, 12)}:${utxo.vout} (${utxo.value} sats) @ ${cfg.feeRate} sat/vB`);

  const chains = await constructUnilateralExitFeeBumpPackages(nodeHexStrings, [utxo], { satPerVbyte: cfg.feeRate }, Network[cfg.network]);
  console.log(`built ${chains.length} fee-bump chain(s), ${chains.reduce((s, c) => s + c.txPackages.length, 0)} package(s)`);

  if (cfg.dryRun) {
    for (const c of chains) {
      console.log(`  leaf ${c.leafId?.slice(0, 12)}: ${c.txPackages.length} package(s) — ` +
        c.txPackages.map((p) => `${parseRaw(p.tx).id.slice(0, 10)}${p.feeBumpPsbt ? "+cpfp" : ""}`).join(" -> "));
    }
    console.log("DRY RUN — nothing broadcast.");
    return { exited: 0, chains: chains.length, dryRun: true };
  }

  for (const c of chains) {
    for (let i = 0; i < c.txPackages.length; i++) {
      const p = c.txPackages[i];
      const parent = parseRaw(p.tx);
      // Packages after the first spend a CSV-timelocked output of the prior tx.
      if (i > 0) {
        const csv = parent.getInput(0).sequence & 0x0000ffff;
        const target = (await btc("getblockcount")) + csv;
        console.log(`  leaf ${c.leafId.slice(0, 12)} pkg[${i}]: CSV ${csv} blocks -> waiting for height ${target}`);
        await waitForHeight(cfg, btc, target);
      }
      let childHex = null;
      if (p.feeBumpPsbt) {
        const fin = await btc("finalizepsbt", [partialSignFeeBump(p.feeBumpPsbt, priv)]);
        if (!fin.complete) throw new Error(`could not finalize CPFP child for ${c.leafId} pkg[${i}]`);
        childHex = fin.hex;
      }
      const res = await broadcastPackage(cfg, btc, p.tx, childHex);
      console.log(`  leaf ${c.leafId.slice(0, 12)} pkg[${i}] ${parent.id.slice(0, 12)} -> ${JSON.stringify(res).slice(0, 120)}`);
      if (cfg.regtestMine) await mineBlocks(cfg, btc, 1);
    }
  }
  console.log("✅ unilateral exit broadcast complete — funds recovering to L1.");
  return { exited: chains.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUnilateralExit().catch((e) => { console.error("unilateral-exit ERROR:", e?.message || e); process.exit(1); });
}
