import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { handle } from "../server/app.ts";
import { readCurrentRound, readScoringHeartbeat } from "../server/database.ts";
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

async function resumeStaleScoring(): Promise<void> {
  const current = await readCurrentRound();
  if (!current.round) return;
  const heartbeat = await readScoringHeartbeat(current.round.id);
  if (shouldDispatchRoundScorer({ platformIsVercel: true, method: "GET", pathname: "/api/rounds/current",
    responseStatus: 200, roundStatus: current.round.status, heartbeatAt: heartbeat, now: Date.now() })) {
    scheduleScoring(current.round.id);
  }
}

export default async function api(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The browser already polls persisted state. Process-local SSE subscribers
  // cannot receive events from the independently hosted scoring worker.
  if (new URL(request.url ?? "/", "https://toruni.invalid").pathname === "/api/events") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  try {
    await handle(request, response);
    if (process.env.VERCEL) {
      try {
        const pathname = new URL(request.url ?? "/", "https://toruni.invalid").pathname;
        const joined = shouldDispatchRoundScorer({ platformIsVercel: true, method: request.method ?? "", pathname,
          responseStatus: response.statusCode, now: Date.now() });
        const pollingCurrentRound = request.method === "GET" && pathname === "/api/rounds/current" && response.statusCode === 200;
        if (joined) {
          const current = await readCurrentRound();
          if (current.round) scheduleScoring(current.round.id);
        } else if (pollingCurrentRound) await resumeStaleScoring();
      } catch { /* The HTTP response is already complete; a later poll can retry. */ }
    }
  } catch {
    if (!response.headersSent) response.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: "Request could not be completed. Try again shortly." }));
  }
}
