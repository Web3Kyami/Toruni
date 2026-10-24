import { createPortal } from "react-dom";
import { useRoundData, type ObservedOrder } from "../api/useRoundData";
import { ScorePanel, StandingsPanel } from "./RoundPanels";
import { Results } from "./Results";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketSnapshot } from "../../shared/contracts";
import { authorizeBuilderConnect, clearApiSession, getBuilderCode, getCurrentApiSession, isBuilderAuthorizationUncertain, reconcileBuilderAuthorization } from "../api/builderConnect";
import { readMarketSnapshot, readPublicStrikeAccount, readRiskSnapshot, type RiskSnapshot, type PublicStrikeAccount } from "../api/market";
import type { EthereumProvider } from "../api/walletProvider";
import { cancelToruniOrder, placePostOnlyLimitOrder } from "../api/orders";
import { ensureToruniSession, joinCurrentRound, readGamePolicy, requestQuoteIntent, type GamePolicy } from "../api/game";
import { validateQuoteDraft } from "../../shared/quoteValidation";
import { connectStrikeUserStream } from "../api/userStream";
import { formatUsd } from "./format";
import { userFacingError } from "./errors";
import { verifiedTerminalOrder } from "./requote";
import { marketStatusMessage } from "./marketStatus";
import { readConnectedWalletAddress } from "../api/walletProvider";
import { useWalletConnection, type WalletConnectorBridge } from "../wallet/WalletConnectionProvider";

type Tab = "quotes" | "market" | "standings";
type Dialog = "rules" | "how" | "connect" | "orders" | "risk" | "quote-review" | "requote" | null;
type RequoteStage = "confirm" | "canceling" | "checking" | "unresolved" | "filled" | null;
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

