import assert from "node:assert/strict";
import test from "node:test";
import { advanceRound, type RoundClock } from "../shared/roundLifecycle.ts";

const round: RoundClock = {
  status: "lobby",
  startsAt: 15_000,
  endsAt: 195_000,
  settlementDeadline: 210_000,
};

test("server clock advances lobby, active, settling, then verified completion", () => {
  assert.deepEqual(advanceRound(round, 14_999, false), {
    status: "lobby", changed: false, reason: "before-start",
  });
  assert.deepEqual(advanceRound(round, 15_000, false), {
    status: "active", changed: true, reason: "round-started",
  });
  assert.deepEqual(advanceRound({ ...round, status: "active" }, 195_000, false), {
    status: "settling", changed: true, reason: "round-ended",
  });
  assert.deepEqual(advanceRound({ ...round, status: "settling" }, 210_000, true), {
    status: "completed", changed: true, reason: "settled",
  });
});

test("a missed clock tick skips directly to settlement without crediting a local phase", () => {
  assert.deepEqual(advanceRound(round, 205_000, false), {
    status: "settling", changed: true, reason: "round-ended",
  });
});

test("unverified cleanup requires review and can complete only after reconciliation", () => {
  const needsReview = advanceRound({ ...round, status: "settling" }, 210_000, false);
  assert.deepEqual(needsReview, {
    status: "review_required", changed: true, reason: "cleanup-unverified",
  });
  assert.deepEqual(advanceRound({ ...round, status: needsReview.status }, 215_000, false), {
    status: "review_required", changed: false, reason: "cleanup-unverified",
  });
  assert.deepEqual(advanceRound({ ...round, status: needsReview.status }, 215_000, true), {
    status: "completed", changed: true, reason: "settled",
  });
});

test("round transitions never move backward and malformed clocks fail closed", () => {
  assert.deepEqual(advanceRound({ ...round, status: "active" }, 30_000, false), {
    status: "active", changed: false, reason: "before-start",
  });
  assert.throws(() => advanceRound({ ...round, endsAt: round.startsAt }, 20_000, false), /out of order/);
});
