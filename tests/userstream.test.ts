import assert from "node:assert/strict";
import test from "node:test";
import { parseUserStreamFrame } from "../src/api/userStream.ts";

test("parses multiple newline-delimited userstream events and ignores malformed lines", () => {
  const parsed = parseUserStreamFrame([
    JSON.stringify({ e: "ORDER_TRADE_UPDATE", data: { c: "toruni-order" } }),
    "{bad-json}",
    JSON.stringify({ e: "ACCOUNT_UPDATE", data: { r: "FILL" } }),
  ].join("\n"));
  assert.deepEqual(parsed.map(value => (value as { e: string }).e), ["ORDER_TRADE_UPDATE", "ACCOUNT_UPDATE"]);
});
