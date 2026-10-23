import test from "node:test";
import assert from "node:assert/strict";
import type { ObservedOrder } from "../src/api/useRoundData.ts";
import { verifiedTerminalOrder } from "../src/ui/requote.ts";

const target = { client_order_id: "trn0123456789abcdef0123456789abcdef", exchange_order_id: "417" };
const row = (overrides: Partial<ObservedOrder> = {}): ObservedOrder => ({
  client_order_id: target.client_order_id,
  side: "buy",
  intent_status: "terminal",
  verification_error: null,
  last_checked_at: null,
  first_open_observed_at: null,
  exchange_order_id: target.exchange_order_id,
  exchange_status: "canceled",
  price: "81230.80",
  original_qty: "0.00124",
  filled_qty: "0",
  observed_at: null,
  ...overrides,
});

test("requote unlocks only after the same exchange order is independently terminal", () => {
  assert.equal(verifiedTerminalOrder([row({ exchange_status: "open", intent_status: "observed" })], target), null);
  assert.equal(verifiedTerminalOrder([row({ exchange_status: "canceled", intent_status: "observed" })], target), null);
  assert.equal(verifiedTerminalOrder([row({ exchange_order_id: "418" })], target), null);
  assert.equal(verifiedTerminalOrder([row({ exchange_status: "unknown" })], target), null);
  assert.equal(verifiedTerminalOrder([row({ filled_qty: null })], target), null);
  assert.equal(verifiedTerminalOrder([row({ filled_qty: "unknown" })], target), null);

  const result = verifiedTerminalOrder([row()], target);
  assert.equal(result?.status, "canceled");
  assert.equal(result?.hasFill, false);
});

test("terminal partial fills are surfaced as exposure before another offer", () => {
  const result = verifiedTerminalOrder([row({ exchange_status: "canceled", filled_qty: "0.00001" })], target);
  assert.equal(result?.status, "canceled");
  assert.equal(result?.hasFill, true);
  assert.equal(verifiedTerminalOrder([row({ exchange_status: "filled", filled_qty: "0.00124" })], target)?.hasFill, true);
});
