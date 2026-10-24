import { isMarketSymbol, marketSymbols, type MarketOption, type PricePoint } from "../shared/markets.ts";
import type { MarketSnapshot, StrikeDepth, StrikeDepthLevel, StrikeMark, StrikePublicAccount, StrikeMarketRules, StrikePosition, VerifiedQuote } from "../shared/contracts.ts";

export const STRIKE_TESTNET_ORIGIN = "https://api-v2-testnet.strikefinance.org";
const STRIKE_PRICE_ORIGIN = `${STRIKE_TESTNET_ORIGIN}/price`;
export const MARK_FRESHNESS_LIMIT_MS = 5_000;

if (new URL(STRIKE_TESTNET_ORIGIN).hostname !== "api-v2-testnet.strikefinance.org") {
  throw new Error("The server is restricted to Strike V2 testnet.");
}

export class StrikeReadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "StrikeReadError";
  }
}

async function getJson(url: URL): Promise<unknown> {
  const allowed = new Set([new URL(STRIKE_TESTNET_ORIGIN).origin, new URL(STRIKE_PRICE_ORIGIN).origin]);
  if (!allowed.has(url.origin)) throw new Error("Strike read attempted outside the testnet allowlist.");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
  } catch {
    throw new StrikeReadError("Strike testnet is not reachable.", 503);
  }
  if (!response.ok) throw new StrikeReadError(`Strike testnet returned ${response.status}.`, response.status);
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function field<T>(record: Record<string, unknown>, ...keys: string[]): T | null {
  for (const key of keys) if (key in record) return record[key] as T;
  return null;
}

export function parseMark(symbol: string, raw: unknown): StrikeMark | null {
  const row = Array.isArray(raw) ? asRecord(raw[0]) : asRecord(raw);
  if (!row) return null;
  const rawMark = row.markPrice ?? row.mark_price ?? row.p;
  const markPrice = typeof rawMark === "string" ? rawMark : null;
  const responseSymbol = stringValue(row, "symbol", "s") ?? symbol;
  const rawEventTime = row.E ?? row.eventTime ?? row.time;
  const eventTime = typeof rawEventTime === "number"
    ? rawEventTime
    : typeof rawEventTime === "string" && /^\d+$/.test(rawEventTime)
      ? Number(rawEventTime)
      : Number.NaN;
  if (!markPrice || responseSymbol !== symbol || !/^\d+(?:\.\d+)?$/.test(markPrice) || !Number.isFinite(eventTime) || eventTime <= 0) {
    return null;
  }
  return { symbol, markPrice, observedAt: eventTime, source: "strike-v2-testnet" };
}

function parseDepthLevel(value: unknown): StrikeDepthLevel | null {
  if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
    return { price: value[0], size: value[1] };
  }
  const row = asRecord(value);
  if (!row) return null;
  const rawPrice = row.price ?? row.Price;
  const rawSize = row.size ?? row.quantity ?? row.qty ?? row.Size;
  const price = typeof rawPrice === "string" ? rawPrice : null;
  const size = typeof rawSize === "string" ? rawSize : null;
  return price && size ? { price, size } : null;
}

function parseDepth(raw: unknown, observedAt: number): StrikeDepth | null {
  const row = asRecord(raw);
  if (!row || !Array.isArray(row.bids) || !Array.isArray(row.asks)) return null;
  return {
    bids: row.bids.map(parseDepthLevel).filter((level): level is StrikeDepthLevel => level !== null),
    asks: row.asks.map(parseDepthLevel).filter((level): level is StrikeDepthLevel => level !== null),
    observedAt,
    source: "strike-v2-testnet",
  };
}

async function readSource(url: URL): Promise<{ data: unknown; observedAt: number } | null> {
  try {
    const data = await getJson(url);
    return { data, observedAt: Date.now() };
  } catch {
    return null;
  }
}

