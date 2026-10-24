import type { MarketSymbol } from "./markets.ts";
export type LeaderboardPeriod = "all" | "7d";
export type LeaderboardMarket = MarketSymbol | "all";
export interface LeaderboardEntry {
  rank: number; makerId: string; score: string; rounds: number;
  symbol: string; roundId: string; endsAt: number;
}
export interface LeaderboardSnapshot {
  entries: LeaderboardEntry[]; hasMore: boolean; page: number;
  period: LeaderboardPeriod; market: LeaderboardMarket; updatedAt: number;
}
