import { useEffect, useId, useState } from "react";
import type { StrikeMark } from "../../shared/contracts";
import type { PricePoint } from "../../shared/markets";

export function MarketTrend({ symbol, mark }: { symbol: string; mark: StrikeMark | null }) {
  const [history, setHistory] = useState<{ symbol: string; points: PricePoint[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const gradient = useId().replaceAll(":", "");
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/price-history?symbol=${encodeURIComponent(symbol)}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error("Price history unavailable");
        const payload = await response.json() as { symbol: string; points: PricePoint[] };
        if (payload.symbol !== symbol || !Array.isArray(payload.points)) throw new Error("Price history unavailable");
        const points = payload.points.filter(point => Number.isFinite(point.close) && point.close > 0 && Number.isSafeInteger(point.time));
        if (!cancelled) { setHistory({ symbol, points }); setFailed(points.length < 2); }
      } catch { if (!cancelled) setFailed(true); }
    };
    void load(); const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [symbol]);
  const points = history?.symbol === symbol ? [...history.points] : [];
  if (points.length && mark?.symbol === symbol && mark.observedAt > points.at(-1)!.time) points.push({ time: mark.observedAt, close: Number(mark.markPrice) });
  if (points.length < 2) return <div className="market-trend market-trend--empty" role="img" aria-label={`${symbol} price history ${failed ? "unavailable" : "loading"}`}><span>{failed ? "Chart unavailable" : "Loading chart…"}</span></div>;
  const low = Math.min(...points.map(point => point.close));
  const high = Math.max(...points.map(point => point.close));
  const range = Math.max(high - low, high * 0.0001);
  const start = points[0]!.time; const end = points.at(-1)!.time;
  const path = points.map((point, index) => `${index ? "L" : "M"}${(6 + (point.time - start) / Math.max(1, end - start) * 288).toFixed(2)},${(82 - (point.close - low) / range * 68).toFixed(2)}`).join(" ");
  const rising = points.at(-1)!.close >= points[0]!.close;
  const label = new Intl.NumberFormat("en-US", { maximumFractionDigits: low < 1 ? 4 : 2 });
  return <figure className={`market-trend ${rising ? "market-trend--up" : "market-trend--down"}`}>
    <figcaption><span>Price trend</span><span>1H</span></figcaption>
    <svg viewBox="0 0 300 100" role="img" aria-label={`${symbol} price trend, ${label.format(low)} to ${label.format(high)} USD`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop stopColor="currentColor" stopOpacity=".18"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
      <path d={`${path} L294,100 L6,100 Z`} fill={`url(#${gradient})`}/>
      <path d="M6 82H294" className="trend-baseline"/>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    <div className="trend-range"><span>${label.format(low)}</span><span>${label.format(high)}</span></div>
  </figure>;
}