export async function readMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  if (!isMarketSymbol(symbol)) throw new StrikeReadError("Choose an available market.", 400);
  const markUrl = new URL("/price/v2/markPrice", STRIKE_TESTNET_ORIGIN);
  markUrl.searchParams.set("symbol", symbol);
  const depthUrl = new URL("/price/v2/depth", STRIKE_TESTNET_ORIGIN);
  depthUrl.searchParams.set("symbol", symbol);
  depthUrl.searchParams.set("limit", "20");
  const rulesUrl = new URL("/v2/markets", STRIKE_TESTNET_ORIGIN);

  const [markRead, depthRead, rulesRead] = await Promise.all([
    readSource(markUrl),
    readSource(depthUrl),
    readSource(rulesUrl),
  ]);
  const checkedAt = Date.now();
  const parsedMark = markRead ? parseMark(symbol, markRead.data) : null;
  const mark = parsedMark && checkedAt >= parsedMark.observedAt && checkedAt - parsedMark.observedAt <= MARK_FRESHNESS_LIMIT_MS
    ? parsedMark
    : null;
  const depth = depthRead ? parseDepth(depthRead.data, depthRead.observedAt) : null;
  const marketRules = rulesRead ? parseMarketRules(symbol, rulesRead.data, rulesRead.observedAt) : null;
  const unavailableSources: MarketSnapshot["unavailableSources"] = [];
  if (!mark) unavailableSources.push("mark");
  if (!depth) unavailableSources.push("depth");
  if (!marketRules) unavailableSources.push("marketRules");
  return { symbol, checkedAt, mark, depth, marketRules, unavailableSources };
}

export function parseMarketRules(symbol: string, raw: unknown, observedAt: number): StrikeMarketRules | null {
  const envelope = asRecord(raw);
  const markets = envelope ? asRecord(envelope.markets) : null;
  const row = markets ? asRecord(markets[symbol]) : null;
  if (!row || row.symbol !== symbol || typeof row.status !== "string" || typeof row.reduce_only !== "boolean") return null;
  const names = ["order_tick_price", "order_min_price", "order_max_price", "order_limit_step_size",
    "order_limit_min_size", "order_limit_max_size", "order_min_notional", "order_limit_price_bound"] as const;
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = row[name];
    if (typeof value !== "string" || value.length > 100 || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) return null;
    values[name] = value;
  }
  return {
    symbol, status: row.status, reduceOnly: row.reduce_only,
    tickPrice: values.order_tick_price!, minimumPrice: values.order_min_price!, maximumPrice: values.order_max_price!,
    limitStepSize: values.order_limit_step_size!, minimumLimitSize: values.order_limit_min_size!,
    maximumLimitSize: values.order_limit_max_size!, minimumNotional: values.order_min_notional!,
    limitPriceBound: values.order_limit_price_bound!, observedAt, source: "strike-v2-testnet",
  };
}

export async function readPublicAccount(selector: { accountId?: string; address?: string }): Promise<StrikePublicAccount> {
  const url = new URL("/v2/account", STRIKE_TESTNET_ORIGIN);
  if (selector.accountId) url.searchParams.set("account_id", selector.accountId);
  else if (selector.address) {
    url.searchParams.set("blockchain", "ethereum");
    url.searchParams.set("blockchain_address", selector.address);
  } else {
    throw new StrikeReadError("A public Strike account selector is required.", 400);
  }
  const raw = await getJson(url);
  const row = asRecord(raw);
  if (!row) throw new StrikeReadError("Strike returned an invalid account record.", 502);
  const accountId = stringValue(row, "account_id");
  const blockchain = stringValue(row, "blockchain");
  const address = row.blockchain_address === null ? null : stringValue(row, "blockchain_address");
  const decimalField = (key: string): string | null => {
    const value = row[key];
    return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
  };
  const walletBalance = decimalField("wallet_balance");
  const availableBalance = decimalField("available_balance");
  const marginBalance = decimalField("margin_balance");
  if (!accountId || !blockchain || (row.blockchain_address !== null && !address) || !walletBalance || !availableBalance || !marginBalance) {
    throw new StrikeReadError("Strike account record is missing required identity or balance fields.", 502);
  }
  if (selector.accountId && selector.accountId !== accountId) throw new StrikeReadError("Public Strike account did not match the requested ID.", 409);
  if (selector.address) {
    if (blockchain !== "ethereum" || address?.toLowerCase() !== selector.address.toLowerCase()) {
      throw new StrikeReadError("Public Strike account did not match the requested wallet.", 409);
    }
  }
  const settings = asRecord(row.symbol_settings);
  const symbolSettings: StrikePublicAccount["symbolSettings"] = settings ? {} : null;
  if (settings && symbolSettings) for (const [symbol, rawSetting] of Object.entries(settings)) {
    const setting = asRecord(rawSetting);
    if (!setting || !Number.isInteger(setting.leverage) || Number(setting.leverage) < 1
      || (setting.margin_mode !== "cross" && setting.margin_mode !== "isolated") || typeof setting.allow_pre_trade !== "boolean") {
      throw new StrikeReadError("Strike symbol settings could not be verified.", 502);
    }
    symbolSettings[symbol] = { leverage: Number(setting.leverage), marginMode: setting.margin_mode, allowPreTrade: setting.allow_pre_trade };
  }
  return {
    account_id: accountId,
    blockchain,
    blockchain_address: address,
    wallet_balance: walletBalance,
    available_balance: availableBalance,
    margin_balance: marginBalance,
    symbolSettings,
    observedAt: Date.now(),
  };
}