function formatPositionSize(value: string, symbol: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return "Position size unavailable";
  const short = value.startsWith("-");
  const absolute = value.replace(/^-/, "");
  const [wholeValue = "0", fractionValue = ""] = absolute.split(".");
  const whole = wholeValue.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = fractionValue.replace(/0+$/, "");
  const amount = `${whole}${fraction ? `.${fraction}` : ""}`;
  const flat = /^0(?:\.0*)?$/.test(absolute);
  const baseAsset = symbol.split(/[-_/]/)[0];
  const unit = /^[A-Z0-9]{1,12}$/.test(baseAsset) ? baseAsset : "units";
  return `${flat ? "Flat" : short ? "Short" : "Long"} ${amount} ${unit}`;
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

function AppDialog({ kind, onClose, address, account, stage, error, onChooseWallet, onAuthorize, onReconcile, recovering, risk, riskLoading, riskError, onRiskRefresh, orders, ordersCurrent, canJoinRound, joinBlockReason, joining, joinError, onJoin, quoteReview, quoteSubmitting, canWriteOrders, canCancelOrders, onSubmitQuote, onCancelOrder, cancelingOrderIds, requoteOrder, requoteStage, requoteError, onConfirmRequote, onCheckRequote, onOpenRisk }: {
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
  requoteOrder: ObservedOrder | null;
  requoteStage: RequoteStage;
  requoteError: string;
  onConfirmRequote: () => void;
  onCheckRequote: () => void;
  onOpenRisk: () => void;
  kind: Dialog;
  onClose: () => void;
  address: string;
  account: PublicStrikeAccount | null;
  stage: ConnectStage;
  error: string;
  onChooseWallet: () => void;
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
  const title = kind === "rules" ? "How scoring works" : kind === "how" ? "Make both sides count" : kind === "risk" ? "Margin and positions" : kind === "orders" ? "Your offers" : kind === "quote-review" ? `Review ${quoteReview?.side === "buy" ? "bid" : "ask"}` : kind === "requote" ? `Requote ${requoteOrder?.side === "buy" ? "bid" : "ask"}` : stage === "checking-account" ? "Checking account" : stage === "account-found" || stage === "new-account" ? "Authorize Toruni" : stage === "connected" ? "Your Strike account" : stage === "unknown" ? "Check approval" : "Connect wallet";
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
      <div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog" disabled={requoteStage === "canceling" || requoteStage === "checking"}>×</button></div>
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
        <p>Review this offer before sending it to Strike.</p>
        <div className="balance-row"><span>Side</span><strong>{quoteReview.side === "buy" ? "Buy · bid" : "Sell · ask"}</strong></div>
        <div className="balance-row"><span>Price</span><strong>${formatPrice(quoteReview.price)}</strong></div>
        <div className="balance-row"><span>Size</span><strong>{quoteReview.size} BTC</strong></div>
        <div className="balance-row"><span>Order value</span><strong>{formatUsd(quoteReview.notional)}</strong></div>
        <div className="quote-order-terms"><span>Order type</span><strong>Post-only limit</strong><span>Stays open</span><strong>Until you cancel it, even after the round ends</strong></div>
        <p className="risk-warning">A fill opens a position. Canceling the offer does not close it. Strike trading fees may apply.</p>
        <button className="button button--primary button--wide" onClick={onSubmitQuote} disabled={!canWriteOrders || quoteSubmitting}>
          {quoteSubmitting ? "Sending to Strike…" : "Place offer"}<Icon name="arrow" />
        </button>
      </div>}
      {kind === "requote" && requoteOrder && <div className="connect-flow requote-flow">
        {requoteStage === "confirm" && <>
          <p>Toruni will cancel this offer and wait for Strike to confirm it is closed. Then you can change the price or amount.</p>
          <p className="risk-warning">It may fill before cancellation completes. A fill creates a position, and canceling does not close it.</p>
          <button className="button button--primary button--wide" onClick={onConfirmRequote}>Cancel offer and edit</button>
          <button className="button button--ghost button--wide" onClick={onClose}>Keep offer</button>
        </>}
        {(requoteStage === "canceling" || requoteStage === "checking") && <p role="status">Checking with Strike to confirm this offer is closed.</p>}
        {requoteStage === "unresolved" && <>
          <p className="inline-error" role="alert">{requoteError}</p>
          <p>No replacement has been sent.</p>
          <button className="button button--primary button--wide" onClick={onCheckRequote}>Check status again</button>
          <button className="button button--ghost button--wide" onClick={onClose}>Return to offer</button>
        </>}
        {requoteStage === "filled" && <>
          <p className="inline-error" role="alert">{requoteError}</p>
          <p>Canceling an offer does not close a position created by a fill.</p>
          <button className="button button--primary button--wide" onClick={onOpenRisk}>Check margin and positions</button>
          <button className="button button--ghost button--wide" onClick={onClose}>Close</button>
        </>}
      </div>}
      {kind === "risk" && <div className="connect-flow">
        {riskLoading && <p role="status">Checking Strike account data…</p>}
        {riskError && <p className="inline-error" role="alert">{riskError}</p>}
        {!account && <p>Connect to view your balance and positions.</p>}
        {risk && <><div className="balance-row"><span>Available balance</span><strong>{formatUsd(risk.account.available_balance)}</strong></div>
          <h3>Open positions</h3>{risk.positions.length === 0 ? <p>No open positions.</p> : <ul className="position-list">{risk.positions.map((position, index) => <li key={`${position.symbol}-${index}`}><strong>{position.symbol}</strong><span>{formatPositionSize(position.size, position.symbol)}</span><span>{position.leverage}x · {position.marginMode}</span></li>)}</ul>}
          <p className="modal-note">Leverage: {risk.account.symbolSettings?.["BTC-USD"]?.leverage !== undefined ? `${risk.account.symbolSettings["BTC-USD"].leverage}x` : "Unavailable"}. Toruni requires 1x to play.</p></>}
        {account && <button className="button button--ghost button--wide" onClick={onRiskRefresh} disabled={riskLoading}>Refresh account and positions</button>}
        <p className="risk-warning">Canceling an offer will not close a position created by a fill.</p>
      </div>}
      {isConnect && <div className="connect-flow">
        {stage === "connected" && address && <div className="connected-summary">
          <StatusPill state="live">CONNECTED</StatusPill>
          <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>
          {account ? <div className="balance-row"><span>Available balance</span><strong>{formatUsd(account.available_balance)}</strong></div> : <p className="inline-error" role="status"><Icon name="alert" size={17} />Your wallet is authorized, but the balance is unavailable. Check again shortly.</p>}
          {error && <p className="inline-error" role="status">{error}</p>}
          {stage === "connected" && account && <button className="button button--ghost button--wide" onClick={onRiskRefresh} disabled={riskLoading}>
            {riskLoading ? "Refreshing account…" : "Refresh balance and positions"}
          </button>}
          {canJoinRound && <button className="button button--primary button--wide" onClick={onJoin} disabled={joining}>
            {joining ? "Joining challenge…" : "Join challenge"}<Icon name="arrow" />
          </button>}
          {stage === "connected" && !canJoinRound && <p className="modal-note">{joinBlockReason}</p>}
          {joinError && <p className="inline-error" role="alert">{joinError}</p>}
          {getBuilderCode() && <button className="button button--ghost button--wide" onClick={onChooseWallet}>Change wallet</button>}
        </div>}
        {stage === "unknown" && <div className="unknown-auth">
          <StatusPill state="paused">APPROVAL UNCLEAR</StatusPill>
          <p>Your approval may have succeeded. Check its status before approving again.</p>
          <p className="modal-note">No offer or deposit was sent.</p>
          <button className="button button--primary button--wide" onClick={onReconcile} disabled={recovering}>{recovering ? "Checking…" : "Check approval"}</button>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </div>}
        {stage !== "connected" && stage !== "unknown" && <>
          {stage === "account-found" && <div className="account-found"><StatusPill state="live">ACCOUNT FOUND</StatusPill><span>{address ? shortAddress(address) : ""}</span></div>}
          {stage === "new-account" && <div className="account-found account-found--new"><StatusPill state="waiting">NO ACCOUNT FOUND</StatusPill><span>Strike may create one after you approve its message.</span></div>}
          {address && <p className="wallet-address"><Icon name="wallet" size={17} />{shortAddress(address)}</p>}
          {error && <p className="inline-error" role="alert"><Icon name="alert" size={17} />{error}</p>}
          {stage === "account-found" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>Toruni adds no fee. Strike’s trading fees may apply. This replaces any prior Toruni approval. Approval does not place an offer or deposit funds.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Authorize Toruni on Strike <Icon name="arrow" />
            </button>
          </>}
          {stage === "new-account" && <>
            <div className="authorization-notice"><Icon name="shield" size={18} /><span>Toruni adds no fee. Strike’s trading fees may apply. Approval does not place an offer or deposit funds.</span></div>
            <button className="button button--primary button--wide" onClick={onAuthorize}>
              Continue to wallet signature <Icon name="arrow" />
            </button>
          </>}
          {stage === "checking-account" && <div className="progress-line"><span className="spinner" />Checking account…</div>}
          {stage === "authorizing" && <div className="progress-line"><span className="spinner" />Waiting for wallet approval…</div>}
          {getBuilderCode() && stage !== "checking-account" && stage !== "authorizing" && <button className="button button--ghost button--wide" onClick={onChooseWallet}>Choose another wallet</button>}
          {!getBuilderCode() && <p className="modal-note">Wallet connection is unavailable. You can still explore the arena.</p>}
        </>}
        <button className="button button--ghost button--wide spectator-return" onClick={onClose}>Return as spectator</button>
      </div>}
    </div></div>, document.body
  );
}

