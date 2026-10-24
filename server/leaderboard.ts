import { publicMakerId } from "./makerIdentity.ts";
import { query } from "./database.ts";
import { formatScore, scoringConstants } from "../shared/scoring.ts";
import { isMarketSymbol } from "../shared/markets.ts";
import type { LeaderboardMarket, LeaderboardPeriod, LeaderboardSnapshot } from "../shared/leaderboard.ts";
import { RoundGuardError } from "./roundService.ts";

export function leaderboardFilters(url: URL): { market: LeaderboardMarket; period: LeaderboardPeriod; page: number } {
  const market = url.searchParams.get("symbol") ?? "all";
  const period = url.searchParams.get("period") ?? "all";
  const rawPage = url.searchParams.get("page") ?? "1";
  if ((market !== "all" && !isMarketSymbol(market)) || (period !== "all" && period !== "7d")
    || !/^[1-9]\d{0,3}$/.test(rawPage) || Number(rawPage) > 1000) {
    throw new RoundGuardError("Choose a valid leaderboard filter.", 400);
  }
  return { market, period, page: Number(rawPage) };
}

// Rank exact stored scores before pagination. One best round per verified account;
// equal scores share a rank, and first achievement gives stable display order.
export const rankingsSql = `WITH eligible AS (
  SELECT p.account_id,rr.total_scaled,r.market,r.id AS round_id,r.ends_at,
    count(*) OVER (PARTITION BY p.account_id) AS rounds,
    row_number() OVER (PARTITION BY p.account_id ORDER BY rr.total_scaled DESC,r.ends_at,r.id,rr.participant_id) AS best
  FROM round_results rr JOIN rounds r ON r.id=rr.round_id
  JOIN participants p ON p.id=rr.participant_id AND p.round_id=rr.round_id
  WHERE p.verification_state='verified' AND p.account_id IS NOT NULL
    AND r.status='completed' AND rr.cleanup_state='verified'
    AND rr.score_version=$1 AND r.scoring_version=$1
    AND r.ends_at<=$2 AND rr.finalized_at<=$2
    AND ($3::timestamptz IS NULL OR r.ends_at>=$3)
    AND ($4::text IS NULL OR r.market=$4)
), ranked AS (
  SELECT *,rank() OVER (ORDER BY total_scaled DESC) AS rank FROM eligible WHERE best=1
)
SELECT account_id,total_scaled::text,market,round_id,ends_at,rounds::text,rank::text
FROM ranked ORDER BY total_scaled::numeric DESC,ends_at,account_id LIMIT 26 OFFSET $5`;

interface RankingRow {
  account_id: string; total_scaled: string; market: string; round_id: string;
  ends_at: Date; rounds: string; rank: string;
}
export async function readRankings(filters: ReturnType<typeof leaderboardFilters>): Promise<LeaderboardSnapshot> {
  const now = Date.now();
  const rows = await query<RankingRow>(rankingsSql, [scoringConstants.version, new Date(now),
    filters.period === "7d" ? new Date(now - 7 * 24 * 60 * 60 * 1000) : null,
    filters.market === "all" ? null : filters.market, (filters.page - 1) * 25]);
  return {
    ...filters, updatedAt: now, hasMore: rows.length > 25,
    entries: rows.slice(0,25).map(row => ({ rank: Number(row.rank),
      makerId: publicMakerId(row.account_id),
      score: formatScore(BigInt(row.total_scaled)), rounds: Number(row.rounds),
      symbol: row.market, roundId: row.round_id, endsAt: row.ends_at.getTime(),
    })),
  };
}
