import { useCallback, useEffect, useState } from "react";
import { readRoundAudit, readRoundReport, RoundNotFoundError, type AuditSample, type RoundReport } from "../api/rounds";

export function Results({ roundId, onBack, onRules }: { roundId: string; onBack: () => void; onRules: () => void }) {
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
      setError(failure instanceof Error ? failure.message : "The report is unavailable.");
    } finally { setLoading(false); }
  }, [roundId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const inspectAudit = async () => {
    setAuditOpen(true); setAuditLoading(true); setAuditError("");
    try { setAudit(await readRoundAudit(roundId)); }
    catch (failure) { setAuditError(failure instanceof Error ? failure.message : "Scoring evidence is unavailable."); }
    finally { setAuditLoading(false); }
  };
  const unresolved = report?.participants.some(row => row.cleanupState !== "verified");
  return <section className="results-page" aria-labelledby="results-title">
    <div className="results-heading"><div><span className="panel-kicker">ROUND REPORT · STRIKE V2 TESTNET</span><h1 id="results-title">Your round, in review.</h1></div><button className="button button--ghost" onClick={onBack}>Back to lobby</button></div>
    {loading && <div className="panel results-empty" role="status"><span className="spinner" /><h2>Loading round report</h2></div>}
    {!loading && !report && <div className="panel results-empty" role="status"><h2>{missing ? "Round not found" : "Report unavailable"}</h2><p>{missing ? "There is no stored report for this round." : error}</p><button className="button button--primary" onClick={() => void refresh()}>Try again</button></div>}
    {report && <>
      <div className="feed-banner" role="status"><span>{report.round.symbol} · {report.round.status.replaceAll("_", " ")}</span><span className="feed-banner-time">{new Date(report.round.endsAt).toLocaleString()}</span></div>
      {report.participants.length === 0 ? <div className="panel results-empty"><h2>No finalized scores</h2><p>Scores appear once the round has been checked.</p><button className="button button--ghost" onClick={() => void refresh()}>Refresh report</button></div> : <div className="results-summary">
        {report.participants.map((participant, index) => <article className="panel result-score" key={participant.participantId}>
          <span className="panel-kicker">{report.participants.length === 1 ? "SOLO ROUND" : `MAKER ${index + 1}`}</span>
          <h2>{participant.score}<small> POINTS</small></h2>
          <dl><div><dt>Time earning points</dt><dd>{participant.verifiedSeconds}s</dd></div><div><dt>Buy offer scoring</dt><dd>{participant.bidSeconds}s</dd></div><div><dt>Sell offer scoring</dt><dd>{participant.askSeconds}s</dd></div><div><dt>Both offers scoring</dt><dd>{participant.twoSidedSeconds}s</dd></div><div><dt>Paused</dt><dd>{participant.pausedSeconds}s</dd></div><div><dt>Unscored time</dt><dd>{participant.unscoredSeconds}s</dd></div><div><dt>Order cleanup</dt><dd>{participant.cleanupState === "verified" ? "All closed" : "Check remaining offers"}</dd></div></dl>
        </article>)}
      </div>}
      <section className={`panel cleanup-panel ${unresolved ? "cleanup-panel--warning" : ""}`}><h2>{unresolved ? "Review remaining orders" : "Order cleanup"}</h2><p>{unresolved ? "One or more game orders may still be open. Inspect the latest Strike status before taking action." : report.participants.length ? "All offers from this round are closed." : "Cleanup has not been finalized."}</p><p>Canceling an order does not close a filled position.</p></section>
      <section className="panel results-orders"><div className="panel-heading"><h2>Round orders</h2><button className="text-button" onClick={() => void inspectAudit()}>View score history</button></div>
        {report.orders.length === 0 ? <p className="results-empty-copy">No confirmed offers for this round.</p> : <div className="results-table-wrap"><table><thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Filled size</th><th>Strike status</th><th>Order reference</th></tr></thead><tbody>{report.orders.map(order => <tr key={order.client_order_id}><td>{order.side}</td><td>{order.price}</td><td>{order.original_qty}</td><td>{order.filled_qty}</td><td>{order.exchange_status}</td><td><code>{order.exchange_order_id || order.client_order_id}</code></td></tr>)}</tbody></table></div>}
      </section>
      {auditOpen && <section className="panel audit-section"><div className="panel-heading"><h2>Score history</h2><button className="text-button" onClick={() => setAuditOpen(false)}>Close evidence</button></div>{auditLoading && <p role="status">Loading score history…</p>}{auditError && <p role="alert">{auditError} <button className="text-button" onClick={() => void inspectAudit()}>Try again</button></p>}{audit && <>
        <div className="audit-timeline" aria-label="Score observation timeline">{audit.length === 0 ? <p>No score history yet.</p> : audit.map(sample => <div key={`${sample.participant_id}-${sample.sampled_at}`} className={`audit-tick ${BigInt(sample.delta_scaled) > 0n ? "audit-tick--earned" : ""}`} title={`${new Date(sample.sampled_at).toLocaleTimeString()} · ${BigInt(sample.delta_scaled) > 0n ? "Points earned" : "No points earned"}`}><span className="sr-only">{sample.sampled_at}: {BigInt(sample.delta_scaled) > 0n ? "Points earned" : "No points earned"}</span></div>)}</div>
        <p className="metric-sub">Green: points earned. Gray: no points earned.</p><div className="results-table-wrap"><table className="score-history"><thead><tr><th>Time</th><th>Buy quality</th><th>Sell quality</th><th>Points</th></tr></thead><tbody>{audit.map(sample => <tr key={`${sample.participant_id}-${sample.sampled_at}`}><td>{new Date(sample.sampled_at).toLocaleTimeString()}</td><td>{qualityPercent(sample.bid_quality_scaled)}</td><td>{qualityPercent(sample.ask_quality_scaled)}</td><td>{(Number(sample.delta_scaled) / 1e12).toFixed(3)}</td></tr>)}</tbody></table></div></>}</section>}
      <div className="results-actions"><button className="button button--primary" onClick={onBack}>Back to lobby</button><button className="button button--ghost" onClick={onRules}>Review scoring rules</button></div>
    </>}
  </section>;
}

function qualityPercent(value: string): string { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e12 ? `${Math.round(parsed / 1e10)}%` : "Unavailable"; }
