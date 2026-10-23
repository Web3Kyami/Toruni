import assert from "node:assert/strict";
import test from "node:test";
import { generateApiWalletKeyPair } from "../src/api/builderConnect.ts";

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
