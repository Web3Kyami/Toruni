// next_verify_at is two seconds after the last proof. Half-second checks keep
// boundary jitter below the three-second evidence freshness limit.
export const ORDER_POLL_CHECK_INTERVAL_MS = 500;

export function nextOrderPollDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return ORDER_POLL_CHECK_INTERVAL_MS;
  return Math.max(0, ORDER_POLL_CHECK_INTERVAL_MS - Math.trunc(elapsedMs));
}
