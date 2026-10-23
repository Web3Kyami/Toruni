import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { StrikeSide, VerifiedQuote } from "../shared/contracts.ts";
import { alignDecimals, compareDecimals, formatDecimal, multiplyDecimals, parseDecimal, subtractDecimals } from "../shared/decimal.ts";
import { scoringConstants } from "../shared/scoring.ts";

export class RoundGuardError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
export interface RoundRules {
  symbol: "BTC-USD";
  minimumRemainingNotional: string;
  maximumQuoteNotional: string;
  maximumAccountExposure: string;
}
export interface IndependentAdmission {
  accountId: string;
  observedAt: number;
  availableCollateral: string;
  requiredCollateral: string;
  absoluteExposure: string;
  effectiveLeverage: number;
  provenance: "strike-independent-read";
}

export async function enrollParticipant(client: PoolClient, sessionHash: string,
  admission: IndependentAdmission, rules: RoundRules, now: number) {
  const available = parseDecimal(admission.availableCollateral);
  const required = parseDecimal(admission.requiredCollateral);
  const exposure = parseDecimal(admission.absoluteExposure);
  const minimum = parseDecimal(rules.minimumRemainingNotional);
  const cap = parseDecimal(rules.maximumQuoteNotional);
  const exposureLimit = parseDecimal(rules.maximumAccountExposure);
  if (!available || !required || !exposure || !minimum || !cap || !exposureLimit
    || required.coefficient <= 0n || minimum.coefficient <= 0n || exposure.coefficient < 0n || exposureLimit.coefficient <= 0n
    || compareDecimals(cap, minimum) < 0 || compareDecimals(available, required) < 0
    || compareDecimals(exposure, exposureLimit) > 0) {
    throw new RoundGuardError("Credited collateral and round limits must be verified before joining.", 423);
  }
  if (admission.provenance !== "strike-independent-read" || admission.effectiveLeverage !== 1
    || now < admission.observedAt || now - admission.observedAt > 3_000) {
    throw new RoundGuardError("Refresh account risk and confirm 1x leverage before joining.", 423);
  }
  const session = await client.query("SELECT session_hash FROM app_sessions WHERE session_hash = $1 AND expires_at > $2", [sessionHash, new Date(now)]);
  if (!session.rowCount) throw new RoundGuardError("Session expired. Reopen Toruni before joining.", 401);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('toruni-enrollment'))");
  let round = (await client.query(`SELECT * FROM rounds WHERE status IN ('lobby','active','settling','review_required') FOR UPDATE`)).rows[0];
  if (!round) {
    round = (await client.query(`INSERT INTO rounds (id,market,status,lobby_opened_at,starts_at,ends_at,
      settlement_deadline,scoring_version,rules_json) VALUES ($1,$2,'lobby',$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), rules.symbol, new Date(now), new Date(now + 15_000), new Date(now + 195_000),
        new Date(now + 210_000), scoringConstants.version, JSON.stringify(rules)])).rows[0];
  }
  if (round.status !== "lobby" || now >= (round.starts_at as Date).getTime()) throw new RoundGuardError("This round has started. Watch it and join the next round.");
  const enrolled = await client.query(`SELECT id FROM participants WHERE round_id = $1 AND (session_hash = $2 OR claimed_account_id = $3)`,
    [round.id, sessionHash, admission.accountId]);
  if (enrolled.rowCount) throw new RoundGuardError("This session or Strike account is already enrolled.");
  const count = await client.query<{ count: string }>("SELECT count(*) FROM participants WHERE round_id = $1", [round.id]);
  if (Number(count.rows[0]?.count) >= 8) throw new RoundGuardError("This round is full.");
  const participantId = randomUUID();
  await client.query(`INSERT INTO participants (id,round_id,session_hash,claimed_account_id,verification_state,joined_at,consent_at)
    VALUES ($1,$2,$3,$4,'unverified',$5,$5)`, [participantId, round.id, sessionHash, admission.accountId, new Date(now)]);
  return { participantId, roundId: round.id as string, startsAt: (round.starts_at as Date).getTime(), verificationState: "unverified" as const };
}

export async function issueQuoteIntent(client: PoolClient, sessionHash: string, side: StrikeSide, now: number,
  risk?: { availableBalance: string; currentAbsoluteExposure: string; requestedNotional: string; maximumAccountExposure: string; price: string; size: string }) {
  if (side !== "buy" && side !== "sell") throw new RoundGuardError("Choose bid or ask.", 400);
  const rows = await client.query(`SELECT p.id AS participant_id,p.round_id,r.market,r.starts_at,r.ends_at
    FROM participants p JOIN rounds r ON r.id = p.round_id JOIN app_sessions s ON s.session_hash=p.session_hash
    WHERE p.session_hash = $1 AND r.status = 'active' AND s.expires_at > $2 FOR UPDATE OF p`, [sessionHash, new Date(now)]);
  const row = rows.rows[0];
  if (!row || now < (row.starts_at as Date).getTime() || now >= (row.ends_at as Date).getTime()) {
    throw new RoundGuardError("Join an active round before requesting an order intent.");
  }
  if (!risk) throw new RoundGuardError("Refresh Strike balance and positions before reviewing this quote.", 423);
  const availableBalance = parseDecimal(risk.availableBalance);
  const currentExposure = parseDecimal(risk.currentAbsoluteExposure);
  const requestedNotional = parseDecimal(risk.requestedNotional);
  const exposureLimit = parseDecimal(risk.maximumAccountExposure);
  const price = parseDecimal(risk.price);
  const size = parseDecimal(risk.size);
  if (!availableBalance || !currentExposure || !requestedNotional || !exposureLimit || !price || !size
    || availableBalance.coefficient < 0n || currentExposure.coefficient < 0n || requestedNotional.coefficient <= 0n
    || exposureLimit.coefficient <= 0n || price.coefficient <= 0n || size.coefficient <= 0n
    || compareDecimals(multiplyDecimals(price, size), requestedNotional) !== 0) {
    throw new RoundGuardError("Strike risk data could not be verified.", 423);
  }
  if (compareDecimals(availableBalance, requestedNotional) < 0) {
    throw new RoundGuardError("Available Strike collateral is below this quote’s notional.", 423);
  }
  const outstanding = await client.query(`SELECT id FROM quote_intents WHERE participant_id = $1 AND round_id = $2 AND side = $3 AND status <> 'terminal'`,
    [row.participant_id, row.round_id, side]);
  if (outstanding.rowCount) throw new RoundGuardError("Resolve the existing quote on this side before creating another.");
  const activeOrders = await client.query(`SELECT qi.status,oo.exchange_status,oo.price::text AS price,
      oo.original_qty::text AS original_qty,oo.filled_qty::text AS filled_qty,oo.observed_at
    FROM quote_intents qi LEFT JOIN LATERAL (SELECT exchange_status,price,original_qty,filled_qty,observed_at
      FROM order_observations WHERE intent_id=qi.id ORDER BY observed_at DESC LIMIT 1) oo ON true
    WHERE qi.participant_id=$1 AND qi.round_id=$2 AND qi.status<>'terminal' FOR UPDATE OF qi`, [row.participant_id, row.round_id]);
  let restingExposure = { coefficient: 0n, scale: 0 };
  for (const order of activeOrders.rows) {
    if (order.status !== "observed" || order.exchange_status !== "open" || !(order.observed_at instanceof Date)
      || now < order.observed_at.getTime() || now - order.observed_at.getTime() > 3_000) {
      throw new RoundGuardError("Wait for Strike to confirm your existing offer before adding another.", 423);
    }
    const price = parseDecimal(String(order.price));
    const original = parseDecimal(String(order.original_qty));
    const filled = parseDecimal(String(order.filled_qty));
    if (!price || !original || !filled || price.coefficient <= 0n || filled.coefficient < 0n) {
      throw new RoundGuardError("An existing offer has incomplete risk data. Refresh its status first.", 423);
    }
    const remaining = subtractDecimals(original, filled);
    if (remaining.coefficient <= 0n) continue;
    const notional = multiplyDecimals(remaining, price);
    const [left, right, scale] = alignDecimals(restingExposure, notional);
    restingExposure = { coefficient: left + right, scale };
  }
  const proposedTotal = [formatDecimal(currentExposure), formatDecimal(restingExposure), risk.requestedNotional]
    .map(value => parseDecimal(value)!)
    .reduce((sum, value) => {
      const [left, right, scale] = alignDecimals(sum, value);
      return { coefficient: left + right, scale };
    }, { coefficient: 0n, scale: 0 });
  if (compareDecimals(proposedTotal, exposureLimit) > 0) {
    throw new RoundGuardError("This quote would exceed the round’s position and order exposure limit.", 423);
  }
  const sequence = await client.query<{ next_sequence: number }>(`SELECT coalesce(max(sequence),0)+1 AS next_sequence FROM quote_intents WHERE participant_id = $1 AND round_id = $2 AND side = $3`, [row.participant_id, row.round_id, side]);
  const clientOrderId = `trn${randomBytes(16).toString("hex")}`;
  await client.query(`INSERT INTO quote_intents (id,participant_id,round_id,side,client_order_id,sequence,status,created_at,next_verify_at,requested_price,requested_size)
    VALUES ($1,$2,$3,$4,$5,$6,'issued',$7,$8,$9,$10)`, [randomUUID(), row.participant_id, row.round_id, side, clientOrderId,
      sequence.rows[0]!.next_sequence, new Date(now), new Date(now + 4_000), risk.price, risk.size]);
  return { clientOrderId, roundId: row.round_id as string, symbol: row.market as string, side };
}

export async function recordOrderObservation(client: PoolClient, quote: VerifiedQuote): Promise<void> {
  if (quote.provenance !== "strike-public-order-read") throw new RoundGuardError("Independent Strike order evidence is required.");
  const found = await client.query(`SELECT qi.*, p.claimed_account_id, p.account_id, r.market FROM quote_intents qi
    JOIN participants p ON p.id = qi.participant_id AND p.round_id = qi.round_id
    JOIN rounds r ON r.id = qi.round_id WHERE qi.client_order_id = $1 FOR UPDATE OF qi,p`, [quote.clientOrderId]);
  const intent = found.rows[0];
  if (!intent || intent.claimed_account_id !== quote.accountId || (intent.account_id && intent.account_id !== quote.accountId)
    || intent.side !== quote.side || intent.market !== quote.symbol || quote.lastVerifiedAt < (intent.created_at as Date).getTime()) {
    throw new RoundGuardError("Order evidence does not match a prior session-bound intent.");
  }
  const requestedPrice = parseDecimal(String(intent.requested_price));
  const requestedSize = parseDecimal(String(intent.requested_size));
  const observedPrice = parseDecimal(quote.price);
  const observedSize = parseDecimal(quote.size);
  if (!requestedPrice || !requestedSize || !observedPrice || !observedSize
    || compareDecimals(requestedPrice, observedPrice) !== 0 || compareDecimals(requestedSize, observedSize) !== 0) {
    throw new RoundGuardError("Observed order terms do not match the risk-checked quote intent.");
  }
  if ((intent.last_verified_at && quote.lastVerifiedAt < (intent.last_verified_at as Date).getTime())
    || (intent.status === "terminal" && (quote.status === "open" || quote.status === "pending"))) {
    throw new RoundGuardError("Order evidence is older than the verified lifecycle.");
  }
  const priorId = await client.query<{ exchange_order_id: string }>("SELECT exchange_order_id FROM order_observations WHERE intent_id=$1 ORDER BY observed_at DESC LIMIT 1", [intent.id]);
  if (priorId.rows[0] && priorId.rows[0].exchange_order_id !== quote.exchangeOrderId) {
    throw new RoundGuardError("Strike order identity changed for an existing intent.");
  }
  const maker = quote.postOnly && quote.type === "limit" && quote.timeInForce === "GTC";
  if (quote.status === "open" && maker) {
    await client.query("UPDATE participants SET account_id = $1, verification_state = 'verified' WHERE id = $2 AND round_id = $3", [quote.accountId, intent.participant_id, intent.round_id]);
  }
  const terminal = ["filled", "canceled", "expired", "rejected"].includes(quote.status);
  const previousVerifiedAt = intent.last_verified_at instanceof Date ? intent.last_verified_at.getTime() : null;
  const previousOpenAt = intent.first_open_observed_at instanceof Date ? intent.first_open_observed_at.getTime() : null;
  const continuousOpen = previousVerifiedAt !== null && previousOpenAt !== null
    && quote.lastVerifiedAt >= previousVerifiedAt && quote.lastVerifiedAt - previousVerifiedAt <= 3_000;
  const firstOpenAt = quote.status === "open" && maker
    ? (continuousOpen ? Math.max(previousOpenAt!, quote.firstOpenObservedAt) : quote.lastVerifiedAt) : null;
  const digest = createHash("sha256").update(JSON.stringify(quote)).digest("hex");
  await client.query(`INSERT INTO order_observations (intent_id,participant_id,round_id,observed_at,exchange_status,
    exchange_order_id,price,original_qty,filled_qty,post_only,raw_digest,order_type,time_in_force) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [intent.id, intent.participant_id, intent.round_id, new Date(quote.lastVerifiedAt), quote.status,
      quote.exchangeOrderId, quote.price, quote.size, quote.filled, quote.postOnly, digest, quote.type, quote.timeInForce]);
  await client.query(`UPDATE quote_intents SET status=$1,first_open_observed_at=$2,last_verified_at=$3,
    last_checked_at=$3,verification_error=NULL,verification_failures=0,next_verify_at=$4 WHERE id=$5`,
    [terminal ? "terminal" : "observed", firstOpenAt === null ? null : new Date(firstOpenAt),
      new Date(quote.lastVerifiedAt), new Date(quote.lastVerifiedAt + 2_000), intent.id]);
}
