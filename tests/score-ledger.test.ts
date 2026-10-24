import assert from "node:assert/strict";
import test from "node:test";
import { auditObservedTick, missingSamplerSlots, replayObservedTicks, type ObservedTick } from "../shared/scoreLedger.ts";
import { formatScore } from "../shared/scoring.ts";
import type { VerifiedQuote } from "../shared/contracts.ts";

const startsAt = 1_000_000;
const window = { startsAt, endsAt: startsAt + 180_000, accountId: "fixture-account" };
function tick(second: number): ObservedTick {
  const sampledAt = startsAt + second * 1_000;
  const quote: VerifiedQuote = {
    exchangeOrderId: "12345", accountId: window.accountId, clientOrderId: "fixture-bid", symbol: "BTC-USD", side: "buy",
    status: "open", type: "limit", timeInForce: "GTC", postOnly: true,
    size: "0.001", filled: "0", price: "50000", firstOpenObservedAt: startsAt,
    lastVerifiedAt: sampledAt, provenance: "strike-public-order-read",
  };
  return {
    sampledAt,
    mark: { symbol: "BTC-USD", markPrice: "50000", observedAt: sampledAt, source: "strike-v2-testnet" },
    riskPolicy: {
      symbol: "BTC-USD", minimumRemainingNotional: "1", maximumQuoteNotional: "100",
      maximumAccountExposure: "100", currentAbsoluteExposure: "0", riskObservedAt: sampledAt,
      riskFreshnessLimitMs: 3_000, markFreshnessLimitMs: 5_000, orderFreshnessLimitMs: 3_000,
      minimumDwellMs: 5_000,
    },
    bid: quote, ask: { ...quote, clientOrderId: "fixture-ask", side: "sell" },
  };
}

test("replay is deterministic, preserves exact totals, and never credits the dwell interval", () => {
  const observations = Array.from({ length: 180 }, (_, index) => tick(index + 1));
  const first = replayObservedTicks(observations, window);
  const second = replayObservedTicks([...observations].reverse(), window);
  assert.deepEqual(second, first);
  assert.equal(first.samples.slice(0, 5).every((sample) => sample.deltaScaled === "0"), true);
  assert.equal(formatScore(first.totalScaled), "291.67");
});

test("sampler gaps and restart never catch up missed seconds", () => {
  assert.equal(auditObservedTick(tick(10), window, tick(8).sampledAt).reason, "sampler-gap");
  assert.equal(auditObservedTick(tick(10), window, null).deltaScaled, "0");
  const full = replayObservedTicks(Array.from({ length: 20 }, (_, i) => tick(i + 1)), window);
  const gap = replayObservedTicks(Array.from({ length: 20 }, (_, i) => tick(i + 1)).filter((row) => row.sampledAt !== tick(10).sampledAt), window);
  assert.ok(gap.totalScaled < full.totalScaled);
  assert.equal(gap.samples.find((row) => row.sampledAt === tick(11).sampledAt)?.deltaScaled, "0");
});

test("missed production sampler slots become zeros so later live ticks can resume", () => {
  assert.deepEqual(missingSamplerSlots(startsAt + 1_000, startsAt + 4_000), [startsAt + 2_000, startsAt + 3_000]);
  assert.deepEqual(missingSamplerSlots(startsAt + 3_000, startsAt + 4_000), []);
  assert.deepEqual(missingSamplerSlots(startsAt, startsAt + 1_000), []);
});

test("account mismatches, absent risk evidence, and post-round observations earn zero", () => {
  const mismatched = tick(10);
  mismatched.bid!.accountId = "different-account";
  mismatched.ask = null;
  assert.equal(auditObservedTick(mismatched, window, tick(9).sampledAt).deltaScaled, "0");
  assert.equal(auditObservedTick({ ...tick(10), riskPolicy: null }, window, tick(9).sampledAt).reason, "proof-unavailable");
  assert.equal(auditObservedTick(tick(181), window, tick(180).sampledAt).reason, "outside-round");
  assert.throws(() => replayObservedTicks([tick(10), tick(10)], window), /Duplicate/);
});
