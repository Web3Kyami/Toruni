import assert from "node:assert/strict";
import test from "node:test";
import { nextOrderPollDelay, ORDER_POLL_CHECK_INTERVAL_MS } from "../server/workerTiming.ts";

test("order verifier checks twice per second while intent rows mature every two seconds", () => {
  assert.equal(ORDER_POLL_CHECK_INTERVAL_MS, 500);
  assert.equal(nextOrderPollDelay(0), 500);
  assert.equal(nextOrderPollDelay(200), 300);
  assert.equal(nextOrderPollDelay(500), 0);
  assert.equal(nextOrderPollDelay(Number.NaN), 500);
});