export async function readPublicPositions(accountId: string): Promise<{ positions: StrikePosition[]; observedAt: number }> {
  const url = new URL("/v2/positions", STRIKE_TESTNET_ORIGIN);
  url.searchParams.set("account_id", accountId);
  const raw = asRecord(await getJson(url));
  if (!raw || !Array.isArray(raw.positions) || raw.count !== raw.positions.length) throw new StrikeReadError("Strike positions could not be verified.", 502);
  const positions = raw.positions.map((value): StrikePosition => {
    const row = asRecord(value);
    if (!row || typeof row.symbol !== "string" || typeof row.size !== "string" || !/^-?\d+(?:\.\d+)?$/.test(row.size)
      || !Number.isInteger(row.leverage) || Number(row.leverage) < 1 || (row.margin_mode !== "cross" && row.margin_mode !== "isolated")) {
      throw new StrikeReadError("Strike position fields could not be verified.", 502);
    }
    return { symbol: row.symbol, size: row.size, leverage: Number(row.leverage), marginMode: row.margin_mode };
  });
  return { positions, observedAt: Date.now() };
}

export async function readFreshMark(symbol = "BTC-USD"): Promise<StrikeMark | null> {
  const url = new URL("/price/v2/markPrice", STRIKE_TESTNET_ORIGIN);
  url.searchParams.set("symbol", symbol);
  const mark = parseMark(symbol, await getJson(url));
  const now = Date.now();
  return mark && now >= mark.observedAt && now - mark.observedAt <= 5_000 ? mark : null;
}

export interface RegisteredOrderIntent {
  accountId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  firstOpenObservedAt: number | null;
  lastVerifiedAt?: number;
}

export type OrderReadResult =
  | { kind: "not-found" }
  | { kind: "unavailable"; status: number }
  | { kind: "integrity-error"; reason: string }
  | { kind: "observed"; quote: VerifiedQuote };

const orderStatuses: Record<string, VerifiedQuote["status"]> = {
  open: "open",
  pending: "pending",
  new: "pending",
  filled: "filled",
  canceled: "canceled",
  expired: "expired",
  rejected: "rejected",
  none: "unknown",
  untriggered: "unknown",
};

export async function verifyPublicOrder(intent: RegisteredOrderIntent): Promise<OrderReadResult> {
  const url = new URL("/v2/order", STRIKE_TESTNET_ORIGIN);
  url.searchParams.set("symbol", intent.symbol);
  url.searchParams.set("client_order_id", intent.clientOrderId);
  url.searchParams.set("account_id", intent.accountId);
  let raw: unknown;
  try {
    raw = await getJson(url);
  } catch (error) {
    if (error instanceof StrikeReadError && error.status === 404) return { kind: "not-found" };
    return {
      kind: "unavailable",
      status: error instanceof StrikeReadError ? error.status : 503,
    };
  }

  return parsePublicOrder(raw, intent, Date.now());
}

