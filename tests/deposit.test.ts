import test from "node:test";
import assert from "node:assert/strict";
import { parseDepositQuote, parseDepositPlan, SEPOLIA_USDC } from "../shared/deposit.ts";
import { checkDepositNetwork } from "../src/api/deposits.ts";

const now = 1_792_768_028_057;
const binding = { accountId: "00000000-0000-4000-8000-000000000001", address: `0x${"1".repeat(40)}`, assetAmount: "100000000" };
const requestId = "00000000-0000-4000-8000-000000000002";
const vault = `0x${"2".repeat(40)}`;
// Uses the actual quote/build shape observed from Strike V2 testnet. No funds or orders are simulated by the app.
const rawQuote = { request_id: requestId, deposit_address: vault, confirmations_required: 12, quote: {
  request_id: requestId, account_id: binding.accountId, blockchain: "ethereum", asset_symbol: "USDC",
  asset_amount: binding.assetAmount, usd_value: "99.99625000", timestamp: now, expiration_at: now + 600_000, confirmations: 12,
} };
const word = (v: string) => v.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const bytes16 = (v: string) => v.replaceAll("-", "").padEnd(64, "0");
const amount = BigInt(binding.assetAmount).toString(16);
const built = { blockchain: "ethereum", format: "evm_tx_params", unsigned_tx: {
  from: binding.address, to: vault, value: "0x0", gas: "0x30d40",
  data: `0x61cd1530${bytes16(requestId)}${bytes16(binding.accountId)}${word(SEPOLIA_USDC)}${word(amount)}${word("a0")}${word("0")}`,
}, approval_tx: {
  from: binding.address, to: SEPOLIA_USDC, value: "0x0", gas: "0x259a3", data: `0x095ea7b3${word(vault)}${word(amount)}`,
} };

test("deposit quote binds account, asset, exact units and expiry before an unsigned plan is accepted", () => {
  const quote = parseDepositQuote(rawQuote, binding, now);
  const plan = parseDepositPlan(built, quote, now);
  assert.equal(plan.transaction.chainId, "0xaa36a7");
  assert.equal(plan.approval?.to, SEPOLIA_USDC);
  assert.throws(() => parseDepositQuote(rawQuote, { ...binding, assetAmount: "99999999" }, now));
  assert.throws(() => parseDepositQuote(rawQuote, { ...binding, accountId: requestId }, now));
  assert.throws(() => parseDepositQuote({ ...rawQuote, quote: { ...rawQuote.quote, asset_symbol: "ETH" } }, binding, now));
  assert.throws(() => parseDepositQuote(rawQuote, binding, now + 600_001));
});

test("deposit build rejects recipient, account, amount, chain, native-value and approval substitutions", () => {
  const quote = parseDepositQuote(rawQuote, binding, now);
  for (const unsigned of [
    { ...built.unsigned_tx, to: binding.address }, { ...built.unsigned_tx, from: vault },
    { ...built.unsigned_tx, value: "0x1" }, { ...built.unsigned_tx, chainId: "0x1" },
    { ...built.unsigned_tx, data: built.unsigned_tx.data.replace(bytes16(binding.accountId), bytes16(requestId)) },
    { ...built.unsigned_tx, data: built.unsigned_tx.data.replace(word(amount), word("1")) },
    { ...built.unsigned_tx, data: `${built.unsigned_tx.data}00` },
  ]) assert.throws(() => parseDepositPlan({ ...built, unsigned_tx: unsigned }, quote, now));
  for (const approval of [
    { ...built.approval_tx, to: vault },
    { ...built.approval_tx, data: `0x095ea7b3${word(vault)}${"f".repeat(64)}` },
    { ...built.approval_tx, data: `0x095ea7b3${word(binding.address)}${word(amount)}` },
  ]) assert.throws(() => parseDepositPlan({ ...built, approval_tx: approval }, quote, now));
});

test("deposit preparation never switches networks and rejects mainnet or malformed provider chain IDs", async () => {
  for (const chain of ["0x1", "0x2105", undefined, "not-a-chain"]) {
    await assert.rejects(checkDepositNetwork({ request: async ({ method }) => {
      assert.equal(method, "eth_chainId"); return chain;
    } }), /Ethereum Sepolia/);
  }
  await checkDepositNetwork({ request: async ({ method }) => { assert.equal(method, "eth_chainId"); return "0xaa36a7"; } });
});
