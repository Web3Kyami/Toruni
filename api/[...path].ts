import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../server/app.ts";

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
  } catch {
    if (!response.headersSent) response.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: "Request could not be completed. Try again shortly." }));
  }
}
