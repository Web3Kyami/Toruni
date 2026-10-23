import type { PoolClient, QueryResultRow } from "pg";
import type { ScorePolicy, StrikeMark, VerifiedQuote } from "../shared/contracts.ts";
import { auditObservedTick } from "../shared/scoreLedger.ts";
import { scoringConstants } from "../shared/scoring.ts";
import type { RoundRules } from "./roundService.ts";

interface OrderRow extends QueryResultRow {
  observation_id: string; intent_id: string; client_order_id: string; side: "buy" | "sell";
  exchange_status: VerifiedQuote["status"]; exchange_order_id: string; price: string;
  original_qty: string; filled_qty: string; post_only: boolean;
  order_type: string; time_in_force: string;
  first_open_observed_at: Date | null; observed_at: Date;
}

export async function persistScoreTick(client: PoolClient, roundId: string, participantId: string,
  sampledAt: number, engineMinimumNotional: string | null): Promise<boolean> {
  const found = await client.query(`SELECT r.*,p.account_id FROM rounds r JOIN participants p ON p.round_id=r.id
    WHERE r.id=$1 AND p.id=$2 AND p.verification_state='verified' AND r.status='active' FOR UPDATE OF r`, [roundId, participantId]);
  const round = found.rows[0];
  if (!round) return false;
  const startsAt = (round.starts_at as Date).getTime();
  const endsAt = (round.ends_at as Date).getTime();
  if (sampledAt <= startsAt || sampledAt > endsAt || (sampledAt - startsAt) % 1000 !== 0) return false;
  const previous = await client.query<{ latest: Date | null }>("SELECT max(sampled_at) AS latest FROM score_samples WHERE round_id=$1 AND participant_id=$2", [roundId, participantId]);
  const previousAt = previous.rows[0]?.latest?.getTime() ?? startsAt;
  if (previousAt >= sampledAt) return false;
  const at = new Date(sampledAt);
  const markRow = (await client.query(`SELECT * FROM market_observations WHERE round_id=$1 AND observed_at<=$2 AND data_status='healthy' ORDER BY observed_at DESC LIMIT 1`, [roundId, at])).rows[0];
  const risk = (await client.query(`SELECT * FROM risk_observations WHERE round_id=$1 AND participant_id=$2 AND observed_at<=$3 ORDER BY observed_at DESC LIMIT 1`, [roundId, participantId, at])).rows[0];
  const orders = await client.query<OrderRow>(`SELECT DISTINCT ON (qi.side) oo.id::text AS observation_id,
    qi.id AS intent_id,qi.client_order_id,qi.side,qi.first_open_observed_at,oo.observed_at,
    oo.exchange_status,oo.exchange_order_id,oo.price::text,oo.original_qty::text,oo.filled_qty::text,oo.post_only,oo.order_type,oo.time_in_force
    FROM quote_intents qi JOIN LATERAL (SELECT * FROM order_observations obs WHERE obs.intent_id=qi.id
      AND obs.observed_at<=$3 ORDER BY obs.observed_at DESC LIMIT 1) oo ON true
    WHERE qi.round_id=$1 AND qi.participant_id=$2 AND qi.created_at<=$3
    ORDER BY qi.side,qi.sequence DESC,oo.observed_at DESC`, [roundId, participantId, at]);
  const quote = (row: OrderRow | undefined): VerifiedQuote | null => row ? {
    exchangeOrderId: row.exchange_order_id, accountId: round.account_id as string, clientOrderId: row.client_order_id,
    symbol: round.market as string, side: row.side, status: row.exchange_status, type: row.order_type, timeInForce: row.time_in_force,
    postOnly: row.post_only, size: row.original_qty, filled: row.filled_qty, price: row.price,
    firstOpenObservedAt: row.first_open_observed_at?.getTime() ?? 0,
    lastVerifiedAt: row.observed_at.getTime(), provenance: "strike-public-order-read",
  } : null;
  const bid = orders.rows.find(row => row.side === "buy");
  const ask = orders.rows.find(row => row.side === "sell");
  const rules = round.rules_json as RoundRules;
  const mark: StrikeMark | null = markRow && markRow.exchange_event_at instanceof Date && markRow.source === "strike-v2-testnet" ? {
    symbol: round.market as string, markPrice: String(markRow.mark),
    observedAt: (markRow.exchange_event_at as Date).getTime(), source: "strike-v2-testnet",
  } : null;
  const policy: ScorePolicy | null = risk && risk.source === "strike-independent-read" && risk.symbol_leverage === 1 && engineMinimumNotional ? {
    ...rules, minimumRemainingNotional: engineMinimumNotional, currentAbsoluteExposure: String(risk.absolute_exposure),
    riskObservedAt: (risk.observed_at as Date).getTime(), riskFreshnessLimitMs: 3000,
    markFreshnessLimitMs: 5000, orderFreshnessLimitMs: 3000, minimumDwellMs: 5000,
  } : null;
  const audited = auditObservedTick({ sampledAt, mark, riskPolicy: policy, bid: quote(bid), ask: quote(ask) },
    { startsAt, endsAt, accountId: round.account_id as string }, previousAt);
  const saved = await client.query(`INSERT INTO score_samples (round_id,participant_id,sampled_at,delta_scaled,
    points_per_minute_scaled,bid_intent_id,ask_intent_id,bid_quality_scaled,ask_quality_scaled,reason,scoring_version,
    policy_json,mark_observation_id,risk_observation_id,bid_observation_id,ask_observation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (round_id,participant_id,sampled_at) DO NOTHING RETURNING id`,
    [roundId, participantId, at, audited.deltaScaled, audited.pointsPerMinuteScaled, bid?.intent_id ?? null,
      ask?.intent_id ?? null, audited.bidQualityScaled, audited.askQualityScaled,
      JSON.stringify({ reason: audited.reason, bid: audited.bidReason, ask: audited.askReason }), scoringConstants.version,
      policy ? JSON.stringify(policy) : null, markRow?.id ?? null, risk?.id ?? null,
      bid?.observation_id ?? null, ask?.observation_id ?? null]);
  return Boolean(saved.rowCount);
}

