import type { MarketSnapshot, StrikePublicAccount, StrikePosition } from "../../shared/contracts";

export type PublicStrikeAccount = StrikePublicAccount;

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "Toruni could not read Strike testnet data.";
    throw new Error(message);
  }
  return payload as T;
}

export function readMarketSnapshot(symbol = "BTC-USD"): Promise<MarketSnapshot> {
  return readJson<MarketSnapshot>(`/api/market?symbol=${encodeURIComponent(symbol)}`);
}

export function readPublicStrikeAccount(address: string): Promise<PublicStrikeAccount> {
  return readJson<PublicStrikeAccount>(`/api/account?blockchain_address=${encodeURIComponent(address)}`);
}

export interface RiskSnapshot { account: StrikePublicAccount; positions: StrikePosition[]; observedAt: number }
export function readRiskSnapshot(accountId: string): Promise<RiskSnapshot> {
  return readJson<RiskSnapshot>(`/api/risk?account_id=${encodeURIComponent(accountId)}`);
}
