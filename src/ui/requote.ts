import type { ObservedOrder } from "../api/useRoundData";

const terminalStatuses = new Set(["canceled", "expired", "filled", "rejected"]);

export function verifiedTerminalOrder(
  orders: readonly ObservedOrder[],
  target: Pick<ObservedOrder, "client_order_id" | "exchange_order_id">,
) {
  const order = orders.find(item => item.client_order_id === target.client_order_id);
  if (!order || order.exchange_order_id !== target.exchange_order_id || order.intent_status !== "terminal"
    || !order.exchange_status || !terminalStatuses.has(order.exchange_status)) return null;
  if (typeof order.filled_qty !== "string" || !/^\d+(?:\.\d+)?$/.test(order.filled_qty)) return null;
  return {
    order,
    status: order.exchange_status,
    hasFill: /[1-9]/.test(order.filled_qty),
  };
}
