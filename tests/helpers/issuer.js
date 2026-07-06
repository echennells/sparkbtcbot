import { IssuerSparkWallet } from "@buildonspark/issuer-sdk";

const NETWORK = "REGTEST";

const trackedIssuers = new Set();

// Initializes an IssuerSparkWallet on REGTEST. If the wallet doesn't yet have
// an issued token, creates one (Spark allows one token per wallet per the
// issuance rules). Returns { wallet, tokenId, alreadyExisted }. Idempotent
// across runs — running this twice with the same mnemonic returns the same
// tokenId on the second call.
export async function getOrCreateIssuerToken({
  mnemonic,
  tokenName = "RegtestTest",
  tokenTicker = "RTEST",
  decimals = 6,
  maxSupply = 1_000_000_000_000n,
}) {
  const { wallet } = await IssuerSparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network: NETWORK },
  });
  trackedIssuers.add(wallet);

  let tokenId;
  try {
    tokenId = await wallet.getIssuerTokenIdentifier();
  } catch {
    // Throws when no token has been issued yet.
  }

  if (tokenId) {
    return { wallet, tokenId, alreadyExisted: true };
  }

  await wallet.createToken({
    tokenName,
    tokenTicker: tokenTicker.slice(0, 6).toUpperCase(),
    maxSupply,
    decimals,
    isFreezeable: false,
  });

  tokenId = await wallet.getIssuerTokenIdentifier();
  return { wallet, tokenId, alreadyExisted: false };
}

// Mints `amount` units to the issuer wallet so subsequent transferTokens calls
// have supply to draw from. Spark tokens are 6-decimal by default; 1000 units
// = 0.001 token at 6 decimals, which is plenty for a transfer test.
export async function mintTo(issuerWallet, amount = 1_000n) {
  const tokenIdentifier = await issuerWallet.getIssuerTokenIdentifier();
  return await issuerWallet.mintTokens({ tokenAmount: amount, tokenIdentifier });
}

export async function cleanupAllIssuers() {
  for (const w of trackedIssuers) {
    try {
      await w.cleanup();
    } catch {}
  }
  trackedIssuers.clear();
}
