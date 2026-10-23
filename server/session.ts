import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { query } from "./database.ts";

const production = process.env.NODE_ENV === "production";
const secureCookies = production || process.env.APP_ORIGIN?.startsWith("https://") === true;
const cookieName = secureCookies ? "__Host-toruni" : "toruni_local";
const lifetimeMs = 24 * 60 * 60 * 1000;
const appOrigin = process.env.APP_ORIGIN
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : production ? "" : "http://localhost:5173");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function requestHasTrustedOrigin(request: IncomingMessage): boolean {
  if (!appOrigin) return false;
  try {
    const expected = new URL(appOrigin);
    if (production && expected.protocol !== "https:") return false;
    return request.headers.origin === expected.origin && request.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}

function sessionToken(request: IncomingMessage): string | null {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const value = cookie?.slice(cookieName.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export async function issueSession(request: IncomingMessage, response: ServerResponse): Promise<{ csrfToken: string }> {
  if (!requestHasTrustedOrigin(request)) throw new Error("Untrusted application origin.");
  const csrfToken = randomBytes(32).toString("base64url");
  const prior = sessionToken(request);
  if (prior) {
    const existing = await query(`UPDATE app_sessions SET csrf_hash = $1 WHERE session_hash = $2
      AND expires_at > now() RETURNING session_hash`, [hash(csrfToken), hash(prior)]);
    if (existing.length) return { csrfToken };
  }
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await query(`INSERT INTO app_sessions (session_hash, csrf_hash, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
    [hash(token), hash(csrfToken), now, new Date(now.getTime() + lifetimeMs)]);
  response.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetimeMs / 1000}${secureCookies ? "; Secure" : ""}`);
  return { csrfToken };
}

export async function requireSession(request: IncomingMessage): Promise<string | null> {
  if (!requestHasTrustedOrigin(request)) return null;
  const token = sessionToken(request);
  const csrf = request.headers["x-csrf-token"];
  if (!token || typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) return null;
  const rows = await query<{ csrf_hash: string }>(`SELECT csrf_hash FROM app_sessions WHERE session_hash = $1 AND expires_at > now()`, [hash(token)]);
  if (!rows[0]) return null;
  const supplied = Buffer.from(hash(csrf), "hex");
  const stored = Buffer.from(rows[0].csrf_hash, "hex");
  return supplied.length === stored.length && timingSafeEqual(supplied, stored) ? hash(token) : null;
}

export async function readSessionHash(request: IncomingMessage): Promise<string | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const sessionHash = hash(token);
  const rows = await query("SELECT session_hash FROM app_sessions WHERE session_hash=$1 AND expires_at>now()", [sessionHash]);
  return rows.length ? sessionHash : null;
}
