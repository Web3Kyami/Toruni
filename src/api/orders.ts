import type { StrikeSide } from "../../shared/contracts";
import { strikeAuthenticatedFetch } from "./builderConnect";

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
  if (!input.intent.clientOrderId || !input.intent.roundId) {
    throw new Error("A server-issued order intent is required.");
  }
  const isPositiveDecimal = (value: string) => /^\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
  if (!isPositiveDecimal(input.size) || !isPositiveDecimal(input.price)) {
    throw new Error("Order size and price must be positive decimal strings.");
  }

  return strikeAuthenticatedFetch<StrikeCreateOrderResponse>("/v2/order", "POST", {
    client_order_id: input.intent.clientOrderId,
    symbol: input.intent.symbol,
    side: input.intent.side,
    type: "limit",
    size: input.size,
    price: input.price,
    time_in_force: "GTC",
    post_only: true,
  });
}

export async function cancelToruniOrder(input: {
  orderId: number;
  symbol: string;
}): Promise<unknown> {
  if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0) {
    throw new Error("A verified Strike order ID is required.");
  }
  return strikeAuthenticatedFetch<unknown>("/v2/order/cancel", "DELETE", {
    order_id: input.orderId,
    symbol: input.symbol,
  });
}
