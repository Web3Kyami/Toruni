import { STRIKE_API_ORIGIN } from "./config";
import type { EthereumProvider } from "./walletProvider";

interface BuilderConnectResponse {
  account_id: string;
  api_wallet_public_key: string;
  api_wallet_expired_at?: number;
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

let currentSession: ApiWalletSession | null = null;
let authorizationUncertain = false;

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

async function generateApiWalletKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
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

export function getCurrentApiSession(): Pick<ApiWalletSession, "accountId" | "address" | "publicKey" | "builderCode"> | null {
  if (!currentSession) return null;
  return {
    accountId: currentSession.accountId,
    address: currentSession.address,
    publicKey: currentSession.publicKey,
    builderCode: currentSession.builderCode,
  };
}

export function isBuilderAuthorizationUncertain(): boolean {
  return authorizationUncertain;
}

export async function authorizeBuilderConnect(
  provider: EthereumProvider,
  address: string,
): Promise<BuilderConnectResponse> {
  const code = getBuilderCode();
  if (!code) throw new Error("Toruni's active Strike builder code has not been configured.");

  const keys = await generateApiWalletKeyPair();
  const challenge = await postJson<{ nonce: string; message_to_sign: string }>(
    "/auth/builder/request-signature",
    {
      address,
      chain: "ethereum",
      code,
      fee_share_bps: 0,
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
  if (!result.account_id || result.api_wallet_public_key?.toLowerCase() !== keys.publicKey.toLowerCase()) {
    authorizationUncertain = true;
    throw new Error("Strike's authorization response did not match the generated API wallet.");
  }

  currentSession = {
    accountId: result.account_id,
    address,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    builderCode: result.builder_code,
    expiresAt: result.api_wallet_expired_at,
  };
  authorizationUncertain = false;
  return result;
}

export async function strikeAuthenticatedFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  const session = currentSession;
  if (!session) throw new Error("Authorize Toruni with your wallet first.");

  const url = new URL(path, STRIKE_API_ORIGIN);
  if (url.origin !== STRIKE_API_ORIGIN) throw new Error("Strike requests are restricted to testnet.");
  const rawBody = method.toUpperCase() === "GET" ? "" : JSON.stringify(body ?? {});
  const timestamp = Math.floor(Date.now() / 1_000).toString();
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

  // POST /v2/order is never retried. A lost response must be reconciled by
  // client_order_id before a user can issue another create request.
  const response = await fetch(url, {
    method,
    headers,
    body: rawBody || undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Strike request failed with status ${response.status}.`);
  return payload as T;
}

export function clearApiSession(): void {
  currentSession = null;
  authorizationUncertain = false;
}
