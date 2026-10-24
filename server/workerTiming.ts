export const ORDER_POLL_CHECK_INTERVAL_MS = 1_000;

export function nextOrderPollDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return ORDER_POLL_CHECK_INTERVAL_MS;
  return Math.max(0, ORDER_POLL_CHECK_INTERVAL_MS - Math.trunc(elapsedMs));
}
