import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { formatScore } from "../shared/scoring.ts";

export class DatabaseUnavailableError extends Error {}
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 6_000,
  statement_timeout: 5_000,
  lock_timeout: 2_000,
  idle_in_transaction_session_timeout: 10_000,
}) : null;
const configuredDatabaseUrl = process.env.DATABASE_URL;
const configuredDatabaseIsPooler = (() => {
  if (!configuredDatabaseUrl) return false;
  try { return new URL(configuredDatabaseUrl).hostname.includes("-pooler."); }
  catch { return false; }
})();
const leaderConnectionString = process.env.DATABASE_URL_UNPOOLED
  || (configuredDatabaseIsPooler ? undefined : configuredDatabaseUrl);
const leaderPool = leaderConnectionString ? new Pool({
  connectionString: leaderConnectionString,
  max: 1,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 6_000,
  statement_timeout: 5_000,
  lock_timeout: 2_000,
  idle_in_transaction_session_timeout: 10_000,
}) : null;
pool?.on("error", () => { process.stderr.write("Toruni database connection interrupted.\n"); });
leaderPool?.on("error", () => { process.stderr.write("Toruni scoring leader connection interrupted.\n"); });

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  if (!pool) throw new DatabaseUnavailableError("Round service unavailable.");
  return (await pool.query<T>(text, values)).rows;
}

export async function transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new DatabaseUnavailableError("Round service unavailable.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

interface RoundRow extends QueryResultRow {
  id: string; market: string; status: string; starts_at: Date; ends_at: Date;
  settlement_deadline: Date; scoring_version: string; participant_count: string;
}
function roundView(row: RoundRow) {
  return {
    id: row.id, symbol: row.market, status: row.status,
    startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime(),
    settlementDeadline: row.settlement_deadline.getTime(), scoringVersion: row.scoring_version,
    participantCount: Number(row.participant_count),
  };
}
const roundSelect = `SELECT r.*, (SELECT count(*) FROM participants p
  WHERE p.round_id = r.id AND p.verification_state = 'verified') AS participant_count FROM rounds r`;

export async function readCurrentRound() {
  const rows = await query<RoundRow>(`${roundSelect} WHERE r.status IN ('lobby','active','settling','review_required') ORDER BY r.created_at DESC LIMIT 1`);
  return { serverTime: Date.now(), round: rows[0] ? roundView(rows[0]) : null };
}

export async function readScoringHeartbeat(roundId: string): Promise<number | null> {
  const rows = await query<{ latest: Date | null }>(`SELECT max(observed_at) AS latest FROM market_observations WHERE round_id=$1`, [roundId]);
  return rows[0]?.latest instanceof Date ? rows[0].latest.getTime() : null;
}

export async function readRoundReport(roundId: string) {
  const rounds = await query<RoundRow>(`${roundSelect} WHERE r.id = $1`, [roundId]);
  if (!rounds[0]) return null;
  const participants = await query<{
    participant_id: string; total_scaled: string; verified_seconds: string;
    unscored_seconds: string; bid_eligible_seconds: number; ask_eligible_seconds: number; two_sided_seconds: number; paused_seconds: number; cleanup_state: string; finalized_at: Date;
  }>(`SELECT rr.participant_id, rr.total_scaled::text, rr.verified_seconds::text,
    rr.unscored_seconds::text, rr.bid_eligible_seconds, rr.ask_eligible_seconds, rr.two_sided_seconds, rr.paused_seconds, rr.cleanup_state, rr.finalized_at
    FROM round_results rr JOIN participants p ON p.id = rr.participant_id AND p.round_id = rr.round_id
    WHERE rr.round_id = $1 AND p.verification_state = 'verified' ORDER BY rr.total_scaled DESC`, [roundId]);
  const orders = await query(`SELECT DISTINCT ON (qi.id) qi.client_order_id, qi.side,
    oo.observed_at, oo.exchange_status, oo.exchange_order_id, oo.price::text,
    oo.original_qty::text, oo.filled_qty::text
    FROM quote_intents qi JOIN order_observations oo ON oo.intent_id = qi.id
    JOIN participants p ON p.id = qi.participant_id AND p.verification_state = 'verified'
    WHERE qi.round_id = $1 ORDER BY qi.id, oo.observed_at DESC`, [roundId]);
  return {
    serverTime: Date.now(), round: roundView(rounds[0]),
    participants: participants.map(row => ({
      participantId: row.participant_id, score: formatScore(BigInt(row.total_scaled)),
      totalScaled: row.total_scaled, verifiedSeconds: row.verified_seconds,
      unscoredSeconds: row.unscored_seconds, bidSeconds: row.bid_eligible_seconds, askSeconds: row.ask_eligible_seconds,
      twoSidedSeconds: row.two_sided_seconds, pausedSeconds: row.paused_seconds, cleanupState: row.cleanup_state,
      finalizedAt: row.finalized_at.getTime(),
    })), orders,
  };
}

export async function readRoundAudit(roundId: string) {
  return query(`SELECT sampled_at, participant_id, delta_scaled::text, points_per_minute_scaled::text,
    bid_quality_scaled::text, ask_quality_scaled::text, reason, scoring_version, policy_json,
    mark_observation_id::text, risk_observation_id::text, bid_observation_id::text, ask_observation_id::text
    FROM score_samples WHERE round_id = $1 ORDER BY sampled_at, participant_id LIMIT 2000`, [roundId]);
}

export async function closeDatabase(): Promise<void> { await Promise.all([pool?.end(), leaderPool?.end()]); }

export function scoringLeaderConfigured(): boolean { return leaderPool !== null; }

export async function acquireScoringLeader(): Promise<{ held: () => boolean; release: () => Promise<void> } | null> {
  if (!leaderPool) return null;
  const client = await leaderPool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('toruni-single-score-leader')) AS acquired");
    if (!result.rows[0]?.acquired) { client.release(); return null; }
    let held = true;
    const interrupted = () => { held = false; };
    client.on("error", interrupted);
    return {
      held: () => held,
      release: async () => {
        const shouldUnlock = held;
        held = false;
        client.removeListener("error", interrupted);
        try {
          if (shouldUnlock) await client.query("SELECT pg_advisory_unlock(hashtext('toruni-single-score-leader'))");
          client.release();
        } catch (error) {
          client.release(error instanceof Error ? error : new Error("Scoring leader connection failed."));
          throw error;
        }
      },
    };
  } catch (error) { client.release(); throw error; }
}

