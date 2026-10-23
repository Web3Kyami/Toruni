import assert from "node:assert/strict";
import test from "node:test";
import { serializeStrikeCancelBody } from "../src/api/builderConnect.ts";

test("cancel request encodes the verified Strike order ID as an exact JSON integer", () => {
  const maxInt64 = 9_223_372_036_854_775_807n;
  assert.equal(serializeStrikeCancelBody("1234567890123456789"), '{"order_id":1234567890123456789,"symbol":"BTC-USD"}');
  for (const id of ["0", "01", "-1", "1.5", "9".repeat(20), (maxInt64 + 1n).toString()]) {
    assert.throws(() => serializeStrikeCancelBody(id));
  }
});
