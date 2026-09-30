# BitBlock DeFi Tracker

Web version of `BitBlock_Finance_DeFi_Strategy_Tracker-V02.xlsx`: the same position journal and formulas,
plus performance charts, a strategy × chain matrix, live prices, and wallet / DeBank import.
It runs as a single Docker container with a SQLite file for storage.

## Run

```bash
cp .env.example .env        # optional: add DEBANK_ACCESS_KEY, APP_PASSWORD
docker compose up -d --build
open http://localhost:8090
```

Change the port with `HOST_PORT=9000 docker compose up -d`. Data persists in the `defi-data` volume.
Wipe everything (including demo data) with `docker compose down -v`.

Without Docker: `npm install && npm start` (Node ≥ 22.13), served on http://localhost:8080.

## What maps to what

| Spreadsheet | App |
|---|---|
| Strategies + Inputs sheets | **Positions**: one row per wallet/deposit; *Update value*, *Withdrawal*, *Reward*, *Fee*, *Close* are dated events |
| Inputs E ("withdrawals already reflected") | Not needed: inferred from dates (withdrawals after the latest valuation reduce current value) |
| Overview sheet | **Dashboard**: USD KPIs across all currencies, plus the per-currency table in native units |
| Lists sheet (prices, chains, wallets) | **Prices** page (manual or CoinGecko refresh) and **Wallets** page |
| Column R status | Same rules: Complete inputs / Enter position value / Check withdrawals / Check dates / Open / Closed |

Formulas are identical: P/L = value + withdrawals + rewards − fees − deposit; total return = P/L ÷ deposit;
simple annualized = total return × 365 ÷ days. `npm test` checks them against the worked examples in the workbook.

## Wallet integrations

All read-only: the app asks only for a public address and never requests a signature or transaction.

- **MetaMask**: connects via the injected EIP-1193 / EIP-6963 provider; shows native balance on the current chain.
- **Phantom**: Solana address (SOL balance via Solana RPC) and Phantom's EVM address.
- **Watch any address**: paste an EVM or Solana address, no extension needed.
Data sources import positions by wallet address. Enable them in `.env`:

| Source | Covers | Deposit known? | Key |
|---|---|---|---|
| **Zerion** | EVM DeFi positions + wallet balances; Solana balances | No, deposit starts at today's value | `ZERION_API_KEY` (dashboard.zerion.io) |
| **DeBank** | EVM DeFi positions | No | `DEBANK_ACCESS_KEY` (cloud.debank.com, paid) |
| **Lighter** | Perps account, LLP / public pools, LIT staking | **Yes**: principal, entry date, daily history (LLP) | none, public API |
| **Extended** | Perps account equity | **Yes**: net deposits from asset operations | `EXTENDED_API_KEY`, read-only key from Extended → API management |

*Track* / *Track all* turns synced items into positions. Every later sync from **the same source** adds a valuation,
and `AUTO_SYNC_HOURS` (default 12) does that in the background, so each position builds a value history.
Zerion syncs also scan recent transactions and **suggest collected pool fees (as rewards) and LP deposits** for tracked pools; nothing is applied until you confirm it.
Lighter staking pools are tracked in the staked token (e.g. LIT) because that's what the principal is denominated in.
`DEBANK_MOCK=1` / `ZERION_MOCK=1` give labelled demo data for testing.

Browser wallet extensions only inject into pages served over `http://localhost` or HTTPS, which covers this setup.

## Deploying beyond localhost

Set `APP_PASSWORD` (HTTP basic auth) and put it behind HTTPS (e.g. Caddy, Traefik, Cloudflare Tunnel).
This is a single-user app. A multi-tenant SaaS would need real user accounts and per-user data (see notes in the chat).

## API

`GET /api/dashboard?wallet=&currency=&status=` · `GET/POST /api/positions` · `PUT/DELETE /api/positions/:id` ·
`POST /api/positions/:id/events|close|reopen` · `GET/POST /api/wallets` · `POST /api/wallets/:id/sync?provider=debank|zerion` · `GET /api/wallets/:id/snapshot` ·
`GET/PUT /api/prices` · `POST /api/prices/refresh` · `GET /api/export` (JSON) · `GET /api/export.csv` · `POST /api/import`

## Keeping secrets and wallet data out of git

- `.env` (API keys), `data/` and any `*.db` (your positions) are git-ignored.
- `scripts/check-secrets.sh` blocks commits containing API keys/tokens, wallet or contract addresses,
  64-hex hashes/private keys and Solana addresses. Test fixtures use placeholders like `0x1111…1111`.
- Put your own identifiers (wallet addresses, exchange account numbers, position ids) in a local
  `.secrets-denylist`, one per line. It's git-ignored and checked on every commit.
- Enable the hook after cloning: `git config core.hooksPath .githooks`. CI runs the same scan on every push.
