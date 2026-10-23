import { STRIKE_API_ORIGIN } from "./config.ts";
import type { EthereumProvider } from "./walletProvider";

interface BuilderConnectResponse {
  account_id: string;
  api_wallet_public_key: string;
  api_wallet_expired_at?: string;
  builder_code: string;
  fee_share_bps: number;
}

interface ApiWalletSession {
  accountId: string;
  address: string;
  publicKey: string;
  privateKey: CryptoKey;
  builderCode: string;
  expiresAt?: number;
}

let sessionRevision = 0;
let currentSession: ApiWalletSession | null = null;
let pendingAuthorization: Omit<ApiWalletSession, "accountId"> | null = null;
let recoveryReadAllowed = true;
let serverClockOffset = 0;
let clockCheckedAt = 0;
let authorizationUncertain = false;
let authorizationInProgress = false;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${STRIKE_API_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Strike returned ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

export async function generateApiWalletKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" } as AlgorithmIdentifier,
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = Array.from(publicBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { publicKey, privateKey: pair.privateKey };
}

export function getBuilderCode(): string | null {
  const code = import.meta.env.VITE_BUILDER_CODE?.trim();
  return code ? code : null;
}

function getBuilderFeeBps(): number {
  const fee = import.meta.env.VITE_BUILDER_FEE_BPS?.trim() ?? "0";
  if (fee !== "0") throw new Error("Toruni connection is unavailable right now.");
  return 0;
}

export function getCurrentApiSession(): Pick<ApiWalletSession, "accountId" | "address" | "publicKey" | "builderCode"> | null {
  if (!currentSession) return null;
  return {
    accountId: currentSession.accountId,
    address: currentSession.address,
    publicKey: currentSession.publicKey,
    builderCode: currentSession.builderCode,
  };
}

export async function createUserStreamLogon(
  privateKey: CryptoKey,
  publicKey: string,
  timestamp = Date.now(),
): Promise<{ method: "session.logon"; params: { apiKey: string; signature: string; timestamp: number }; id: number }> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("Strike login details could not be checked.");
  }
  const message = new TextEncoder().encode(`apiKey=${publicKey}&timestamp=${timestamp}`);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" } as AlgorithmIdentifier, privateKey, message,
  ));
  return {
    method: "session.logon",
    params: {
      apiKey: publicKey,
      signature: Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join(""),
      timestamp,
    },
    id: 1,
  };
}

export async function signCurrentUserStreamLogon(accountId: string, timestamp = Date.now()): Promise<{
  method: "session.logon";
  params: { apiKey: string; signature: string; timestamp: number };
  id: number;
}> {
  const session = currentSession;
  if (!session || session.accountId !== accountId) throw new Error("Authorize this Strike account before opening its order updates.");
  const logon = await createUserStreamLogon(session.privateKey, session.publicKey, timestamp);
  if (currentSession !== session) throw new Error("Wallet access changed. Reconnect before checking order updates.");
  return logon;
}

export function isBuilderAuthorizationUncertain(): boolean {
  return authorizationUncertain;
}

