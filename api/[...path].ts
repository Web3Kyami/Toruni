import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { handle, type RoundScoringHooks } from "../server/app.ts";
import { readScoringHeartbeat } from "../server/database.ts";
import { runRoundWorkerForRound } from "../server/worker.ts";
import { shouldDispatchRoundScorer } from "../server/scoringDispatch.ts";

const activeRuns = new Map<string, Promise<void>>();
const lastScheduledAt = new Map<string, number>();

function scoringFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as { name?: unknown; code?: unknown };
  const name = typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value.name) ? value.name : "Error";
  const code = typeof value.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(value.code) ? value.code : null;
  return code ? `${name}:${code}` : name;
}

function scheduleScoring(roundId: string): void {
  if (activeRuns.has(roundId)) return;
  const now = Date.now();
  if (now - (lastScheduledAt.get(roundId) ?? 0) < 5_000) return;
  lastScheduledAt.set(roundId, now);
  const task = runRoundWorkerForRound(roundId)
    .then(result => {
      if (result === "time-limit") process.stderr.write("Toruni scoring invocation reached its round runtime limit.\n");
      else if (result === "another-leader") process.stderr.write("Toruni scoring invocation found another database leader.\n");
      else if (result === "round-missing") process.stderr.write("Toruni scoring invocation found no runnable round.\n");
    })
    .catch(error => { process.stderr.write(`Toruni scoring invocation ended before the round was finalized (${scoringFailureCode(error)}).\n`); })
    .finally(() => { activeRuns.delete(roundId); });
  activeRuns.set(roundId, task);
  waitUntil(task);
}

const scoringHooks: RoundScoringHooks | undefined = process.env.VERCEL ? {
  onRoundJoined(roundId) {
    if (shouldDispatchRoundScorer({ platformIsVercel: true, method: "POST", pathname: "/api/rounds/current/join",
      responseStatus: 201, now: Date.now() })) scheduleScoring(roundId);
  },
  async onCurrentRound(roundId, roundStatus) {
    try {
      const heartbeat = await readScoringHeartbeat(roundId);
      if (shouldDispatchRoundScorer({ platformIsVercel: true, method: "GET", pathname: "/api/rounds/current",
        responseStatus: 200, roundStatus, heartbeatAt: heartbeat, now: Date.now() })) {
        process.stderr.write("Toruni stale scoring heartbeat detected; resuming the round worker.\n");
        scheduleScoring(roundId);
      }
    } catch (error) {
      process.stderr.write(`Toruni scorer dispatch check failed (${scoringFailureCode(error)}).\n`);
    }
  },
} : undefined;

export default async function api(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The browser already polls persisted state. Process-local SSE subscribers
  // cannot receive events from the independently hosted scoring worker.
  if (new URL(request.url ?? "/", "https://toruni.invalid").pathname === "/api/events") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  try {
    await handle(request, response, scoringHooks);
  } catch {
    if (!response.headersSent) response.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: "Request could not be completed. Try again shortly." }));
  }
}
