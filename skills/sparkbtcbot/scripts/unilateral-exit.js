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
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Transaction } from "@scure/btc-signer";
import { readVault, validateSnapshotShape } from "../../../lib/leaf-vault.js";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

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
  // A test-only flag (generateblock + throwaway in-memory keys) must never touch a
  // real network — on MAINNET the regtest fee path sends real BTC to a discarded key.
  if (cfg.regtestMine && !["REGTEST", "LOCAL"].includes(cfg.network)) {
    throw new Error(`SPARK_EXIT_REGTEST_MINE is regtest-only; refusing to use it on ${cfg.network}. Unset it and set SPARK_EXIT_FEE_PRIVKEY for a real broadcast.`);
  }
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

// Confirmation height of a tx output via gettxout (no txindex needed): while the
// tx sits in the mempool gettxout reports confirmations 0; once mined, >=1. On
// regtest we mine to force it. Returns the height the tx confirmed at.
async function waitForConfirmation(cfg, btc, txid, vout = 0) {
  for (;;) {
    const out = await btc("gettxout", [txid, vout]).catch(() => null);
    if (out && out.confirmations >= 1) {
      const tip = await btc("getblockcount");
      return tip - out.confirmations + 1;
    }
    if (cfg.regtestMine) { await mineBlocks(cfg, btc, 1); continue; }
    console.log(`   waiting for ${txid.slice(0, 12)} to confirm…`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// Confirmation height of the output an input spends — used only on a re-run where
// an earlier package already confirmed. Byte-order-agnostic (tries the txid both
// reversed and as-is) so it doesn't depend on the signer lib's internal ordering.
async function confHeightOfInput(cfg, btc, inp) {
  const vout = inp.index ?? 0;
  for (const txid of [Buffer.from(inp.txid).reverse().toString("hex"), Buffer.from(inp.txid).toString("hex")]) {
    if (await btc("gettxout", [txid, vout]).catch(() => null)) return waitForConfirmation(cfg, btc, txid, vout);
  }
  throw new Error("could not locate the prevout of a timelocked input to measure its confirmation height");
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

  // Warn if the CPFP fee rate is below what the node will even relay — the exit's
  // node txs are 0-fee, so an underpriced child silently gates confirmation, and an
  // operators-offline event may coincide with an L1 fee spike (everyone exiting).
  try {
    const minRate = (await btc("getmempoolinfo"))?.mempoolminfee;
    const minSatVb = minRate ? minRate * 1e5 : 0; // BTC/kvB -> sat/vB
    if (minSatVb > cfg.feeRate) console.log(`⚠️  fee rate ${cfg.feeRate} sat/vB is BELOW this node's mempool minimum (${minSatVb.toFixed(2)} sat/vB) — packages may be rejected. Raise SPARK_EXIT_FEERATE.`);
  } catch { /* getmempoolinfo unavailable — skip the advisory */ }

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

  // BIP68 relative-timelock bit layout (encoded in the input sequence).
  const CSV_DISABLE = 0x80000000, CSV_TYPE_SECONDS = 0x00400000, CSV_VALUE = 0x0000ffff;
  for (const c of chains) {
    let prevConfHeight = null; // confirmation height of the package we last broadcast
    for (let i = 0; i < c.txPackages.length; i++) {
      const p = c.txPackages[i];
      const parent = parseRaw(p.tx);
      const inp = parent.getInput(0);
      const seq = (inp.sequence ?? 0) >>> 0;
      // A BIP68 relative timelock matures at the SPENT output's CONFIRMATION height
      // + csv — NOT the current tip. The old code sampled the tip at broadcast time,
      // so on mainnet (parent still unconfirmed in the mempool) it waited too few
      // blocks and the refund was rejected non-BIP68-final. Regtest's generateblock
      // confirmed each package immediately, which is exactly why this stayed hidden.
      if (!(seq & CSV_DISABLE) && (seq & CSV_VALUE) > 0) {
        if (seq & CSV_TYPE_SECONDS) throw new Error(`leaf ${c.leafId}: refund uses a time-based (512s) BIP68 timelock; this tool supports block-based CSV only`);
        const csv = seq & CSV_VALUE;
        const confH = prevConfHeight ?? await confHeightOfInput(cfg, btc, inp); // re-run: look up the prevout
        const target = confH + csv;
        console.log(`  leaf ${c.leafId.slice(0, 12)} pkg[${i}]: CSV ${csv} from conf height ${confH} -> waiting for height ${target}`);
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
      // Wait for THIS package to confirm so the next stage's CSV is measured from
      // its real confirmation height (mainnet: poll; regtest: generateblock already
      // confirmed it, so this returns immediately).
      if (i < c.txPackages.length - 1) prevConfHeight = await waitForConfirmation(cfg, btc, parent.id, 0);
    }
  }
  console.log("✅ unilateral exit broadcast complete — funds recovering to L1.");
  return { exited: chains.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUnilateralExit().catch((e) => { console.error("unilateral-exit ERROR:", e?.message || e); process.exit(1); });
}
