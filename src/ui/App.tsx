import { useRoundData, type ObservedOrder } from "../api/useRoundData";
import { ScorePanel, StandingsPanel } from "./RoundPanels";
import { Results } from "./Results";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketSnapshot } from "../../shared/contracts";
import { authorizeBuilderConnect, clearApiSession, getBuilderCode, getCurrentApiSession, isBuilderAuthorizationUncertain, reconcileBuilderAuthorization } from "../api/builderConnect";
import { readMarketSnapshot, readPublicStrikeAccount, readRiskSnapshot, type RiskSnapshot, type PublicStrikeAccount } from "../api/market";
import { getEthereumProvider, requestWalletAddress, type EthereumProvider } from "../api/walletProvider";

type Tab = "quotes" | "market" | "standings";
type Dialog = "rules" | "how" | "connect" | "orders" | "risk" | null;
type MarketState = "checking" | "live" | "partial" | "offline";
type ConnectStage = "idle" | "checking-account" | "account-found" | "new-account" | "authorizing" | "connected" | "unknown";

function formatPrice(value?: string | null): string {
  if (!value) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(parsed);
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  if (name === "arrow") return <svg {...shared}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
  if (name === "check") return <svg {...shared}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === "book") return <svg {...shared}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20" /></svg>;
  if (name === "wallet") return <svg {...shared}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 9h18M16 14h.01" /></svg>;
  if (name === "clock") return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  if (name === "shield") return <svg {...shared}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg>;
  return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M12 8v4m0 4h.01" /></svg>;
}

function StatusPill({ state, children }: { state: "live" | "waiting" | "paused"; children: ReactNode }) {
  return <span className={`status-pill status-pill--${state}`}><span className="status-dot" />{children}</span>;
}

