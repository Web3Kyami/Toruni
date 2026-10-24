import type { RoundData } from "../api/useRoundData";

export function ScorePanel({ data, now }: { data: RoundData; now: number }) {
  const participant = data.participant;
  const stale = data.health !== "current" || (participant?.asOf !== null && participant?.asOf !== undefined && now - participant.asOf > 3_000);
  const verified = participant?.verificationState === "verified";
  const sideStatus = (reason: string | undefined) => {
    if (!verified) return "Waiting for offer confirmation";
    if (stale) return "Waiting for a fresh update";
    return reason ? scoreReasonLabel(reason) : "Waiting for score evidence";
  };
  return <section className="panel score-panel">
    <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">YOUR SCORE</span><h2>{participant?.score ?? "—"} <small>PTS</small></h2></div></div>
    {participant && <div className={`score-status ${stale ? "score-status--stale" : ""}`}><span className="status-square status-square--amber" />{stale ? "Updates paused" : participant.verificationState === "verified" ? "Confirmed" : "Pending"}</div>}
    {participant && <div className="score-sides" aria-label="Score by offer side">
      <div className="score-side"><span>Bid</span><strong>{sideStatus(participant.sideReasons?.bid)}</strong></div>
      <div className="score-side"><span>Ask</span><strong>{sideStatus(participant.sideReasons?.ask)}</strong></div>
    </div>}
  </section>;
}

function scoreReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    eligible: "Earning now",
    "wrong-market": "Wrong market",
    "not-open": "Not open on Strike",
    "not-maker-limit": "Post-only limit required",
    "invalid-size-or-price": "Offer size or price is invalid",
    "below-minimum-notional": "Below minimum offer value",
    "above-risk-cap": "Above the round limit",
    "exposure-limit": "Account exposure is over the limit",
    "risk-stale": "Account check is out of date",
    "mark-stale": "Market price is out of date",
    "order-stale": "Offer status is out of date",
    "dwell-incomplete": "Offer needs to stay open longer",
    "crosses-mark": "Price crosses the mark",
    "outside-score-band": "Too far from the mark",
    "sampler-gap": "Score update missed",
    "outside-round": "Outside the round",
    "proof-unavailable": "Waiting for a verified offer",
  };
  return labels[reason] ?? "Checking this side";
}
export function StandingsPanel({ data }: { data: RoundData }) {
  return <section className="panel standings-panel">
    <div className="panel-heading"><div><span className="panel-kicker">STANDINGS</span><h2>{data.round ? "Current round" : "Next challenge"}</h2></div><span className="standings-count">{data.health === "current" ? data.makers.length : "—"} <small>MAKERS</small></span></div>
    {data.makers.length === 0 ? <div className="standings-empty"><span className="standings-mark"><i /><i /><b /></span><h3>{data.health === "checking" ? "Loading standings" : data.health === "unavailable" ? "Standings unavailable" : data.round ? "Waiting for players" : "No active round"}</h3></div> : <>
      {data.makers.length === 1 && <p className="solo-notice">{data.makers[0]?.participantId === data.participant?.id ? "You’re the only maker this round" : "One maker this round"}</p>}
      <ol className="maker-list">{data.makers.map((maker, index) => <li key={maker.participantId}><span>{maker.participantId === data.participant?.id ? "You" : `Maker ${index + 1}`}</span><strong>{maker.score}<small> PTS</small></strong></li>)}</ol>
    </>}
    <div className="standings-foot"><span>ROUND STATUS</span><span className="round-state-label">{data.health === "current" ? data.round?.status.replaceAll("_", " ") ?? "NOT SCHEDULED" : "CHECKING"}</span></div>
  </section>;
}
