interface BuilderChallenge {
  nonce: string;
  message_to_sign: string;
}

/** Toruni approves zero fees and no referral, exactly as Strike's canonical consent states. */
export function validateBuilderConsent(challenge: BuilderChallenge, binding: {
  address: string; publicKey: string; builderCode: string;
}): boolean {
  if (!/^0x[0-9a-f]{40}$/i.test(binding.address) || !/^[0-9a-f]{64}$/.test(binding.publicKey)
    || !binding.builderCode || /["\r\n]/.test(binding.builderCode)
    || typeof challenge?.nonce !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(challenge.nonce)
    || typeof challenge.message_to_sign !== "string") return false;
  const timestamp = challenge.message_to_sign.match(/^Timestamp: (.+)$/m)?.[1];
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) return false;
  // The server enforces nonce expiry. Do not reject valid consent because a
  // browser's wall clock differs from Strike's clock.
  return challenge.message_to_sign === [
    `Connect to Strike via builder "${binding.builderCode}".`,
    "This authorizes the builder to collect up to 0% fee on your trades.",
    "Referral attribution: none.",
    "By signing, you are entrusting your API wallet private key to this builder. You trust the builder to store and use this key responsibly.",
    `Wallet: ${binding.address}`, "Chain: ethereum", `API Key: ${binding.publicKey}`,
    `Nonce: ${challenge.nonce}`, `Timestamp: ${timestamp}`, "",
    "Complete verify-signature within 5 minutes; after that the challenge expires.",
  ].join("\n");
}
