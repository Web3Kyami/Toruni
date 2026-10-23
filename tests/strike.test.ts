import assert from "node:assert/strict";
import test from "node:test";
import { parseMark } from "../server/strike.ts";

test("parses Strike's documented mark event fields and preserves exchange time", () => {
  const eventTime = 1_700_000_000_000;
  const mark = parseMark("BTC-USD", {
    e: "markPriceUpdate",
    E: eventTime,
    s: "BTC-USD",
    p: "43250.10",
  });

  assert.deepEqual(mark, {
    symbol: "BTC-USD",
    markPrice: "43250.10",
    observedAt: eventTime,
    source: "strike-v2-testnet",
  });
});

test("rejects wrong-symbol and undated mark records", () => {
  assert.equal(parseMark("BTC-USD", { E: 1_700_000_000_000, s: "ETH-USD", p: "2500" }), null);
  assert.equal(parseMark("BTC-USD", { s: "BTC-USD", p: "43250.10" }), null);
});
