import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { handle } from "../server/app.ts";
import { readCurrentRound, readScoringHeartbeat } from "../server/database.ts";
import { runRoundWorkerForRound } from "../server/worker.ts";
import { shouldDispatchRoundScorer } from "../server/scoringDispatch.ts";

const activeRuns = new Map<string, Promise<void>>();
const lastScheduledAt = new Map<string, number>();

function scheduleScoring(roundId: string): void {
  if (activeRuns.has(roundId)) return;
  const now = Date.now();
  if (now - (lastScheduledAt.get(roundId) ?? 0) < 5_000) return;
  lastScheduledAt.set(roundId, now);
  const task = runRoundWorkerForRound(roundId)
    .then(result => {
      if (result === "time-limit") process.stderr.write("Toruni scoring invocation reached its round runtime limit.\n");
    })
    .catch(() => { process.stderr.write("Toruni scoring invocation ended before the round was finalized.\n"); })
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
