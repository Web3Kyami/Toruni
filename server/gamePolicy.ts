import { compareDecimals, formatDecimal, multiplyDecimals, parseDecimal } from "../shared/decimal.ts";
import type { StrikeMarketRules } from "../shared/contracts.ts";
import type { RoundRules } from "./roundService.ts";

/** Numeric risk limits are operator decisions. Missing or invalid limits keep entry closed. */
export function readGamePolicy(market: StrikeMarketRules | null): {
  rules: RoundRules;
  requiredCollateral: string;
} | null {
  if (!market || market.source !== "strike-v2-testnet" || market.status !== "trading" || market.reduceOnly) return null;
  const maximumQuoteNotional = process.env.TORUNI_MAX_QUOTE_NOTIONAL?.trim() ?? "";
  const maximumAccountExposure = process.env.TORUNI_MAX_ACCOUNT_EXPOSURE?.trim() ?? "";
  const minimum = parseDecimal(market.minimumNotional);
  const quoteCap = parseDecimal(maximumQuoteNotional);
  const exposureCap = parseDecimal(maximumAccountExposure);
  if (!minimum || !quoteCap || !exposureCap || minimum.coefficient <= 0n || quoteCap.coefficient <= 0n
    || exposureCap.coefficient <= 0n || compareDecimals(quoteCap, minimum) < 0) return null;

  // At 1x, reserve enough free collateral for both maximum-sized sides to rest together.
  const twoSidedReserve = multiplyDecimals(quoteCap, { coefficient: 2n, scale: 0 });
  if (compareDecimals(exposureCap, twoSidedReserve) < 0) return null;
  return {
    rules: {
      symbol: "BTC-USD",
      minimumRemainingNotional: market.minimumNotional,
      maximumQuoteNotional,
      maximumAccountExposure,
    },
    requiredCollateral: formatDecimal(twoSidedReserve),
  };
}

export function publicGamePolicy(market: StrikeMarketRules | null) {
  const policy = readGamePolicy(market);
  if (!policy) return { ready: false as const, maximumQuoteNotional: null, maximumAccountExposure: null, requiredCollateral: null };
  return {
    ready: true as const,
    maximumQuoteNotional: policy.rules.maximumQuoteNotional,
    maximumAccountExposure: policy.rules.maximumAccountExposure,
    requiredCollateral: policy.requiredCollateral,
  };
}
