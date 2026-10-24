// Funds the e2e wallet from the shared REGTEST test wallet: sats + SKILL tokens.
import dotenv from "dotenv";
dotenv.config({ path: "/workspace/.env" });
import { SparkWallet } from "@buildonspark/spark-sdk";
import { IssuerSparkWallet } from "@buildonspark/issuer-sdk";
const [to, sats, tokens] = process.argv.slice(2);
const opts = { network: "REGTEST", optimizationOptions: { auto: false } };
const m = process.env.SPARK_TEST_MNEMONIC.trim();
const { wallet: issuer } = await IssuerSparkWallet.initialize({ mnemonicOrSeed: m, options: opts });
const tokenId = await issuer.getIssuerTokenIdentifier();
await issuer.mintTokens({ tokenAmount: BigInt(tokens), tokenIdentifier: tokenId });
await issuer.transferTokens({ tokenIdentifier: tokenId, tokenAmount: BigInt(tokens), receiverSparkAddress: to });
await issuer.cleanup();
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: m, options: opts });
await wallet.transfer({ receiverSparkAddress: to, amountSats: Number(sats) });
const back = await wallet.getSparkAddress();
await wallet.cleanup();
console.log(JSON.stringify({ tokenId, fundedAddress: back }));
