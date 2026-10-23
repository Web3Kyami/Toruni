import type { RoundData } from "../api/useRoundData";

export function ScorePanel({ data, now }: { data: RoundData; now: number }) {
  const participant = data.participant;
  const stale = data.health !== "current" || (participant?.asOf !== null && participant?.asOf !== undefined && now - participant.asOf > 3_000);
  return <section className="panel score-panel">
    <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">YOUR SCORE</span><h2>{participant?.score ?? "—"} <small>PTS</small></h2></div></div>
    {participant && <div className={`score-status ${stale ? "score-status--stale" : ""}`}><span className="status-square status-square--amber" />{stale ? "Updates paused" : participant.verificationState === "verified" ? "Confirmed" : "Pending"}</div>}
  </section>;
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
