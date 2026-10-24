import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.NODE_ENV = "production";
delete process.env.APP_ORIGIN;
process.env.VERCEL_URL = "toruni-preview.vercel.app";
const { requestHasTrustedOrigin } = await import("../server/session.ts");
const { shouldDispatchRoundScorer } = await import("../server/scoringDispatch.ts");
const { default: api } = await import("../api/[...path].ts");
const { default: participantsApi } = await import("../api/participants/me.ts");
const { default: joinApi } = await import("../api/rounds/current/join.ts");

test("Vercel scoring starts after a successful join and stale live-round heartbeats", () => {
  const base = { platformIsVercel: true, method: "POST", pathname: "/api/rounds/current/join", responseStatus: 201, now: 20_000 };
  assert.equal(shouldDispatchRoundScorer(base), true);
  assert.equal(shouldDispatchRoundScorer({ ...base, responseStatus: 409 }), false);
  assert.equal(shouldDispatchRoundScorer({ ...base, platformIsVercel: false }), false);
  assert.equal(shouldDispatchRoundScorer({ ...base, method: "GET", pathname: "/api/rounds/current", responseStatus: 200,
    roundStatus: "active", heartbeatAt: 14_999 }), true);
  assert.equal(shouldDispatchRoundScorer({ ...base, method: "GET", pathname: "/api/rounds/current", responseStatus: 200,
    roundStatus: "active", heartbeatAt: 15_000 }), false);
  assert.equal(shouldDispatchRoundScorer({ ...base, method: "GET", pathname: "/api/rounds/current", responseStatus: 200,
    roundStatus: "completed", heartbeatAt: null }), false);
});

test("preview sessions trust the configured deployment, never a caller supplied host", () => {
  const request = (origin: string, host: string) => ({ headers: { origin, host, "sec-fetch-site": "same-origin" } }) as IncomingMessage;
  assert.equal(requestHasTrustedOrigin(request("https://toruni-preview.vercel.app", "toruni-preview.vercel.app")), true);
  assert.equal(requestHasTrustedOrigin(request("https://attacker.example", "attacker.example")), false);
  assert.equal(requestHasTrustedOrigin(request("http://toruni-preview.vercel.app", "toruni-preview.vercel.app")), false);
});

test("Vercel disables process-local event streams so the client keeps its polling fallback", async () => {
  let status = 0;
  let ended = false;
  const response = {
    writeHead(code: number) { status = code; },
    end() { ended = true; },
  } as unknown as ServerResponse;
  await api({ url: "/api/events" } as IncomingMessage, response);
  assert.equal(status, 204);
  assert.equal(ended, true);
});

test("nested Vercel API entrypoints reach the shared handler", async () => {
  const response = () => {
    let status = 0;
    let ended = false;
    return {
      value: { setHeader() {}, writeHead(code: number) { status = code; }, end() { ended = true; } } as unknown as ServerResponse,
      status: () => status,
      ended: () => ended,
    };
  };
  const participantResponse = response();
  await participantsApi({ url: "/api/participants/me", method: "GET", headers: {} } as IncomingMessage, participantResponse.value);
  assert.equal(participantResponse.status(), 401);
  assert.equal(participantResponse.ended(), true);

  const joinResponse = response();
  await joinApi({ url: "/api/rounds/current/join", method: "POST", headers: {
    origin: "https://toruni-preview.vercel.app", host: "toruni-preview.vercel.app", "sec-fetch-site": "same-origin",
  } } as IncomingMessage, joinResponse.value);
  assert.equal(joinResponse.status(), 401);
  assert.equal(joinResponse.ended(), true);
});
