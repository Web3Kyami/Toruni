import type { IncomingMessage, ServerResponse } from "node:http";
const subscribers = new Set<ServerResponse>();
export function publishEvent(type: string, data: unknown): void {
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const subscriber of subscribers) {
    if (!subscriber.write(message)) { subscriber.end(); subscribers.delete(subscriber); }
  }
}
export function openEventStream(request: IncomingMessage, response: ServerResponse): void {
  if (subscribers.size >= 64) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Live updates are busy. Use refresh while reconnecting." })); return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  response.write(`event: connected\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
  subscribers.add(response);
  const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  const lifetime = setTimeout(() => response.end(), 20 * 60_000);
  const close = () => { subscribers.delete(response); clearInterval(keepalive); clearTimeout(lifetime); };
  request.once("close", close); response.once("close", close);
}
export function closeEventStreams(): void { for (const client of subscribers) client.end(); subscribers.clear(); }
