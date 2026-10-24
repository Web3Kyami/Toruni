import assert from "node:assert/strict";
import test from "node:test";
import { readConnectedWalletAddress } from "../src/api/walletProvider.ts";

const selected = `0x${"a".repeat(40)}`;

test("reads the account selected through the wallet picker without requesting permission again", async () => {
  const methods: string[] = [];
  const address = await readConnectedWalletAddress({ request: async ({ method }) => {
    methods.push(method);
    return [selected];
  } }, selected);
  assert.equal(address, selected);
  assert.deepEqual(methods, ["eth_accounts"]);
});

test("rejects a stale or malformed account returned by a selected connector", async () => {
  await assert.rejects(readConnectedWalletAddress({ request: async () => [`0x${"b".repeat(40)}`] }, selected), /account changed/i);
  await assert.rejects(readConnectedWalletAddress({ request: async () => ["0x123"] }, selected), /valid Ethereum address/i);
  await assert.rejects(readConnectedWalletAddress({ request: async () => [] }, selected), /valid Ethereum address/i);
});
