import assert from "node:assert/strict";
import test from "node:test";
import { parseUserStreamFrame, shouldReconnectWhenVisible } from "../src/api/userStream.ts";

test("parses multiple newline-delimited userstream events and ignores malformed lines", () => {
  const parsed = parseUserStreamFrame([
    JSON.stringify({ e: "ORDER_TRADE_UPDATE", data: { c: "toruni-order" } }),
    "{bad-json}",
    JSON.stringify({ e: "ACCOUNT_UPDATE", data: { r: "FILL" } }),
    JSON.stringify({ e: "error", error: { code: 401, msg: "Authentication failed" } }),
  ].join("\n"));
  assert.deepEqual(parsed.map(value => (value as { e: string }).e), ["ORDER_TRADE_UPDATE", "ACCOUNT_UPDATE", "error"]);
});

test("visibility recovery does not open a duplicate socket while the current one is connecting or closing", () => {
  assert.equal(shouldReconnectWhenVisible("visible", null), true);
  assert.equal(shouldReconnectWhenVisible("visible", 0), false);
  assert.equal(shouldReconnectWhenVisible("visible", 1), false);
  assert.equal(shouldReconnectWhenVisible("visible", 2), false);
  assert.equal(shouldReconnectWhenVisible("visible", 3), true);
  assert.equal(shouldReconnectWhenVisible("hidden", 3), false);
});
