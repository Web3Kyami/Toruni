export type MarketState = "checking" | "live" | "partial" | "offline";

export function marketStatusMessage(sourceState: MarketState, visibleState: MarketState, message: string): string {
  if (sourceState === "live" && visibleState === "offline") {
    return "Live market data is delayed. Offers are paused.";
  }
  return message;
}