export function parsePublicOrder(raw: unknown, intent: RegisteredOrderIntent, verifiedAt: number): OrderReadResult {
  const row = asRecord(raw);
  if (!row) return { kind: "integrity-error", reason: "Strike returned an invalid order record." };
  const rawId = field<unknown>(row, "ID", "order_id");
  const exchangeOrderId = typeof rawId === "string" && /^[1-9]\d*$/.test(rawId) ? rawId
    : typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : null;
  if (!exchangeOrderId) return { kind: "integrity-error", reason: "Strike order ID is missing or cannot be represented exactly." };
  const accountId = stringValue(row, "AccountID", "account_id");
  const clientOrderId = stringValue(row, "ClientOrderID", "client_order_id");
  const symbol = stringValue(row, "Symbol", "symbol");
  if (accountId !== intent.accountId || clientOrderId !== intent.clientOrderId || symbol !== intent.symbol) {
    return { kind: "integrity-error", reason: "Strike order identity did not match the registered intent." };
  }

  const rawSide = stringValue(row, "Side", "side")?.toLowerCase();
  const rawStatus = stringValue(row, "Status", "status")?.toLowerCase();
  const side = rawSide === "buy" || rawSide === "sell" ? rawSide : null;
  const status = rawStatus ? orderStatuses[rawStatus] : undefined;
  const type = stringValue(row, "Type", "type")?.toLowerCase();
  const timeInForce = stringValue(row, "TimeInForce", "time_in_force")?.toUpperCase();
  const postOnly = field<boolean>(row, "PostOnly", "post_only");
  const decimalField = (...keys: string[]): string | null => {
    const value = field<unknown>(row, ...keys);
    return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
  };
  const size = decimalField("Size", "size");
  const filled = decimalField("Filled", "filled");
  const price = decimalField("Price", "price");
  if (!side || !status || !type || !timeInForce || typeof postOnly !== "boolean" || !size || filled === null || !price) {
    return { kind: "integrity-error", reason: "Strike order record is missing required verification fields." };
  }
  if (side !== intent.side) return { kind: "integrity-error", reason: "Strike order side did not match the registered intent." };

  const continuous = intent.firstOpenObservedAt !== null && intent.lastVerifiedAt !== undefined
    && intent.firstOpenObservedAt > 0 && intent.firstOpenObservedAt <= intent.lastVerifiedAt
    && verifiedAt >= intent.lastVerifiedAt && verifiedAt - intent.lastVerifiedAt <= 3_000;
  return {
    kind: "observed",
    quote: {
      exchangeOrderId,
      accountId,
      clientOrderId,
      symbol,
      side,
      status,
      type,
      timeInForce,
      postOnly,
      size,
      filled,
      price,
      firstOpenObservedAt: status === "open" ? (continuous ? intent.firstOpenObservedAt! : verifiedAt) : 0,
      lastVerifiedAt: verifiedAt,
      provenance: "strike-public-order-read",
    },
  };
}

/** The engine catalogue, including its price limits, controls market availability. */
export async function readMarketCatalog(): Promise<MarketOption[]> {
  const raw = await getJson(new URL("/v2/markets", STRIKE_TESTNET_ORIGIN));
  const rows = asRecord(asRecord(raw)?.markets);
  return marketSymbols.flatMap(symbol => {
    const row = rows ? asRecord(rows[symbol]) : null;
    if (!row) return [];
    const rules = parseMarketRules(symbol, raw, Date.now());
    const mark = typeof row.mark_price === "string" ? Number(row.mark_price) : NaN;
    const available = Boolean(rules && rules.status === "trading" && !rules.reduceOnly && Number.isFinite(mark)
      && mark >= Number(rules.minimumPrice) && mark <= Number(rules.maximumPrice));
    return [{ symbol, name: typeof row.name === "string" ? row.name : symbol, available }];
  });
}

export async function readPriceHistory(symbol: string): Promise<PricePoint[]> {
  if (!isMarketSymbol(symbol)) throw new StrikeReadError("Choose an available market.", 400);
  const url = new URL("/price/v2/klines", STRIKE_TESTNET_ORIGIN);
  url.searchParams.set("symbol", symbol); url.searchParams.set("interval", "1m"); url.searchParams.set("limit", "60");
  const raw = await getJson(url);
  if (!Array.isArray(raw)) throw new StrikeReadError("Price history is unavailable.", 503);
  return raw.flatMap(row => {
    if (!Array.isArray(row)) return [];
    const time = Number(row[0]); const close = Number(row[4]);
    return Number.isSafeInteger(time) && time > 0 && Number.isFinite(close) && close > 0 ? [{ time, close }] : [];
  }).sort((a, b) => a.time - b.time).filter((point, index, all) => !index || point.time > all[index - 1]!.time).slice(-60);
}
