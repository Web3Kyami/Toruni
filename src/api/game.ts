import type { StrikeSide } from "../../shared/contracts";

export interface GamePolicy {
  ready: boolean;
  maximumQuoteNotional: string | null;
  maximumAccountExposure: string | null;
  requiredCollateral: string | null;
}
export interface JoinResult { participantId: string; roundId: string; startsAt: number; verificationState: "unverified" }
export interface ServerIssuedOrderIntent { clientOrderId: string; roundId: string; symbol: string; side: StrikeSide }
export interface IntentResult { intent: ServerIssuedOrderIntent; validation: { notional: string }; marketCheckedAt: number }

let csrfToken = "";
let sessionRequest: Promise<void> | null = null;

export async function ensureToruniSession(): Promise<void> {
  if (csrfToken) return;
  if (sessionRequest) return sessionRequest;
  sessionRequest = (async () => {
    const response = await fetch("/api/session", { method: "POST", cache: "no-store", credentials: "same-origin" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object" || !("csrfToken" in payload)
      || typeof payload.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.csrfToken)) {
      throw new Error("Toruni could not prepare a secure session. Refresh and try again.");
    }
    csrfToken = payload.csrfToken;
  })().finally(() => { sessionRequest = null; });
  return sessionRequest;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  await ensureToruniSession();
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error : "Toruni could not complete that step. Try again shortly.";
    if (response.status === 401) csrfToken = "";
    throw new Error(message);
  }
  return payload as T;
}

export async function readGamePolicy(symbol = "BTC-USD"): Promise<GamePolicy> {
  const response = await fetch(`/api/game-policy?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object" || typeof (payload as GamePolicy).ready !== "boolean") {
    throw new Error("Round settings could not be checked.");
  }
  return payload as GamePolicy;
}

export function joinCurrentRound(accountId: string, symbol = "BTC-USD"): Promise<JoinResult> {
  return post("/api/rounds/current/join", { accountId, symbol });
}

export function requestQuoteIntent(draft: { side: StrikeSide; price: string; size: string; symbol: string }): Promise<IntentResult> {
  return post("/api/quote-intents", draft);
}