function AppDialog({ kind, onClose, address, account, stage, error, onLookup, onAuthorize, onReconcile, recovering, risk, riskLoading, riskError, onRiskRefresh, orders, ordersCurrent }: {
  orders: ObservedOrder[];
  ordersCurrent: boolean;
  kind: Dialog;
  onClose: () => void;
  address: string;
  account: PublicStrikeAccount | null;
  stage: ConnectStage;
  error: string;
  onLookup: () => void;
  onAuthorize: () => void;
  onReconcile: () => void;
  recovering: boolean;
  risk: RiskSnapshot | null;
  riskLoading: boolean;
  riskError: string;
  onRiskRefresh: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (kind && !dialog.open) dialog.showModal();
    if (!kind && dialog.open) dialog.close();
  }, [kind]);

  const isConnect = kind === "connect";
  const title = kind === "rules" ? "How scoring works" : kind === "how" ? "Make both sides count" : kind === "risk" ? "Margin and positions" : kind === "orders" ? "Your Toruni orders" : "Connect to Strike testnet";
  return (
    <dialog ref={dialogRef} className={isConnect || kind === "risk" ? "modal modal--wallet" : "modal"} onClose={onClose} aria-labelledby="dialog-title" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter(control => control.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="modal-topline"><span>TORUNI · STRIKE V2 TESTNET</span><button className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></div>
      <h2 id="dialog-title">{title}</h2>
      {kind === "rules" && <div className="modal-copy">
        <p>Points reward real post-only quotes that rest close to Strike’s mark price. Every order must be independently confirmed open by Toruni’s server.</p>
        <div className="formula-card"><span>POINTS / MINUTE</span><strong>25B + 25A + 50 min(B, A)</strong><small>B and A are quote quality from 0 to 1. Quality falls linearly to zero at 50 bps.</small></div>
        <ul><li>Only verified open GTC limit orders count.</li><li>A quote must rest for five observed seconds before it can earn points.</li><li>Stale market, order, or risk data pauses scoring.</li><li>Filled orders can create positions. Canceling the remaining order does not close a position.</li></ul>
        <p className="modal-note">Scoring version: observed two-sided v0.1. No fills, rivals, or profits are simulated.</p>
      </div>}
      {kind === "how" && <div className="how-content">
        <div className="how-rails" aria-label="Illustration showing bid, mark, and ask"><span>BID</span><i /><b>MARK</b><i /><span>ASK</span></div>
        <p>Place a real buy quote below the mark and a real sell quote above it. Strike confirms the orders; Toruni checks their status and scores the time they stay eligible.</p>
        <div className="how-steps"><span><b>01</b> Connect and check account</span><span><b>02</b> Review each quote</span><span><b>03</b> Keep both sides eligible</span></div>
        <p className="modal-note">Illustration only. No market price or order is shown here.</p>
      </div>}
      {kind === "orders" && <OrderRecords orders={orders} current={ordersCurrent} />}
      {kind === "risk" && <div className="connect-flow">
        {riskLoading && <p role="status">Checking Strike account data…</p>}
        {riskError && <p className="inline-error" role="alert">{riskError}</p>}
        {!account && <p>Connect a wallet and check its Strike testnet account to view margin and positions.</p>}
        {risk && <><div className="balance-row"><span>Available balance</span><strong>{risk.account.available_balance}</strong></div><p className="metric-sub">Observed {new Date(risk.observedAt).toLocaleTimeString()}</p>
          <h3>Open positions</h3>{risk.positions.length === 0 ? <p>No open positions were returned by Strike.</p> : <ul className="position-list">{risk.positions.map((position, index) => <li key={`${position.symbol}-${index}`}><strong>{position.symbol}</strong><span>Size {position.size}</span><span>{position.leverage}x · {position.marginMode}</span></li>)}</ul>}
          <p className="modal-note">BTC leverage: {risk.account.symbolSettings?.["BTC-USD"]?.leverage !== undefined ? `${risk.account.symbolSettings["BTC-USD"].leverage}x` : "Not verified"}. Toruni requires independently checked 1x settings before new game quotes.</p></>}
        {account && <button className="button button--ghost button--wide" onClick={onRiskRefresh} disabled={riskLoading}>Refresh account and positions</button>}
        <p className="risk-warning">Canceling an order does not close a filled position. Toruni does not automatically close positions.</p>
      </div>}
      {isConnect && <div className="connect-flow">
        {stage === "connected" && address && <div className="connected-summary">
          <StatusPill state="live">BUILDER API WALLET AUTHORIZED</StatusPill>
          <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>
          {account ? <div className="balance-row"><span>Available balance</span><strong>{account.available_balance}</strong></div> : <p className="inline-error" role="status"><Icon name="alert" size={17} />Public account data is unavailable. Do not authorize again; refresh the account check later.</p>}
          <p className="modal-note">This session key stays in browser memory. Order placement remains locked until market limits, credited collateral, and a live round are verified.</p>
          {error && <p className="inline-error" role="status">{error}</p>}
        </div>}
        {stage === "unknown" && <div className="unknown-auth">
          <StatusPill state="paused">AUTHORIZATION STATUS UNKNOWN</StatusPill>
          <p>Strike may have created a Toruni API wallet, but the response did not arrive. Do not authorize again yet; that could revoke the wallet Strike just created.</p>
          <p className="modal-note">No order or deposit was submitted. Keep this tab open while the existing API key is checked.</p>
          <button className="button button--primary button--wide" onClick={onReconcile} disabled={recovering}>{recovering ? "Checking authorization…" : "Check authorization status"}</button>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </div>}
        {stage !== "connected" && stage !== "unknown" && <>
          <p>Toruni checks your Ethereum wallet against Strike’s public testnet account data first. This check does not place an order or transfer funds.</p>
          {stage === "account-found" && <div className="account-found"><StatusPill state="live">ACCOUNT FOUND</StatusPill><span>{address ? shortAddress(address) : ""}</span></div>}
          {stage === "new-account" && <div className="account-found account-found--new"><StatusPill state="waiting">NO ACCOUNT FOUND</StatusPill><span>Strike may create one after you approve its message.</span></div>}
          {address && <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>}
          {error && <p className="inline-error" role="alert"><Icon name="alert" size={17} />{error}</p>}
          {stage === "idle" && <button className="button button--primary button--wide" onClick={onLookup} disabled={!getBuilderCode()}>
            <Icon name="wallet" />{getBuilderCode() ? "Connect wallet and check account" : "Builder code required"}<Icon name="arrow" />
          </button>}
          {stage === "account-found" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>Next, your wallet will sign a Strike authorization message. It approves Toruni at <b>0 bps</b>. Reconnecting replaces any existing API wallet for this builder. No trade or deposit is authorized.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Authorize Toruni on Strike <Icon name="arrow" />
            </button>
          </>}
          {stage === "new-account" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>After your approval, Strike creates an account and a Toruni API wallet. The fee cap is <b>0 bps</b>. No trade or deposit is authorized.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Continue to wallet signature <Icon name="arrow" />
            </button>
          </>}
          {stage === "checking-account" && <div className="progress-line"><span className="spinner" />Checking Strike testnet…</div>}
          {stage === "authorizing" && <div className="progress-line"><span className="spinner" />Waiting for wallet approval…</div>}
          {!getBuilderCode() && <p className="modal-note">No active Toruni builder code is configured in this build, so wallet access is not requested.</p>}
        </>}
        <button className="button button--ghost button--wide spectator-return" onClick={onClose}>Return as spectator</button>
      </div>}
    </dialog>
  );
}

