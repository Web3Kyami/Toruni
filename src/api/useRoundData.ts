import { useEffect, useRef, useState } from "react";
import type { RoundSnapshot } from "./rounds";
export interface MakerStanding { participantId: string; makerId?: string; score: string; asOf: number | null }
export interface ParticipantSnapshot {
  id: string; roundId: string; verificationState: string; roundStatus: string;
  startsAt: number; endsAt: number; score: string | null;
  sideReasons: { bid: string; ask: string } | null; asOf: number | null;
}
export interface ObservedOrder {
  symbol?: string; client_order_id: string; side: "buy" | "sell"; intent_status: string; verification_error: string | null;
  last_checked_at: string | null; first_open_observed_at: string | null;
  exchange_order_id: string | null; exchange_status: string | null;
  price: string | null; original_qty: string | null; filled_qty: string | null; observed_at: string | null;
}
export interface RoundData {
  round: RoundSnapshot | null; makers: MakerStanding[]; participant: ParticipantSnapshot | null;
  orders: ObservedOrder[]; serverTime: number; receivedAt: number;
  completedRoundId: string | null;
  health: "checking" | "current" | "unavailable"; transport: "connecting" | "stream" | "polling";
}
const empty: RoundData = { round: null, makers: [], participant: null, orders: [], serverTime: 0,
  receivedAt: 0, completedRoundId: null, health: "checking", transport: "connecting" };

export function useRoundData(): [RoundData, () => Promise<void>] {
  const [data, setData] = useState<RoundData>(empty);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || cancelled) return;
      refreshing = true;
      try {
        const response = await fetch("/api/rounds/current", { signal: AbortSignal.timeout(5_000), cache: "no-store" });
        if (!response.ok) throw new Error("Round service unavailable.");
        const current = await response.json() as { round: RoundSnapshot | null; serverTime: number };
        if (!current || typeof current !== "object" || !Number.isFinite(current.serverTime) || !("round" in current)
          || (current.round !== null && (!current.round || typeof current.round.id !== "string" || !Number.isFinite(current.round.endsAt)))) throw new Error("Round snapshot could not be verified.");
        const [standingResponse, meResponse] = await Promise.all([
          current.round ? fetch(`/api/rounds/${current.round.id}/leaderboard`, { signal: AbortSignal.timeout(5_000), cache: "no-store" }) : null,
          fetch("/api/participants/me", { signal: AbortSignal.timeout(5_000), cache: "no-store" }),
        ]);
        const standings = standingResponse?.ok ? await standingResponse.json() as { makers: MakerStanding[] } : { makers: [] };
        const me = meResponse.ok ? await meResponse.json() as { participant: ParticipantSnapshot | null; orders: ObservedOrder[] }
          : { participant: null, orders: [] };
        if (!meResponse.ok && meResponse.status !== 401) throw new Error("Account round state is unavailable.");
        if (standingResponse && !standingResponse.ok) throw new Error("Standings unavailable.");
        if (!Array.isArray(standings.makers) || !Array.isArray(me.orders) || !("participant" in me)
          || standings.makers.some(row => !row || typeof row.participantId !== "string" || typeof row.score !== "string")
          || me.orders.some(row => !row || typeof row.client_order_id !== "string" || !["buy", "sell"].includes(row.side))
          || (me.participant !== null && (!me.participant || typeof me.participant !== "object"
            || (me.participant.sideReasons !== null && (!me.participant.sideReasons
              || typeof me.participant.sideReasons.bid !== "string" || typeof me.participant.sideReasons.ask !== "string"))))) {
          throw new Error("Round observations could not be verified.");
        }
        if (!cancelled) setData(previous => ({ ...previous, round: current.round, makers: standings.makers,
          participant: me.participant, orders: me.orders, serverTime: current.serverTime,
          receivedAt: Date.now(), health: "current" }));
      } catch {
        if (!cancelled) setData(previous => ({ ...previous, health: "unavailable" }));
      } finally { refreshing = false; }
    };
    refreshRef.current = refresh;
    const poll = async () => { await refresh(); if (!cancelled) timer = window.setTimeout(poll, 2_000); };
    void poll();
    const stream = new EventSource("/api/events");
    stream.addEventListener("connected", () => { if (!cancelled) setData(previous => ({ ...previous, transport: "stream" })); void refresh(); });
    stream.addEventListener("round", event => {
      try {
        const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (payload && typeof payload === "object" && "completedRoundId" in payload
          && typeof payload.completedRoundId === "string" && /^[0-9a-f-]{36}$/i.test(payload.completedRoundId)) {
          setData(previous => ({ ...previous, completedRoundId: payload.completedRoundId as string }));
        }
      } catch { /* A malformed advisory event must not change route or score state. */ }
      void refresh();
    });
    const onStrikeOrderUpdate = () => { void refresh(); };
    window.addEventListener("toruni:order-update", onStrikeOrderUpdate);
    stream.addEventListener("scoring-paused", () => { if (!cancelled) setData(previous => ({ ...previous, health: "unavailable" })); });
    stream.onerror = () => { if (!cancelled) setData(previous => ({ ...previous, transport: "polling" })); };
    return () => { cancelled = true; window.clearTimeout(timer); stream.close(); window.removeEventListener("toruni:order-update", onStrikeOrderUpdate); };
  }, []);
  return [data, () => refreshRef.current()];
}
