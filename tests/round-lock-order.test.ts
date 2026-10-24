import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { VerifiedQuote } from "../shared/contracts.ts";
import { issueQuoteIntent, recordOrderObservation, RoundGuardError } from "../server/roundService.ts";

function sequencedClient(rowCounts: number[]) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      const rowCount = rowCounts[statements.length - 1] ?? 0;
      return { rowCount, rows: rowCount ? [{ id: "fixture-round" }] : [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

test("quote intent creation locks the round before participant rows", async () => {
  const { client, statements } = sequencedClient([1, 0]);
  await assert.rejects(issueQuoteIntent(client, "fixture-session", "buy", 1_000), RoundGuardError);
  assert.match(statements[0]!, /FOR UPDATE OF r/);
  assert.match(statements[1]!, /FOR UPDATE OF p/);
});

test("quote intent refuses risk evidence for a different locked round market", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (statements.length === 1) return { rowCount: 1, rows: [{ id: "fixture-round" }] };
      if (statements.length === 2) return { rowCount: 1, rows: [{ participant_id: "fixture-participant", round_id: "fixture-round",
        market: "BTC-USD", starts_at: new Date(1_000), ends_at: new Date(181_000) }] };
      throw new Error("Market mismatch should be rejected before reading or writing quote rows.");
    },
  } as unknown as PoolClient;
  await assert.rejects(issueQuoteIntent(client, "fixture-session", "buy", 2_000, {
    symbol: "ETH-USD", availableBalance: "1000", currentAbsoluteExposure: "0", requestedNotional: "100",
    maximumAccountExposure: "1000", price: "100", size: "1",
  }), /round market changed/i);
  assert.equal(statements.length, 2);
});

test("order observations lock the round before participant and intent rows", async () => {
  const { client, statements } = sequencedClient([1, 0]);
  const quote: VerifiedQuote = {
    exchangeOrderId: "123", accountId: "fixture-account", clientOrderId: "trnfixture", symbol: "BTC-USD",
    side: "buy", status: "open", type: "limit", timeInForce: "GTC", postOnly: true,
    size: "0.001", filled: "0", price: "50000", firstOpenObservedAt: 1_000,
    lastVerifiedAt: 1_000, provenance: "strike-public-order-read",
  };
  await assert.rejects(recordOrderObservation(client, quote), RoundGuardError);
  assert.match(statements[0]!, /FOR UPDATE OF r/);
  assert.match(statements[1]!, /FOR UPDATE OF qi,p/);
});
