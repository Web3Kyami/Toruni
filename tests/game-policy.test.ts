import assert from "node:assert/strict";
import test from "node:test";
import { readGamePolicy } from "../server/gamePolicy.ts";
import type { StrikeMarketRules } from "../shared/contracts.ts";

const market: StrikeMarketRules = {
  symbol: "BTC-USD", status: "trading", reduceOnly: false, tickPrice: "0.1", minimumPrice: "10",
  maximumPrice: "100000", limitStepSize: "0.00001", minimumLimitSize: "0.00001", maximumLimitSize: "1000",
  minimumNotional: "100", limitPriceBound: "0.05", observedAt: 1_000, source: "strike-v2-testnet",
};

test("risk limits are required and two-sided collateral is derived at 1x", () => {
  const oldQuoteCap = process.env.TORUNI_MAX_QUOTE_NOTIONAL;
  const oldExposureCap = process.env.TORUNI_MAX_ACCOUNT_EXPOSURE;
  try {
    delete process.env.TORUNI_MAX_QUOTE_NOTIONAL;
    delete process.env.TORUNI_MAX_ACCOUNT_EXPOSURE;
    assert.equal(readGamePolicy(market), null);
    process.env.TORUNI_MAX_QUOTE_NOTIONAL = "150.25";
    process.env.TORUNI_MAX_ACCOUNT_EXPOSURE = "300.50";
    assert.deepEqual(readGamePolicy(market), {
      rules: { symbol: "BTC-USD", minimumRemainingNotional: "100", maximumQuoteNotional: "150.25", maximumAccountExposure: "300.50" },
      requiredCollateral: "300.50",
    });
    process.env.TORUNI_MAX_ACCOUNT_EXPOSURE = "300.49";
    assert.equal(readGamePolicy(market), null);
    process.env.TORUNI_MAX_ACCOUNT_EXPOSURE = "400";
    process.env.TORUNI_MAX_QUOTE_NOTIONAL = "99";
    assert.equal(readGamePolicy(market), null);
    process.env.TORUNI_MAX_QUOTE_NOTIONAL = "150";
    assert.equal(readGamePolicy({ ...market, status: "halted" }), null);
    assert.equal(readGamePolicy({ ...market, reduceOnly: true }), null);
  } finally {
    if (oldQuoteCap === undefined) delete process.env.TORUNI_MAX_QUOTE_NOTIONAL;
    else process.env.TORUNI_MAX_QUOTE_NOTIONAL = oldQuoteCap;
    if (oldExposureCap === undefined) delete process.env.TORUNI_MAX_ACCOUNT_EXPOSURE;
    else process.env.TORUNI_MAX_ACCOUNT_EXPOSURE = oldExposureCap;
  }
});
