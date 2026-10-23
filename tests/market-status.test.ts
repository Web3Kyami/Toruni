import test from "node:test";
import assert from "node:assert/strict";
import { marketStatusMessage } from "../src/ui/marketStatus.ts";

test("stale marks cannot leave a live banner while offers are paused", () => {
  assert.equal(
    marketStatusMessage("live", "offline", "Market data live"),
    "Live market data is delayed. Offers are paused.",
  );
});

test("source errors and healthy market copy remain unchanged", () => {
  assert.equal(marketStatusMessage("partial", "partial", "Some market data is unavailable. Offers are paused."),
    "Some market data is unavailable. Offers are paused.");
  assert.equal(marketStatusMessage("live", "live", "Market data live"), "Market data live");
});
