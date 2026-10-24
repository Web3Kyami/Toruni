import assert from "node:assert/strict";
import test from "node:test";
import { nextOrderPollDelay, ORDER_POLL_CHECK_INTERVAL_MS } from "../server/workerTiming.ts";

test("order verifier checks each second while intent rows mature every two seconds", () => {
  assert.equal(ORDER_POLL_CHECK_INTERVAL_MS, 1_000);
  assert.equal(nextOrderPollDelay(0), 1_000);
  assert.equal(nextOrderPollDelay(400), 600);
  assert.equal(nextOrderPollDelay(1_000), 0);
  assert.equal(nextOrderPollDelay(Number.NaN), 1_000);
});
