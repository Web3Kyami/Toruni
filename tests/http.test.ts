import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../server/app.ts";
import { leaderboardFilters } from "../server/leaderboard.ts";

async function request(path: string, method = "GET", origin?: string) {
  let status = 0;
  let body = "";
  const headers = new Map<string, unknown>();
  const response = {
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    writeHead(code: number, values: Record<string, unknown> = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value);
    },
    end(value?: string | Buffer) { body = value?.toString() ?? ""; },
  } as unknown as ServerResponse;
  await handle({ url: path, method, headers: origin ? { origin } : {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage, response);
  return { status, headers, body };
}

test("health identifies the testnet environment and sets browser protection headers", async () => {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  const health = JSON.parse(response.body);
  assert.equal(health.network, "strike-v2-testnet");
  assert.equal(typeof health.databaseReady, "boolean");
  assert.equal(typeof health.scoringLeaderConfigured, "boolean");
  assert.match(String(response.headers.get("content-security-policy")), /frame-ancestors 'none'/);
});

test("session creation rejects absent or foreign origins before database access", async () => {
  assert.equal((await request("/api/session", "POST")).status, 403);
  assert.equal((await request("/api/session", "POST", "https://untrusted.example")).status, 403);
  assert.equal((await request("/api/quote-intents", "POST", "http://localhost:5173")).status, 401);
  assert.equal((await request("/api/participants/me")).status, 401);
  assert.equal((await request("/api/rounds/current/join", "POST", "http://localhost:5173")).status, 401);
  assert.equal((await request("/api/quote-intents", "POST", "http://localhost:5173")).status, 401);
});

test("leaderboard filters accept supported values and reject malformed input", async () => {
  assert.deepEqual(leaderboardFilters(new URL("https://toruni.test/api/leaderboard")), { market: "all", period: "all", page: 1 });
  assert.deepEqual(leaderboardFilters(new URL("https://toruni.test/api/leaderboard?symbol=ETH-USD&period=7d&page=12")), { market: "ETH-USD", period: "7d", page: 12 });
  for (const query of ["symbol=UNKNOWN", "period=30d", "page=0", "page=-1", "page=1001", "page=1.5"]) {
    assert.throws(() => leaderboardFilters(new URL(`https://toruni.test/api/leaderboard?${query}`)), /valid leaderboard filter/);
  }
  assert.equal((await request("/api/leaderboard?symbol=UNKNOWN")).status, 400);
});

test("static serving never exposes local environment, private blueprint or source paths", async () => {
  for (const path of ["/.env.local", "/TASKS.md", "/AGENTS.md", "/server/database.ts", "/assets/../../.env.local", "/assets/%2e%2e/.env.local"]) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.includes("DATABASE_URL="), false);
  }
});
