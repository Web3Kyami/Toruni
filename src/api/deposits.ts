import { getCurrentApiSession, strikeAuthenticatedFetch } from "./builderConnect.ts";
import type { EthereumProvider } from "./walletProvider.ts";
import { parseDepositPlan, parseDepositQuote, SEPOLIA_CHAIN_ID, SEPOLIA_USDC, type DepositPlan } from "../../shared/deposit.ts";

/** Read-only network checks. This never switches networks or sends a wallet transaction. */
export async function checkDepositNetwork(provider: EthereumProvider): Promise<void> {
  const chain = await provider.request({ method: "eth_chainId" });
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(SEPOLIA_CHAIN_ID)) {
    throw new Error("Select Ethereum Sepolia before continuing.");
  }
}

/** Prepares only. The caller must obtain a separate wallet approval for each transaction. */
export async function prepareSepoliaUsdcDeposit(provider: EthereumProvider, assetAmount: string): Promise<DepositPlan> {
  const session = getCurrentApiSession();
  if (!session) throw new Error("Connect your wallet before continuing.");
  await checkDepositNetwork(provider);
  if (!/^[1-9]\d{0,77}$/.test(assetAmount) || BigInt(assetAmount) >= 2n ** 256n) throw new Error("Enter a valid USDC amount.");
  const raw = await strikeAuthenticatedFetch<unknown>("/v2/deposit/quote", "POST", {
    blockchain: "ethereum", asset_symbol: "USDC", asset_amount: assetAmount,
  });
  const quote = parseDepositQuote(raw, { accountId: session.accountId, address: session.address, assetAmount }, Date.now());
  const built = await strikeAuthenticatedFetch<unknown>("/v2/deposit/build-tx", "POST", {
    request_id: quote.requestId, user_address: session.address,
  });
  const plan = parseDepositPlan(built, quote, Date.now());
  await checkDepositNetwork(provider);
  const codes = await Promise.all([SEPOLIA_USDC, quote.depositAddress].map(to =>
    provider.request({ method: "eth_getCode", params: [to, "latest"] })));
  if (codes.some(code => typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code))) {
    throw new Error("Deposit details could not be verified.");
  }
  if (getCurrentApiSession()?.publicKey !== session.publicKey) throw new Error("Wallet access changed. Connect again before continuing.");
  return plan;
}

/** Reports an existing hash to Strike. Pending confirmation is never described as credited collateral. */
export async function confirmDepositSubmission(plan: DepositPlan, txHash: string): Promise<{ status: "pending"; txHash: string }> {
  const session = getCurrentApiSession();
  if (!session || session.accountId !== plan.quote.accountId || session.address.toLowerCase() !== plan.quote.address.toLowerCase()
    || !/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error("Deposit details could not be verified.");
  const result = await strikeAuthenticatedFetch<{ request_id: string; tx_hash: string; status: string }>("/v2/deposit", "POST", {
    request_id: plan.quote.requestId, tx_hash: txHash,
  });
  if (!result || result.request_id !== plan.quote.requestId || typeof result.tx_hash !== "string"
    || result.tx_hash.toLowerCase() !== txHash.toLowerCase() || result.status !== "pending") {
    throw new Error("Check your deposit status before trying again.");
  }
  return { status: "pending", txHash };
}