export async function readLeaderboard(roundId: string) {
  const rows = await query<{ id: string; total_scaled: string; sampled_at: Date | null }>(`SELECT p.id,
    coalesce(sum(s.delta_scaled),0)::text AS total_scaled,max(s.sampled_at) AS sampled_at
    FROM participants p LEFT JOIN score_samples s ON s.participant_id=p.id AND s.round_id=p.round_id
    WHERE p.round_id=$1 AND p.verification_state='verified' GROUP BY p.id ORDER BY sum(s.delta_scaled) DESC NULLS LAST`, [roundId]);
  return { serverTime: Date.now(), makers: rows.map(row => ({ participantId: row.id,
    score: formatScore(BigInt(row.total_scaled)), asOf: row.sampled_at?.getTime() ?? null })) };
}

export async function readParticipantSnapshot(sessionHash: string) {
  const rows = await query(`SELECT p.*,r.status AS round_status,r.starts_at,r.ends_at FROM participants p
    JOIN rounds r ON r.id=p.round_id WHERE p.session_hash=$1 ORDER BY p.joined_at DESC LIMIT 1`, [sessionHash]);
  const participant = rows[0];
  if (!participant) return { serverTime: Date.now(), participant: null, orders: [] };
  const samples = await query<{ total: string; sampled_at: Date | null; side_reason: string | null }>(`SELECT
    coalesce(sum(s.delta_scaled),0)::text AS total,max(s.sampled_at) AS sampled_at,
    (SELECT latest.reason FROM score_samples latest WHERE latest.participant_id=$1 AND latest.round_id=$2
      ORDER BY latest.sampled_at DESC LIMIT 1) AS side_reason
    FROM score_samples s WHERE s.participant_id=$1 AND s.round_id=$2`, [participant.id, participant.round_id]);
  const orders = await query(`SELECT qi.client_order_id,qi.side,qi.status AS intent_status,qi.verification_error,
    qi.last_checked_at,qi.first_open_observed_at,oo.exchange_order_id,oo.exchange_status,oo.price::text,
    oo.original_qty::text,oo.filled_qty::text,oo.observed_at FROM quote_intents qi LEFT JOIN LATERAL
    (SELECT * FROM order_observations obs WHERE obs.intent_id=qi.id ORDER BY obs.observed_at DESC LIMIT 1) oo ON true
    WHERE qi.participant_id=$1 AND qi.round_id=$2 ORDER BY qi.created_at`, [participant.id, participant.round_id]);
  return { serverTime: Date.now(), participant: { id: participant.id, roundId: participant.round_id,
    verificationState: participant.verification_state, roundStatus: participant.round_status,
    startsAt: (participant.starts_at as Date).getTime(), endsAt: (participant.ends_at as Date).getTime(),
    score: participant.verification_state === 'verified' ? formatScore(BigInt(samples[0]?.total ?? "0")) : null,
    sideReasons: parseScoreSideReasons(samples[0]?.side_reason ?? null),
    asOf: samples[0]?.sampled_at?.getTime() ?? null }, orders };
}

function parseScoreSideReasons(value: string | null): { bid: string; ask: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const reasons = parsed as Record<string, unknown>;
    return typeof reasons.bid === "string" && typeof reasons.ask === "string"
      ? { bid: reasons.bid, ask: reasons.ask }
      : null;
  } catch { return null; }
}
