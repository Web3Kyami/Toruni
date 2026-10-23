import test from "node:test";
import assert from "node:assert/strict";
import { validateBuilderConsent } from "../shared/builderConsent.ts";

const binding = { address: `0x${"1".repeat(40)}`, publicKey: "2".repeat(64), builderCode: "Turino" };
const nonce = "00000000-0000-4000-8000-000000000001";
// Shape checked against a genuine V2-testnet signature challenge, not a signed fixture.
const message = `Connect to Strike via builder "Turino".
This authorizes the builder to collect up to 0% fee on your trades.
Referral attribution: none.
By signing, you are entrusting your API wallet private key to this builder. You trust the builder to store and use this key responsibly.
Wallet: ${binding.address}
Chain: ethereum
API Key: ${binding.publicKey}
Nonce: ${nonce}
Timestamp: 2026-10-23T15:05:45Z

Complete verify-signature within 5 minutes; after that the challenge expires.`;

test("only the precise zero-fee consent for the selected wallet and API key can reach the signer", () => {
  assert.equal(validateBuilderConsent({ nonce, message_to_sign: message }, binding), true);
  for (const altered of [
    message.replace("0% fee", "1% fee"), message.replace('builder "Turino"', 'builder "Other"'),
    message.replace(binding.address, `0x${"3".repeat(40)}`), message.replace(binding.publicKey, "4".repeat(64)),
    message.replace("Chain: ethereum", "Chain: solana"), message.replace(nonce, "00000000-0000-4000-8000-000000000002"),
    message.replace("Referral attribution: none.", "Referral attribution: permanent."),
    `${message}\nAlso approve unlimited transfers.`, message.replace("2026-10-23T15:05:45Z", "invalid"),
  ]) assert.equal(validateBuilderConsent({ nonce, message_to_sign: altered }, binding), false);
});