/** Exact totals are computed in Postgres from the append-only sample ledger. */
export async function finalizeRoundResults(client: PoolClient, roundId: string, now: number): Promise<void> {
  await client.query(`INSERT INTO round_results (round_id,participant_id,total_scaled,score_version,
    verified_seconds,unscored_seconds,cleanup_state,finalized_at,bid_eligible_seconds,ask_eligible_seconds,two_sided_seconds,paused_seconds)
    SELECT p.round_id,p.id,coalesce(sum(s.delta_scaled),0),$2,
    count(s.id) FILTER (WHERE s.bid_quality_scaled>0 OR s.ask_quality_scaled>0),
    greatest(0,180-count(s.id) FILTER (WHERE s.bid_quality_scaled>0 OR s.ask_quality_scaled>0)),
    CASE WHEN EXISTS (SELECT 1 FROM quote_intents qi WHERE qi.participant_id=p.id AND qi.round_id=p.round_id AND qi.status<>'terminal')
      THEN 'unresolved' ELSE 'verified' END,$3,
    count(s.id) FILTER (WHERE s.bid_quality_scaled>0),count(s.id) FILTER (WHERE s.ask_quality_scaled>0),
    count(s.id) FILTER (WHERE s.bid_quality_scaled>0 AND s.ask_quality_scaled>0),
    greatest(0,180-count(s.id) FILTER (WHERE s.reason::jsonb->>'reason'='sampled'))
    FROM participants p JOIN rounds r ON r.id=p.round_id LEFT JOIN score_samples s ON s.participant_id=p.id AND s.round_id=p.round_id
    WHERE p.round_id=$1 AND p.verification_state='verified' AND r.status IN ('settling','review_required','completed')
      AND r.ends_at<=$3 GROUP BY p.id,p.round_id
    ON CONFLICT (round_id,participant_id) DO UPDATE SET cleanup_state=excluded.cleanup_state`, [roundId, scoringConstants.version, new Date(now)]);
}