export function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const navigate = (path: string) => {
    window.history.pushState(null, "", path);
    setPathname(window.location.pathname);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const resultsRoundId = pathname.match(/^\/results\/([0-9a-f-]{36})$/i)?.[1];
  const [clock, setClock] = useState(Date.now());
  const roundData = useRoundData();
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tab, setTab] = useState<Tab>("quotes");
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketState, setMarketState] = useState<MarketState>("checking");
  const [marketMessage, setMarketMessage] = useState("Checking Strike testnet data");
  const [connectStage, setConnectStage] = useState<ConnectStage>("idle");
  const [walletAddress, setWalletAddress] = useState("");
  const [account, setAccount] = useState<PublicStrikeAccount | null>(null);
  const [connectError, setConnectError] = useState("");
  const [provider, setProvider] = useState<EthereumProvider | null>(null);
  const [notice, setNotice] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [risk, setRisk] = useState<RiskSnapshot | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState("");
  const refreshRisk = async () => {
    if (!account) return;
    setRiskLoading(true); setRiskError("");
    try {
      const result = await readRiskSnapshot(account.account_id);
      if (result.account.account_id !== account.account_id) throw new Error("The returned account did not match your selected wallet.");
      setRisk(result);
    } catch { setRisk(null); setRiskError("Strike account and position data is unavailable. Refresh before making another decision."); }
    finally { setRiskLoading(false); }
  };
  useEffect(() => {
    if (!provider?.on || !walletAddress) return;
    const changed = (accounts: unknown) => {
      const selected = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      if (selected.toLowerCase() !== walletAddress.toLowerCase()) {
        clearApiSession(); setAccount(null); setRisk(null); setWalletAddress("");
        setConnectStage(isBuilderAuthorizationUncertain() ? "unknown" : "idle");
        setConnectError("Wallet selection changed. Check the selected account before continuing.");
      }
    };
    provider.on("accountsChanged", changed);
    return () => provider.removeListener?.("accountsChanged", changed);
  }, [provider, walletAddress]);

  const refreshMarket = useCallback(async () => {
    try {
      const snapshot = await readMarketSnapshot("BTC-USD");
      setMarket(snapshot);
      if (snapshot.unavailableSources.length === 0) {
        setMarketState("live");
        setMarketMessage("Strike testnet data live");
      } else if (snapshot.unavailableSources.length < 3) {
        setMarketState("partial");
        setMarketMessage(`Partial feed · ${snapshot.unavailableSources.join(", ")} unavailable`);
      } else {
        setMarketState("offline");
        setMarketMessage("Strike testnet data unavailable · scoring paused");
      }
    } catch {
      setMarketState("offline");
      setMarketMessage("Strike testnet data unavailable · scoring paused");
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    let cancelled = false;
    const poll = async () => {
      await refreshMarket();
      if (!cancelled) timer = window.setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshMarket]);

  useEffect(() => {
    const session = getCurrentApiSession();
    if (session) {
      setWalletAddress(session.address);
      setConnectStage("connected");
    }
  }, []);

  const openConnect = () => {
    if (isBuilderAuthorizationUncertain()) setConnectStage("unknown");
    else if (getCurrentApiSession()) setConnectStage("connected");
    else if (connectStage !== "checking-account" && connectStage !== "authorizing") setConnectStage("idle");
    setDialog("connect");
  };

  const lookupAccount = async () => {
    setConnectError("");
    setConnectStage("checking-account");
    try {
      const nextProvider = getEthereumProvider();
      const address = await requestWalletAddress(nextProvider);
      setProvider(nextProvider);
      setWalletAddress(address);
      try {
        const result = await readPublicStrikeAccount(address);
        setAccount(result);
        setConnectStage("account-found");
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
          setAccount(null);
          setConnectStage("new-account");
          return;
        }
        throw error;
      }
    } catch (error) {
      setConnectStage("idle");
      setConnectError(error instanceof Error ? error.message : "Could not read Strike account status.");
    }
  };

  const authorize = async () => {
    if (!provider || !walletAddress) return;
    setConnectError("");
    setConnectStage("authorizing");
    try {
      const result = await authorizeBuilderConnect(provider, walletAddress);
      setConnectStage("connected");
      try {
        const verifiedAccount = await readPublicStrikeAccount(walletAddress);
        if (verifiedAccount.account_id !== result.account_id) {
          throw new Error("Strike account lookup did not match the authorization response.");
        }
        setAccount(verifiedAccount);
      } catch (readError) {
        setAccount(null);
        setConnectError(readError instanceof Error ? `Builder authorization succeeded. ${readError.message}` : "Builder authorization succeeded, but the public account read is unavailable.");
      }
    } catch (error) {
      setConnectStage(isBuilderAuthorizationUncertain() ? "unknown" : account ? "account-found" : "new-account");
      setConnectError(error instanceof Error ? error.message : "Strike authorization could not be completed.");
    }
  };

  const reconcile = async () => {
    setRecovering(true); setConnectError("");
    try {
      const recovered = await reconcileBuilderAuthorization();
      setConnectStage("connected");
      try {
        const verified = await readPublicStrikeAccount(walletAddress);
        if (verified.account_id !== recovered.accountId) throw new Error("Account identity did not match.");
        setAccount(verified);
      } catch { setAccount(null); setConnectError("Authorization is active, but the account balance is unavailable. Do not authorize again."); }
    } catch (failure) { setConnectError(failure instanceof Error ? failure.message : "Authorization could not be checked."); }
    finally { setRecovering(false); }
  };
  const explore = () => {
    navigate("/arena?mode=spectate");
    setTab("market");
    document.getElementById("market-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const currentMarketState = marketState === "live" && market?.mark && clock - market.mark.observedAt > 5000 ? "offline" : marketState;
  const serverNow = roundData.serverTime ? roundData.serverTime + Math.max(0, clock - roundData.receivedAt) : clock;
  const round = roundData.round;
  const remaining = round ? Math.max(0, Math.ceil(((round.status === "lobby" ? round.startsAt : round.endsAt) - serverNow) / 1000)) : null;
  const countdown = remaining === null ? null : `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
  const markPrice = market?.mark?.markPrice ?? null;
  const bid = market?.depth?.bids[0];
  const ask = market?.depth?.asks[0];
  const liveAccount = connectStage === "connected" && account !== null;
  const gameBlockReason = currentMarketState !== "live"
    ? "Live mark, depth, and engine rules are required."
    : !liveAccount
      ? "Connect and verify a Strike testnet account first."
      : "A funded account and server-open round are not verified yet.";

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate("/"); }} aria-label="Toruni home">
          <span className="brand-mark"><i /><i /><b /></span>
          <span>TORUNI</span>
        </a>
        <span className="network-badge" aria-label="Strike V2 testnet">TESTNET</span>
        <div className="topbar-divider" />
        <span className="topbar-context">LIQUIDITY ARENA <span className="topbar-dot">·</span> BTC-USD</span>
        <div className="topbar-spacer" />
        <StatusPill state={currentMarketState === "live" ? "live" : currentMarketState === "checking" ? "waiting" : "paused"}>
          {currentMarketState === "live" ? "TESTNET LIVE" : currentMarketState === "checking" ? "CONNECTING" : "SCORING PAUSED"}
        </StatusPill>
        <button className="button button--connect" onClick={openConnect}>
          <Icon name="wallet" size={17} />
          {liveAccount ? shortAddress(walletAddress) : "Connect wallet"}
        </button>
      </header>

      <main id="top" className="page-content">
        {resultsRoundId ? <Results roundId={resultsRoundId} onBack={() => navigate("/")} onRules={() => setDialog("rules")} /> : <>
        {pathname === "/arena" ? <section className="arena-heading"><div><span className="panel-kicker">BTC-USD · STRIKE V2 TESTNET</span><h1>The liquidity arena</h1></div><button className="button button--ghost" onClick={() => navigate("/")}>Back to lobby</button></section> : <section className="intro-row">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" />THE MARKET NEEDS MAKERS</div>
            <h1>Anyone can bet on the market.<br /><em>Can you make the market?</em></h1>
            <p className="intro-copy">Keep genuine testnet buy and sell quotes close to the mark. Verified liquidity earns points.</p>
          </div>
          <div className="intro-actions">
            <button className="button button--ghost" onClick={explore}>Explore live arena <Icon name="arrow" size={16} /></button>
            <button className="button button--ghost" onClick={() => setDialog("how")}>How it works <Icon name="arrow" size={16} /></button>
            <button className="button button--ghost" onClick={() => setDialog("rules")}>Scoring rules</button>
          </div>
        </section>}

        <div className={`feed-banner feed-banner--${currentMarketState}`} role="status" aria-live="polite">
          <span className="feed-banner-icon"><Icon name={currentMarketState === "live" ? "check" : "alert"} size={16} /></span>
          <span>{currentMarketState === "offline" && marketState === "live" ? "Strike market data is stale · scoring paused" : marketMessage}</span>
          <span className="feed-banner-time">{market?.mark ? `MARK OBSERVED ${new Date(market.mark.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "NO MARK OBSERVED"}</span>
        </div>

        <div className="mobile-score-strip"><span>{roundData.health === "unavailable" ? "Server updates unavailable" : round ? round.status.replaceAll("_", " ") : "Spectating"}</span><strong>Your score {roundData.participant?.score ?? "—"}</strong></div>
        <nav className="mobile-tabs" aria-label="Arena sections">
          {(["quotes", "market", "standings"] as Tab[]).map((item) => <button key={item} className={tab === item ? "mobile-tab is-active" : "mobile-tab"} onClick={() => setTab(item)} aria-pressed={tab === item}>{item}</button>)}
        </nav>

        <div className="arena-grid">
          <aside id="market-panel" className={`panel market-panel ${tab !== "market" ? "mobile-hidden" : ""}`}>
            <div className="panel-heading">
              <div><span className="panel-kicker">LIVE MARKET</span><h2>BTC-USD</h2></div>
              <span className="market-icon">₿</span>
            </div>
            <div className="mark-block">
              <span className="metric-label">STRIKE MARK <span className="help-dot" title="Strike mark price is the reference Toruni uses to grade quote proximity.">?</span></span>
              <strong className="mark-value">{markPrice ? `$${formatPrice(markPrice)}` : "—"}</strong>
              <span className="metric-sub">{markPrice ? "Public Strike testnet feed" : "Waiting for a live Strike mark"}</span>
            </div>
            <div className="book-heading"><span>TOP OF BOOK</span><span>PRICE <small>·</small> SIZE</span></div>
            {market?.depth ? <div className="book-table">
              <div className="book-side book-side--ask"><span>ASK</span><strong>{ask ? `$${formatPrice(ask.price)}` : "—"}</strong><small>{ask?.size ?? "—"}</small></div>
              <div className="book-mid"><i /><span>MARK</span><i /></div>
              <div className="book-side book-side--bid"><span>BID</span><strong>{bid ? `$${formatPrice(bid.price)}` : "—"}</strong><small>{bid?.size ?? "—"}</small></div>
            </div> : <div className="book-empty"><span className="book-empty-line"><i /><i /><i /><i /><i /></span><p>{currentMarketState === "offline" ? "Book unavailable" : "Waiting for Strike depth"}</p></div>}
            <div className="market-foot"><span><i className="source-dot" />SOURCE</span><strong>{market?.depth ? "Strike V2 testnet" : "Not verified"}</strong></div>
            <div className="market-foot"><span>ENGINE RULES</span><strong>{market?.marketRules ? "Received" : "Unavailable"}</strong></div>
            <button className="text-button" onClick={refreshMarket}>Refresh live data <Icon name="arrow" size={14} /></button>
          </aside>

          <section className={`center-column ${tab !== "quotes" ? "mobile-hidden" : ""}`}>
            <div className="round-card panel">
              <div className="round-left">
                <span className="panel-kicker">{round ? round.status.replaceAll("_", " ") : "NEXT CHALLENGE NOT SCHEDULED"}</span>
                <div className="round-title-row"><h2>Two sides. One score.</h2><span className="round-length"><Icon name="clock" size={14} /> {countdown ?? "180 SEC"}</span></div>
                <p>One maker per account · real Strike orders · no simulated fills</p>
              </div>
              <button className="button button--join" onClick={openConnect} disabled={!getBuilderCode()} title={!getBuilderCode() ? "Toruni needs an active Strike builder code before wallet authorization." : gameBlockReason}>
                Join challenge <Icon name="arrow" size={16} />
              </button>
            </div>

            <div className="quote-section-heading">
              <div><span className="panel-kicker">YOUR QUOTES</span><h2>Build the spread</h2></div>
              <StatusPill state={currentMarketState === "live" ? "waiting" : "paused"}>{currentMarketState !== "live" ? "SCORING PAUSED" : round?.status === "active" ? "ROUND ACTIVE" : "NO ACTIVE ROUND"}</StatusPill>
            </div>
            <div className="quote-grid">
              <QuoteCard side="bid" markPrice={markPrice} blockReason={gameBlockReason} onReview={() => setNotice(gameBlockReason)} />
              <QuoteCard side="ask" markPrice={markPrice} blockReason={gameBlockReason} onReview={() => setNotice(gameBlockReason)} />
            </div>
            {notice && <p className="quote-notice" role="status"><Icon name="alert" size={15} />{notice}</p>}
            <p className="quote-safety"><Icon name="shield" size={15} />Post-only GTC limit orders only. Review price and size before each order.</p>

            <div className="lower-grid lower-grid--orders">

              <section className={`panel order-panel ${tab === "standings" ? "mobile-show" : ""}`}>
                <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">MY ORDERS</span><h2>Order status</h2></div><button className="icon-button icon-button--subtle" onClick={() => setDialog("orders")} aria-label="Open order details"><Icon name="arrow" size={16} /></button></div>
                <OrderRecords orders={roundData.orders} current={roundData.health === "current"} />
                <button className="text-button" onClick={() => setDialog("orders")}>Open order details <Icon name="arrow" size={14} /></button>
                <button className="text-button risk-access" onClick={() => { setDialog("risk"); void refreshRisk(); }}>Margin and positions <Icon name="shield" size={14} /></button>
              </section>
            </div>
          </section>

          <aside className={`right-column ${tab !== "standings" ? "mobile-hidden" : ""}`}>
            <ScorePanel data={roundData} now={serverNow} />
            <StandingsPanel data={roundData} />
            <section className="panel trust-panel">
              <div className="trust-icon"><Icon name="shield" size={17} /></div>
              <div><strong>Proof before points</strong><p>Toruni scores only after Strike confirms your order is open.</p></div>
              <button className="icon-button icon-button--subtle" onClick={() => setDialog("rules")} aria-label="Read verification rules"><Icon name="arrow" size={15} /></button>
            </section>
            <section className="panel activity-panel">
              <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">ROUND FEED</span><h2>Recent activity</h2></div><span className="feed-live-label">{roundData.health !== "current" ? "PAUSED" : roundData.round ? "SERVER OBSERVATIONS" : "AWAITING ROUND"}</span></div>
              <OrderRecords orders={roundData.orders.filter(order => order.observed_at).slice(0, 4)} current={roundData.health === "current"} activity />
            </section>
          </aside>
        </div>

        </>}
        <footer className="app-footer">
          <div className="footer-brand"><span className="brand-mark brand-mark--small"><i /><i /><b /></span><span>TORUNI</span><small>Liquidity, made visible.</small></div>
          <div className="footer-links"><button onClick={() => setDialog("rules")}>Rules & scoring</button><button onClick={() => setDialog("how")}>How to play</button><span>STRIKE FINANCE · V2 TESTNET</span></div>
        </footer>
      </main>

      <div className="mobile-order-bar">
        <button onClick={() => setDialog("orders")}><Icon name="book" size={16} /> My orders <span>{roundData.orders.length || "—"}</span></button>
        <button onClick={openConnect}><Icon name="wallet" size={16} />{liveAccount ? "Account" : "Connect"}</button>
      </div>

      <AppDialog
        orders={roundData.orders}
        ordersCurrent={roundData.health === "current"}
        kind={dialog}
        onClose={() => setDialog(null)}
        address={walletAddress}
        account={account}
        stage={connectStage}
        error={connectError}
        onLookup={() => void lookupAccount()}
        onAuthorize={() => void authorize()}
        onReconcile={() => void reconcile()}
        recovering={recovering}
        risk={risk}
        riskLoading={riskLoading}
        riskError={riskError}
        onRiskRefresh={() => void refreshRisk()}
      />
    </div>
  );
}

function QuoteCard({ side, markPrice, blockReason, onReview }: {
  side: "bid" | "ask";
  markPrice: string | null;
  blockReason: string;
  onReview: () => void;
}) {
  const isBid = side === "bid";
  return <article className={`quote-card panel quote-card--${side}`}>
    <div className="quote-card-top">
      <div className="quote-side-title"><span className="quote-glyph">{isBid ? "↙" : "↗"}</span><div><span className="panel-kicker">{isBid ? "BUY SIDE" : "SELL SIDE"}</span><h3>{isBid ? "Bid" : "Ask"}</h3></div></div>
      <StatusPill state="paused">NOT JOINED</StatusPill>
    </div>
    <div className="quote-fields">
      <label>PRICE <span>USD</span><div className="input-shell"><span>$</span><input aria-label={`${isBid ? "Bid" : "Ask"} price`} inputMode="decimal" placeholder={markPrice ? "Enter price" : "Waiting for mark"} disabled /></div></label>
      <label>SIZE <span>BTC</span><div className="input-shell"><input aria-label={`${isBid ? "Bid" : "Ask"} size`} inputMode="decimal" placeholder="Enter size" disabled /><span>BTC</span></div></label>
    </div>
    <div className="quote-meta"><span><Icon name="shield" size={14} /> POST-ONLY</span><span>GTC</span><span>≤ 50 BPS</span></div>
    <button className={`button quote-button quote-button--${side}`} onClick={onReview} disabled>
      Review {isBid ? "bid" : "ask"} <Icon name="arrow" size={15} />
    </button>
    <p className="quote-disabled-reason" title={blockReason}><Icon name="alert" size={13} />{blockReason}</p>
  </article>;
}

function OrderRecords({ orders, current, activity = false }: { orders: ObservedOrder[]; current: boolean; activity?: boolean }) {
  if (!orders.length) return <div className="empty-orders"><p>{!current ? "Order status is unavailable" : activity ? "Waiting for verified activity" : "No Toruni orders in this session"}</p><small>{!current ? "Checking again automatically. No order is assumed closed." : "Pending and unknown orders never count as open."}</small></div>;
  return <div className="order-records">{!current && <p role="status">Updates paused. These are the last observed statuses.</p>}{orders.map(order => <article className="order-record" key={order.client_order_id}>
    <div><strong>{order.side === "buy" ? "Bid" : "Ask"}</strong><span>{order.verification_error ? "Verification unavailable" : order.exchange_status || order.intent_status}</span></div>
    <p>{order.price ? `$${formatPrice(order.price)}` : "Price not verified"} · {order.original_qty ?? "Unverified"} BTC</p>
    <small>{order.filled_qty === null ? "Filled size not verified" : `${order.filled_qty} BTC filled`}{order.observed_at ? ` · Observed ${new Date(order.observed_at).toLocaleTimeString()}` : ""}</small>
    {!activity && <code>{order.exchange_order_id || order.client_order_id}</code>}
  </article>)}</div>;
}
