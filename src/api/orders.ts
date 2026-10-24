import { isMarketSymbol } from "../../shared/markets";
import type { StrikeSide } from "../../shared/contracts";
import { getCurrentApiSession, strikeAuthenticatedFetch, strikeCancelOrderById } from "./builderConnect";

export interface ServerIssuedOrderIntent {
  clientOrderId: string;
  symbol: string;
  side: StrikeSide;
  roundId: string;
}

export interface PostOnlyLimitInput {
  intent: ServerIssuedOrderIntent;
  size: string;
  price: string;
}

export interface StrikeCreateOrderResponse {
  account_id: string;
  client_order_id: string;
  symbol: string;
  sequence_id: number;
  message_id: string;
}

export async function placePostOnlyLimitOrder(input: PostOnlyLimitInput): Promise<StrikeCreateOrderResponse> {
  if (!input.intent.clientOrderId || !input.intent.roundId || !isMarketSymbol(input.intent.symbol)) {
    throw new Error("A server-issued order intent is required.");
  }
  const isPositiveDecimal = (value: string) => /^\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
  if (!isPositiveDecimal(input.size) || !isPositiveDecimal(input.price)) {
    throw new Error("Order size and price must be positive decimal strings.");
  }

  const response = await strikeAuthenticatedFetch<StrikeCreateOrderResponse>("/v2/order", "POST", {
    client_order_id: input.intent.clientOrderId,
    symbol: input.intent.symbol,
    side: input.intent.side,
    type: "limit",
    size: input.size,
    price: input.price,
    time_in_force: "GTC",
    post_only: true,
  });
  const session = getCurrentApiSession();
  if (!session || response.account_id !== session.accountId || response.client_order_id !== input.intent.clientOrderId
    || response.symbol !== input.intent.symbol || !Number.isSafeInteger(response.sequence_id) || response.sequence_id <= 0) {
    throw new Error("Strike’s response could not be matched to this quote. Toruni is checking its status before you try again.");
  }
  return response;
}

export async function cancelToruniOrder(input: {
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: string;
}): Promise<unknown> {
  if (!/^trn[0-9a-f]{32}$/.test(input.clientOrderId) || !isMarketSymbol(input.symbol)
    || !/^[1-9]\d{0,18}$/.test(input.exchangeOrderId) || BigInt(input.exchangeOrderId) > 9_223_372_036_854_775_807n) {
    throw new Error("A verified Toruni order is required.");
  }
  return strikeCancelOrderById(input.exchangeOrderId);
}
