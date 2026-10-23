import test from "node:test";
import assert from "node:assert/strict";
import { assertFreshRisk, readAccountRisk } from "../server/accountRisk.ts";

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

test("risk and market freshness use their separate 3-second and 5-second limits", async () => {
  const original = globalThis.fetch;
  const markObservedAt = Date.now() - 4_000;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    const payload = path === "/v2/account" ? {
      account_id: "fixture-account", blockchain: "ethereum", blockchain_address: `0x${"1".repeat(40)}`,
      available_balance: "250", wallet_balance: "250", margin_balance: "250",
      symbol_settings: { "BTC-USD": { leverage: 1, margin_mode: "cross", allow_pre_trade: false } },
    } : path === "/v2/positions" ? { count: 0, positions: [] }
      : { e: "markPriceUpdate", E: markObservedAt, s: "BTC-USD", p: "60000" };
    return Response.json(payload);
  };
  try {
    const risk = await readAccountRisk("fixture-account");
    const now = Date.now();
    assert.ok(now - risk.observedAt < 1_000, "account and position timestamps remain current");
    assert.equal(risk.mark.observedAt, markObservedAt);
    assert.doesNotThrow(() => assertFreshRisk(risk, now), "a valid 4-second mark must not invalidate fresh account reads");
    assert.throws(() => assertFreshRisk({ ...risk, observedAt: now - 3_001 }, now), /must be current/);
    assert.throws(() => assertFreshRisk({ ...risk, mark: { ...risk.mark, observedAt: now - 5_001 } }, now), /must be current/);
  } finally { globalThis.fetch = original; }
});
