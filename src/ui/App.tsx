import { createPortal } from "react-dom";
import { useRoundData, type ObservedOrder } from "../api/useRoundData";
import { ScorePanel, StandingsPanel } from "./RoundPanels";
import { Results } from "./Results";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketSnapshot } from "../../shared/contracts";
import { authorizeBuilderConnect, clearApiSession, getBuilderCode, getCurrentApiSession, isBuilderAuthorizationUncertain, reconcileBuilderAuthorization } from "../api/builderConnect";
import { readMarketSnapshot, readPublicStrikeAccount, readRiskSnapshot, type RiskSnapshot, type PublicStrikeAccount } from "../api/market";
import { getEthereumProvider, requestWalletAddress, type EthereumProvider } from "../api/walletProvider";
import { cancelToruniOrder, placePostOnlyLimitOrder } from "../api/orders";
import { ensureToruniSession, joinCurrentRound, readGamePolicy, requestQuoteIntent, type GamePolicy } from "../api/game";
import { validateQuoteDraft } from "../../shared/quoteValidation";
import { connectStrikeUserStream } from "../api/userStream";

type Tab = "quotes" | "market" | "standings";
type Dialog = "rules" | "how" | "connect" | "orders" | "risk" | "quote-review" | null;
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

function AppDialog({ kind, onClose, address, account, stage, error, onLookup, onAuthorize, onReconcile, recovering, risk, riskLoading, riskError, onRiskRefresh, orders, ordersCurrent, canJoinRound, joinBlockReason, joining, joinError, onJoin, quoteReview, quoteSubmitting, canWriteOrders, canCancelOrders, onSubmitQuote, onCancelOrder, cancelingOrderIds }: {
  orders: ObservedOrder[];
  ordersCurrent: boolean;
  canJoinRound: boolean;
  joinBlockReason: string;
  joining: boolean;
  joinError: string;
  onJoin: () => void;
  quoteReview: { side: "buy" | "sell"; price: string; size: string; notional: string } | null;
  quoteSubmitting: boolean;
  canWriteOrders: boolean;
  canCancelOrders: boolean;
  onSubmitQuote: () => void;
  onCancelOrder: (order: ObservedOrder) => void;
  cancelingOrderIds: Set<string>;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!kind) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (root) root.inert = true;
    const resize = () => dialogRef.current?.parentElement?.style.setProperty("--sheet-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.visualViewport?.removeEventListener("resize", resize);
      document.body.style.overflow = previousOverflow;
      if (root) root.inert = false;
      previous?.focus();
    };
  }, [kind]);

  const isConnect = kind === "connect";
  const title = kind === "rules" ? "How scoring works" : kind === "how" ? "Make both sides count" : kind === "risk" ? "Margin and positions" : kind === "orders" ? "Your Toruni orders" : kind === "quote-review" ? `Review ${quoteReview?.side === "buy" ? "bid" : "ask"}` : "Connect to Strike testnet";
  if (!kind) return null;
  return createPortal(
    <div className={`dialog-overlay ${isConnect || kind === "risk" ? "dialog-overlay--side" : ""}`} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" ref={dialogRef} className={isConnect || kind === "risk" ? "modal modal--wallet" : "modal"} aria-labelledby="dialog-title" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
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
        <p>Earn points by keeping buy and sell offers close to the market price.</p>
        <ul><li>Closer offers earn more. Offers 0.5% or more from the market earn no points.</li><li>Keep an offer open for five seconds before it starts scoring.</li><li>Keep both a buy and a sell offer open to earn a two-sided bonus.</li><li>Scoring pauses when current market or account information is unavailable.</li></ul>
        <p className="risk-warning">An offer can fill and create a position. Canceling the offer does not close that position.</p>
      </div>}
      {kind === "how" && <div className="how-content">
        <div className="how-rails" aria-label="Buy below the market price; sell above it"><span>BUY</span><i /><b>MARKET</b><i /><span>SELL</span></div>
        <p>Offer to buy below the market price and sell above it. Keep both offers open during the three-minute round to earn points.</p>
        <div className="how-steps"><span><b>01</b> Connect and check account</span><span><b>02</b> Review each quote</span><span><b>03</b> Keep both sides eligible</span></div>

      </div>}
      {kind === "orders" && <OrderRecords orders={orders} current={ordersCurrent} onCancel={onCancelOrder} canCancel={canCancelOrders} cancelingOrderIds={cancelingOrderIds} />}
      {kind === "quote-review" && quoteReview && <div className="connect-flow quote-review">
        <p>Review the exact offer before it is sent to Strike testnet.</p>
        <div className="balance-row"><span>Side</span><strong>{quoteReview.side === "buy" ? "Buy · bid" : "Sell · ask"}</strong></div>
        <div className="balance-row"><span>Price</span><strong>${formatPrice(quoteReview.price)}</strong></div>
        <div className="balance-row"><span>Size</span><strong>{quoteReview.size} BTC</strong></div>
        <div className="balance-row"><span>Order value</span><strong>${quoteReview.notional}</strong></div>
        <p className="modal-note">This offer will rest on the market instead of filling immediately. It stays open until it fills or you cancel it. A fill can create a position.</p>
        <p className="risk-warning">Toruni checks the order status independently. A submitted order is not counted as open until Strike confirms it.</p>
        <button className="button button--primary button--wide" onClick={onSubmitQuote} disabled={!canWriteOrders || quoteSubmitting}>
          {quoteSubmitting ? "Sending to Strike…" : "Place testnet order"}<Icon name="arrow" />
        </button>
      </div>}
      {kind === "risk" && <div className="connect-flow">
        {riskLoading && <p role="status">Checking Strike account data…</p>}
        {riskError && <p className="inline-error" role="alert">{riskError}</p>}
        {!account && <p>Connect a wallet and check its Strike testnet account to view margin and positions.</p>}
        {risk && <><div className="balance-row"><span>Available balance</span><strong>{risk.account.available_balance}</strong></div><p className="metric-sub">Observed {new Date(risk.observedAt).toLocaleTimeString()}</p>
          <h3>Open positions</h3>{risk.positions.length === 0 ? <p>No open positions were returned by Strike.</p> : <ul className="position-list">{risk.positions.map((position, index) => <li key={`${position.symbol}-${index}`}><strong>{position.symbol}</strong><span>Size {position.size}</span><span>{position.leverage}x · {position.marginMode}</span></li>)}</ul>}
          <p className="modal-note">BTC leverage: {risk.account.symbolSettings?.["BTC-USD"]?.leverage !== undefined ? `${risk.account.symbolSettings["BTC-USD"].leverage}x` : "Not verified"}. Toruni requires 1x leverage before new game quotes.</p></>}
        {account && <button className="button button--ghost button--wide" onClick={onRiskRefresh} disabled={riskLoading}>Refresh account and positions</button>}
        <p className="risk-warning">Canceling an order does not close a filled position. Toruni does not automatically close positions.</p>
      </div>}
      {isConnect && <div className="connect-flow">
        {stage === "connected" && address && <div className="connected-summary">
          <StatusPill state="live">WALLET AUTHORIZED</StatusPill>
          <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>
          {account ? <div className="balance-row"><span>Available balance</span><strong>{account.available_balance}</strong></div> : <p className="inline-error" role="status"><Icon name="alert" size={17} />Your wallet is authorized, but the balance is unavailable. Check again shortly.</p>}
          <p className="modal-note">Keep this tab open to stay connected. Your Strike balance must be confirmed before you can join.</p>
          {error && <p className="inline-error" role="status">{error}</p>}
          {stage === "connected" && account && <button className="button button--ghost button--wide" onClick={onRiskRefresh} disabled={riskLoading}>
            {riskLoading ? "Refreshing account…" : "Refresh balance and positions"}
          </button>}
          {canJoinRound && <button className="button button--primary button--wide" onClick={onJoin} disabled={joining}>
            {joining ? "Joining challenge…" : "Join challenge"}<Icon name="arrow" />
          </button>}
          {stage === "connected" && !canJoinRound && <p className="modal-note">{joinBlockReason}</p>}
          {joinError && <p className="inline-error" role="alert">{joinError}</p>}
        </div>}
        {stage === "unknown" && <div className="unknown-auth">
          <StatusPill state="paused">AUTHORIZATION STATUS UNKNOWN</StatusPill>
          <p>Your approval may have succeeded. Check its status before approving again; a new approval replaces the previous connection.</p>
          <p className="modal-note">No order or deposit was submitted. Keep this tab open while we check your connection.</p>
          <button className="button button--primary button--wide" onClick={onReconcile} disabled={recovering}>{recovering ? "Checking authorization…" : "Check authorization status"}</button>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </div>}
        {stage !== "connected" && stage !== "unknown" && <>
          <p>Connect your wallet to check your Strike testnet balance. Connecting does not place orders or move funds.</p>
          {stage === "account-found" && <div className="account-found"><StatusPill state="live">ACCOUNT FOUND</StatusPill><span>{address ? shortAddress(address) : ""}</span></div>}
          {stage === "new-account" && <div className="account-found account-found--new"><StatusPill state="waiting">NO ACCOUNT FOUND</StatusPill><span>Strike may create one after you approve its message.</span></div>}
          {address && <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>}
          {error && <p className="inline-error" role="alert"><Icon name="alert" size={17} />{error}</p>}
          {stage === "idle" && <button className="button button--primary button--wide" onClick={onLookup} disabled={!getBuilderCode()}>
            <Icon name="wallet" />{getBuilderCode() ? "Connect wallet and check account" : "Builder code required"}<Icon name="arrow" />
          </button>}
          {stage === "account-found" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>Approve Toruni in your wallet. Toruni adds <b>no extra trading fee</b>. This replaces any previous Toruni authorization. Your approval does not place an order or deposit funds.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Authorize Toruni on Strike <Icon name="arrow" />
            </button>
          </>}
          {stage === "new-account" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>Your approval lets Strike set up access for Toruni, with <b>no extra Toruni trading fee</b>. It does not place an order or deposit funds.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Continue to wallet signature <Icon name="arrow" />
            </button>
          </>}
          {stage === "checking-account" && <div className="progress-line"><span className="spinner" />Checking Strike testnet…</div>}
          {stage === "authorizing" && <div className="progress-line"><span className="spinner" />Waiting for wallet approval…</div>}
          {!getBuilderCode() && <p className="modal-note">Wallet connection is unavailable. You can still explore the arena.</p>}
        </>}
        <button className="button button--ghost button--wide spectator-return" onClick={onClose}>Return as spectator</button>
      </div>}
    </div></div>, document.body
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
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [gamePolicy, setGamePolicy] = useState<GamePolicy | null>(null);
  const [joinError, setJoinError] = useState("");
  const [joining, setJoining] = useState(false);
  const [quoteDrafts, setQuoteDrafts] = useState({ buy: { price: "", size: "" }, sell: { price: "", size: "" } });
  const [quoteReview, setQuoteReview] = useState<{ side: "buy" | "sell"; price: string; size: string; notional: string } | null>(null);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [cancelingOrderIds, setCancelingOrderIds] = useState<Set<string>>(() => new Set());
  const [orderActionMessage, setOrderActionMessage] = useState("");
  const refreshRisk = async (accountId = account?.account_id) => {
    if (!accountId) return null;
    setRiskLoading(true); setRiskError("");
    try {
      const result = await readRiskSnapshot(accountId);
      if (result.account.account_id !== accountId) throw new Error("The returned account did not match your selected wallet.");
      setRisk(result);
      return result;
    } catch { setRisk(null); setRiskError("Strike account and position data is unavailable. Refresh before making another decision."); }
    finally { setRiskLoading(false); }
    return null;
  };
  useEffect(() => {
    void ensureToruniSession().then(() => { setSessionReady(true); setSessionError(""); })
      .catch(error => setSessionError(error instanceof Error ? error.message : "Toruni session is unavailable."));
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try { const policy = await readGamePolicy(); if (!cancelled) setGamePolicy(policy); }
      catch { if (!cancelled) setGamePolicy(null); }
      if (!cancelled) timer = window.setTimeout(poll, 15_000);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);
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
        void refreshRisk(verifiedAccount.account_id);
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
        void refreshRisk(verified.account_id);
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
  const apiSession = getCurrentApiSession();
  const liveAccount = connectStage === "connected" && account !== null && apiSession?.accountId === account.account_id;
  const userStreamAccountId = apiSession?.accountId;
  useEffect(() => {
    if (!liveAccount || !userStreamAccountId) return;
    return connectStrikeUserStream(userStreamAccountId, {
      onState: () => {},
      onEvent: event => {
        if (event === "ORDER_TRADE_UPDATE") window.dispatchEvent(new Event("toruni:order-update"));
        if (event === "ACCOUNT_UPDATE") {
          void readRiskSnapshot(userStreamAccountId).then(next => {
            if (next.account.account_id === userStreamAccountId) setRisk(next);
          }).catch(() => setRisk(null));
        }
      },
    });
  }, [liveAccount, userStreamAccountId]);
  const participantJoined = Boolean(roundData.participant && roundData.round?.id === roundData.participant.roundId);
  const riskFresh = Boolean(risk && clock >= risk.observedAt && clock - risk.observedAt <= 3_000);
  const policyReady = gamePolicy?.ready === true;
  const canJoinRound = Boolean(sessionReady && liveAccount && currentMarketState === "live" && risk && riskFresh && policyReady
    && risk.account.symbolSettings?.["BTC-USD"]?.leverage === 1
    && Number(risk.account.available_balance) >= Number(gamePolicy?.requiredCollateral ?? Infinity)
    && !participantJoined && (!round || round.status === "lobby"));
  const joinBlockReason = !sessionReady
    ? sessionError || "Preparing a secure session…"
    : !liveAccount
      ? "Connect and authorize your Strike testnet account first."
      : !policyReady
        ? "The challenge limits are still being prepared. You can explore the market meanwhile."
        : !riskFresh
          ? "Refresh your Strike balance and positions before joining."
          : risk?.account.symbolSettings?.["BTC-USD"]?.leverage !== 1
            ? "Set BTC-USD to 1x leverage in Strike before joining."
            : Number(risk?.account.available_balance ?? 0) < Number(gamePolicy?.requiredCollateral ?? Infinity)
              ? `Keep at least ${gamePolicy?.requiredCollateral ?? "the required amount"} available for both offers. Strike fees or open positions may require more.`
              : participantJoined
                ? "You have already joined this challenge."
                : round && round.status !== "lobby"
                  ? "This challenge has started. Join the next one."
                  : "Check the latest Strike account details, then join.";
  const sideBusy = (side: "buy" | "sell") => roundData.orders.some(order => order.side === side && order.intent_status !== "terminal");
  const canReviewQuote = (side: "buy" | "sell") => Boolean(sessionReady && liveAccount && market && market.mark && market.depth
    && market.marketRules && currentMarketState === "live" && policyReady && participantJoined
    && round?.status === "active" && roundData.health === "current" && risk && risk.account.symbolSettings?.["BTC-USD"]?.leverage === 1
    && !sideBusy(side));
  const quoteBlockReason = !sessionReady
    ? sessionError || "Preparing a secure session…"
    : !liveAccount
      ? "Connect and verify your Strike testnet account first."
      : !policyReady
        ? "Challenge limits are not ready yet."
        : currentMarketState !== "live"
          ? "Strike market data is unavailable. Quote review is paused."
        : !participantJoined
          ? "Join the challenge to review quotes."
          : round?.status !== "active"
            ? "Quote review opens when the round begins."
            : roundData.health !== "current"
              ? "Waiting for current round and order status."
              : !risk || risk.account.symbolSettings?.["BTC-USD"]?.leverage !== 1
                ? "Refresh your Strike balance and positions first."
                : "This side already has an unresolved offer.";

  const beginJoin = async () => {
    if (!liveAccount || !apiSession) { openConnect(); return; }
    setJoining(true); setJoinError("");
    try {
      const refreshed = await refreshRisk(apiSession.accountId);
      if (!refreshed) throw new Error("Strike balance and position data could not be refreshed.");
      const joined = await joinCurrentRound(apiSession.accountId);
      setDialog(null); navigate("/arena"); setTab("quotes");
      setNotice(`You joined the challenge. It begins in ${Math.max(0, Math.ceil((joined.startsAt - Date.now()) / 1000))} seconds.`);
    } catch (error) { setJoinError(error instanceof Error ? error.message : "Toruni could not join this challenge."); }
    finally { setJoining(false); }
  };

  const reviewQuote = async (side: "buy" | "sell") => {
    setNotice("");
    if (!market?.mark || !market.depth || !market.marketRules || !gamePolicy?.maximumQuoteNotional || !canReviewQuote(side)) {
      setNotice(quoteBlockReason); return;
    }
    const refreshed = await refreshRisk(apiSession?.accountId);
    if (!refreshed || refreshed.account.symbolSettings?.["BTC-USD"]?.leverage !== 1) {
      setNotice("Refresh your Strike balance and positions before reviewing a quote."); return;
    }
    const draft = quoteDrafts[side];
    const validation = validateQuoteDraft({ side, ...draft }, market.marketRules, market.mark, market.depth,
      gamePolicy.maximumQuoteNotional, Date.now());
    if (!validation.valid || !validation.notional) {
      setNotice(validation.errors.price ?? validation.errors.size ?? validation.errors.general ?? "Check the quote details."); return;
    }
    setQuoteReview({ side, ...draft, notional: validation.notional });
    setDialog("quote-review");
  };

  const submitQuote = async () => {
    if (!quoteReview || !apiSession || !canReviewQuote(quoteReview.side)) return;
    setQuoteSubmitting(true); setNotice("");
    let intentIssued = false;
    try {
      const response = await requestQuoteIntent(quoteReview);
      intentIssued = true;
      await placePostOnlyLimitOrder({ intent: response.intent, price: quoteReview.price, size: quoteReview.size });
      setDialog(null); setQuoteReview(null);
      setNotice("Order sent to Strike. Waiting for Strike to confirm it is resting.");
    } catch (error) {
      setDialog(null); setQuoteReview(null);
      setNotice(intentIssued
        ? "Strike may have received this order. Toruni is checking its status. Do not submit it again yet."
        : error instanceof Error ? error.message : "Quote could not be reviewed. Refresh before trying again.");
    } finally { setQuoteSubmitting(false); }
  };

  const cancelObservedOrder = async (order: ObservedOrder) => {
    if (!liveAccount || order.exchange_status !== "open" || !order.client_order_id || !order.exchange_order_id
      || cancelingOrderIds.has(order.client_order_id)) return;
    setCancelingOrderIds(previous => new Set(previous).add(order.client_order_id));
    setOrderActionMessage("");
    try {
      await cancelToruniOrder({ clientOrderId: order.client_order_id, exchangeOrderId: order.exchange_order_id, symbol: "BTC-USD" });
      setOrderActionMessage("Cancellation requested. Waiting for Strike to confirm the final status.");
    } catch {
      setOrderActionMessage("Cancellation could not be confirmed. Toruni is checking the order status; do not repeat the request yet.");
    }
  };

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
        {resultsRoundId ? <Results roundId={resultsRoundId} onBack={() => navigate("/")} onRules={() => setDialog("rules")}
          myOrders={roundData.participant?.roundId === resultsRoundId ? roundData.orders : []}
          canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds}
          onCancel={clientOrderId => { const order = roundData.orders.find(item => item.client_order_id === clientOrderId); if (order) void cancelObservedOrder(order); }} /> : <>
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
              <span className="metric-sub">{markPrice ? "Strike testnet" : "Waiting for a live Strike mark"}</span>
            </div>
            <div className="book-heading"><span>TOP OF BOOK</span><span>PRICE <small>·</small> SIZE</span></div>
            {market?.depth ? <div className="book-table">
              <div className="book-side book-side--ask"><span>ASK</span><strong>{ask ? `$${formatPrice(ask.price)}` : "—"}</strong><small>{ask?.size ?? "—"}</small></div>
              <div className="book-mid"><i /><span>MARK</span><i /></div>
              <div className="book-side book-side--bid"><span>BID</span><strong>{bid ? `$${formatPrice(bid.price)}` : "—"}</strong><small>{bid?.size ?? "—"}</small></div>
            </div> : <div className="book-empty"><span className="book-empty-line"><i /><i /><i /><i /><i /></span><p>{currentMarketState === "offline" ? "Book unavailable" : "Waiting for Strike depth"}</p></div>}
            <div className="market-foot"><span><i className="source-dot" />SOURCE</span><strong>{market?.depth ? "Strike V2 testnet" : "Not verified"}</strong></div>
            <div className="market-foot"><span>MARKET LIMITS</span><strong>{market?.marketRules ? "Received" : "Unavailable"}</strong></div>
            <button className="text-button" onClick={refreshMarket}>Refresh live data <Icon name="arrow" size={14} /></button>
          </aside>

          <section className={`center-column ${tab !== "quotes" ? "mobile-hidden" : ""}`}>
            <div className="round-card panel">
              <div className="round-left">
                <span className="panel-kicker">{round ? round.status.replaceAll("_", " ") : "NEXT CHALLENGE NOT SCHEDULED"}</span>
                <div className="round-title-row"><h2>Two sides. One score.</h2><span className="round-length"><Icon name="clock" size={14} /> {countdown ?? "180 SEC"}</span></div>
                <p>Three minutes. Keep both sides competitive.</p>
              </div>
              <button className="button button--join" onClick={() => {
                if (!liveAccount) openConnect();
                else if (participantJoined) { navigate("/arena"); setTab("quotes"); }
                else if (canJoinRound) void beginJoin();
                else setNotice(joinBlockReason);
              }} disabled={!getBuilderCode() || joining} title={!getBuilderCode() ? "Toruni needs an active Strike builder code before wallet authorization." : joinBlockReason}>
                {joining ? "Joining…" : participantJoined ? "Open arena" : "Join challenge"} <Icon name="arrow" size={16} />
              </button>
            </div>

            <div className="quote-section-heading">
              <div><span className="panel-kicker">YOUR QUOTES</span><h2>Build the spread</h2></div>
              <StatusPill state={currentMarketState === "live" ? "waiting" : "paused"}>{currentMarketState !== "live" ? "SCORING PAUSED" : round?.status === "active" ? "ROUND ACTIVE" : "NO ACTIVE ROUND"}</StatusPill>
            </div>
            <div className="quote-grid">
              {(["buy", "sell"] as const).map(side => {
                const order = [...roundData.orders].reverse().find(item => item.side === side);
                const sideBusyNow = sideBusy(side);
                const status = order?.verification_error ? "CHECKING" : order?.exchange_status?.toUpperCase()
                  ?? (participantJoined ? "READY" : "NOT JOINED");
                const statusState = order?.exchange_status === "open" ? "live" as const
                  : order?.verification_error || order?.intent_status === "issued" || order?.intent_status === "submitted" ? "waiting" as const
                    : "paused" as const;
                return <QuoteCard key={side} side={side === "buy" ? "bid" : "ask"} markPrice={markPrice} value={quoteDrafts[side]}
                  blockReason={sideBusyNow ? "Resolve the existing offer before creating another." : quoteBlockReason}
                  status={status} statusState={statusState} canReview={canReviewQuote(side)}
                  onChange={(field, value) => setQuoteDrafts(previous => ({ ...previous, [side]: { ...previous[side], [field]: value } }))}
                  onReview={() => void reviewQuote(side)} />;
              })}
            </div>
            {notice && <p className="quote-notice" role="status"><Icon name="alert" size={15} />{notice}</p>}
            {orderActionMessage && <p className="quote-notice" role="status"><Icon name="alert" size={15} />{orderActionMessage}</p>}
            <p className="quote-safety"><Icon name="shield" size={15} />Offers stay open until filled or canceled. An offer that would trade immediately is rejected.</p>

            <div className="lower-grid lower-grid--orders">

              <section className={`panel order-panel ${tab === "standings" ? "mobile-show" : ""}`}>
                <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">MY ORDERS</span><h2>Order status</h2></div><button className="icon-button icon-button--subtle" onClick={() => setDialog("orders")} aria-label="Open order details"><Icon name="arrow" size={16} /></button></div>
                <OrderRecords orders={roundData.orders} current={roundData.health === "current"} onCancel={cancelObservedOrder} canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds} />
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
              <div><strong>Open offers earn points</strong><p>Keep your offers open and close to the market.</p></div>
              <button className="icon-button icon-button--subtle" onClick={() => setDialog("rules")} aria-label="Read verification rules"><Icon name="arrow" size={15} /></button>
            </section>
            <section className="panel activity-panel">
              <div className="panel-heading panel-heading--compact"><div><span className="panel-kicker">ROUND FEED</span><h2>Recent activity</h2></div><span className="feed-live-label">{roundData.health !== "current" ? "PAUSED" : roundData.round ? "LATEST UPDATES" : "AWAITING ROUND"}</span></div>
              <OrderRecords orders={roundData.orders.filter(order => order.observed_at).slice(0, 4)} current={roundData.health === "current"} activity onCancel={cancelObservedOrder} canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds} />
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
        canJoinRound={canJoinRound}
        joinBlockReason={joinBlockReason}
        joining={joining}
        joinError={joinError}
        onJoin={() => void beginJoin()}
        quoteReview={quoteReview}
        quoteSubmitting={quoteSubmitting}
        canWriteOrders={Boolean(quoteReview && canReviewQuote(quoteReview.side))}
        canCancelOrders={liveAccount}
        onSubmitQuote={() => void submitQuote()}
        onCancelOrder={cancelObservedOrder}
        cancelingOrderIds={cancelingOrderIds}
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

