export type RoundStatus = "lobby" | "active" | "settling" | "completed" | "review_required";

export interface RoundClock {
  status: RoundStatus;
  startsAt: number;
  endsAt: number;
  settlementDeadline: number;
}

export interface RoundTransition {
  status: RoundStatus;
  changed: boolean;
  reason: "before-start" | "round-started" | "round-ended" | "settled" | "cleanup-unverified" | "already-final";
}

function validateClock(round: RoundClock, now: number): void {
  if (![round.startsAt, round.endsAt, round.settlementDeadline, now].every(Number.isFinite)) {
    throw new Error("Round timestamps must be finite server timestamps.");
  }
  if (round.startsAt <= 0 || round.endsAt <= round.startsAt || round.settlementDeadline < round.endsAt) {
    throw new Error("Round timestamps are out of order.");
  }
}

/**
 * Advances a persisted round using server time only. Missed phases are skipped
 * forward, never backward; completion requires verified terminal order cleanup.
 */
export function advanceRound(round: RoundClock, now: number, cleanupVerified: boolean): RoundTransition {
  validateClock(round, now);

  if (round.status === "completed") {
    return { status: "completed", changed: false, reason: "already-final" };
  }
  if (round.status === "review_required") {
    return cleanupVerified
      ? { status: "completed", changed: true, reason: "settled" }
      : { status: "review_required", changed: false, reason: "cleanup-unverified" };
  }
  if (round.status === "settling") {
    if (now < round.settlementDeadline) {
      return { status: "settling", changed: false, reason: "round-ended" };
    }
    return cleanupVerified
      ? { status: "completed", changed: true, reason: "settled" }
      : { status: "review_required", changed: true, reason: "cleanup-unverified" };
  }
  if (round.status === "active") {
    return now >= round.endsAt
      ? { status: "settling", changed: true, reason: "round-ended" }
      : { status: "active", changed: false, reason: "before-start" };
  }

  if (now < round.startsAt) {
    return { status: "lobby", changed: false, reason: "before-start" };
  }
  if (now >= round.endsAt) {
    return { status: "settling", changed: true, reason: "round-ended" };
  }
  return { status: "active", changed: true, reason: "round-started" };
}
