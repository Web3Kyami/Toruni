import { useEffect, useState } from "react";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { baseAsset, type PublicOrderActivity } from "../../shared/markets";

export function MarketActivity({ symbol }: { symbol: string }) {
  const [snapshot, setSnapshot] = useState<{ symbol: string; activity: PublicOrderActivity[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false; let timer = 0;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/activity?symbol=${encodeURIComponent(symbol)}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]),
        });
        if (!response.ok) throw new Error("Activity unavailable");
        const payload = await response.json() as { activity: PublicOrderActivity[] };
        if (!Array.isArray(payload.activity)) throw new Error("Activity unavailable");
        if (!cancelled) { setSnapshot({ symbol, activity: payload.activity }); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
      if (!cancelled) timer = window.setTimeout(load, 5_000);
    };
    void load();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [symbol]);
  const activity = snapshot?.symbol === symbol ? snapshot.activity : [];
  const unit = baseAsset(symbol);
  return <section className="panel activity-panel">
    <div className="panel-heading activity-heading"><h2>Market activity</h2>{activity.length > 0 && <span className="activity-count">{activity.length}</span>}</div>
    {!activity.length ? <div className="empty-orders"><p>{failed ? "Activity unavailable" : snapshot?.symbol === symbol ? "No activity yet" : "Loading activity…"}</p></div>
      : <div className="activity-scroll" tabIndex={0} role="region" aria-label={`${symbol} recent offers`}><ol className="activity-list">{activity.map(order => <li key={order.id}>
        <span className={`activity-side activity-side--${order.side}`} aria-label={order.side === "buy" ? "Buy" : "Sell"}>{order.side === "buy" ? <ArrowDownLeftIcon size={18}/> : <ArrowUpRightIcon size={18}/>}</span>
        <div><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Number(order.price) < 1 ? 4 : 2 }).format(Number(order.price))}</strong><span>{Number(order.size).toLocaleString("en-US", { maximumFractionDigits: 8 })} {unit}</span></div>
        <div className="activity-outcome"><span>{order.status === "open" ? "Open" : order.status === "canceled" ? "Canceled" : order.status === "filled" ? "Filled" : order.status === "rejected" ? "Rejected" : order.status === "expired" ? "Expired" : "Pending"}</span><time dateTime={new Date(order.observedAt).toISOString()}>{new Date(order.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
      </li>)}</ol></div>}
  </section>;
}
