import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readMarketSnapshot, readPublicAccount, StrikeReadError } from "./strike.ts";

const PORT = Number(process.env.PORT ?? 4174);
const HOST = process.env.HOST ?? "127.0.0.1";

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function queryValue(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : null;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "This endpoint only accepts GET requests." });
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { service: "toruni-local-api", network: "strike-v2-testnet" });
      return;
    }
    if (url.pathname === "/api/market") {
      const symbol = queryValue(url, "symbol") ?? "BTC-USD";
      const snapshot = await readMarketSnapshot(symbol);
      const status = snapshot.unavailableSources.length === 3 ? 503 : 200;
      sendJson(response, status, snapshot);
      return;
    }
    if (url.pathname === "/api/account") {
      const accountId = queryValue(url, "account_id");
      const address = queryValue(url, "blockchain_address");
      if (accountId && !/^[\da-fA-F-]{36}$/.test(accountId)) {
        sendJson(response, 400, { error: "Invalid Strike account ID." });
        return;
      }
      if (address && !/^0x[\da-fA-F]{40}$/.test(address)) {
        sendJson(response, 400, { error: "Invalid Ethereum address." });
        return;
      }
      const account = await readPublicAccount({ accountId: accountId ?? undefined, address: address ?? undefined });
      sendJson(response, 200, account);
      return;
    }
    sendJson(response, 404, { error: "API route not found." });
  } catch (error) {
    if (error instanceof StrikeReadError) {
      const status = error.status === 404 ? 404 : error.status >= 400 && error.status < 600 ? error.status : 503;
      const message = status === 404
        ? "Strike account was not found."
        : status === 409
          ? "Strike account identity could not be verified."
          : "Strike testnet data is unavailable.";
      sendJson(response, status, { error: message });
      return;
    }
    sendJson(response, 503, { error: "Strike testnet data is unavailable." });
  }
}

const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Toruni API listening on http://${HOST}:${PORT} (Strike V2 testnet only)\n`);
});
