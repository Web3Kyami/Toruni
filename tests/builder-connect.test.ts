import assert from "node:assert/strict";
import test from "node:test";
import { createUserStreamLogon, generateApiWalletKeyPair } from "../src/api/builderConnect.ts";

test("Builder Connect exports the public key while keeping the private key non-exportable", async () => {
  const pair = await generateApiWalletKeyPair();
  assert.equal(pair.publicKey.length, 64);
  assert.equal(pair.privateKey.extractable, false);

  const message = new TextEncoder().encode("toruni testnet key handling check");
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" } as AlgorithmIdentifier,
    pair.privateKey,
    message,
  );
  const publicBytes = Uint8Array.from(pair.publicKey.match(/.{2}/g) ?? [], (hex) => Number.parseInt(hex, 16));
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, true, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" } as AlgorithmIdentifier, publicKey, signature, message), true);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", pair.privateKey));
});

test("signs the official userstream login payload with the in-memory Ed25519 key", async () => {
  const pair = await generateApiWalletKeyPair();
  const timestamp = 1_795_000_000_000;
  const logon = await createUserStreamLogon(pair.privateKey, pair.publicKey, timestamp);
  assert.deepEqual(logon, {
    method: "session.logon",
    params: { apiKey: pair.publicKey, signature: logon.params.signature, timestamp },
    id: 1,
  });
  const publicBytes = Uint8Array.from(pair.publicKey.match(/.{2}/g) ?? [], hex => Number.parseInt(hex, 16));
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, true, ["verify"]);
  const signatureBytes = Uint8Array.from(logon.params.signature.match(/.{2}/g) ?? [], hex => Number.parseInt(hex, 16));
  const payload = new TextEncoder().encode(`apiKey=${pair.publicKey}&timestamp=${timestamp}`);
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" } as AlgorithmIdentifier, publicKey, signatureBytes, payload), true);
});