function QuoteCard({ side, markPrice, blockReason, onReview, value, onChange, canReview, status, statusState }: {
  side: "bid" | "ask";
  markPrice: string | null;
  blockReason: string;
  onReview: () => void;
  value: { price: string; size: string };
  onChange: (field: "price" | "size", value: string) => void;
  canReview: boolean;
  status: string;
  statusState: "live" | "waiting" | "paused";
}) {
  const isBid = side === "bid";
  return <article className={`quote-card panel quote-card--${side}`}>
    <div className="quote-card-top">
      <div className="quote-side-title"><span className="quote-glyph">{isBid ? "↙" : "↗"}</span><div><span className="panel-kicker">{isBid ? "BUY SIDE" : "SELL SIDE"}</span><h3>{isBid ? "Bid" : "Ask"}</h3></div></div>
      <StatusPill state={statusState}>{status}</StatusPill>
    </div>
    <div className="quote-fields">
      <label>PRICE <span>USD</span><div className="input-shell"><span>$</span><input aria-label={`${isBid ? "Bid" : "Ask"} price`} inputMode="decimal" placeholder={markPrice ? "Enter price" : "Waiting for mark"} value={value.price} onChange={event => onChange("price", event.target.value)} disabled={!canReview} /></div></label>
      <label>SIZE <span>BTC</span><div className="input-shell"><input aria-label={`${isBid ? "Bid" : "Ask"} size`} inputMode="decimal" placeholder="Enter size" value={value.size} onChange={event => onChange("size", event.target.value)} disabled={!canReview} /><span>BTC</span></div></label>
    </div>
    <div className="quote-meta"><span><Icon name="shield" size={14} />Resting offers only</span></div>
    <button className={`button quote-button quote-button--${side}`} onClick={onReview} disabled={!canReview}>
      Review {isBid ? "bid" : "ask"} <Icon name="arrow" size={15} />
    </button>
    {!canReview && <p className="quote-disabled-reason" title={blockReason}><Icon name="alert" size={13} />{blockReason}</p>}
  </article>;
}

