import { readCurrentRound } from "./database.ts";
import { STRIKE_TESTNET_ORIGIN } from "./strike.ts";
import { writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";

/** Development diagnostics only. Never an authorization or trading gate. */
export async function checkReadiness() {
  const paths = ["/v2/time", "/v2/markets", "/price/v2/markPrice?symbol=BTC-USD", "/price/v2/depth?symbol=BTC-USD&limit=5"];
  const strike = await Promise.all(paths.map(async path => {
    const start = Date.now();
    try {
      const response = await fetch(new URL(path, STRIKE_TESTNET_ORIGIN), { signal: AbortSignal.timeout(5_000) });
      if (response.ok && path === "/v2/markets") {
        await writeFile("/tmp/toruni-live-markets.json", JSON.stringify(await response.json(), null, 2));
      }
      return { path, status: response.status, elapsedMs: Date.now() - start };
    } catch { return { path, status: null, elapsedMs: Date.now() - start, error: "unreachable" }; }
  }));
  let database = false;
  try { await readCurrentRound(); database = true; } catch { /* Connection strings stay private. */ }
  const probeAddresses = (process.env.TORUNI_READ_ONLY_ACCOUNT_PROBES ?? "").split(",").filter(address => /^0x[0-9a-f]{40}$/i.test(address)).slice(0, 4);
  if (probeAddresses.length) {
    const probes = await Promise.all(probeAddresses.map(async address => {
      const url = new URL("/v2/account", STRIKE_TESTNET_ORIGIN);
      url.searchParams.set("blockchain", "ethereum"); url.searchParams.set("blockchain_address", address);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const raw = response.ok ? await response.json() as Record<string, unknown> : null;
        return { address, status: response.status, accountId: raw?.account_id ?? null,
          availableBalance: raw?.available_balance ?? null, symbolSettings: raw?.symbol_settings ?? null };
      } catch { return { address, status: null }; }
    }));
    await writeFile("/tmp/toruni-read-only-account-probes.json", JSON.stringify(probes, null, 2), { mode: 0o600 });
  }
  let builderCodeProbe: { status: number | null; active: boolean | null } | undefined;
  const builderCode = process.env.TORUNI_BUILDER_CODE_PROBE?.trim();
  const address = probeAddresses[0];
  if (builderCode) {
    if (!address) builderCodeProbe = { status: null, active: null };
    else {
      try {
        const publicKey = generateKeyPairSync("ed25519").publicKey
          .export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
        const response = await fetch(new URL("/auth/builder/request-signature", STRIKE_TESTNET_ORIGIN), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, chain: "ethereum", code: builderCode, fee_share_bps: 0, public_key: publicKey }),
          signal: AbortSignal.timeout(5_000),
        });
        builderCodeProbe = { status: response.status, active: response.ok };
      } catch { builderCodeProbe = { status: null, active: null }; }
    }
  }
  return { environment: "strike-v2-testnet", strike, database, ...(builderCodeProbe ? { builderCodeProbe } : {}) };
}

export async function checkOptionalL3() {
  let snapshotStatus: number | null = null;
  try { snapshotStatus = (await fetch(new URL("/v2/l3/snapshot?symbol=BTC-USD", STRIKE_TESTNET_ORIGIN), { signal: AbortSignal.timeout(5000) })).status; } catch { /* Optional feed can remain unavailable. */ }
  const websocket = await new Promise<{ connected: boolean; messages: number; error: boolean }>(resolve => {
    let connected = false; let messages = 0; let failed = false;
    const socket = new WebSocket("wss://api-v2-testnet.strikefinance.org/ws/l3");
    const timer = setTimeout(() => { socket.close(); resolve({ connected, messages, error: failed }); }, 4000);
    socket.onopen = () => { connected = true; socket.send(JSON.stringify({ method: "SUBSCRIBE", params: ["btc-usd@l3"], id: 1 })); };
    socket.onmessage = () => { messages += 1; };
    socket.onerror = () => { failed = true; clearTimeout(timer); socket.close(); resolve({ connected, messages, error: failed }); };
  });
  return { snapshotStatus, websocket, scoringDependency: false };
}
