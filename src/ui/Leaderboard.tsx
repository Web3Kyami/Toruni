import { useEffect, useState, type MouseEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon, TrophyIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { marketSymbols } from "../../shared/markets";
import type { LeaderboardMarket, LeaderboardPeriod, LeaderboardSnapshot } from "../../shared/leaderboard";

export function Leaderboard({ navigate, market, onMarketChange }: { navigate: (path: string) => void; market: LeaderboardMarket; onMarketChange: (market: LeaderboardMarket) => void }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>(() => new URLSearchParams(window.location.search).get("period") === "7d" ? "7d" : "all");
  const [page, setPage] = useState(() => {const value=new URLSearchParams(window.location.search).get("page") ?? "1";return /^[1-9]\d{0,3}$/.test(value) && Number(value)<=1000 ? Number(value) : 1;});
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<LeaderboardSnapshot | null>(null);
  useEffect(() => {
    const search = new URLSearchParams({ symbol: market, period, page: String(page) });
    window.history.replaceState(null,"",`/leaderboard?${search}`);
  }, [market,period,page]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true); setError(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/leaderboard?symbol=${market}&period=${period}&page=${page}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error("Leaderboard unavailable");
        const result = await response.json() as LeaderboardSnapshot;
        if (!Array.isArray(result.entries) || result.market !== market || result.period !== period || result.page !== page) throw new Error("Leaderboard unavailable");
        if (!cancelled) { setData(result); setError(false); }
      } catch { if (!cancelled) setError(true); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load(); const timer = window.setInterval(load,30_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [market, period, page, revision]);
  const current = data?.market === market && data.period === period && data.page === page ? data : null;
  const follow = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(path);
  };
  return <section className="leaderboard-page">
    <header className="leaderboard-heading"><div><span className="panel-kicker">BEST ROUNDS</span><h1>Leaderboard</h1></div><button className="button button--ghost" onClick={() => navigate("/arena?mode=spectate")}>Open arena <ArrowRightIcon aria-hidden="true" size={17}/></button></header>
    <section className="panel leaderboard-panel" aria-label="Maker rankings">
      <div className="leaderboard-controls">
        <div className="leaderboard-period" role="group" aria-label="Ranking period">{([["all","All time"],["7d","7 days"]] as const).map(([value,label]) => <button key={value} className={period === value ? "is-active" : ""} aria-pressed={period === value} onClick={() => {setPeriod(value);setPage(1);}}>{label}</button>)}</div>
        <label className="leaderboard-market">Market<select aria-label="Leaderboard market" value={market} onChange={event => {onMarketChange(event.target.value as LeaderboardMarket);setPage(1);}}><option value="all">All markets</option>{marketSymbols.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
      </div>
      {error ? <div className="leaderboard-empty" role="status"><h2>Rankings unavailable</h2><button className="button button--ghost" onClick={() => setRevision(value=>value+1)}>Try again</button></div>
        : !current && loading ? <div className="leaderboard-loading" aria-label="Loading leaderboard" role="status"><span className="sr-only">Loading leaderboard</span>{[1,2,3,4].map(row=><div key={row}/>)}</div>
        : !current?.entries.length ? <div className="leaderboard-empty"><TrophyIcon aria-hidden="true" size={30} weight="regular"/><h2>No completed rounds yet</h2><button className="button button--ghost" onClick={() => navigate("/arena?mode=spectate")}>Open arena <ArrowRightIcon aria-hidden="true" size={17}/></button></div>
        : <div className="leaderboard-table-wrap"><table className="leaderboard-table"><caption className="sr-only">Best completed round per maker, ranked by exact score. Equal scores share a rank.</caption><thead><tr><th scope="col">Rank</th><th scope="col">Maker</th><th scope="col" className="number-cell">Best score</th><th scope="col" className="leaderboard-extra number-cell">Rounds</th><th scope="col" className="leaderboard-extra">Best round</th><th scope="col"><span className="sr-only">Results</span></th></tr></thead><tbody>{current.entries.map(entry => <tr key={entry.makerId} className={entry.rank === 1 ? "leaderboard-leader" : ""}>
          <td><span className="leaderboard-rank">{entry.rank === 1 && <TrophyIcon aria-hidden="true" size={17}/>}<span>{entry.rank}</span></span></td>
          <th scope="row"><span className="leaderboard-maker">Maker {entry.makerId.slice(0,8).toUpperCase()}</span><span className="leaderboard-symbol">{entry.symbol}</span></th>
          <td className="number-cell"><strong className="leaderboard-score">{entry.score}</strong><span className="leaderboard-points">PTS</span></td>
          <td className="leaderboard-extra number-cell">{entry.rounds}</td>
          <td className="leaderboard-extra"><time dateTime={new Date(entry.endsAt).toISOString()}>{new Date(entry.endsAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time></td>
          <td><a className="leaderboard-result" href={`/results/${entry.roundId}`} onClick={event=>follow(event,`/results/${entry.roundId}`)} aria-label={`View best round for Maker ${entry.makerId.slice(0,8).toUpperCase()}`}><span>View round</span><ArrowUpRightIcon aria-hidden="true" size={18}/></a></td>
        </tr>)}</tbody></table></div>}
      {!error && current && (page > 1 || current.hasMore) && <nav className="leaderboard-pagination" aria-label="Leaderboard pages"><button className="button button--ghost" disabled={page===1 || loading} onClick={()=>setPage(value=>value-1)}><ArrowLeftIcon aria-hidden="true" size={16}/>Previous</button><span>Page {page}</span><button className="button button--ghost" disabled={!current.hasMore || loading} onClick={()=>setPage(value=>value+1)}>Next<ArrowRightIcon aria-hidden="true" size={16}/></button></nav>}
    </section>
  </section>;
}
