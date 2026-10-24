import { acquireScoringLeader, query, readCurrentRound, transaction } from "./database.ts";
import { readFreshMark, readMarketSnapshot, readPublicAccount, readPublicPositions, verifyPublicOrder } from "./strike.ts";
import { recordOrderObservation } from "./roundService.ts";
import { finalizeRoundResults, persistScoreTick } from "./scorePersistence.ts";
import { advanceRound, type RoundStatus } from "../shared/roundLifecycle.ts";
import { formatDecimal, multiplyDecimals, parseDecimal } from "../shared/decimal.ts";
import { publishEvent } from "./events.ts";
import { drainWorkerTasks } from "./workerRuntime.ts";
import type { StrikeMarketRules } from "../shared/contracts.ts";

const WORKER_STOP_DRAIN_MS = 10_000;

export interface RoundWorkerHandle {
  ready: Promise<boolean>;
  stop: () => Promise<void>;
}

function failureLabel(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as { name?: unknown; code?: unknown };
  const name = typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value.name) ? value.name : "Error";
  const code = typeof value.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(value.code) ? value.code : null;
  return code ? `${name}:${code}` : name;
}

/** One database-held leader; collectors and fixed-slot sampler never submit or cancel orders. */
export function startRoundWorker(options: { roundId?: string } = {}): RoundWorkerHandle {
  let stopped = false;
  let leader: Awaited<ReturnType<typeof acquireScoringLeader>> = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cycleTask: Promise<void> | null = null;
  let collectionTask: Promise<void> | null = null;
  let engineRules: StrikeMarketRules | null = null;
  let lastRulesRead = 0;
  let lastOrderPoll = 0;
  let lastRiskPoll = 0;
  let lastMarkPoll = 0;
  let activeRoundId: string | null = null;
  let lastSampleSlot: number | null = null;
  let lastPublished = 0;
  let lastDiagnosticAt = 0;
  let collectionRunning = false;
  let readySettled = false;
  let resolveReady!: (acquired: boolean) => void;
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const markReady = (acquired: boolean) => {
    if (!readySettled) { readySettled = true; resolveReady(acquired); }
  };
  const mayWrite = () => !stopped && Boolean(leader?.held());

  const resetContinuity = async () => {
    await query(`UPDATE quote_intents SET first_open_observed_at=NULL,last_verified_at=NULL,
      verification_error='reconciling-after-restart',next_verify_at=NULL WHERE status<>'terminal'`);
  };
  const collect = async (roundId: string, now: number) => {
    if (collectionRunning) return;
    collectionRunning = true;
    try {
      const jobs: Promise<unknown>[] = [];
      if (now - lastRulesRead >= 15_000 || !engineRules) {
        lastRulesRead = now;
        jobs.push(readMarketSnapshot("BTC-USD").then(snapshot => { engineRules = snapshot.marketRules; }));
      }
      if (now - lastMarkPoll >= 1000) {
        lastMarkPoll = now;
        jobs.push((async () => {
          const mark = await readFreshMark();
          if (mark && mayWrite()) await query(`INSERT INTO market_observations (round_id,observed_at,exchange_event_at,mark,source,data_status)
            VALUES ($1,$2,$3,$4,'strike-v2-testnet','healthy')`, [roundId, new Date(), new Date(mark.observedAt), mark.markPrice]);
        })());
      }
      if (now - lastOrderPoll >= 2_000) {
        lastOrderPoll = now;
        jobs.push((async () => {
          const intents = await query(`SELECT qi.*,p.claimed_account_id,r.market FROM quote_intents qi
            JOIN participants p ON p.id=qi.participant_id JOIN rounds r ON r.id=qi.round_id
            WHERE qi.round_id=$1 AND qi.status<>'terminal' AND (qi.next_verify_at IS NULL OR qi.next_verify_at<=$2)
            ORDER BY qi.created_at LIMIT 16`, [roundId, new Date(now)]);
          // Two readers at a time bound exchange concurrency and database use.
          for (let index = 0; index < intents.length; index += 2) await Promise.all(intents.slice(index, index + 2).map(async intent => {
            const result = await verifyPublicOrder({ accountId: intent.claimed_account_id as string,
              clientOrderId: intent.client_order_id as string, symbol: intent.market as string, side: intent.side as "buy" | "sell",
              firstOpenObservedAt: intent.first_open_observed_at instanceof Date ? intent.first_open_observed_at.getTime() : null,
              lastVerifiedAt: intent.last_verified_at instanceof Date ? intent.last_verified_at.getTime() : undefined });
            if (!mayWrite()) return;
            if (result.kind === "observed") {
              await transaction(client => mayWrite() ? recordOrderObservation(client, result.quote) : Promise.resolve());
            } else {
              const failures = Number(intent.verification_failures) + 1;
              const code = result.kind === "unavailable" ? `strike-${result.status}` : result.kind;
              const delay = result.kind === "unavailable" && result.status === 429 ? Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4)) : 2_000;
              await query(`UPDATE quote_intents SET status='unknown',verification_error=$1,verification_failures=$2,
                last_checked_at=$3,next_verify_at=$4,first_open_observed_at=NULL,last_verified_at=NULL WHERE id=$5 AND status<>'terminal'`,
                [code, failures, new Date(), new Date(Date.now() + delay), intent.id]);
            }
          }));
        })());
      }
      if (now - lastRiskPoll >= 2_000) {
        lastRiskPoll = now;
        jobs.push((async () => {
          const participants = await query("SELECT id,account_id FROM participants WHERE round_id=$1 AND verification_state='verified' LIMIT 8", [roundId]);
          for (const participant of participants) {
            try {
            const [account, positions, mark] = await Promise.all([
              readPublicAccount({ accountId: participant.account_id as string }), readPublicPositions(participant.account_id as string), readFreshMark(),
            ]);
            if (!mark || account.symbolSettings?.["BTC-USD"]?.leverage !== 1) continue;
            const markValue = parseDecimal(mark.markPrice);
            if (!markValue) continue;
            let exposure = { coefficient: 0n, scale: 0 };
            let supported = true;
            for (const position of positions.positions) {
              const size = parseDecimal(position.size);
              if (!size) { supported = false; break; }
              if (size.coefficient === 0n) continue;
              if (position.symbol !== "BTC-USD" || position.leverage !== 1) { supported = false; break; }
              const notional = multiplyDecimals({ ...size, coefficient: size.coefficient < 0n ? -size.coefficient : size.coefficient }, markValue);
              const scale = Math.max(exposure.scale, notional.scale);
              exposure = { coefficient: exposure.coefficient * 10n ** BigInt(scale - exposure.scale) + notional.coefficient * 10n ** BigInt(scale - notional.scale), scale };
            }
            if (supported && mayWrite()) await query(`INSERT INTO risk_observations (round_id,participant_id,observed_at,absolute_exposure,available_collateral,source,symbol_leverage)
              VALUES ($1,$2,$3,$4,$5,'strike-independent-read',1)`, [roundId, participant.id, new Date(), formatDecimal(exposure), account.available_balance]);
            } catch { /* Missing risk evidence pauses this participant without starving other accounts. */ }
          }
        })());
      }
      const results = await Promise.allSettled(jobs);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure && Date.now() - lastDiagnosticAt >= 10_000) {
        lastDiagnosticAt = Date.now();
        process.stderr.write(`Toruni scoring collection paused (${failureLabel(failure.reason)}).\n`);
      }
    } finally { collectionRunning = false; }
  };

  const cycle = async () => {
    if (stopped) return;
    let stage = "leader";
    try {
      if (!leader?.held()) {
        if (leader) { await leader.release().catch(() => undefined); leader = null; }
        leader = await acquireScoringLeader();
        if (!leader) { markReady(false); return; }
        markReady(true);
        stage = "restart reconciliation";
        await resetContinuity();
      }
      stage = "round lookup";
      const rounds = options.roundId
        ? await query(`SELECT * FROM rounds WHERE id=$1 AND status IN ('lobby','active','settling','review_required') LIMIT 1`, [options.roundId])
        : await query(`SELECT * FROM rounds WHERE status IN ('lobby','active','settling','review_required') LIMIT 1`);
      const round = rounds[0];
      if (!round) { activeRoundId = null; return; }
      if (activeRoundId !== round.id) { activeRoundId = round.id as string; engineRules = null; lastSampleSlot = null; }
      const now = Date.now();
      stage = "market and order collection";
      if (!collectionTask) {
        collectionTask = collect(round.id as string, now)
          .catch(error => {
            if (Date.now() - lastDiagnosticAt >= 10_000) {
              lastDiagnosticAt = Date.now();
              process.stderr.write(`Toruni scoring collection stopped (${failureLabel(error)}).\n`);
            }
          })
          .finally(() => { collectionTask = null; });
      }
      stage = "pending-order lookup";
      const pending = await query<{ count: string }>("SELECT count(*) FROM quote_intents WHERE round_id=$1 AND status<>'terminal'", [round.id]);
      stage = "round transition";
      const next = advanceRound({ status: round.status as RoundStatus, startsAt: (round.starts_at as Date).getTime(),
        endsAt: (round.ends_at as Date).getTime(), settlementDeadline: (round.settlement_deadline as Date).getTime() }, now, pending[0]?.count === "0");
      if (!mayWrite()) return;
      if (round.status === "active" && now < (round.ends_at as Date).getTime() + 1000 && leader.held()) {
        stage = "score sampling";
        const startsAt = (round.starts_at as Date).getTime();
        const sampledAt = Math.min((round.ends_at as Date).getTime(), startsAt + Math.floor((now - startsAt) / 1000) * 1000);
        if (sampledAt !== lastSampleSlot) {
        lastSampleSlot = sampledAt;
        const participants = await query("SELECT id FROM participants WHERE round_id=$1 AND verification_state='verified' LIMIT 8", [round.id]);
        const minimum = engineRules && now >= engineRules.observedAt && now - engineRules.observedAt <= 30_000
          && engineRules.status === "trading" && !engineRules.reduceOnly ? engineRules.minimumNotional : null;
        for (const participant of participants) {
          if (!mayWrite()) break;
          await transaction(async client => {
            if (mayWrite()) await persistScoreTick(client, round.id as string, participant.id as string, sampledAt, minimum);
          });
        }
        }
      }
      if (next.changed) await query("UPDATE rounds SET status=$1 WHERE id=$2", [next.status, round.id]);
      if (!mayWrite()) return;
      if (["completed", "review_required"].includes(next.status)) {
        stage = "result finalization";
        await transaction(client => mayWrite() ? finalizeRoundResults(client, round.id as string, now) : Promise.resolve());
      }
      if (now - lastPublished >= 1000 || next.changed) {
        lastPublished = now;
        stage = "round publication";
        publishEvent("round", { ...await readCurrentRound(), completedRoundId: next.status === "completed" ? round.id : null });
      }
    } catch (error) {
      markReady(false);
      if (Date.now() - lastDiagnosticAt >= 10_000) {
        lastDiagnosticAt = Date.now();
        process.stderr.write(`Toruni scoring cycle paused at ${stage} (${failureLabel(error)}).\n`);
      }
      publishEvent("scoring-paused", { serverTime: Date.now(), reason: "Observations are being reconciled." });
    }
    finally {
      if (!stopped) timer = setTimeout(() => { timer = null; cycleTask = cycle(); }, 250);
    }
  };
  cycleTask = cycle();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!readySettled) markReady(false);
    const drained = await drainWorkerTasks([cycleTask, collectionTask], WORKER_STOP_DRAIN_MS);
    if (!drained) process.stderr.write("Toruni scorer released its leader after the shutdown drain limit.\n");
    const currentLeader = leader;
    leader = null;
    await currentLeader?.release();
  };
  return { ready, stop };
}

/** Vercel runs one bounded worker invocation per round, then releases its database leader. */
export async function runRoundWorkerForRound(roundId: string, maxRuntimeMs = 280_000): Promise<"completed" | "round-missing" | "another-leader" | "time-limit"> {
  const worker = startRoundWorker({ roundId });
  const runtime = Math.min(280_000, Math.max(1_000, maxRuntimeMs));
  const deadline = Date.now() + runtime;
  try {
    if (!await worker.ready) return "another-leader";
    while (Date.now() < deadline) {
      const rows = await query<{ status: string; pending_results: string }>(`SELECT r.status,
        (SELECT count(*)::text FROM participants p LEFT JOIN round_results rr
          ON rr.round_id=p.round_id AND rr.participant_id=p.id
          WHERE p.round_id=r.id AND p.verification_state='verified' AND rr.participant_id IS NULL) AS pending_results
        FROM rounds r WHERE r.id=$1`, [roundId]);
      const round = rows[0];
      if (!round) return "round-missing";
      if (round.status === "completed" && round.pending_results === "0") return "completed";
      await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    }
    return "time-limit";
  } finally { await worker.stop(); }
}
