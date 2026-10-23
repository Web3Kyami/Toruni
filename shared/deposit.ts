export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export interface DepositBinding { accountId: string; address: string; assetAmount: string }
export interface DepositQuote {
  requestId: string; accountId: string; address: string; assetAmount: string;
  depositAddress: string; usdValue: string; expiresAt: number; confirmationsRequired: number;
}
export interface DepositTransaction {
  from: string; to: string; data: string; value: "0x0"; chainId: "0xaa36a7"; gas?: string;
}
export interface DepositPlan {
  quote: DepositQuote; transaction: DepositTransaction; approval: DepositTransaction | null;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Deposit details could not be verified.");
  return v as Record<string, unknown>;
};
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error("Deposit details could not be verified.");
}

export function parseDepositQuote(raw: unknown, binding: DepositBinding, now: number): DepositQuote {
  ensure(uuid.test(binding.accountId) && address.test(binding.address)
    && /^[1-9]\d{0,77}$/.test(binding.assetAmount) && BigInt(binding.assetAmount) < 2n ** 256n);
  const response = object(raw), quote = object(response.quote);
  ensure(typeof response.request_id === "string" && uuid.test(response.request_id)
    && quote.request_id === response.request_id && quote.account_id === binding.accountId
    && quote.blockchain === "ethereum" && quote.asset_symbol === "USDC" && quote.asset_amount === binding.assetAmount
    && typeof response.deposit_address === "string" && address.test(response.deposit_address)
    && typeof quote.usd_value === "string" && /^\d+(?:\.\d+)?$/.test(quote.usd_value) && /[1-9]/.test(quote.usd_value)
    && Number.isSafeInteger(quote.expiration_at) && Number(quote.expiration_at) > now
    && Number.isSafeInteger(quote.timestamp) && Number(quote.timestamp) <= now + 30_000
    && Number(quote.timestamp) < Number(quote.expiration_at)
    && Number.isSafeInteger(response.confirmations_required) && Number(response.confirmations_required) > 0
    && quote.confirmations === response.confirmations_required);
  return {
    ...binding, requestId: response.request_id, depositAddress: response.deposit_address,
    usdValue: quote.usd_value, expiresAt: Number(quote.expiration_at), confirmationsRequired: Number(response.confirmations_required),
  };
}

function transaction(raw: unknown, owner: string, destination: string): DepositTransaction {
  const row = object(raw);
  ensure(same(row.from, owner) && same(row.to, destination) && row.value === "0x0"
    && typeof row.data === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(row.data)
    && (row.chainId === undefined || row.chainId === "0xaa36a7" || row.chainId === SEPOLIA_CHAIN_ID));
  if (row.gas !== undefined) ensure(typeof row.gas === "string" && /^0x[1-9a-f][0-9a-f]*$/i.test(row.gas)
    && BigInt(row.gas) <= 1_000_000n);
  return { from: owner, to: destination, data: row.data, value: "0x0", chainId: "0xaa36a7",
    ...(typeof row.gas === "string" ? { gas: row.gas } : {}) };
}

/** Validates actual calldata, not just labels returned beside an unsigned transaction. */
export function parseDepositPlan(raw: unknown, quote: DepositQuote, now: number): DepositPlan {
  ensure(now < quote.expiresAt);
  const built = object(raw);
  ensure(built.blockchain === "ethereum" && built.format === "evm_tx_params");
  const deposit = transaction(built.unsigned_tx, quote.address, quote.depositAddress);
  const words = deposit.data.slice(10).match(/.{64}/g) ?? [];
  ensure(deposit.data.length === 10 + 64 * 6 && deposit.data.slice(0, 10) === "0x61cd1530" && words.length === 6
    && words[0].toLowerCase() === quote.requestId.replaceAll("-", "").toLowerCase().padEnd(64, "0")
    && words[1].toLowerCase() === quote.accountId.replaceAll("-", "").toLowerCase().padEnd(64, "0")
    && words[2].toLowerCase() === SEPOLIA_USDC.slice(2).toLowerCase().padStart(64, "0")
    && BigInt(`0x${words[3]}`) === BigInt(quote.assetAmount)
    && BigInt(`0x${words[4]}`) === 160n && BigInt(`0x${words[5]}`) === 0n);
  let approval: DepositTransaction | null = null;
  if (built.approval_tx !== undefined) {
    approval = transaction(built.approval_tx, quote.address, SEPOLIA_USDC);
    ensure(approval.data.length === 138 && approval.data.slice(0, 10) === "0x095ea7b3"
      && approval.data.slice(10, 74).toLowerCase() === quote.depositAddress.slice(2).toLowerCase().padStart(64, "0")
      && BigInt(`0x${approval.data.slice(74)}`) === BigInt(quote.assetAmount));
  }
  return { quote, transaction: deposit, approval };
}
