import test from "node:test";
import assert from "node:assert/strict";
import { readAccountRisk } from "../server/accountRisk.ts";

test("a trading-market account at 1x does not need permission to trade pre-launch markets", async () => {
  const original = globalThis.fetch;
  let settings: unknown = { "BTC-USD": { leverage: 1, margin_mode: "cross", allow_pre_trade: false } };
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    const payload = path === "/v2/account" ? {
      account_id: "fixture-account", blockchain: "ethereum", blockchain_address: `0x${"1".repeat(40)}`,
      available_balance: "250", wallet_balance: "250", margin_balance: "250", symbol_settings: settings,
    } : path === "/v2/positions" ? { count: 0, positions: [] }
      : { e: "markPriceUpdate", E: Date.now(), s: "BTC-USD", p: "60000" };
    return Response.json(payload);
  };
  try {
    assert.equal((await readAccountRisk("fixture-account")).absoluteExposure, "0");
    settings = { "BTC-USD": { leverage: 20, margin_mode: "cross", allow_pre_trade: true } };
    await assert.rejects(readAccountRisk("fixture-account"), /1x/);
    settings = undefined;
    await assert.rejects(readAccountRisk("fixture-account"), /1x/);
  } finally { globalThis.fetch = original; }
});
