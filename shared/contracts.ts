export type QuoteSide = "bid" | "ask";
export type StrikeSide = "buy" | "sell";

export interface StrikeOrderRecord {
  ID: number | string;
  ClientOrderID: string;
  AccountID: string;
  Symbol: string;
  Side: StrikeSide;
  Status: string;
  Type: string;
  TimeInForce: string;
  PostOnly: boolean;
  Size: string;
  Filled: string;
  Price: string;
  EventTimestamp?: number;
}

export interface StrikeMark {
  symbol: string;
  markPrice: string;
  observedAt: number;
  source: "strike-v2-testnet";
}

export interface StrikeDepthLevel {
  price: string;
  size: string;
}

export interface StrikeDepth {
  bids: StrikeDepthLevel[];
  asks: StrikeDepthLevel[];
  observedAt: number;
  source: "strike-v2-testnet";
}

export interface MarketSnapshot {
  symbol: string;
  checkedAt: number;
  mark: StrikeMark | null;
  depth: StrikeDepth | null;
  marketRules: StrikeMarketRules | null;
  unavailableSources: Array<"mark" | "depth" | "marketRules">;
}

export interface StrikeMarketRules {
  symbol: string;
  status: string;
  reduceOnly: boolean;
  tickPrice: string;
  minimumPrice: string;
  maximumPrice: string;
  limitStepSize: string;
  minimumLimitSize: string;
  maximumLimitSize: string;
  minimumNotional: string;
  limitPriceBound: string;
  observedAt: number;
  source: "strike-v2-testnet";
}

export interface StrikePublicAccount {
  account_id: string;
  blockchain: string;
  blockchain_address: string | null;
  wallet_balance: string;
  available_balance: string;
  margin_balance: string;
  symbolSettings: Record<string, { leverage: number; marginMode: "cross" | "isolated"; allowPreTrade: boolean }> | null;
  observedAt: number;
}

export interface StrikePosition {
  symbol: string;
  size: string;
  leverage: number;
  marginMode: "cross" | "isolated";
}

export interface VerifiedQuote {
  exchangeOrderId: string;
  accountId: string;
  clientOrderId: string;
  symbol: string;
  side: StrikeSide;
  status: "open" | "pending" | "filled" | "canceled" | "expired" | "rejected" | "unknown";
  type: string;
  timeInForce: string;
  postOnly: boolean;
  size: string;
  filled: string;
  price: string;
  firstOpenObservedAt: number;
  lastVerifiedAt: number;
  provenance: "strike-public-order-read";
}

export interface ScorePolicy {
  symbol: string;
  minimumRemainingNotional: string;
  maximumQuoteNotional: string;
  maximumAccountExposure: string;
  currentAbsoluteExposure: string;
  riskObservedAt: number;
  riskFreshnessLimitMs: number;
  markFreshnessLimitMs: number;
  orderFreshnessLimitMs: number;
  minimumDwellMs: number;
}

export interface QuoteAssessment {
  eligible: boolean;
  reason:
    | "eligible"
    | "wrong-market"
    | "not-open"
    | "not-maker-limit"
    | "invalid-size-or-price"
    | "below-minimum-notional"
    | "above-risk-cap"
    | "exposure-limit"
    | "risk-stale"
    | "mark-stale"
    | "order-stale"
    | "dwell-incomplete"
    | "crosses-mark"
    | "outside-score-band";
  side: QuoteSide;
  qualityScaled: bigint;
}

export interface ScoreSample {
  scoreDeltaScaled: bigint;
  pointsPerMinuteScaled: bigint;
  bidQualityScaled: bigint;
  askQualityScaled: bigint;
}
