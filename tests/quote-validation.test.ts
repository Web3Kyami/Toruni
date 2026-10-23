import assert from "node:assert/strict";
import test from "node:test";
import { validateQuoteDraft } from "../shared/quoteValidation.ts";
import { parseMarketRules } from "../server/strike.ts";
import type { StrikeMarketRules } from "../shared/contracts.ts";
const now = 1_000_000;
const rules: StrikeMarketRules = {
  symbol: "BTC-USD", status: "trading", reduceOnly: false, tickPrice: "0.10", minimumPrice: "10",
  maximumPrice: "100000", limitStepSize: "0.00001", minimumLimitSize: "0.00001",
  maximumLimitSize: "1000", minimumNotional: "100", limitPriceBound: "0.05", observedAt: now,
  source: "strike-v2-testnet",
};
const mark = { symbol: "BTC-USD", markPrice: "81500", observedAt: now, source: "strike-v2-testnet" as const };
const draft = { side: "buy" as const, price: "81500.00", size: "0.00123" };

test("validates decimal ticks, steps and the actual BTC minimum without floating point", () => {
  assert.deepEqual(validateQuoteDraft(draft, rules, mark, null, "200", now), { valid: true, errors: {}, notional: "100.2450000" });
  assert.match(validateQuoteDraft({ ...draft, size: "0.00122" }, rules, mark, null, "200", now).errors.size ?? "", /at least 100/);
  assert.match(validateQuoteDraft({ ...draft, price: "81499.99" }, rules, mark, null, "200", now).errors.price ?? "", /increments/);
  assert.match(validateQuoteDraft({ ...draft, size: "0.001231" }, rules, mark, null, "200", now).errors.size ?? "", /increments/);
});

test("rejects crossing, stale, halted, reduce-only and oversized drafts", () => {
  const depth = { bids: [{ price: "81400", size: "1" }], asks: [{ price: "81450", size: "1" }], observedAt: now, source: "strike-v2-testnet" as const };
  assert.match(validateQuoteDraft(draft, rules, mark, depth, "200", now).errors.price ?? "", /cross/);
  assert.equal(validateQuoteDraft(draft, rules, { ...mark, observedAt: now - 5001 }, null, "200", now).valid, false);
  assert.equal(validateQuoteDraft(draft, { ...rules, status: "halted" }, mark, null, "200", now).valid, false);
  assert.equal(validateQuoteDraft(draft, { ...rules, reduceOnly: true }, mark, null, "200", now).valid, false);
  assert.match(validateQuoteDraft({ ...draft, size: "0.003" }, rules, mark, null, "200", now).errors.size ?? "", /cap/);
});

test("engine rules reject absent fields instead of falling back to price-service placeholders", () => {
  assert.equal(parseMarketRules("BTC-USD", { symbols: [{ symbol: "BTC-USD", filters: [] }] }, now), null);
  assert.equal(parseMarketRules("BTC-USD", { markets: { "BTC-USD": { symbol: "BTC-USD", status: "trading", reduce_only: false } } }, now), null);
});
