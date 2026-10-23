# Toruni

A 180-second market-making challenge on Strike Finance V2 testnet. Hold competitive post-only bids and asks, then inspect the independently observed evidence behind each score.

## Run locally

Use Node.js 22.18 or newer and npm. Wallet authorization requires an Ethereum-compatible browser wallet.

```sh
npm ci
cp .env.example .env.local
```

Set these values in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `VITE_BUILDER_CODE` | Public Strike builder code registered on V2 testnet |
| `VITE_BUILDER_FEE_BPS` | `0` for this build |
| `DATABASE_URL` | Server-only PostgreSQL connection string |
| `APP_ORIGIN` | Exact browser origin, normally `http://localhost:5173` |

```sh
npm run migrate
npm run dev
```

Vite serves the client and API together. For a stable local preview without hot reload, first run `npm run build`, then `npm run dev -- --mode wallet-preview --port 5173`. API-wallet keys live only in tab memory; refreshing or closing the tab loses the local signer.

For a built Node service:

```sh
npm run build
npm run start:server
```

The service serves `dist/` and the API on port 4174 by default. Configure `APP_ORIGIN` for its actual browser URL. Run migrations before starting a new schema version.

## Architecture

- `src/`: React interface, Builder Connect, browser-only Ed25519 signing, and testnet order adapters.
- `server/`: secure sessions, independent Strike reads, round lifecycle, a database-held scoring leader, server-sent updates, and report APIs.
- `shared/`: typed contracts, exact decimal validation, fixed-point scoring, and deterministic ledger replay.
- `sql/`: ordered PostgreSQL migrations with checksum verification.

Only `api-v2-testnet.strikefinance.org` accepts authenticated requests. There is no configurable mainnet endpoint. Builder Connect starts after an explicit user action; the server never receives the private API-wallet key and never places, cancels, or closes trades.

Order placement is locked until account authorization, credited collateral, risk limits, and independent order-status verification satisfy the trading gate. A successful create response is not proof that an order is open. Canceling an order does not close any position created by a fill.

## Scoring

`toruni-observed-two-sided-v0.1` awards a per-minute rate of `25B + 25A + 50 min(B,A)`, where each side’s quality decreases linearly from 1 at the mark to 0 at 50 basis points. A quote must be independently observed open, post-only, GTC, sufficiently sized, and continuously eligible through a five-second dwell period.

The server samples once per second using exact scaled integers. Stale or missing order, market, or risk evidence earns no credit. Missed intervals are never backfilled. PostgreSQL stores the observations, score policy, samples, and finalized totals; the browser displays those totals.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

`npm test` uses isolated fixtures and never submits trades. The optional `integration-check` Vite mode exercises PostgreSQL persistence in a rolled-back transaction. The optional `visual-review` mode captures real screens through a locally installed Chromium; its executable path is configured in `scripts/visual-review.mjs`.

## Attribution

Strike API behavior and signing conventions follow the [Strike Builder Reference](https://github.com/strike-finance/strike-builder-reference) and [official Strike API documentation](https://docs.strikefinance.org/api). No Strike app code, icons, or branding assets are copied. MIT licensed.
