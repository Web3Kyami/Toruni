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
| `TORUNI_MAX_QUOTE_NOTIONAL` | Owner-approved maximum value for one resting quote, in USD |
| `TORUNI_MAX_ACCOUNT_EXPOSURE` | Owner-approved gross limit for positions and Toruni resting quotes, in USD; must cover two maximum quotes |

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

The Vercel deployment serves the interface and the existing HTTP API through `api/[...path].ts`. Set `VITE_BUILDER_CODE`, `VITE_BUILDER_FEE_BPS`, and the server-only `DATABASE_URL` in the project environment. Sessions use the deployment's `VERCEL_URL` as their trusted origin unless `APP_ORIGIN` is configured for a custom domain. Client routes support direct navigation and refresh.

The submitted preview at [toruni.vercel.app](https://toruni.vercel.app) was deployed without `DATABASE_URL`, so it cannot persist sessions or run live rounds. Vercel request handlers also do not run the continuous scoring worker. A playable deployment needs PostgreSQL and the Node service running continuously on a persistent host.

The scoring worker runs through `npm run start:server` on a persistent Node host sharing the same database. It is not started inside Vercel request handlers. Vercel clients poll persisted observations; the persistent Node service retains its event stream. Keep round entry closed until the worker and the approved risk limits are configured.

- `src/`: React interface, Builder Connect, browser-only Ed25519 signing, and testnet order adapters.
- `src/api/deposits.ts`: Sepolia USDC quote, unsigned-transaction validation, and submission confirmation adapters. Preparation checks the connected network and deployed contracts, binds calldata to the account and quote, and permits only an exact-amount approval. It never broadcasts a transaction; a caller must obtain wallet approval, track its receipt, and separately verify credited Strike collateral.
- `server/`: secure sessions, independent Strike reads, round lifecycle, a database-held scoring leader, server-sent updates, and report APIs.
- `shared/`: typed contracts, exact decimal validation, fixed-point scoring, and deterministic ledger replay.
- `sql/`: ordered PostgreSQL migrations with checksum verification.

Only `api-v2-testnet.strikefinance.org` accepts authenticated requests. There is no configurable mainnet endpoint. Builder Connect starts after an explicit user action; the server never receives the private API-wallet key and never places, cancels, or closes trades. The authenticated userstream prompts quick UI refreshes; server-side Strike reads remain authoritative for statuses and scoring.

Round entry stays closed until both risk limits are set. At 1x, the app uses twice the per-quote cap as a baseline reserve estimate for both offers. Strike fees and positions created by fills may require more; the actual available balance and risk are rechecked before each order. These limits have no default because the blueprint does not approve numeric values. A successful create response is not proof that an order is open. Canceling an order does not close any position created by a fill.

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

Typography uses bundled Plus Jakarta Sans from Fontsource 5.3.0, licensed under the SIL Open Font License. The license is included at `src/assets/plus-jakarta-sans-LICENSE.txt`.