function OrderRecords({ orders, current, activity = false, onCancel, canCancel, cancelingOrderIds }: {
  orders: ObservedOrder[]; current: boolean; activity?: boolean; onCancel: (order: ObservedOrder) => void;
  canCancel: boolean; cancelingOrderIds: Set<string>;
}) {
  if (!orders.length) return <div className="empty-orders"><p>{!current ? "Order status is unavailable" : activity ? "Waiting for verified activity" : "No Toruni orders in this session"}</p><small>{!current ? "Checking again automatically. No order is assumed closed." : "Only confirmed open offers earn points."}</small></div>;
  return <div className="order-records">{!current && <p role="status">Updates paused. These are the last observed statuses.</p>}{orders.map(order => <article className="order-record" key={order.client_order_id}>
    <div><strong>{order.side === "buy" ? "Bid" : "Ask"}</strong><span>{readableOrderStatus(order)}</span></div>
    <p>{order.price ? `$${formatPrice(order.price)}` : "Price not verified"} · {order.original_qty ?? "Unverified"} BTC</p>
    <small>{order.filled_qty === null ? "Filled size not verified" : `${order.filled_qty} BTC filled`}{order.observed_at ? ` · Observed ${new Date(order.observed_at).toLocaleTimeString()}` : ""}</small>
    {!activity && <><code>{order.exchange_order_id || order.client_order_id}</code>
      {order.exchange_status === "open" && <button className="text-button order-cancel" onClick={() => onCancel(order)}
        disabled={!canCancel || !/^[1-9]\d{0,18}$/.test(order.exchange_order_id ?? "") || cancelingOrderIds.has(order.client_order_id)}>
        {cancelingOrderIds.has(order.client_order_id) ? "Cancellation requested · checking" : "Request cancellation"}
      </button>}
      {Number(order.filled_qty ?? 0) > 0 && <small className="order-risk-note">A fill may have created a position. Check Margin and positions.</small>}
    </>}
  </article>)}</div>;
}

function readableOrderStatus(order: ObservedOrder): string {
  if (order.verification_error) return "Checking with Strike";
  switch (order.exchange_status) {
    case "open": return "Resting on Strike";
    case "pending": return "Waiting for Strike";
    case "filled": return "Filled";
    case "canceled": return "Canceled";
    case "expired": return "Expired";
    case "rejected": return "Not accepted";
    case "unknown": return "Not confirmed yet";
    default: return "Checking with Strike";
  }
}