export async function authorizeBuilderConnect(
  provider: EthereumProvider,
  address: string,
): Promise<BuilderConnectResponse> {
  if (authorizationUncertain) throw new Error("Reconcile the previous authorization before requesting another signature.");
  if (authorizationInProgress) throw new Error("A wallet authorization is already in progress.");
  if (currentSession) throw new Error("Toruni is already connected in this tab.");
  const code = getBuilderCode();
  if (!code) throw new Error("Toruni connection is unavailable right now.");
  const feeBps = getBuilderFeeBps();
  authorizationInProgress = true;
  const revision = sessionRevision;
  try {

    const keys = await generateApiWalletKeyPair();
    const challenge = await postJson<{ nonce: string; message_to_sign: string }>(
      "/auth/builder/request-signature",
      {
        address,
        chain: "ethereum",
        code,
        fee_share_bps: feeBps,
        public_key: keys.publicKey,
      },
    );
    if (!challenge.nonce || !challenge.message_to_sign) {
      throw new Error("Strike returned an incomplete authorization challenge.");
    }

    // The wallet shows and signs this exact challenge only after the user clicks
    // the explicit authorization control in Toruni.
    const signature = await provider.request({
      method: "personal_sign",
      params: [challenge.message_to_sign, address],
    });
    if (typeof signature !== "string") throw new Error("The wallet did not return a message signature.");

    if (revision !== sessionRevision) throw new Error("Wallet selection changed. Check the selected account before continuing.");
    pendingAuthorization = { address, publicKey: keys.publicKey, privateKey: keys.privateKey, builderCode: code };
    recoveryReadAllowed = true;
    let result: BuilderConnectResponse;
    try {
      const response = await fetch(`${STRIKE_API_ORIGIN}/auth/builder/verify-signature`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: challenge.nonce, wallet_signature: signature }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status >= 500) authorizationUncertain = true;
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Strike returned ${response.status}.`;
        throw new Error(message);
      }
      result = payload as BuilderConnectResponse;
      if (!result || typeof result !== "object") {
        authorizationUncertain = true;
        throw new Error("Strike's authorization response was incomplete.");
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name === "TimeoutError" || error.name === "TypeError") {
        authorizationUncertain = true;
      }
      throw error;
    }
    if (!result.account_id || result.api_wallet_public_key?.toLowerCase() !== keys.publicKey.toLowerCase()
      || result.builder_code !== code || result.fee_share_bps !== feeBps) {
      authorizationUncertain = true;
      recoveryReadAllowed = false;
      throw new Error("Strike could not confirm this approval. Check it before continuing.");
    }

    if (revision !== sessionRevision) {
      authorizationUncertain = true; recoveryReadAllowed = false;
      throw new Error("Wallet selection changed during approval. Check your Strike approval before continuing.");
    }
    currentSession = {
      accountId: result.account_id,
      address,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      builderCode: result.builder_code,
      expiresAt: result.api_wallet_expired_at ? Date.parse(result.api_wallet_expired_at) : undefined,
    };
    authorizationUncertain = false;
    pendingAuthorization = null;
    return result;
  } finally {
    authorizationInProgress = false;
    if (!authorizationUncertain) pendingAuthorization = null;
  }
}

async function signedFetch<T>(session: Pick<ApiWalletSession, "publicKey" | "privateKey" | "expiresAt">, path: string, method: string, body?: unknown, exactBody?: string): Promise<T> {
  if (session.expiresAt !== undefined && (!Number.isFinite(session.expiresAt) || Date.now() >= session.expiresAt)) {
    throw new Error("Your Strike connection has expired. Review it in Strike before reconnecting.");
  }

  const url = new URL(path, STRIKE_API_ORIGIN);
  if (url.origin !== STRIKE_API_ORIGIN) throw new Error("Strike connection is unavailable.");
  const rawBody = method.toUpperCase() === "GET" ? "" : exactBody ?? JSON.stringify(body ?? {});
  if (Date.now() - clockCheckedAt > 30_000) {
    const timeResponse = await fetch(`${STRIKE_API_ORIGIN}/v2/time`, { signal: AbortSignal.timeout(5_000) });
    const time: unknown = await timeResponse.json();
    if (!timeResponse.ok || !time || typeof time !== "object" || !("serverTime" in time) || !Number.isSafeInteger(time.serverTime)) {
      throw new Error("Strike’s clock could not be checked. Try again shortly.");
    }
    serverClockOffset = Number(time.serverTime) - Date.now();
    clockCheckedAt = Date.now();
  }
  const timestamp = Math.floor((Date.now() + serverClockOffset - 1_000) / 1_000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
  const bodyHashHex = Array.from(bodyHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const requestPath = url.pathname + url.search;
  const message = `${method.toUpperCase()}:${requestPath}:${timestamp}:${nonce}:${bodyHashHex}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" } as AlgorithmIdentifier, session.privateKey, new TextEncoder().encode(message)),
  );
  const signatureHex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const headers = new Headers({
    "X-API-Wallet-Public-Key": session.publicKey,
    "X-API-Wallet-Signature": signatureHex,
    "X-API-Wallet-Timestamp": timestamp,
    "X-API-Wallet-Nonce": nonce,
  });
  if (rawBody) headers.set("Content-Type", "application/json");
  if (url.pathname === "/v2/order" && method.toUpperCase() === "POST") headers.set("X-Builder-Fee-Bps", "0");

  // POST /v2/order is never retried. A lost response must be reconciled by
  // client_order_id before a user can issue another create request.
  if (session !== currentSession && session !== pendingAuthorization) throw new Error("Wallet access changed. Check authorization before continuing.");
  const response = await fetch(url, {
    method,
    headers,
    body: rawBody || undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error : response.status === 401 ? "Strike could not confirm this API-wallet authorization." : "Strike could not complete the request. Check the current order status before trying again.";
    throw new Error(message);
  }
  return payload as T;
}

export async function strikeAuthenticatedFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  if (!currentSession) throw new Error("Authorize Toruni with your wallet first.");
  return signedFetch<T>(currentSession, path, method, body);
}

export function serializeStrikeCancelBody(orderId: string): string {
  if (!/^[1-9]\d{0,18}$/.test(orderId) || BigInt(orderId) > 9_223_372_036_854_775_807n) {
    throw new Error("Strike’s order reference could not be verified.");
  }
  return `{"order_id":${orderId},"symbol":"BTC-USD"}`;
}

export async function strikeCancelOrderById<T>(orderId: string): Promise<T> {
  if (!currentSession) throw new Error("Authorize Toruni with your wallet first.");
  const rawBody = serializeStrikeCancelBody(orderId);
  return signedFetch<T>(currentSession, "/v2/order/cancel", "DELETE", undefined, rawBody);
}

/** Reconcile a lost verify response with a read. Never retries verify or creates another wallet. */
export async function reconcileBuilderAuthorization(): Promise<{ accountId: string }> {
  if (!authorizationUncertain || !pendingAuthorization) throw new Error("There is no pending authorization to check in this tab.");
  if (!recoveryReadAllowed) throw new Error("Approval details do not match. Check your approval in Strike before continuing.");
  const candidate = pendingAuthorization;
  const account = await signedFetch<Record<string, unknown>>(candidate, "/v2/account", "GET");
  if (typeof account.account_id !== "string" || account.blockchain !== "ethereum"
    || typeof account.blockchain_address !== "string" || account.blockchain_address.toLowerCase() !== candidate.address.toLowerCase()) {
    throw new Error("Strike has not confirmed this wallet’s account. Keep the tab open and try the status check again.");
  }
  if (candidate !== pendingAuthorization) throw new Error("Wallet access changed while authorization was being checked.");
  currentSession = { ...candidate, accountId: account.account_id };
  pendingAuthorization = null; authorizationUncertain = false;
  return { accountId: currentSession.accountId };
}

export function clearApiSession(): void {
  sessionRevision += 1;
  currentSession = null;
  pendingAuthorization = null;
  // An uncertain prior registration is not permission to generate another wallet.
}
