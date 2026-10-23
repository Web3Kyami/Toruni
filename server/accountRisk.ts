import { alignDecimals, compareDecimals, formatDecimal, parseDecimal } from "../shared/decimal.ts";
import type { StrikePublicAccount, StrikePosition, StrikeMark } from "../shared/contracts.ts";
import { MARK_FRESHNESS_LIMIT_MS, readFreshMark, readPublicAccount, readPublicPositions } from "./strike.ts";
import { RoundGuardError } from "./roundService.ts";

export interface AccountRiskEvidence {
  account: StrikePublicAccount;
  positions: StrikePosition[];
  mark: StrikeMark;
  observedAt: number;
  absoluteExposure: string;
}

function add(a: { coefficient: bigint; scale: number }, b: { coefficient: bigint; scale: number }) {
  const [left, right, scale] = alignDecimals(a, b);
  return { coefficient: left + right, scale };
}

export async function readAccountRisk(accountId: string): Promise<AccountRiskEvidence> {
  const [account, positionRead, mark] = await Promise.all([
    readPublicAccount({ accountId }), readPublicPositions(accountId), readFreshMark("BTC-USD"),
  ]);
  if (!mark) throw new RoundGuardError("Strike market data is stale. Refresh before joining or reviewing a quote.", 503);
  const settings = account.symbolSettings?.["BTC-USD"];
  if (!settings || settings.leverage !== 1) {
    throw new RoundGuardError("Set BTC-USD to 1x in Strike before joining.", 423);
  }

  const markValue = parseDecimal(mark.markPrice);
  if (!markValue || markValue.coefficient <= 0n) throw new RoundGuardError("Strike mark could not be verified.", 503);
  let exposure = { coefficient: 0n, scale: 0 };
  for (const position of positionRead.positions) {
    const size = parseDecimal(position.size);
    if (!size) throw new RoundGuardError("Strike position size could not be verified.", 503);
    if (size.coefficient === 0n) continue;
    if (position.symbol !== "BTC-USD" || position.leverage !== 1) {
      throw new RoundGuardError("Close or manage other positions in Strike before joining this round.", 423);
    }
    const magnitude = { ...size, coefficient: size.coefficient < 0n ? -size.coefficient : size.coefficient };
    const notional = {
      coefficient: magnitude.coefficient * markValue.coefficient,
      scale: magnitude.scale + markValue.scale,
    };
    exposure = add(exposure, notional);
  }
  return {
    account, positions: positionRead.positions, mark,
    // Account and position reads have a 3-second admission window. The exchange
    // mark has its own 5-second event-time window and must not shorten that one.
    observedAt: Math.min(account.observedAt, positionRead.observedAt),
    absoluteExposure: formatDecimal(exposure),
  };
}

export function assertFreshRisk(evidence: AccountRiskEvidence, now: number): void {
  const available = parseDecimal(evidence.account.available_balance);
  const riskIsFresh = now >= evidence.observedAt && now - evidence.observedAt <= 3_000;
  const markIsFresh = now >= evidence.mark.observedAt && now - evidence.mark.observedAt <= MARK_FRESHNESS_LIMIT_MS;
  if (!available || available.coefficient < 0n || !riskIsFresh || !markIsFresh) {
    throw new RoundGuardError("Strike balance and position data must be current before continuing.", 423);
  }
}

export function assertWithinExposure(evidence: AccountRiskEvidence, maximumExposure: string): void {
  const exposure = parseDecimal(evidence.absoluteExposure);
  const limit = parseDecimal(maximumExposure);
  if (!exposure || !limit || compareDecimals(exposure, limit) > 0) {
    throw new RoundGuardError("Current positions exceed this round’s exposure limit.", 423);
  }
}
