import { useCallback, useEffect, useState } from "react";
import { readRoundAudit, readRoundReport, RoundNotFoundError, type AuditSample, type RoundReport } from "../api/rounds";
import type { ObservedOrder } from "../api/useRoundData";

export function Results({ roundId, onBack, onRules, myOrders = [], canCancel = false, cancelingOrderIds = new Set(), onCancel }: {
  roundId: string; onBack: () => void; onRules: () => void; myOrders?: ObservedOrder[]; canCancel?: boolean;
  cancelingOrderIds?: Set<string>; onCancel?: (clientOrderId: string) => void;
}) {
  const [report, setReport] = useState<RoundReport | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [audit, setAudit] = useState<AuditSample[] | null>(null);
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError(""); setMissing(false);
    try { setReport(await readRoundReport(roundId)); }
    catch (failure) {
      setReport(null);
      setMissing(failure instanceof RoundNotFoundError);
      setError("Could not load these results. Check your connection and try again.");
    } finally { setLoading(false); }
  }, [roundId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const inspectAudit = async () => {
    setAuditOpen(true); setAuditLoading(true); setAuditError("");
    try { setAudit(await readRoundAudit(roundId)); }
    catch { setAuditError("Score history is unavailable. Try again shortly."); }
    finally { setAuditLoading(false); }
  };
  const unresolved = report?.participants.some(row => row.cleanupState !== "verified");
  return <section className="results-page" aria-labelledby="results-title">
    <div className="results-heading"><div><span className="panel-kicker">ROUND RESULTS</span><h1 id="results-title">Your round</h1></div><button className="button button--ghost" onClick={onBack}>Back to lobby</button></div>
    {loading && <div className="panel results-empty" role="status"><span className="spinner" /><h2>Loading results</h2></div>}
    {!loading && !report && <div className="panel results-empty" role="status"><h2>{missing ? "Round not found" : "Results unavailable"}</h2><p>{missing ? "There are no results for this round." : error}</p><button className="button button--primary" onClick={() => void refresh()}>Try again</button></div>}
    {report && <>
      <div className="feed-banner" role="status"><span>{report.round.symbol} · {report.round.status.replaceAll("_", " ")}</span><span className="feed-banner-time">{new Date(report.round.endsAt).toLocaleString()}</span></div>
      {report.participants.length === 0 ? <div className="panel results-empty"><h2>No scores yet</h2><button className="button button--ghost" onClick={() => void refresh()}>Refresh</button></div> : <div className="results-summary">
        {report.participants.map((participant, index) => <article className="panel result-score" key={participant.participantId}>
          <span className="panel-kicker">{report.participants.length === 1 ? "SOLO ROUND" : `MAKER ${index + 1}`}</span>
          <h2>{participant.score}<small> POINTS</small></h2>
          <dl><div><dt>Time earning points</dt><dd>{participant.verifiedSeconds}s</dd></div><div><dt>Buy offer points</dt><dd>{participant.bidSeconds}s</dd></div><div><dt>Sell offer points</dt><dd>{participant.askSeconds}s</dd></div><div><dt>Two-sided points</dt><dd>{participant.twoSidedSeconds}s</dd></div><div><dt>Offers</dt><dd>{participant.cleanupState === "verified" ? "Closed" : "Check open offers"}</dd></div></dl>
        </article>)}
      </div>}
      {report.participants.length > 0 && <section className={`panel cleanup-panel ${unresolved ? "cleanup-panel--warning" : ""}`}><h2>{unresolved ? "Check open offers" : "Offers closed"}</h2>{unresolved && <p>Some offers may still be open. Check their status before acting.</p>}{report.orders.some(order => Number(order.filled_qty) > 0) && <p>Canceling an offer does not close a position created by a fill.</p>}</section>}
      <section className="panel results-orders"><div className="panel-heading"><h2>Round orders</h2><button className="text-button" onClick={() => void inspectAudit()}>View score history</button></div>
        {report.orders.length === 0 ? <p className="results-empty-copy">No offers this round.</p> : <div className="results-table-wrap"><table><thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Filled</th><th>Status</th><th>Action</th></tr></thead><tbody>{report.orders.map(order => {
          const ownOrder = myOrders.find(item => item.client_order_id === order.client_order_id);
          const canRequestCancel = canCancel && ownOrder?.exchange_status === "open" && Boolean(ownOrder.exchange_order_id);
          const cancelRequested = cancelingOrderIds.has(order.client_order_id);
          return <tr key={order.client_order_id}><td>{order.side === "buy" ? "Bid" : "Ask"}</td><td>{formatPrice(order.price)}</td><td>{formatBtc(order.original_qty)}</td><td>{formatBtc(order.filled_qty)}</td><td>{resultOrderStatus(order.exchange_status)}</td>
            <td>{canRequestCancel ? <button className="text-button" onClick={() => onCancel?.(order.client_order_id)} disabled={cancelRequested}>{cancelRequested ? "Checking…" : "Cancel offer"}</button> : "—"}</td></tr>;
        })}</tbody></table></div>}
      </section>
      {auditOpen && <section className="panel audit-section"><div className="panel-heading"><h2>Score history</h2><button className="text-button" onClick={() => setAuditOpen(false)}>Close</button></div>{auditLoading && <p role="status">Loading…</p>}{auditError && <p role="alert">{auditError} <button className="text-button" onClick={() => void inspectAudit()}>Try again</button></p>}{audit && <>
        <div className="audit-timeline" aria-label="Score observation timeline">{audit.length === 0 ? <p>No score history yet.</p> : audit.map(sample => <div key={`${sample.participant_id}-${sample.sampled_at}`} className={`audit-tick ${BigInt(sample.delta_scaled) > 0n ? "audit-tick--earned" : ""}`} title={`${new Date(sample.sampled_at).toLocaleTimeString()} · ${BigInt(sample.delta_scaled) > 0n ? "Points earned" : "No points earned"}`}><span className="sr-only">{sample.sampled_at}: {BigInt(sample.delta_scaled) > 0n ? "Points earned" : "No points earned"}</span></div>)}</div>
        <p className="metric-sub">Green: points earned. Gray: no points earned.</p><div className="results-table-wrap"><table className="score-history"><thead><tr><th>Time</th><th>Buy quality</th><th>Sell quality</th><th>Points</th></tr></thead><tbody>{audit.map(sample => <tr key={`${sample.participant_id}-${sample.sampled_at}`}><td>{new Date(sample.sampled_at).toLocaleTimeString()}</td><td>{qualityPercent(sample.bid_quality_scaled)}</td><td>{qualityPercent(sample.ask_quality_scaled)}</td><td>{(Number(sample.delta_scaled) / 1e12).toFixed(3)}</td></tr>)}</tbody></table></div></>}</section>}
      <div className="results-actions"><button className="button button--primary" onClick={onBack}>Back to lobby</button><button className="button button--ghost" onClick={onRules}>Review scoring rules</button></div>
    </>}
  </section>;
}

function resultOrderStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "open": return "Resting on Strike";
    case "pending": return "Waiting for Strike";
    case "filled": return "Filled";
    case "canceled": return "Canceled";
    case "expired": return "Expired";
    case "rejected": return "Not accepted";
    default: return "Not confirmed";
  }
}

function formatPrice(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0
    ? `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`
    : "Unavailable";
}

function formatBtc(value: string): string {
  const amount = Number(value);
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(amount) && amount >= 0
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(amount)} BTC`
    : "Unavailable";
}

function qualityPercent(value: string): string { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e12 ? `${Math.round(parsed / 1e10)}%` : "Unavailable"; }
