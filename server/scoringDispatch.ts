const RUNNABLE_ROUND_STATUSES = new Set(["lobby", "active", "settling", "review_required"]);

export interface ScoringDispatchCheck {
  platformIsVercel: boolean;
  method: string;
  pathname: string;
  responseStatus: number;
  roundStatus?: string | null;
  heartbeatAt?: number | null;
  now: number;
}

/** Only a successful join or a stale live-round heartbeat may launch background scoring. */
export function shouldDispatchRoundScorer(check: ScoringDispatchCheck): boolean {
  if (!check.platformIsVercel) return false;
  if (check.method === "POST" && check.pathname === "/api/rounds/current/join") return check.responseStatus === 201;
  if (check.method !== "GET" || check.pathname !== "/api/rounds/current" || check.responseStatus !== 200
    || !RUNNABLE_ROUND_STATUSES.has(check.roundStatus ?? "")) return false;
  return check.heartbeatAt == null || check.now < check.heartbeatAt || check.now - check.heartbeatAt > 5_000;
}
