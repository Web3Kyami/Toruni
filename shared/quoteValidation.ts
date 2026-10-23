import type { StrikeDepth, StrikeMark, StrikeMarketRules, StrikeSide } from "./contracts.ts";
import { alignDecimals, compareDecimals, formatDecimal, isDecimalMultiple, multiplyDecimals, parseDecimal, subtractDecimals } from "./decimal.ts";

export interface QuoteDraft { side: StrikeSide; price: string; size: string }
export interface QuoteValidation {
  valid: boolean;
  errors: { price?: string; size?: string; general?: string };
  notional: string | null;
}

/** Static preflight only. Margin admission and independent OPEN proof are separate server checks. */
export function validateQuoteDraft(draft: QuoteDraft, rules: StrikeMarketRules, mark: StrikeMark,
  depth: StrikeDepth | null, maximumQuoteNotional: string, now: number): QuoteValidation {
  const errors: QuoteValidation["errors"] = {};
  const finish = (notional: string | null = null): QuoteValidation => ({ valid: Object.keys(errors).length === 0, errors, notional });
  if (draft.side !== "buy" && draft.side !== "sell") { errors.general = "Choose bid or ask."; return finish(); }
  if (rules.source !== "strike-v2-testnet" || mark.source !== "strike-v2-testnet" || mark.symbol !== rules.symbol
    || now < rules.observedAt || now - rules.observedAt > 30_000 || now < mark.observedAt || now - mark.observedAt > 5_000) {
    errors.general = "Refresh Strike market data before reviewing a quote."; return finish();
  }
  if (rules.status !== "trading" || rules.reduceOnly) {
    errors.general = "This market is not accepting new maker quotes."; return finish();
  }
  const price = parseDecimal(draft.price);
  const size = parseDecimal(draft.size);
  if (!price || price.coefficient <= 0n) errors.price = "Enter a positive decimal price.";
  if (!size || size.coefficient <= 0n) errors.size = "Enter a positive decimal size.";
  if (!price || !size || Object.keys(errors).length) return finish();
  const tick = parseDecimal(rules.tickPrice);
  const step = parseDecimal(rules.limitStepSize);
  const minPrice = parseDecimal(rules.minimumPrice);
  const maxPrice = parseDecimal(rules.maximumPrice);
  const minSize = parseDecimal(rules.minimumLimitSize);
  const maxSize = parseDecimal(rules.maximumLimitSize);
  const minimum = parseDecimal(rules.minimumNotional);
  const cap = parseDecimal(maximumQuoteNotional);
  const bound = parseDecimal(rules.limitPriceBound);
  const markPrice = parseDecimal(mark.markPrice);
  if (!tick || !step || !minPrice || !maxPrice || !minSize || !maxSize || !minimum || !cap || !bound
    || !markPrice || cap.coefficient <= 0n || markPrice.coefficient <= 0n) {
    errors.general = "The market or round limits could not be verified."; return finish();
  }
  if (!isDecimalMultiple(price, tick)) errors.price = `Use a price in increments of ${rules.tickPrice}.`;
  else if (compareDecimals(price, minPrice) < 0 || compareDecimals(price, maxPrice) > 0) errors.price = "Price is outside Strike’s market limits.";
  if (!isDecimalMultiple(size, step)) errors.size = `Use a size in increments of ${rules.limitStepSize}.`;
  else if (compareDecimals(size, minSize) < 0 || compareDecimals(size, maxSize) > 0) errors.size = "Size is outside Strike’s market limits.";
  const difference = subtractDecimals(price, markPrice);
  if ((draft.side === "buy" && difference.coefficient > 0n) || (draft.side === "sell" && difference.coefficient < 0n)) {
    errors.price = draft.side === "buy" ? "A bid must be at or below the mark." : "An ask must be at or above the mark.";
  }
  const absoluteDifference = { ...difference, coefficient: difference.coefficient < 0n ? -difference.coefficient : difference.coefficient };
  const [distance, maximumDistance] = alignDecimals(absoluteDifference, multiplyDecimals(markPrice, bound));
  if (distance > maximumDistance) errors.price = "Price is outside Strike’s limit-order band.";
  if (depth && depth.source === "strike-v2-testnet" && now >= depth.observedAt && now - depth.observedAt <= 5_000) {
    const opposite = parseDecimal((draft.side === "buy" ? depth.asks[0] : depth.bids[0])?.price ?? "");
    if (opposite && (draft.side === "buy" ? compareDecimals(price, opposite) >= 0 : compareDecimals(price, opposite) <= 0)) {
      errors.price = "This quote would cross the opposite book. Choose a resting price.";
    }
  }
  const notional = multiplyDecimals(price, size);
  if (compareDecimals(notional, minimum) < 0) errors.size = `Each quote must be worth at least ${rules.minimumNotional} USD.`;
  else if (compareDecimals(notional, cap) > 0) errors.size = "This quote exceeds the round’s notional cap.";
  return finish(formatDecimal(notional));
}
