import type { RoundData } from "../api/useRoundData";

export function ScorePanel({ data, now }: { data: RoundData; now: number }) {
  const participant = data.participant;
  const stale = data.health !== "current" || (participant?.asOf !== null && participant?.asOf !== undefined && now - participant.asOf > 3_000);
  return <section className="panel score-panel">
    <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">YOUR SCORE</span><h2>{participant?.score ?? "—"} <small>PTS</small></h2></div></div>
    <div className="score-status"><span className="status-square status-square--amber" />{stale ? "Score updates paused" : participant?.verificationState === "verified" ? "Score confirmed" : "Join and verify a resting quote to earn points"}</div>
    {participant?.asOf && <p className="score-as-of">As of {new Date(participant.asOf).toLocaleTimeString()}</p>}
    {!participant && <p className="score-context">Keep both offers competitive to earn a bonus.</p>}
  </section>;
}
export function StandingsPanel({ data }: { data: RoundData }) {
  return <section className="panel standings-panel">
    <div className="panel-heading"><div><span className="panel-kicker">STANDINGS</span><h2>{data.round ? "Current round" : "Next challenge"}</h2></div><span className="standings-count">{data.health === "current" ? data.makers.length : "—"} <small>MAKERS</small></span></div>
    {data.makers.length === 0 ? <div className="standings-empty"><span className="standings-mark"><i /><i /><b /></span><h3>{data.health === "checking" ? "Checking the round" : data.health === "unavailable" ? "Standings unavailable" : data.round ? "Waiting for verified makers" : "No active round"}</h3><p>{data.health === "unavailable" ? "Last known scores stay unchanged until current observations return." : "Join a round to appear here."}</p></div> : <>
      {data.makers.length === 1 && <p className="solo-notice">{data.makers[0]?.participantId === data.participant?.id ? "You’re the only maker this round" : "One verified maker this round"}</p>}
      <ol className="maker-list">{data.makers.map((maker, index) => <li key={maker.participantId}><span>{data.makers.length > 1 ? `${index + 1}. ` : ""}{maker.participantId === data.participant?.id ? "You" : `Maker ${maker.participantId.slice(0, 6)}`}</span><strong>{maker.score}<small> PTS</small></strong></li>)}</ol>
    </>}
    <div className="standings-foot"><span>ROUND STATUS</span><span className="round-state-label">{data.health === "current" ? data.round?.status.replaceAll("_", " ") ?? "NOT SCHEDULED" : "CHECKING"}</span></div>
  </section>;
}
