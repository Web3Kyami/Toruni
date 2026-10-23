import test from "node:test";
import assert from "node:assert/strict";
import { formatUsd } from "../src/ui/format.ts";

test("formats USD values to cents without floating-point rounding", () => {
  assert.equal(formatUsd("254.7866592921546134"), "$254.79");
  assert.equal(formatUsd("100.7751720"), "$100.78");
  assert.equal(formatUsd("202"), "$202.00");
  assert.equal(formatUsd("1000000.995"), "$1,000,001.00");
  assert.equal(formatUsd("-0.009"), "-$0.01");
  assert.equal(formatUsd("not-a-number"), "Unavailable");
});
