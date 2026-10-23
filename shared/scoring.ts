import { parseDecimal, alignDecimals, compareDecimals, subtractDecimals, multiplyDecimals, type DecimalValue } from "./decimal.ts";
import type {
  QuoteAssessment,
  QuoteSide,
  ScorePolicy,
  ScoreSample,
  StrikeMark,
  VerifiedQuote,
} from "./contracts.ts";

const SCORE_SCALE = 1_000_000_000_000n;
const SCORE_SCALE_DIGITS = 12;
const SCORE_BAND_BPS = 50n;
const BPS = 10_000n;

function isFresh(observedAt: number, nowMs: number, maximumAgeMs: number): boolean {
  const age = nowMs - observedAt;
  return age >= 0 && age <= maximumAgeMs;
}

function quoteSide(quote: VerifiedQuote): QuoteSide {
  return quote.side === "buy" ? "bid" : "ask";
}

function assessFailure(side: QuoteSide, reason: QuoteAssessment["reason"]): QuoteAssessment {
  return { eligible: false, reason, side, qualityScaled: 0n };
}

function qualityAtMark(mark: DecimalValue, price: DecimalValue, side: QuoteSide): bigint | null {
  const [markValue, priceValue] = alignDecimals(mark, price);
  const distance = side === "bid" ? markValue - priceValue : priceValue - markValue;
  if (distance < 0n) return null;

  const denominator = markValue * SCORE_BAND_BPS;
  const remaining = denominator - distance * BPS;
  if (remaining < 0n || denominator <= 0n) return 0n;

  // The common decimal scale cancels in the ratio. Integer division truncates
  // toward zero at 12 decimal places; every sampled score uses that same rule.
  return (remaining * SCORE_SCALE) / denominator;
}

export function assessVerifiedQuote(
  quote: VerifiedQuote,
  mark: StrikeMark,
  policy: ScorePolicy,
  nowMs: number,
): QuoteAssessment {
  const side = quoteSide(quote);
  if (quote.symbol !== policy.symbol || mark.symbol !== policy.symbol) {
    return assessFailure(side, "wrong-market");
  }
  if (quote.status !== "open") return assessFailure(side, "not-open");
  if (quote.type !== "limit" || quote.timeInForce !== "GTC" || !quote.postOnly) {
    return assessFailure(side, "not-maker-limit");
  }

  const size = parseDecimal(quote.size);
  const filled = parseDecimal(quote.filled);
  const price = parseDecimal(quote.price);
  const markPrice = parseDecimal(mark.markPrice);
  const minimum = parseDecimal(policy.minimumRemainingNotional);
  const maximum = parseDecimal(policy.maximumQuoteNotional);
  const exposure = parseDecimal(policy.currentAbsoluteExposure);
  const exposureLimit = parseDecimal(policy.maximumAccountExposure);
  if (!size || !filled || !price || !markPrice || !minimum || !maximum || !exposure || !exposureLimit) {
    return assessFailure(side, "invalid-size-or-price");
  }
  if (minimum.coefficient <= 0n || maximum.coefficient <= 0n || exposureLimit.coefficient < 0n
    || compareDecimals(maximum, minimum) < 0) return assessFailure(side, "invalid-size-or-price");

  const remaining = subtractDecimals(size, filled);
  if (remaining.coefficient <= 0n || filled.coefficient < 0n || price.coefficient <= 0n || markPrice.coefficient <= 0n) {
    return assessFailure(side, "invalid-size-or-price");
  }

  if (!isFresh(policy.riskObservedAt, nowMs, policy.riskFreshnessLimitMs)) {
    return assessFailure(side, "risk-stale");
  }
  if (!isFresh(mark.observedAt, nowMs, policy.markFreshnessLimitMs)) {
    return assessFailure(side, "mark-stale");
  }
  if (!isFresh(quote.lastVerifiedAt, nowMs, policy.orderFreshnessLimitMs)) {
    return assessFailure(side, "order-stale");
  }
  if (!Number.isFinite(quote.firstOpenObservedAt) || quote.firstOpenObservedAt <= 0
    || quote.firstOpenObservedAt > quote.lastVerifiedAt || nowMs - quote.firstOpenObservedAt < policy.minimumDwellMs) {
    return assessFailure(side, "dwell-incomplete");
  }

  const notional = multiplyDecimals(remaining, price);
  if (compareDecimals(notional, minimum) < 0) {
    return assessFailure(side, "below-minimum-notional");
  }
  if (compareDecimals(notional, maximum) > 0) {
    return assessFailure(side, "above-risk-cap");
  }
  const exposureMagnitude = { ...exposure, coefficient: exposure.coefficient < 0n ? -exposure.coefficient : exposure.coefficient };
  if (compareDecimals(exposureMagnitude, exposureLimit) > 0) {
    return assessFailure(side, "exposure-limit");
  }

  const quality = qualityAtMark(markPrice, price, side);
  if (quality === null) return assessFailure(side, "crosses-mark");
  if (quality === 0n) return assessFailure(side, "outside-score-band");
  return { eligible: true, reason: "eligible", side, qualityScaled: quality };
}

export function scoreVerifiedSample(
  bid: QuoteAssessment | null,
  ask: QuoteAssessment | null,
  intervalMs: number,
): ScoreSample {
  const elapsedMs = Math.trunc(intervalMs);
  const dtMs = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(1_000, elapsedMs)) : 0;
  const bidQuality = bid?.eligible && bid.side === "bid" ? bid.qualityScaled : 0n;
  const askQuality = ask?.eligible && ask.side === "ask" ? ask.qualityScaled : 0n;
  const twoSidedQuality = bidQuality < askQuality ? bidQuality : askQuality;
  const pointsPerMinuteScaled = 25n * bidQuality + 25n * askQuality + 50n * twoSidedQuality;
  const scoreDeltaScaled = (pointsPerMinuteScaled * BigInt(dtMs)) / 60_000n;
  return { scoreDeltaScaled, pointsPerMinuteScaled, bidQualityScaled: bidQuality, askQualityScaled: askQuality };
}

export function formatScore(scoreScaled: bigint): string {
  const cents = (scoreScaled * 100n + SCORE_SCALE / 2n) / SCORE_SCALE;
  const whole = cents / 100n;
  const fractional = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fractional}`;
}

export const scoringConstants = {
  version: "toruni-observed-two-sided-v0.1",
  scoreScale: SCORE_SCALE,
  scaleDigits: SCORE_SCALE_DIGITS,
  maximumDistanceBps: Number(SCORE_BAND_BPS),
} as const;
