import assert from "node:assert/strict";
import test from "node:test";
import { parseMark, parsePublicOrder, verifyPublicOrder } from "../server/strike.ts";

test("parses Strike's documented mark event fields and preserves exchange time", () => {
  const eventTime = 1_700_000_000_000;
  const mark = parseMark("BTC-USD", {
    e: "markPriceUpdate",
    E: eventTime,
    s: "BTC-USD",
    p: "43250.10",
  });

  assert.deepEqual(mark, {
    symbol: "BTC-USD",
    markPrice: "43250.10",
    observedAt: eventTime,
    source: "strike-v2-testnet",
  });
});

test("rejects wrong-symbol and undated mark records", () => {
  assert.equal(parseMark("BTC-USD", { E: 1_700_000_000_000, s: "ETH-USD", p: "2500" }), null);
  assert.equal(parseMark("BTC-USD", { s: "BTC-USD", p: "43250.10" }), null);
});

const intent = {
  accountId: "fixture-account", clientOrderId: "fixture-order", symbol: "BTC-USD", side: "buy" as const,
  firstOpenObservedAt: 10_000, lastVerifiedAt: 16_000,
};
const order = {
  ID: "12345",
  AccountID: "fixture-account", ClientOrderID: "fixture-order", Symbol: "BTC-USD", Side: "BUY",
  Status: "OPEN", Type: "limit", TimeInForce: "GTC", PostOnly: true,
  Size: "0.001", Filled: "0", Price: "50000",
};

test("independent order reads bind account, intent, symbol and side and require fill quantity", () => {
  for (const altered of [{ ...order, AccountID: "other-account" }, { ...order, ClientOrderID: "other-order" },
    { ...order, Symbol: "ETH-USD" }, { ...order, Side: "SELL" }, { ...order, Filled: undefined }]) {
    assert.equal(parsePublicOrder(altered, intent, 18_000).kind, "integrity-error");
  }
});

test("continuously observed OPEN preserves dwell, gaps and terminal states reset it", () => {
  const continued = parsePublicOrder(order, intent, 18_000);
  const gap = parsePublicOrder(order, intent, 19_001);
  const terminal = parsePublicOrder({ ...order, Status: "CANCELED" }, intent, 18_000);
  assert.equal(continued.kind === "observed" && continued.quote.firstOpenObservedAt, 10_000);
  assert.equal(gap.kind === "observed" && gap.quote.firstOpenObservedAt, 19_001);
  assert.equal(terminal.kind === "observed" && terminal.quote.firstOpenObservedAt, 0);
});

test("404 and 429 order reads stay unproven and never become a fill or open order", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    assert.deepEqual(await verifyPublicOrder(intent), { kind: "not-found" });
    globalThis.fetch = async () => new Response("{}", { status: 429 });
    assert.deepEqual(await verifyPublicOrder(intent), { kind: "unavailable", status: 429 });
  } finally { globalThis.fetch = original; }
});
