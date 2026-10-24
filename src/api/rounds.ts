export interface RoundSnapshot {
  id: string; symbol: string; status: string; startsAt: number; endsAt: number;
  settlementDeadline: number; scoringVersion: string; participantCount: number;
}
export interface RoundReport {
  serverTime: number;
  round: RoundSnapshot;
  participants: Array<{
    participantId: string; makerId?: string; score: string; totalScaled: string; verifiedSeconds: string;
    unscoredSeconds: string; bidSeconds: number; askSeconds: number; twoSidedSeconds: number; pausedSeconds: number; cleanupState: string; finalizedAt: number;
  }>;
  orders: Array<{
    client_order_id: string; side: string; observed_at: string; exchange_status: string;
    exchange_order_id: string; price: string; original_qty: string; filled_qty: string;
  }>;
}
export class RoundNotFoundError extends Error {}
export async function readRoundReport(roundId: string): Promise<RoundReport> {
  if (!/^[0-9a-f-]{36}$/i.test(roundId)) throw new RoundNotFoundError("Round not found.");
  const response = await fetch(`/api/rounds/${encodeURIComponent(roundId)}/results`, { signal: AbortSignal.timeout(6_000) });
  if (response.status === 404) throw new RoundNotFoundError("Round not found.");
  if (!response.ok) throw new Error("The round report is unavailable. Try again shortly.");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("round" in result) || !("participants" in result)
    || !Array.isArray(result.participants) || !("orders" in result) || !Array.isArray(result.orders)) {
    throw new Error("The round report could not be verified.");
  }
  return result as RoundReport;
}
export interface AuditSample {
  sampled_at: string; participant_id: string; delta_scaled: string; points_per_minute_scaled: string;
  bid_quality_scaled: string; ask_quality_scaled: string; reason: string; scoring_version: string;
}
export async function readRoundAudit(roundId: string): Promise<AuditSample[]> {
  const response = await fetch(`/api/rounds/${encodeURIComponent(roundId)}/audit`, { signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error("Scoring evidence is unavailable. Try again shortly.");
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Scoring evidence could not be verified.");
  if (data.some(row => !row || typeof row !== "object" || typeof row.sampled_at !== "string"
    || typeof row.participant_id !== "string" || typeof row.delta_scaled !== "string" || !/^\d+$/.test(row.delta_scaled)
    || typeof row.reason !== "string")) throw new Error("Scoring evidence could not be verified.");
  return data as AuditSample[];
}
