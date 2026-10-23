export const STRIKE_API_ORIGIN = "https://api-v2-testnet.strikefinance.org";
export const STRIKE_PRICE_ORIGIN = `${STRIKE_API_ORIGIN}/price`;

if (new URL(STRIKE_API_ORIGIN).hostname !== "api-v2-testnet.strikefinance.org") {
  throw new Error("Strike connection is unavailable.");
}
