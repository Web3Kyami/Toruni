export const marketSymbols = ["BTC-USD", "ETH-USD", "SOL-USD", "ADA-USD"] as const;
export type MarketSymbol = typeof marketSymbols[number];
export function isMarketSymbol(value: unknown): value is MarketSymbol {
  return typeof value === "string" && (marketSymbols as readonly string[]).includes(value);
}
export function baseAsset(symbol: string): string { return symbol.split("-")[0] ?? symbol; }
export interface MarketOption { symbol: MarketSymbol; name: string; available: boolean }
export interface PricePoint { time: number; close: number }
export interface PublicOrderActivity {
  id: string; symbol: string; side: "buy" | "sell"; status: string;
  price: string; size: string; filled: string; observedAt: number;
}
