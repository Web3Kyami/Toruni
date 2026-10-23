import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { query, transaction } from "../server/database.ts";
import { applyMigrations } from "../server/migrations.ts";
import { enrollParticipant, issueQuoteIntent, recordOrderObservation, type IndependentAdmission } from "../server/roundService.ts";
import type { VerifiedQuote } from "../shared/contracts.ts";
import { finalizeRoundResults, persistScoreTick } from "../server/scorePersistence.ts";

class FixtureRollback extends Error {}
/** All fixture rows remain invisible to the app and are rolled back. No exchange write is made. */
export async function runPostgresChecks() {
  const applied = await applyMigrations();
  const now = Date.now();
  const sessionHash = createHash("sha256").update(randomUUID()).digest("hex");
  const otherSession = createHash("sha256").update(randomUUID()).digest("hex");
  const accountId = randomUUID();
  let roundId = "";
  let checks = 0;
  try {
    await transaction(async client => {
      for (const session of [sessionHash, otherSession]) await client.query(`INSERT INTO app_sessions
        (session_hash,csrf_hash,created_at,expires_at) VALUES ($1,$1,$2,$3)`, [session, new Date(now), new Date(now + 3_600_000)]);
      const admission: IndependentAdmission = { accountId, observedAt: now, availableCollateral: "1000",
        requiredCollateral: "200", absoluteExposure: "0", effectiveLeverage: 1, provenance: "strike-independent-read" };
      const rules = { symbol: "BTC-USD" as const, minimumRemainingNotional: "100", maximumQuoteNotional: "200", maximumAccountExposure: "200" };
      const participant = await enrollParticipant(client, sessionHash, admission, rules, now);
      roundId = participant.roundId;
      assert.equal(participant.verificationState, "unverified"); checks++;
      await assert.rejects(enrollParticipant(client, sessionHash, { ...admission, accountId: randomUUID() }, rules, now), /already enrolled/); checks++;
      await assert.rejects(enrollParticipant(client, otherSession, admission, rules, now), /already enrolled/); checks++;
      await assert.rejects(enrollParticipant(client, otherSession, { ...admission, observedAt: now - 3001 }, rules, now), /Refresh/); checks++;
      await assert.rejects(enrollParticipant(client, otherSession, { ...admission, effectiveLeverage: 20 }, rules, now), /1x/); checks++;
      await assert.rejects(issueQuoteIntent(client, sessionHash, "buy", now), /active round/); checks++;
      await client.query("UPDATE rounds SET status='active' WHERE id=$1", [roundId]);
      await assert.rejects(issueQuoteIntent(client, sessionHash, "buy", now), /active round/); checks++;
      const at = now + 16_000;
      const risk = { availableBalance: "1000", currentAbsoluteExposure: "0", requestedNotional: "100.245", maximumAccountExposure: "200", price: "81500", size: "0.00123" };
      const intent = await issueQuoteIntent(client, sessionHash, "buy", at, risk);
      assert.match(intent.clientOrderId, /^trn[0-9a-f]{32}$/); checks++;
      await assert.rejects(issueQuoteIntent(client, sessionHash, "buy", at, risk), /existing quote/); checks++;
      await assert.rejects(issueQuoteIntent(client, otherSession, "buy", at), /active round/); checks++;
      const quote: VerifiedQuote = { exchangeOrderId: "12345", accountId, clientOrderId: intent.clientOrderId,
        symbol: "BTC-USD", side: "buy", status: "pending", type: "limit", timeInForce: "GTC", postOnly: true,
        size: "0.00123", filled: "0", price: "81500", firstOpenObservedAt: 0, lastVerifiedAt: at + 1000,
        provenance: "strike-public-order-read" };
      await recordOrderObservation(client, quote);
      const pending = await client.query("SELECT account_id,verification_state FROM participants WHERE id=$1", [participant.participantId]);
      assert.equal(pending.rows[0].account_id, null); assert.equal(pending.rows[0].verification_state, "unverified"); checks++;
      await assert.rejects(recordOrderObservation(client, { ...quote, accountId: randomUUID() }), /does not match/); checks++;
      await assert.rejects(recordOrderObservation(client, { ...quote, clientOrderId: `trn${randomUUID().replaceAll('-', '')}` }), /does not match/); checks++;
      await assert.rejects(recordOrderObservation(client, { ...quote, size: "100" }), /terms do not match/); checks++;
      const open = { ...quote, status: "open" as const, firstOpenObservedAt: at + 2000, lastVerifiedAt: at + 2000 };
      await recordOrderObservation(client, open);
      const bound = await client.query("SELECT account_id,verification_state FROM participants WHERE id=$1", [participant.participantId]);
      assert.equal(bound.rows[0].account_id, accountId); assert.equal(bound.rows[0].verification_state, "verified"); checks++;
      await assert.rejects(recordOrderObservation(client, { ...open, exchangeOrderId: "54321" }), /identity changed/); checks++;
      for (const elapsed of [4000, 6000, 8000]) await recordOrderObservation(client, { ...open, lastVerifiedAt: at + elapsed });
      await client.query(`INSERT INTO market_observations (round_id,observed_at,exchange_event_at,mark,source,data_status)
        VALUES ($1,$2,$2,'81500','strike-v2-testnet','healthy')`, [roundId, new Date(at + 8500)]);
      await client.query(`INSERT INTO risk_observations (round_id,participant_id,observed_at,absolute_exposure,available_collateral,source,symbol_leverage)
        VALUES ($1,$2,$3,'0','1000','strike-independent-read',1)`, [roundId, participant.participantId, new Date(at + 8500)]);
      assert.equal(await persistScoreTick(client, roundId, participant.participantId, now + 25000, "100"), true); checks++;
      assert.equal(await persistScoreTick(client, roundId, participant.participantId, now + 26000, "100"), true); checks++;
      assert.equal(await persistScoreTick(client, roundId, participant.participantId, now + 26000, "100"), false); checks++;
      const ledger = await client.query("SELECT delta_scaled::text FROM score_samples WHERE round_id=$1 ORDER BY sampled_at", [roundId]);
      assert.deepEqual(ledger.rows.map(row => row.delta_scaled), ["0", "416666666666"]); checks++;
      await finalizeRoundResults(client, roundId, now + 27000);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM round_results WHERE round_id=$1", [roundId])).rows[0].count, 0); checks++;
      await recordOrderObservation(client, { ...quote, status: "canceled", lastVerifiedAt: at + 11000 });
      await assert.rejects(recordOrderObservation(client, { ...open, lastVerifiedAt: at + 12000 }), /older than/); checks++;
      const next = await issueQuoteIntent(client, sessionHash, "buy", at + 12000, risk);
      assert.notEqual(next.clientOrderId, intent.clientOrderId); checks++;
      await assert.rejects(issueQuoteIntent(client, sessionHash, "sell", now + 195_000), /active round/); checks++;
      await client.query("UPDATE rounds SET status='settling' WHERE id=$1", [roundId]);
      await finalizeRoundResults(client, roundId, now + 196000);
      const final = (await client.query("SELECT total_scaled::text,verified_seconds::text,cleanup_state FROM round_results WHERE round_id=$1", [roundId])).rows[0];
      assert.deepEqual(final, { total_scaled: "416666666666", verified_seconds: "1", cleanup_state: "unresolved" }); checks++;
      throw new FixtureRollback();
    });
  } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
  const residue = await query<{ count: string }>("SELECT count(*) FROM rounds WHERE id=$1", [roundId]);
  assert.equal(residue[0]?.count, "0"); checks++;
  return { passed: checks, migrationsApplied: applied, fixtureRowsPersisted: 0, exchangeWrites: 0 };
}
