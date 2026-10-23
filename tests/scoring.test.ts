import assert from "node:assert/strict";
import test from "node:test";
import type { QuoteAssessment, ScorePolicy, StrikeMark, VerifiedQuote } from "../shared/contracts.ts";
import { assessVerifiedQuote, formatScore, scoreVerifiedSample } from "../shared/scoring.ts";

const now = 1_000_000;
const mark: StrikeMark = {
  symbol: "BTC-USD",
  markPrice: "50000",
  observedAt: now,
  source: "strike-v2-testnet",
};
const policy: ScorePolicy = {
  symbol: "BTC-USD",
  minimumRemainingNotional: "1",
  maximumQuoteNotional: "1000",
  maximumAccountExposure: "1000",
  currentAbsoluteExposure: "0",
  riskObservedAt: now,
  riskFreshnessLimitMs: 3_000,
  markFreshnessLimitMs: 5_000,
  orderFreshnessLimitMs: 3_000,
  minimumDwellMs: 5_000,
};

function quote(overrides: Partial<VerifiedQuote> = {}): VerifiedQuote {
  return {
    accountId: "account-test-fixture",
    clientOrderId: "toruni-test-fixture",
    symbol: "BTC-USD",
    side: "buy",
    status: "open",
    type: "limit",
    timeInForce: "GTC",
    postOnly: true,
    size: "0.0001",
    filled: "0",
    price: "49950",
    firstOpenObservedAt: now - 6_000,
    lastVerifiedAt: now,
    provenance: "strike-public-order-read",
    ...overrides,
  };
}

function eligible(side: "bid" | "ask", qualityScaled = 1_000_000_000_000n): QuoteAssessment {
  return { eligible: true, reason: "eligible", side, qualityScaled };
}

function accrueMinute(bid: QuoteAssessment | null, ask: QuoteAssessment | null): bigint {
  let total = 0n;
  for (let second = 0; second < 60; second += 1) {
    total += scoreVerifiedSample(bid, ask, 1_000).scoreDeltaScaled;
  }
  return total;
}

test("one 10 bps bid earns at most 20.00 points per minute", () => {
  const bid = assessVerifiedQuote(quote({ price: "49950" }), mark, policy, now);
  assert.equal(formatScore(accrueMinute(bid, null)), "20.00");
});

test("two 10 bps sides earn 80.00 points per minute", () => {
  const bid = assessVerifiedQuote(quote({ price: "49950" }), mark, policy, now);
  const ask = assessVerifiedQuote(quote({ side: "sell", price: "50050" }), mark, policy, now);
  assert.equal(formatScore(accrueMinute(bid, ask)), "80.00");
});

test("two quotes at the mark reach the 100 point per minute rate", () => {
  const bid = assessVerifiedQuote(quote({ price: "50000" }), mark, policy, now);
  const ask = assessVerifiedQuote(quote({ side: "sell", price: "50000" }), mark, policy, now);
  assert.equal(formatScore(accrueMinute(bid, ask)), "100.00");
});

test("two 40 bps sides earn 20.00 points per minute and no quotes earn zero", () => {
  const bid = assessVerifiedQuote(quote({ price: "49800" }), mark, policy, now);
  const ask = assessVerifiedQuote(quote({ side: "sell", price: "50200" }), mark, policy, now);
  assert.equal(formatScore(accrueMinute(bid, ask)), "20.00");
  assert.equal(scoreVerifiedSample(null, null, 1_000).scoreDeltaScaled, 0n);
});

test("50 bps edge, crossing prices, pending orders, and incomplete dwell earn zero", () => {
  const edge = assessVerifiedQuote(quote({ price: "49750" }), mark, policy, now);
  const crossing = assessVerifiedQuote(quote({ price: "50001" }), mark, policy, now);
  const pending = assessVerifiedQuote(quote({ status: "pending" }), mark, policy, now);
  const dwell = assessVerifiedQuote(quote({ firstOpenObservedAt: now - 4_999 }), mark, policy, now);
  assert.equal(edge.eligible, false);
  assert.equal(crossing.reason, "crosses-mark");
  assert.equal(pending.reason, "not-open");
  assert.equal(dwell.reason, "dwell-incomplete");
  assert.equal(scoreVerifiedSample(edge, null, 1_000).scoreDeltaScaled, 0n);
});

test("partial fills use remaining size and engine-provided minimum notional", () => {
  const belowMinimum = assessVerifiedQuote(quote({ size: "0.0001", filled: "0.00009" }), mark, policy, now);
  const remaining = assessVerifiedQuote(quote({ size: "0.0002", filled: "0.0001" }), mark, policy, now);
  assert.equal(belowMinimum.reason, "below-minimum-notional");
  assert.equal(remaining.eligible, true);
});

test("stale mark, order, or risk data pauses credit", () => {
  const staleMark = assessVerifiedQuote(quote(), { ...mark, observedAt: now - 5_001 }, policy, now);
  const staleOrder = assessVerifiedQuote(quote({ lastVerifiedAt: now - 3_001 }), mark, policy, now);
  const staleRisk = assessVerifiedQuote(quote(), mark, { ...policy, riskObservedAt: now - 3_001 }, now);
  assert.equal(staleMark.reason, "mark-stale");
  assert.equal(staleOrder.reason, "order-stale");
  assert.equal(staleRisk.reason, "risk-stale");
});

test("future-dated observations and unsafe account exposure earn zero", () => {
  const futureMark = assessVerifiedQuote(quote(), { ...mark, observedAt: now + 1 }, policy, now);
  const futureOpen = assessVerifiedQuote(quote({ firstOpenObservedAt: now + 1 }), mark, policy, now);
  const excessiveExposure = assessVerifiedQuote(quote(), mark, { ...policy, currentAbsoluteExposure: "-1001" }, now);
  assert.equal(futureMark.reason, "mark-stale");
  assert.equal(futureOpen.reason, "dwell-incomplete");
  assert.equal(excessiveExposure.reason, "exposure-limit");
});

test("malformed or negative fill amounts fail closed", () => {
  const malformed = assessVerifiedQuote(quote({ size: "1e-4" }), mark, policy, now);
  const negativeFill = assessVerifiedQuote(quote({ filled: "-0.01" }), mark, policy, now);
  assert.equal(malformed.reason, "invalid-size-or-price");
  assert.equal(negativeFill.reason, "invalid-size-or-price");
});

test("samples cap at one second and display rounding is separate", () => {
  const oneSecond = scoreVerifiedSample(eligible("bid", 1_000_000_000_000n), eligible("ask", 1_000_000_000_000n), 5_000);
  const capped = scoreVerifiedSample(eligible("bid"), eligible("ask"), 1_000);
  assert.equal(oneSecond.scoreDeltaScaled, capped.scoreDeltaScaled);
  assert.equal(formatScore(oneSecond.scoreDeltaScaled * 180n), "300.00");
});
