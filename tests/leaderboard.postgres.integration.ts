import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { transaction } from "../server/database.ts";
import { rankingsSql } from "../server/leaderboard.ts";
import { publicMakerId } from "../server/makerIdentity.ts";
import { scoringConstants } from "../shared/scoring.ts";

class FixtureRollback extends Error {}

/** Exercises the production query against transaction-local tables. It writes no app rows. */
export async function runLeaderboardPostgresChecks() {
  let checks = 0;
  try {
    await transaction(async client => {
      await client.query("SET LOCAL search_path TO pg_temp");
      await client.query("CREATE TEMP TABLE rounds (id uuid PRIMARY KEY, market text, status text, ends_at timestamptz, scoring_version text) ON COMMIT DROP");
      await client.query("CREATE TEMP TABLE participants (id uuid PRIMARY KEY, round_id uuid, account_id text, verification_state text) ON COMMIT DROP");
      await client.query("CREATE TEMP TABLE round_results (round_id uuid, participant_id uuid, total_scaled numeric(38,0), score_version text, cleanup_state text, finalized_at timestamptz) ON COMMIT DROP");
      const now = new Date();
      const addResult = async (options: {
        account?: string; symbol?: "BTC-USD" | "ETH-USD"; score: string; daysAgo?: number;
        status?: string; verification?: string; cleanup?: string; scoreVersion?: string; roundVersion?: string;
      }) => {
        const roundId = randomUUID();
        const participantId = randomUUID();
        const endedAt = new Date(now.getTime() - (options.daysAgo ?? 1) * 86_400_000);
        const account = options.account ?? randomUUID();
        await client.query("INSERT INTO rounds VALUES ($1,$2,$3,$4,$5)", [roundId, options.symbol ?? "BTC-USD", options.status ?? "completed", endedAt, options.roundVersion ?? scoringConstants.version]);
        await client.query("INSERT INTO participants VALUES ($1,$2,$3,$4)", [participantId, roundId, account, options.verification ?? "verified"]);
        await client.query("INSERT INTO round_results VALUES ($1,$2,$3,$4,$5,$6)", [roundId, participantId, options.score,
          options.scoreVersion ?? scoringConstants.version, options.cleanup ?? "verified", endedAt]);
      };

      const alpha = randomUUID();
      const exactTie = "100000000000000000000000000001";
      const justBelow = "100000000000000000000000000000";
      await addResult({ account: alpha, score: exactTie });
      await addResult({ account: alpha, score: justBelow });
      await addResult({ account: randomUUID(), score: exactTie });
      await addResult({ account: randomUUID(), score: justBelow });
      for (let i = 0; i < 26; i++) await addResult({ account: randomUUID(), score: String(26 - i) });
      await addResult({ account: randomUUID(), symbol: "ETH-USD", score: "999999999999999999999999999999" });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", daysAgo: 8 });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", status: "active" });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", verification: "unverified" });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", cleanup: "unresolved" });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", scoreVersion: "wrong-version" });
      await addResult({ account: randomUUID(), score: "999999999999999999999999999999", roundVersion: "wrong-version" });

      const run = async (period: Date | null, market: string | null, offset: number) => client.query<{ account_id: string; total_scaled: string; market: string; rounds: string; rank: string }>(
        rankingsSql, [scoringConstants.version, now, period, market, offset]);
      const all = await run(null, "BTC-USD", 0);
      assert.equal(all.rows.length, 26); checks++;
      const alphaBest = all.rows.find(row => row.account_id === alpha);
      assert.ok(alphaBest); assert.equal(alphaBest.total_scaled, exactTie); assert.equal(alphaBest.rank, "2"); checks++;
      assert.equal(alphaBest.rounds, "2"); checks++;
      assert.equal(all.rows.filter(row => row.total_scaled === exactTie).length, 2);
      assert.ok(all.rows.filter(row => row.total_scaled === exactTie).every(row => row.rank === "2")); checks++;
      const recent = await run(new Date(now.getTime() - 7 * 86_400_000), "BTC-USD", 0);
      assert.equal(recent.rows.length, 26); checks++;
      const recentAlpha = recent.rows.find(row => row.account_id === alpha);
      assert.ok(recentAlpha); assert.equal(recentAlpha.rank, "1");
      assert.equal(recent.rows.filter(row => row.total_scaled === exactTie).length, 2);
      assert.ok(recent.rows.filter(row => row.total_scaled === exactTie).every(row => row.rank === "1")); checks++;
      assert.equal(recent.rows[2].total_scaled, justBelow); assert.equal(recent.rows[2].rank, "3"); checks++;
      assert.equal((await run(null, "ETH-USD", 0)).rows.length, 1); checks++;
      const nextPage = await run(null, "BTC-USD", 25);
      assert.equal(nextPage.rows.length, 5); assert.equal(nextPage.rows[0].rank, "26"); checks++;
      assert.equal(nextPage.rows[4].rank, "30"); checks++;
      assert.equal(publicMakerId(alpha), publicMakerId(alpha));
      assert.notEqual(publicMakerId(alpha), publicMakerId("another-account"));
      assert.notEqual(publicMakerId(alpha), alpha); checks++;
      throw new FixtureRollback();
    });
  } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
  return { passed: checks, appRowsWritten: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLeaderboardPostgresChecks().then(result => {
    process.stdout.write(`leaderboard postgres checks: ${result.passed} passed; app rows written: ${result.appRowsWritten}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
