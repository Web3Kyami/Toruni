import test from "node:test";
import assert from "node:assert/strict";
import { userFacingError } from "../src/ui/errors.ts";

test("transport and runtime errors use the product fallback", () => {
  const fallback = "Could not continue. Check your connection and try again.";
  assert.equal(userFacingError(new TypeError("Failed to fetch"), fallback), fallback);
  assert.equal(userFacingError(new Error("EAI_AGAIN api.example.com"), fallback), fallback);
  assert.equal(userFacingError(new Error("Request timed out"), fallback), fallback);
  assert.equal(userFacingError("network error", fallback), fallback);
});

test("actionable wallet and account messages remain visible", () => {
  const fallback = "Could not continue. Check your connection and try again.";
  assert.equal(userFacingError(new Error("You declined the wallet signature."), fallback), "You declined the wallet signature.");
  assert.equal(userFacingError(new Error("Available balance is below the round minimum."), fallback), "Available balance is below the round minimum.");
});
