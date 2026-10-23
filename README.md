# Toruni

Toruni is a Strike Finance V2 testnet market-making challenge. It is designed around genuine post-only orders, independent order verification, and an auditable two-sided score. The app contains no simulated trades, fills, competitors, or scores.

## Development

Requirements: Node.js 22.12 or newer, npm 10 or newer, and a browser with an Ethereum wallet provider for the wallet flow.

```sh
npm install
cp .env.example .env.local
npm run build
npm run test
```

In one terminal, start the read-only API service:

```sh
npm run build:server
npm run start:server
```

In another terminal, start Vite with `npm run dev`. The Vite server proxies `/api` to the local read-only service on port 4174.

`VITE_BUILDER_CODE` is a public identifier and must contain an active Strike builder code before wallet authorization becomes available. Leave it blank until one is confirmed. The API and market-data hosts are fixed in source to Strike V2 testnet; there is no mainnet URL setting.

## Current implementation boundary

The interface reads Strike mark, depth, market rules, and public account data through a testnet-only server adapter. Builder Connect is initiated only by the user and keeps the Ed25519 API-wallet key in browser memory. The client order adapter requires a server-issued order intent and enforces post-only GTC limit orders. Public Strike order verification uses the account and client-order selectors documented by Strike.

The round/session service, durable Postgres ledger, market-risk admission checks, and end-to-end order lifecycle are not yet implemented. For that reason, quote controls and challenge entry remain disabled. The scoring module is a pure, fixed-point implementation of the proposed `toruni-observed-two-sided-v0.1` formula; its tests do not submit orders or create game activity.

## Attribution

Strike API behavior and wallet-signing conventions are based on the [Strike Builder Reference](https://github.com/strike-finance/strike-builder-reference) and [official Strike API documentation](https://docs.strikefinance.org/api). No Strike app code, icons, or branding assets are copied.