export function App() {
  const { address: selectedAddress, connector: selectedConnector, connected: walletConnected, connectModalOpen, pickerLoading, openWalletPicker, disconnectWallet } = useWalletConnection();
  const [pathname, setPathname] = useState(window.location.pathname);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setPathname(window.location.pathname);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const resultsRoundId = pathname.match(/^\/results\/([0-9a-f-]{36})$/i)?.[1];
  const [clock, setClock] = useState(Date.now());
  const [roundData, refreshRoundData] = useRoundData();
  const roundDataRef = useRef(roundData);
  const handledCompletedRoundId = useRef<string | null>(null);
  useEffect(() => { roundDataRef.current = roundData; }, [roundData]);
  useEffect(() => {
    const completedRoundId = roundData.completedRoundId;
    if (!completedRoundId || completedRoundId === handledCompletedRoundId.current
      || !/^[0-9a-f-]{36}$/i.test(completedRoundId)) return;
    handledCompletedRoundId.current = completedRoundId;
    if (completedRoundId !== resultsRoundId) navigate(`/results/${completedRoundId}`);
  }, [navigate, resultsRoundId, roundData.completedRoundId]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tab, setTab] = useState<Tab>("quotes");
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketState, setMarketState] = useState<MarketState>("checking");
  const [marketMessage, setMarketMessage] = useState("Checking market data");
  const [connectStage, setConnectStage] = useState<ConnectStage>("idle");
  const [walletAddress, setWalletAddress] = useState("");
  const [account, setAccount] = useState<PublicStrikeAccount | null>(null);
  const [connectError, setConnectError] = useState("");
  const [provider, setProvider] = useState<EthereumProvider | null>(null);
  const pendingWalletConnect = useRef(false);
  const walletPickerWasOpen = useRef(false);
  const walletAttempt = useRef(0);
  const observedWalletAddress = useRef<string | null>(null);
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
  const [requoteOrder, setRequoteOrder] = useState<ObservedOrder | null>(null);
  const [requoteStage, setRequoteStage] = useState<RequoteStage>(null);
  const [requoteError, setRequoteError] = useState("");
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
    } catch { setRisk(null); setRiskError("Account and position details are unavailable. Refresh before continuing."); }
    finally { setRiskLoading(false); }
    return null;
  };
  useEffect(() => {
    void ensureToruniSession().then(() => { setSessionReady(true); setSessionError(""); })
      .catch(error => setSessionError(userFacingError(error, "Toruni could not prepare your connection. Refresh and try again.")));
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
  const refreshMarket = useCallback(async () => {
    try {
      const snapshot = await readMarketSnapshot("BTC-USD");
      setMarket(snapshot);
      if (snapshot.unavailableSources.length === 0) {
        setMarketState("live");
        setMarketMessage("Market data live");
      } else if (snapshot.unavailableSources.length < 3) {
        setMarketState("partial");
        setMarketMessage("Some market data is unavailable. Offers are paused.");
      } else {
        setMarketState("offline");
        setMarketMessage("Market data unavailable. Offers are paused.");
      }
    } catch {
      setMarketState("offline");
      setMarketMessage("Market data unavailable. Offers are paused.");
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

  const lookupSelectedWallet = useCallback(async (address: string, selectedConnector: WalletConnectorBridge) => {
    const attempt = ++walletAttempt.current;
    setConnectError("");
    setConnectStage("checking-account");
    setDialog("connect");
    try {
      const nextProvider = await selectedConnector.getProvider() as EthereumProvider;
      const verifiedAddress = await readConnectedWalletAddress(nextProvider, address);
      if (attempt !== walletAttempt.current) return;
      setProvider(nextProvider);
      setWalletAddress(verifiedAddress);

      const session = getCurrentApiSession();
      const alreadyAuthorized = session?.address.toLowerCase() === verifiedAddress.toLowerCase();
      try {
        const result = await readPublicStrikeAccount(verifiedAddress);
        if (attempt !== walletAttempt.current) return;
        setAccount(result);
        setConnectStage(alreadyAuthorized ? "connected" : "account-found");
      } catch (error) {
        if (attempt !== walletAttempt.current) return;
        if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
          setAccount(null);
          setConnectStage(alreadyAuthorized ? "connected" : "new-account");
          return;
        }
        throw error;
      }
    } catch (error) {
      if (attempt !== walletAttempt.current) return;
      setConnectStage("idle");
      setConnectError(userFacingError(error, "Could not check your Strike account. Check your wallet and try again."));
    }
  }, []);

  const chooseAnotherWallet = useCallback(async () => {
    if (!getBuilderCode() || isBuilderAuthorizationUncertain()) return;
    pendingWalletConnect.current = true;
    walletAttempt.current++;
    setConnectError("");
    setDialog(null);
    try {
      if (walletConnected) await disconnectWallet();
      openWalletPicker();
    } catch (error) {
      pendingWalletConnect.current = false;
      setConnectStage("idle");
      setConnectError(userFacingError(error, "The wallet could not be changed. Try disconnecting it in your wallet and reconnect."));
      setDialog("connect");
    }
  }, [disconnectWallet, openWalletPicker, walletConnected]);

  useEffect(() => {
    if (connectModalOpen) walletPickerWasOpen.current = true;
    if (!connectModalOpen && !walletConnected && walletPickerWasOpen.current) {
      pendingWalletConnect.current = false;
      walletPickerWasOpen.current = false;
    }
  }, [connectModalOpen, walletConnected]);

  useEffect(() => {
    const nextAddress = walletConnected && selectedAddress ? selectedAddress : null;
    const previousAddress = observedWalletAddress.current;
    if (previousAddress && previousAddress.toLowerCase() !== nextAddress?.toLowerCase()) {
      walletAttempt.current++;
      const uncertain = isBuilderAuthorizationUncertain();
      if (!uncertain) {
        clearApiSession();
        setAccount(null);
        setRisk(null);
        setWalletAddress("");
        setProvider(null);
        setConnectStage("idle");
        setDialog(null);
      } else {
        setConnectStage("unknown");
        setDialog("connect");
      }
      setConnectError("Wallet selection changed. Check the selected account before continuing.");
    }
    observedWalletAddress.current = nextAddress;
    if (!pendingWalletConnect.current || !nextAddress || !selectedConnector) return;
    pendingWalletConnect.current = false;
    walletPickerWasOpen.current = false;
    void lookupSelectedWallet(nextAddress, selectedConnector);
  }, [walletConnected, selectedAddress, selectedConnector, lookupSelectedWallet]);

  const openConnect = () => {
    if (isBuilderAuthorizationUncertain()) {
      setConnectStage("unknown");
      setDialog("connect");
      return;
    }
    if (walletConnected && selectedAddress && selectedConnector) {
      setDialog("connect");
      const session = getCurrentApiSession();
      if (session?.address.toLowerCase() === selectedAddress.toLowerCase() && account) {
        setConnectStage("connected");
      } else {
        void lookupSelectedWallet(selectedAddress, selectedConnector);
      }
      return;
    }
    if (!getBuilderCode()) {
      setConnectStage("idle");
      setConnectError("Wallet connection is unavailable right now.");
      setDialog("connect");
      return;
    }
    pendingWalletConnect.current = true;
    setConnectError("");
    openWalletPicker();
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
        setConnectError("Toruni was approved, but account details could not be loaded. Refresh them before approving again.");
      }
    } catch (error) {
      setConnectStage(isBuilderAuthorizationUncertain() ? "unknown" : account ? "account-found" : "new-account");
      setConnectError(userFacingError(error, "Strike authorization could not be completed. Check your wallet and try again."));
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
    } catch (failure) { setConnectError(userFacingError(failure, "Authorization could not be checked. Try again shortly.")); }
    finally { setRecovering(false); }
  };
  const explore = () => {
    navigate("/arena?mode=spectate");
    setTab("market");
    document.getElementById("market-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const currentMarketState = marketState === "live" && market?.mark && clock - market.mark.observedAt > 5000 ? "offline" : marketState;
  const currentMarketMessage = marketStatusMessage(marketState, currentMarketState, marketMessage);
  const serverNow = roundData.serverTime ? roundData.serverTime + Math.max(0, clock - roundData.receivedAt) : clock;
  const round = roundData.round;
  const markAgeSeconds = market?.mark ? Math.max(0, Math.floor((clock - market.mark.observedAt) / 1000)) : null;
  const markFreshness = markAgeSeconds === null ? null : markAgeSeconds <= 5
    ? markAgeSeconds === 0 ? "Updated just now" : `Updated ${markAgeSeconds}s ago`
    : `Delayed · ${markAgeSeconds}s old`;
  const remaining = round ? Math.max(0, Math.ceil(((round.status === "lobby" ? round.startsAt : round.endsAt) - serverNow) / 1000)) : null;
  const countdown = remaining === null ? null : `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
  const markPrice = market?.mark?.markPrice ?? null;
  const bid = market?.depth?.bids[0];
  const ask = market?.depth?.asks[0];
  const apiSession = getCurrentApiSession();
  const liveAccount = walletConnected && selectedAddress?.toLowerCase() === walletAddress.toLowerCase()
    && connectStage === "connected" && account !== null && apiSession?.accountId === account.account_id;
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
    ? sessionError ? "Connection unavailable. Refresh the page." : "Preparing your connection…"
    : !liveAccount
      ? "Connect your wallet first."
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
                  : !round ? "The first eligible maker starts a three-minute round."
                    : "Check the latest Strike account details, then join.";
  const roundActionLabel = participantJoined ? "Open arena" : !round ? "Start challenge"
    : round.status === "lobby" ? "Join challenge" : "View live round";
  const sideBusy = (side: "buy" | "sell") => roundData.orders.some(order => order.side === side && order.intent_status !== "terminal");
  const canReviewQuote = (side: "buy" | "sell") => Boolean(sessionReady && liveAccount && market && market.mark && market.depth
    && market.marketRules && currentMarketState === "live" && policyReady && participantJoined
    && round?.status === "active" && roundData.health === "current" && risk && risk.account.symbolSettings?.["BTC-USD"]?.leverage === 1
    && !sideBusy(side));
  const quoteBlockReason = !sessionReady
    ? sessionError ? "Connection unavailable. Refresh the page." : "Preparing your connection…"
    : !liveAccount
      ? "Connect your wallet first."
      : !policyReady
        ? "Challenge limits are not ready yet."
        : currentMarketState !== "live"
          ? "Market data is unavailable."
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
    } catch (error) { setJoinError(userFacingError(error, "Toruni could not join this challenge. Check your connection and try again.")); }
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
        : userFacingError(error, "Quote could not be reviewed. Refresh before trying again."));
    } finally { setQuoteSubmitting(false); }
  };

  const cancelObservedOrder = async (order: ObservedOrder) => {
    if (!liveAccount || order.exchange_status !== "open" || !order.client_order_id || !order.exchange_order_id
      || cancelingOrderIds.has(order.client_order_id)) return;
    setCancelingOrderIds(previous => new Set(previous).add(order.client_order_id));
    setOrderActionMessage("");
    try {
      await cancelToruniOrder({ clientOrderId: order.client_order_id, exchangeOrderId: order.exchange_order_id, symbol: "BTC-USD" });
      setOrderActionMessage("Cancel request sent. Checking status.");
    } catch {
      setOrderActionMessage("Cancel was not confirmed. Check the order status before trying again.");
    }
  };

  const findRequoteOutcome = async (order: ObservedOrder) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await refreshRoundData();
      const outcome = verifiedTerminalOrder(roundDataRef.current.orders, order);
      if (outcome) return outcome;
      await new Promise(resolve => window.setTimeout(resolve, 500));
    }
    return null;
  };

  const finishRequote = async (order: ObservedOrder) => {
    setRequoteStage("checking");
    setRequoteError("");
    let outcome;
    try { outcome = await findRequoteOutcome(order); }
    catch { outcome = null; }
    if (!outcome) {
      setRequoteStage("unresolved");
      setRequoteError("Toruni could not confirm that this offer is closed. It may still be open. Check its status before changing it.");
      return;
    }
    if (outcome.hasFill || outcome.status === "filled") {
      setRisk(null);
      setRequoteStage("filled");
      setRequoteError("This offer filled before it closed. Refresh your position details before placing another offer.");
      return;
    }
    const side = order.side === "buy" ? "buy" : "sell";
    setQuoteDrafts(previous => ({ ...previous, [side]: {
      price: outcome.order.price ?? order.price ?? previous[side].price,
      size: outcome.order.original_qty ?? order.original_qty ?? previous[side].size,
    } }));
    setRequoteOrder(null);
    setRequoteStage(null);
    setRequoteError("");
    setDialog(null);
    setNotice("Offer closed. Change the price or amount, then review the replacement.");
  };

  const startRequote = (order: ObservedOrder) => {
    if (!liveAccount || round?.status !== "active" || order.exchange_status !== "open"
      || order.intent_status !== "observed" || !order.exchange_order_id
      || !/^[1-9]\d{0,18}$/.test(order.exchange_order_id)) return;
    setRequoteOrder(order);
    setRequoteStage("confirm");
    setRequoteError("");
    setDialog("requote");
  };

  const confirmRequote = async () => {
    const order = requoteOrder;
    if (!order || !liveAccount || requoteStage !== "confirm") return;
    setRequoteStage("canceling");
    setRequoteError("");
    try {
      await cancelToruniOrder({ clientOrderId: order.client_order_id, exchangeOrderId: order.exchange_order_id!, symbol: "BTC-USD" });
    } catch {
      // A lost response does not prove the order stayed open. Read its exact status before offering a replacement.
    }
    await finishRequote(order);
  };

  const checkRequoteAgain = async () => {
    if (requoteOrder && (requoteStage === "unresolved" || requoteStage === "filled")) await finishRequote(requoteOrder);
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
          {currentMarketState === "live" ? "LIVE DATA" : currentMarketState === "checking" ? "CONNECTING" : "PAUSED"}
        </StatusPill>
        <button className="button button--connect" onClick={openConnect} disabled={pickerLoading} aria-label={pickerLoading ? "Opening wallet options" : liveAccount ? `Connected wallet ${shortAddress(walletAddress)}` : "Connect wallet"}>
          <Icon name="wallet" size={17} />
          <span className="connect-label-full">{pickerLoading ? "Opening wallets…" : liveAccount ? shortAddress(walletAddress) : "Connect wallet"}</span>
          <span className="connect-label-short" aria-hidden="true">{pickerLoading ? "Opening…" : liveAccount ? shortAddress(walletAddress) : "Connect"}</span>
        </button>
      </header>

      <main id="top" className={`page-content${resultsRoundId ? "" : " page-content--has-dock"}`}>
        {resultsRoundId ? <Results roundId={resultsRoundId} onBack={() => navigate("/")} onRules={() => setDialog("rules")}
          myOrders={roundData.participant?.roundId === resultsRoundId ? roundData.orders : []}
          canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds}
          onCancel={clientOrderId => { const order = roundData.orders.find(item => item.client_order_id === clientOrderId); if (order) void cancelObservedOrder(order); }} /> : <>
        {pathname === "/arena" ? <section className="arena-heading"><div><span className="panel-kicker">BTC-USD</span><h1>The liquidity arena</h1></div><button className="button button--ghost" onClick={() => navigate("/")}>Back to lobby</button></section> : <section className="intro-row">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" />THE MARKET NEEDS MAKERS</div>
            <h1>Anyone can bet on the market.<br /><em>Can you make the market?</em></h1>
          </div>
          <div className="intro-actions">
            <button className="button button--primary intro-action-primary" onClick={explore}>Explore live arena <Icon name="arrow" size={16} /></button>
            <button className="intro-action-secondary" onClick={() => setDialog("how")}>How it works</button>
            <button className="intro-action-secondary" onClick={() => setDialog("rules")}>Scoring rules</button>
          </div>
        </section>}

        {currentMarketState !== "live" && currentMarketState !== "checking" && <div className={`feed-banner feed-banner--${currentMarketState}`} role="status" aria-live="polite">
          <span className="feed-banner-icon"><Icon name="alert" size={16} /></span>
          <span>{currentMarketMessage}</span>
        </div>}

        <div className="mobile-score-strip"><span>{roundData.health === "unavailable" ? "Updates unavailable" : round ? round.status.replaceAll("_", " ") : "Spectating"}</span><strong>Your score {roundData.participant?.score ?? "—"}</strong></div>
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
              <span className="metric-label">MARK PRICE</span>
              <strong className="mark-value">{markPrice ? `$${formatPrice(markPrice)}` : "—"}</strong>
              {markFreshness && <span className="market-freshness">{markFreshness}</span>}
            </div>
            <div className="book-heading"><span>TOP OF BOOK</span><span>PRICE <small>·</small> SIZE</span></div>
            {market?.depth ? <div className="book-table">
              <div className="book-side book-side--ask"><span>ASK</span><strong>{ask ? `$${formatPrice(ask.price)}` : "—"}</strong><small>{ask?.size ?? "—"}</small></div>
              <div className="book-mid"><i /><span>MARK</span><i /></div>
              <div className="book-side book-side--bid"><span>BID</span><strong>{bid ? `$${formatPrice(bid.price)}` : "—"}</strong><small>{bid?.size ?? "—"}</small></div>
            </div> : <div className="book-empty"><span className="book-empty-line"><i /><i /><i /><i /><i /></span><p>{currentMarketState === "offline" ? "Order book unavailable" : "Loading order book"}</p></div>}
            <button className="text-button" onClick={refreshMarket}>Refresh live data <Icon name="arrow" size={14} /></button>
          </aside>

          <section className={`center-column ${tab !== "quotes" ? "mobile-hidden" : ""}`}>
            <div className="round-card panel">
              <div className="round-left">
                <span className="panel-kicker">{round ? round.status.replaceAll("_", " ") : "NO ACTIVE ROUND"}</span>
                <div className="round-title-row"><h2>Two sides. One score.</h2><span className="round-length"><Icon name="clock" size={14} /> {countdown ?? "180 SEC"}</span></div>
                {!round && <p>The first eligible maker starts a three-minute round.</p>}
              </div>
              <button className="button button--join" onClick={() => {
                if (participantJoined || round?.status === "active") { navigate("/arena"); setTab("quotes"); }
                else if (!liveAccount) openConnect();
                else if (canJoinRound) void beginJoin();
                else setNotice(joinBlockReason);
              }} disabled={joining || (!participantJoined && round?.status !== "active" && !getBuilderCode())}>
                {joining ? round ? "Joining…" : "Starting…" : roundActionLabel} <Icon name="arrow" size={16} />
              </button>
            </div>

            <div className="quote-section-heading">
                <div><h2>Quote both sides</h2></div>
              <StatusPill state={currentMarketState === "live" ? "waiting" : "paused"}>{currentMarketState !== "live" ? "PAUSED" : round?.status === "active" ? "ACTIVE" : "WAITING"}</StatusPill>
            </div>
            <div className="quote-grid">
              {(["buy", "sell"] as const).map(side => {
                const order = [...roundData.orders].reverse().find(item => item.side === side && item.intent_status !== "terminal")
                  ?? [...roundData.orders].reverse().find(item => item.side === side);
                const status = order?.verification_error ? "CHECKING" : order?.exchange_status?.toUpperCase()
                  ?? (participantJoined ? "READY" : "NOT JOINED");
                const statusState = order?.exchange_status === "open" ? "live" as const
                  : order?.verification_error || order?.intent_status === "issued" || order?.intent_status === "submitted" ? "waiting" as const
                    : "paused" as const;
                const openOrder = order?.exchange_status === "open" && order.intent_status === "observed"
                  && order.exchange_order_id && /^[1-9]\d{0,18}$/.test(order.exchange_order_id) ? order : null;
                return <QuoteCard key={side} side={side === "buy" ? "bid" : "ask"} value={quoteDrafts[side]}
                  status={status} statusState={statusState} canReview={canReviewQuote(side)} disabledReason={quoteBlockReason}
                  openOrder={openOrder} canRequote={Boolean(liveAccount && round?.status === "active" && roundData.health === "current")}
                  onRequote={startRequote}
                  onChange={(field, value) => setQuoteDrafts(previous => ({ ...previous, [side]: { ...previous[side], [field]: value } }))}
                  onReview={() => void reviewQuote(side)} />;
              })}
            </div>
            {notice && <p className="quote-notice" role="status"><Icon name="alert" size={15} />{notice}</p>}
            {orderActionMessage && <p className="quote-notice" role="status"><Icon name="alert" size={15} />{orderActionMessage}</p>}

            <div className="lower-grid lower-grid--orders">

              <section className={`panel order-panel ${tab === "standings" ? "mobile-show" : ""}`}>
                <div className="panel-heading panel-heading--compact"><h2>Your offers</h2></div>
                <OrderRecords orders={roundData.orders} current={roundData.health === "current"} onCancel={cancelObservedOrder} canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds} />
                <button className="text-button" onClick={() => setDialog("orders")}>Open order details <Icon name="arrow" size={14} /></button>
                <button className="text-button risk-access" onClick={() => { setDialog("risk"); void refreshRisk(); }}>Margin and positions <Icon name="shield" size={14} /></button>
              </section>
            </div>
          </section>

          <aside className={`right-column ${tab !== "standings" ? "mobile-hidden" : ""}`}>
            <ScorePanel data={roundData} now={serverNow} />
            <StandingsPanel data={roundData} />
            <section className="panel activity-panel">
                <div className="panel-heading panel-heading--compact"><h2>Recent activity</h2></div>
              <OrderRecords orders={roundData.orders.filter(order => order.observed_at).slice(0, 4)} current={roundData.health === "current"} activity onCancel={cancelObservedOrder} canCancel={liveAccount} cancelingOrderIds={cancelingOrderIds} />
            </section>
          </aside>
        </div>

        </>}
        <footer className="app-footer">
          <div className="footer-brand"><span className="brand-mark brand-mark--small"><i /><i /><b /></span><span>TORUNI</span><small>Liquidity, made visible.</small></div>
          <div className="footer-links"><button onClick={() => setDialog("rules")}>Rules & scoring</button><button onClick={() => setDialog("how")}>How to play</button></div>
        </footer>
      </main>

      {!resultsRoundId && <div className="mobile-order-bar">
        <button onClick={() => setDialog("orders")}><Icon name="book" size={16} /> My orders <span>{roundData.orders.length || "—"}</span></button>
        <button onClick={openConnect} disabled={pickerLoading}><Icon name="wallet" size={16} />{pickerLoading ? "Opening…" : liveAccount ? "Account" : "Connect"}</button>
      </div>}

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
        requoteOrder={requoteOrder}
        requoteStage={requoteStage}
        requoteError={requoteError}
        onConfirmRequote={() => void confirmRequote()}
        onCheckRequote={() => void checkRequoteAgain()}
        onOpenRisk={() => { setDialog("risk"); void refreshRisk(); }}
        kind={dialog}
        onClose={() => { if (requoteStage !== "canceling" && requoteStage !== "checking") setDialog(null); }}
        address={walletAddress}
        account={account}
        stage={connectStage}
        error={connectError}
        onChooseWallet={() => void chooseAnotherWallet()}
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

function QuoteCard({ side, onReview, value, onChange, status, statusState, canReview, disabledReason, openOrder, canRequote, onRequote }: {
  side: "bid" | "ask";
  onReview: () => void;
  value: { price: string; size: string };
  onChange: (field: "price" | "size", value: string) => void;
  status: string;
  statusState: "live" | "waiting" | "paused";
  canReview: boolean;
  disabledReason: string;
  openOrder: ObservedOrder | null;
  canRequote: boolean;
  onRequote: (order: ObservedOrder) => void;
}) {
  const isBid = side === "bid";
  return <article className={`quote-card panel quote-card--${side}`}>
    <div className="quote-card-top">
      <div className="quote-side-title"><span className="quote-glyph">{isBid ? "↙" : "↗"}</span><div><span className="panel-kicker">{isBid ? "BUY SIDE" : "SELL SIDE"}</span><h3>{isBid ? "Bid" : "Ask"}</h3></div></div>
      <StatusPill state={statusState}>{status}</StatusPill>
    </div>
    <div className="quote-fields">
      <label>PRICE <span>USD</span><div className="input-shell"><span>$</span><input aria-label={`${isBid ? "Bid" : "Ask"} price`} inputMode="decimal" value={value.price} onChange={event => onChange("price", event.target.value)} disabled={!canReview} /></div></label>
      <label>SIZE <span>BTC</span><div className="input-shell"><input aria-label={`${isBid ? "Bid" : "Ask"} size`} inputMode="decimal" value={value.size} onChange={event => onChange("size", event.target.value)} disabled={!canReview} /><span>BTC</span></div></label>
    </div>
    {!openOrder && !canReview && <p id={`quote-disabled-${side}`} className="quote-disabled-reason"><Icon name="alert" size={14} />{disabledReason}</p>}
    {openOrder
      ? <button className={`button quote-button quote-button--${side}`} onClick={() => onRequote(openOrder)} disabled={!canRequote}>
        Requote {isBid ? "bid" : "ask"} <Icon name="arrow" size={15} />
      </button>
      : <button className={`button quote-button quote-button--${side}`} onClick={onReview} disabled={!canReview}
        aria-describedby={!canReview ? `quote-disabled-${side}` : undefined}>
        Review {isBid ? "bid" : "ask"} <Icon name="arrow" size={15} />
      </button>}
  </article>;
}

function OrderRecords({ orders, current, activity = false, onCancel, canCancel, cancelingOrderIds }: {
  orders: ObservedOrder[]; current: boolean; activity?: boolean; onCancel: (order: ObservedOrder) => void;
  canCancel: boolean; cancelingOrderIds: Set<string>;
}) {
  if (!orders.length) return <div className="empty-orders"><p>{!current ? "Order status unavailable. Offers may still be open." : activity ? "No recent activity" : "No offers yet"}</p></div>;
  return <div className="order-records">{!current && <p role="status">Order status unavailable. Offers may still be open.</p>}{[...orders].reverse().map(order => <article className="order-record" key={order.client_order_id} data-client-order-id={order.client_order_id}>
    <div><strong>{order.side === "buy" ? "Bid" : "Ask"}</strong><span>{readableOrderStatus(order)}</span></div>
    <p>{order.price ? `$${formatPrice(order.price)}` : "Price pending"} · {order.original_qty ?? "—"} BTC</p>
    <small>{order.filled_qty === null ? "Fill details pending" : `${order.filled_qty} BTC filled`}</small>
    {!activity && <>
      {order.exchange_status === "open" && <button className="text-button order-cancel" onClick={() => onCancel(order)}
        disabled={!canCancel || !/^[1-9]\d{0,18}$/.test(order.exchange_order_id ?? "") || cancelingOrderIds.has(order.client_order_id)}>
        {cancelingOrderIds.has(order.client_order_id) ? "Checking cancellation…" : "Cancel offer"}
      </button>}
      {Number(order.filled_qty ?? 0) > 0 && <small className="order-risk-note">A fill may have created a position. Check Margin and positions.</small>}
    </>}
  </article>)}</div>;
}

function readableOrderStatus(order: ObservedOrder): string {
  if (order.verification_error) return "Checking status";
  switch (order.exchange_status) {
    case "open": return "Resting on Strike";
    case "pending": return "Waiting for confirmation";
    case "filled": return "Filled";
    case "canceled": return "Canceled";
    case "expired": return "Expired";
    case "rejected": return "Not accepted";
    case "unknown": return "Not confirmed yet";
    default: return "Checking status";
  }
}
