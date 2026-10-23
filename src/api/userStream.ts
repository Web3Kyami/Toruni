import { STRIKE_API_ORIGIN } from "./config.ts";
import { getCurrentApiSession, signCurrentUserStreamLogon } from "./builderConnect.ts";

export type UserStreamState = "connecting" | "authenticating" | "subscribing" | "live" | "reconnecting" | "stopped" | "error";
export type UserStreamEvent = "ORDER_TRADE_UPDATE" | "ACCOUNT_UPDATE";

export function parseUserStreamFrame(raw: string): unknown[] {
  const frames: unknown[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) frames.push(value);
    } catch { /* An incomplete or malformed advisory frame is ignored and REST remains authoritative. */ }
  }
  return frames;
}

export interface UserStreamCallbacks {
  onState(state: UserStreamState): void;
  onEvent(event: UserStreamEvent): void;
}

const socketUrl = `${STRIKE_API_ORIGIN.replace(/^https:/, "wss:")}/ws/user-api`;
if (new URL(socketUrl).origin !== "wss://api-v2-testnet.strikefinance.org") {
  throw new Error("Toruni user updates are restricted to Strike V2 testnet.");
}

const AUTH_CLOSE_CODES = new Set([1008, 4001, 4003, 4401, 4403]);
const MAX_RECONNECTS = 10;
const RECONNECT_DELAY_MS = 5_000;

export function connectStrikeUserStream(accountId: string, callbacks: UserStreamCallbacks): () => void {
  let stopped = false;
  let authFailed = false;
  let retries = 0;
  let socket: WebSocket | null = null;
  let retryTimer = 0;

  const setState = (state: UserStreamState) => { if (!stopped) callbacks.onState(state); };
  const send = (value: unknown) => {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("Strike order updates are not connected.");
    socket.send(JSON.stringify(value));
  };

  const scheduleReconnect = (immediate = false) => {
    if (stopped || authFailed || retryTimer) return;
    if (retries >= MAX_RECONNECTS) { setState("error"); return; }
    retries += 1;
    setState("reconnecting");
    retryTimer = window.setTimeout(() => { retryTimer = 0; open(); }, immediate ? 0 : RECONNECT_DELAY_MS);
  };

  const open = () => {
    if (stopped) return;
    if (getCurrentApiSession()?.accountId !== accountId) { setState("stopped"); return; }
    setState(retries ? "reconnecting" : "connecting");
    try { socket = new WebSocket(socketUrl); }
    catch { scheduleReconnect(); return; }
    const activeSocket = socket;
    let authenticated = false;
    let subscribed = false;

    activeSocket.onopen = async () => {
      if (stopped || socket !== activeSocket) return;
      setState("authenticating");
      try { send(await signCurrentUserStreamLogon(accountId)); }
      catch { authFailed = true; setState("error"); activeSocket.close(); }
    };

    activeSocket.onmessage = event => {
      if (stopped || socket !== activeSocket || typeof event.data !== "string") return;
      for (const frame of parseUserStreamFrame(event.data)) {
        if (!frame || typeof frame !== "object") continue;
        const message = frame as Record<string, unknown>;
        if (message.id === 1) {
          const result = message.result && typeof message.result === "object" ? message.result as Record<string, unknown> : null;
          if (message.status !== 200 || result?.authenticated !== true || result.account_id !== accountId) {
            authFailed = true; setState("error"); activeSocket.close(); return;
          }
          authenticated = true;
          setState("subscribing");
          try { send({ method: "subscribe", channel: "userstream", account_id: accountId, id: 2 }); }
          catch { scheduleReconnect(); activeSocket.close(); return; }
          continue;
        }
        if (message.id === 2) {
          if (!authenticated || message.error || (typeof message.status === "number" && message.status >= 400)) {
            authFailed = true; setState("error"); activeSocket.close(); return;
          }
          subscribed = true;
          retries = 0;
          setState("live");
          continue;
        }
        if (!subscribed) continue;
        if (message.e === "ORDER_TRADE_UPDATE") callbacks.onEvent("ORDER_TRADE_UPDATE");
        else if (message.e === "ACCOUNT_UPDATE") callbacks.onEvent("ACCOUNT_UPDATE");
      }
    };

    activeSocket.onerror = () => { if (!stopped && !authFailed) setState("reconnecting"); };
    activeSocket.onclose = event => {
      if (stopped || socket !== activeSocket) return;
      socket = null;
      if (AUTH_CLOSE_CODES.has(event.code)) { authFailed = true; setState("error"); return; }
      scheduleReconnect();
    };
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN && !authFailed) {
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
      scheduleReconnect(true);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  open();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = 0;
    socket?.close(1000, "Toruni stream stopped");
    socket = null;
    callbacks.onState("stopped");
  };
}
