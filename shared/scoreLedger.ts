import type { QuoteAssessment, ScorePolicy, StrikeMark, VerifiedQuote } from "./contracts.ts";
import { assessVerifiedQuote, scoreVerifiedSample, scoringConstants } from "./scoring.ts";

export interface ObservedTick {
  sampledAt: number;
  mark: StrikeMark | null;
  riskPolicy: ScorePolicy | null;
  bid: VerifiedQuote | null;
  ask: VerifiedQuote | null;
}

export interface ScoringWindow {
  startsAt: number;
  endsAt: number;
  accountId: string;
}

export interface AuditedTick {
  sampledAt: number;
  deltaScaled: string;
  pointsPerMinuteScaled: string;
  bidQualityScaled: string;
  askQualityScaled: string;
  bidReason: string;
  askReason: string;
  reason: "sampled" | "sampler-gap" | "outside-round" | "proof-unavailable";
  scoringVersion: typeof scoringConstants.version;
}

function zeroTick(tick: ObservedTick, reason: AuditedTick["reason"]): AuditedTick {
  return {
    sampledAt: tick.sampledAt, deltaScaled: "0", pointsPerMinuteScaled: "0",
    bidQualityScaled: "0", askQualityScaled: "0", bidReason: reason, askReason: reason,
    reason, scoringVersion: scoringConstants.version,
  };
}

/** Pure server-side ledger calculation. Never accepts a client-reported score. */
export function auditObservedTick(tick: ObservedTick, window: ScoringWindow, previousSampleAt: number | null): AuditedTick {
  if (!Number.isSafeInteger(tick.sampledAt) || !Number.isSafeInteger(window.startsAt)
    || !Number.isSafeInteger(window.endsAt) || window.endsAt <= window.startsAt || !window.accountId) {
    throw new Error("Invalid authoritative scoring window.");
  }
  if (tick.sampledAt - 1_000 < window.startsAt || tick.sampledAt > window.endsAt) {
    return zeroTick(tick, "outside-round");
  }
  if (previousSampleAt === null || tick.sampledAt - previousSampleAt !== 1_000) {
    return zeroTick(tick, "sampler-gap");
  }
  const { mark, riskPolicy } = tick;
  if (!mark || !riskPolicy || mark.source !== "strike-v2-testnet") return zeroTick(tick, "proof-unavailable");

  const assess = (quote: VerifiedQuote | null, side: "buy" | "sell"): QuoteAssessment | null => {
    if (!quote || quote.side !== side || quote.accountId !== window.accountId
      || quote.provenance !== "strike-public-order-read") return null;
    // Dwell must already be complete at the beginning of this interval.
    // An observation at the tick boundary never earns retroactive dwell credit.
    if (quote.firstOpenObservedAt + riskPolicy.minimumDwellMs > tick.sampledAt - 1_000) return null;
    return assessVerifiedQuote(quote, mark, riskPolicy, tick.sampledAt);
  };
  const bid = assess(tick.bid, "buy");
  const ask = assess(tick.ask, "sell");
  const score = scoreVerifiedSample(bid, ask, 1_000);
  return {
    sampledAt: tick.sampledAt,
    deltaScaled: score.scoreDeltaScaled.toString(),
    pointsPerMinuteScaled: score.pointsPerMinuteScaled.toString(),
    bidQualityScaled: score.bidQualityScaled.toString(),
    askQualityScaled: score.askQualityScaled.toString(),
    bidReason: bid?.reason ?? "proof-unavailable",
    askReason: ask?.reason ?? "proof-unavailable",
    reason: "sampled", scoringVersion: scoringConstants.version,
  };
}

export function replayObservedTicks(ticks: readonly ObservedTick[], window: ScoringWindow): { samples: AuditedTick[]; totalScaled: bigint } {
  const ordered = [...ticks].sort((a, b) => a.sampledAt - b.sampledAt);
  let previous: number | null = window.startsAt;
  let totalScaled = 0n;
  const samples: AuditedTick[] = [];
  for (const tick of ordered) {
    if (previous !== null && tick.sampledAt <= previous) throw new Error("Duplicate or pre-start scoring observation.");
    const sample = auditObservedTick(tick, window, previous);
    samples.push(sample);
    totalScaled += BigInt(sample.deltaScaled);
    previous = tick.sampledAt;
  }
  return { samples, totalScaled };
}
