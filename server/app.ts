import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { readCurrentRound, readRoundReport, readRoundAudit, readLeaderboard, readParticipantSnapshot, query, transaction } from "./database.ts";
import { issueSession, readSessionHash, requestHasTrustedOrigin, requireSession } from "./session.ts";
import { openEventStream } from "./events.ts";
import { readMarketSnapshot, readPublicAccount, readPublicPositions, StrikeReadError } from "./strike.ts";
import { RoundGuardError, enrollParticipant, issueQuoteIntent } from "./roundService.ts";
import { readGamePolicy, publicGamePolicy } from "./gamePolicy.ts";
import { assertFreshRisk, assertWithinExposure, readAccountRisk } from "./accountRisk.ts";
import { validateQuoteDraft } from "../shared/quoteValidation.ts";
import { compareDecimals, parseDecimal } from "../shared/decimal.ts";


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

export async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://api-v2-testnet.strikefinance.org wss://api-v2-testnet.strikefinance.org; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (url.pathname === "/api/session" && request.method === "POST") {
    if (!requestHasTrustedOrigin(request)) { sendJson(response, 403, { error: "Open Toruni from its application address before continuing." }); return; }
    if (!allowSessionRequest(request.socket.remoteAddress ?? "unknown")) { sendJson(response, 429, { error: "Too many session requests. Try again shortly." }); return; }
    try { sendJson(response, 200, await issueSession(request, response)); }
    catch { sendJson(response, 503, { error: "Round service unavailable. Try again shortly." }); }
    return;
  }
  if (request.method === "POST" && (url.pathname === "/api/rounds/current/join" || url.pathname === "/api/quote-intents")) {
    if (!requestHasTrustedOrigin(request)) { sendJson(response, 403, { error: "Open Toruni from its application address before continuing." }); return; }
    const sessionHash = await requireSession(request);
    if (!sessionHash) { sendJson(response, 401, { error: "Your Toruni session expired. Refresh the page and try again." }); return; }
    try {
      const body = await readJsonBody(request);
      if (url.pathname === "/api/rounds/current/join") {
        const accountId = body && typeof body === "object" && "accountId" in body && typeof body.accountId === "string" ? body.accountId : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
          sendJson(response, 400, { error: "Connect your wallet first." }); return;
        }
        const snapshot = await readMarketSnapshot("BTC-USD");
        if (!snapshot.mark || !snapshot.depth || !snapshot.marketRules || snapshot.unavailableSources.length) {
          throw new RoundGuardError("Strike market data is incomplete. Refresh before joining.", 503);
        }
        const policy = readGamePolicy(snapshot.marketRules);
        if (!policy) throw new RoundGuardError("Round limits are not ready yet. You can still explore the live arena.", 423);
        const risk = await readAccountRisk(accountId);
        const now = Date.now();
        assertFreshRisk(risk, now);
        assertWithinExposure(risk, policy.rules.maximumAccountExposure);
        const result = await transaction(client => enrollParticipant(client, sessionHash, {
          accountId, observedAt: Math.min(snapshot.checkedAt, snapshot.marketRules!.observedAt, risk.observedAt),
          availableCollateral: risk.account.available_balance, requiredCollateral: policy.requiredCollateral,
          absoluteExposure: risk.absoluteExposure,
          effectiveLeverage: risk.account.symbolSettings?.["BTC-USD"]?.leverage ?? 0,
          provenance: "strike-independent-read",
        }, policy.rules, now));
        sendJson(response, 201, result); return;
      }

      const side = body && typeof body === "object" && "side" in body ? body.side : null;
      const price = body && typeof body === "object" && "price" in body ? body.price : null;
      const size = body && typeof body === "object" && "size" in body ? body.size : null;
      if ((side !== "buy" && side !== "sell") || typeof price !== "string" || typeof size !== "string") {
        sendJson(response, 400, { error: "Choose a side and enter a price and size." }); return;
      }
      const participant = await query<{ claimed_account_id: string }>(`SELECT p.claimed_account_id FROM participants p
        JOIN rounds r ON r.id=p.round_id WHERE p.session_hash=$1 AND r.status='active'`, [sessionHash]);
      const accountId = participant[0]?.claimed_account_id;
      if (!accountId) throw new RoundGuardError("Join an available round before reviewing a quote.");
      const snapshot = await readMarketSnapshot("BTC-USD");
      if (!snapshot.mark || !snapshot.depth || !snapshot.marketRules || snapshot.unavailableSources.length) {
        throw new RoundGuardError("Strike market data is incomplete. Refresh before reviewing a quote.", 503);
      }
      const policy = readGamePolicy(snapshot.marketRules);
      if (!policy) throw new RoundGuardError("Round limits are not ready yet. You can still explore the live arena.", 423);
      const marketObservedAt = Date.now();
      const validation = validateQuoteDraft({ side, price, size }, snapshot.marketRules, snapshot.mark,
        snapshot.depth, policy.rules.maximumQuoteNotional, marketObservedAt);
      if (!validation.valid || !validation.notional) {
        const error = validation.errors.price ?? validation.errors.size ?? validation.errors.general ?? "Review the quote details.";
        sendJson(response, 422, { error, errors: validation.errors }); return;
      }
      const risk = await readAccountRisk(accountId);
      const now = Date.now();
      assertFreshRisk(risk, now);
      const notional = parseDecimal(validation.notional);
      const available = parseDecimal(risk.account.available_balance);
      if (!notional || !available || notional.coefficient <= 0n || risk.observedAt < now - 3_000) {
        throw new RoundGuardError("Refresh Strike balance and positions before reviewing a quote.", 423);
      }
      if (compareDecimals(available, notional) < 0) throw new RoundGuardError("Available Strike collateral is below this quote’s notional.", 423);
      const intent = await transaction(client => issueQuoteIntent(client, sessionHash, side, now, {
        availableBalance: risk.account.available_balance, currentAbsoluteExposure: risk.absoluteExposure,
        requestedNotional: validation.notional!, maximumAccountExposure: policy.rules.maximumAccountExposure,
        price, size,
      }));
      sendJson(response, 201, { intent, validation: { notional: validation.notional }, marketCheckedAt: snapshot.checkedAt }); return;
    } catch (error) {
      if (error instanceof RoundGuardError) { sendJson(response, error.status, { error: error.message }); return; }
      if (error instanceof StrikeReadError) {
        const status = error.status === 404 ? 404 : error.status === 409 ? 409 : 503;
        sendJson(response, status, { error: status === 404 ? "Strike account was not found." : "Account details are unavailable. Try again shortly." }); return;
      }
      throw error;
    }
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "This endpoint only accepts GET requests." });
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { service: "toruni-local-api", network: "strike-v2-testnet" });
      return;
    }
    if (url.pathname === "/api/game-policy") {
      const snapshot = await readMarketSnapshot("BTC-USD");
      sendJson(response, 200, publicGamePolicy(snapshot.marketRules)); return;
    }
    if (url.pathname === "/api/events") { openEventStream(request, response); return; }
    if (url.pathname === "/api/participants/me") {
      const session = await readSessionHash(request);
      if (!session) { sendJson(response, 401, { error: "No active Toruni session." }); return; }
      sendJson(response, 200, await readParticipantSnapshot(session)); return;
    }
    if (url.pathname === "/api/rounds/current") {
      sendJson(response, 200, await readCurrentRound()); return;
    }
    const reportRoute = url.pathname.match(/^\/api\/rounds\/([0-9a-f-]{36})\/(results|audit|leaderboard)$/i);
    if (reportRoute) {
      const report = await readRoundReport(reportRoute[1]!);
      if (!report) { sendJson(response, 404, { error: "Round not found." }); return; }
      sendJson(response, 200, reportRoute[2] === "audit" ? await readRoundAudit(reportRoute[1]!)
        : reportRoute[2] === "leaderboard" ? await readLeaderboard(reportRoute[1]!) : report);
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
    if (url.pathname === "/api/risk") {
      const accountId = queryValue(url, "account_id");
      if (!accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
        sendJson(response, 400, { error: "Choose a valid Strike account." }); return;
      }
      const [account, positions] = await Promise.all([readPublicAccount({ accountId }), readPublicPositions(accountId)]);
      sendJson(response, 200, { account, positions: positions.positions, observedAt: Math.min(account.observedAt, positions.observedAt) }); return;
    }
    if (!url.pathname.startsWith("/api/")) { await serveClient(url.pathname, response); return; }
    sendJson(response, 404, { error: "API route not found." });
  } catch (error) {
    if (error instanceof RoundGuardError) { sendJson(response, error.status, { error: error.message }); return; }
    if (error instanceof StrikeReadError) {
      const status = error.status === 404 ? 404 : error.status >= 400 && error.status < 600 ? error.status : 503;
      const message = status === 404
        ? "Strike account was not found."
        : status === 409
          ? "Strike account identity could not be verified."
          : "Account details are unavailable. Try again shortly.";
      sendJson(response, status, { error: message });
      return;
    }
    sendJson(response, 503, { error: url.pathname.startsWith("/api/rounds/") ? "Round service unavailable. Try again shortly." : "Market data is unavailable." });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new RoundGuardError("Send the request as JSON.", 415);
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > 8_192) throw new RoundGuardError("Request is too large.", 413);
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (body.length > 8_192) throw new RoundGuardError("Request is too large.", 413);
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Object required");
    return parsed;
  } catch { throw new RoundGuardError("Request details could not be read.", 400); }
}


