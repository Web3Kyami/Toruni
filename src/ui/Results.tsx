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
    <div className="results-heading"><div><span className="panel-kicker">ROUND REPORT · STRIKE V2 TESTNET</span><h1 id="results-title">Proof behind the points.</h1></div><button className="button button--ghost" onClick={onBack}>Back to lobby</button></div>
    {loading && <div className="panel results-empty" role="status"><span className="spinner" /><h2>Loading round report</h2></div>}
    {!loading && !report && <div className="panel results-empty" role="status"><h2>{missing ? "Round not found" : "Report unavailable"}</h2><p>{missing ? "There is no stored report for this round." : error}</p><button className="button button--primary" onClick={() => void refresh()}>Try again</button></div>}
    {report && <>
      <div className="feed-banner" role="status"><span>{report.round.symbol} · {report.round.status.replaceAll("_", " ")}</span><span className="feed-banner-time">{new Date(report.round.endsAt).toLocaleString()}</span></div>
      {report.participants.length === 0 ? <div className="panel results-empty"><h2>No finalized scores</h2><p>Verified results appear after the server reconciles this round.</p><button className="button button--ghost" onClick={() => void refresh()}>Refresh report</button></div> : <div className="results-summary">
        {report.participants.map((participant, index) => <article className="panel result-score" key={participant.participantId}>
          <span className="panel-kicker">{report.participants.length === 1 ? "SOLO ROUND" : `MAKER ${index + 1} · ${participant.participantId.slice(0, 8)}`}</span>
          <h2>{participant.score}<small> VERIFIED PTS</small></h2>
          <dl><div><dt>Observed eligible time</dt><dd>{participant.verifiedSeconds}s</dd></div><div><dt>Bid eligible</dt><dd>{participant.bidSeconds}s</dd></div><div><dt>Ask eligible</dt><dd>{participant.askSeconds}s</dd></div><div><dt>Both sides eligible</dt><dd>{participant.twoSidedSeconds}s</dd></div><div><dt>Paused</dt><dd>{participant.pausedSeconds}s</dd></div><div><dt>Unscored time</dt><dd>{participant.unscoredSeconds}s</dd></div><div><dt>Order cleanup</dt><dd>{participant.cleanupState}</dd></div></dl>
        </article>)}
      </div>}
      <section className={`panel cleanup-panel ${unresolved ? "cleanup-panel--warning" : ""}`}><h2>{unresolved ? "Review remaining orders" : "Order cleanup"}</h2><p>{unresolved ? "One or more game orders may still be open. Inspect the latest Strike status before taking action." : report.participants.length ? "The server verified terminal status for this round’s game orders." : "Cleanup has not been finalized."}</p><p>Canceling an order does not close a filled position.</p></section>
      <section className="panel results-orders"><div className="panel-heading"><h2>Order proof</h2><button className="text-button" onClick={() => void inspectAudit()}>Inspect scoring evidence</button></div>
        {report.orders.length === 0 ? <p className="results-empty-copy">No independently observed game orders.</p> : <div className="results-table-wrap"><table><thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Filled size</th><th>Strike status</th><th>Order reference</th></tr></thead><tbody>{report.orders.map(order => <tr key={order.client_order_id}><td>{order.side}</td><td>{order.price}</td><td>{order.original_qty}</td><td>{order.filled_qty}</td><td>{order.exchange_status}</td><td><code>{order.exchange_order_id || order.client_order_id}</code></td></tr>)}</tbody></table></div>}
      </section>
      {auditOpen && <section className="panel audit-section"><div className="panel-heading"><h2>Server scoring evidence</h2><button className="text-button" onClick={() => setAuditOpen(false)}>Close evidence</button></div>{auditLoading && <p role="status">Loading observations…</p>}{auditError && <p role="alert">{auditError} <button className="text-button" onClick={() => void inspectAudit()}>Try again</button></p>}{audit && <>
        <div className="audit-timeline" aria-label="Score observation timeline">{audit.length === 0 ? <p>No score samples stored.</p> : audit.map(sample => <div key={`${sample.participant_id}-${sample.sampled_at}`} className={`audit-tick ${BigInt(sample.delta_scaled) > 0n ? "audit-tick--earned" : ""}`} title={`${new Date(sample.sampled_at).toLocaleTimeString()} · ${sample.participant_id} · ${sample.reason}`}><span className="sr-only">{sample.sampled_at}: {sample.reason}, {sample.delta_scaled} scaled points</span></div>)}</div>
        <details><summary>Exact samples and observation references</summary><pre tabIndex={0}>{JSON.stringify(audit, null, 2)}</pre></details></>}</section>}
      <div className="results-actions"><button className="button button--primary" onClick={onBack}>Back to lobby</button><button className="button button--ghost" onClick={onRules}>Review scoring rules</button></div>
    </>}
  </section>;
}