const sessionRequests = new Map<string, { start: number; count: number }>();
function allowSessionRequest(address: string): boolean {
  const now = Date.now();
  const previous = sessionRequests.get(address);
  if (!previous || now - previous.start >= 60_000) {
    if (sessionRequests.size >= 5000) sessionRequests.clear();
    sessionRequests.set(address, { start: now, count: 1 });
    return true;
  }
  previous.count += 1;
  return previous.count <= 10;
}

async function serveClient(pathname: string, response: ServerResponse): Promise<void> {
  const root = resolve(process.cwd(), "dist");
  const isAppRoute = pathname === "/" || pathname === "/arena" || /^\/results\/[0-9a-f-]{36}$/i.test(pathname);
  const isAsset = /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2|png|svg)$/.test(pathname);
  if (!isAppRoute && !isAsset) { sendJson(response, 404, { error: "Page not found." }); return; }
  const filename = resolve(root, isAppRoute ? "index.html" : pathname.slice(1));
  if (!filename.startsWith(root + sep)) { sendJson(response, 404, { error: "Page not found." }); return; }
  try {
    const data = await readFile(filename);
    const extension = filename.split(".").pop() ?? "";
    const types: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2" };
    response.writeHead(200, { "Content-Type": `${types[extension] ?? "application/octet-stream"}; charset=utf-8`, "X-Content-Type-Options": "nosniff", "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-store" });
    response.end(data);
  } catch { sendJson(response, 503, { error: "Toruni is unavailable. Try again shortly." }); }
}
