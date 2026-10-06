# BitBlock DeFi Tracker

Web version of `BitBlock_Finance_DeFi_Strategy_Tracker-V02.xlsx`: the same position journal and formulas,
plus performance charts, a strategy × chain matrix, live prices, and wallet / DeBank import.
It runs as a single Docker container with a SQLite file for storage.

## Run

```bash
cp .env.example .env        # required: the app saves API keys here (Data sources page)
docker compose up -d --build
open http://localhost:8090
```

Change the port or container name with `HOST_PORT=9000 CONTAINER_NAME=defi-tracker-2 docker compose up -d`. Data persists in the `defi-data` volume.
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
Data sources are set up per portfolio in the app (sidebar → **Data sources**), in two groups.

**Portfolio trackers:** on-chain aggregators that read a wallet's DeFi positions and token balances by address. One key per portfolio.

| Tracker | Covers | Deposit known? |
|---|---|---|
| **Zerion** | EVM DeFi positions + wallet balances; Solana balances | No, deposit starts at today's value |
| **DeBank** | EVM DeFi positions (paid API) | No |

**DEX accounts:** opt-in. Nothing exists until you use **+ Add DEX account**, and each account belongs to one wallet.

| DEX | Read access | Covers | Status |
|---|---|---|---|
| **Lighter** | wallet address | perps account, LLP / public pools, LIT staking, daily history | live |
| **Extended** | read-only API key | perps account, net deposits, P/L breakdown | live |
| **Hyperliquid** | wallet address | perps + spot + staked HYPE, vault deposits (HLP), net deposits, trades & funding | live |
| **GMX v2** | wallet address | open perps on Arbitrum / Avalanche, each with its collateral | live |
| **GRVT** | Trading API key (session login) | equity, positions, transfers into the trading account, fills | beta: not yet checked on a real account |
| **Bulk** | Solana address | perps account, deposits, closed trades | beta: not yet checked on a real account |
| **Variational** | — | no per-user API yet (their trading API is still in development) | not available |

Exchange accounts report P/L as parts that add up: unrealised P/L per open position, trades / fees / funding by
day, and anything the exchange doesn't itemise as "Other". Hyperliquid only serves the latest 10,000 fills; for
accounts with more, older P/L is one dated "Earlier trades" entry.

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
`POST /api/positions/:id/events|close|reopen` · `GET/POST /api/wallets` · `POST /api/wallets/:id/sync?provider=debank|zerion|lighter|extended` · `GET /api/settings` · `PUT/DELETE /api/settings/:source[?wallet=id]` · `GET /api/wallets/:id/snapshot` ·
`GET/PUT /api/prices` · `POST /api/prices/refresh` · `GET /api/export` (JSON) · `GET /api/export.csv` · `POST /api/import`

## Portfolios, rewards, corrections and targets

- **Portfolios:** the sidebar switcher creates, renames and switches portfolios. Each keeps its own wallets,
  positions, totals, suggestions and sync. A portfolio can mix MetaMask, Phantom, Trust Wallet and watched addresses.
  *Sync all* syncs only the active portfolio. Market prices are shared.
- **Rewards:** *Rewards* → **Update total rewards to date** (replaces the total: 112 → 120 shows 120) or
  **Add one reward payment** (adds to it). Fees stay separate.
- **Corrections:** ✎ on any Activity entry corrects it in place. Every edit, deletion and restore is kept in
  *Correction history* and can be undone.
- **Your target:** the optional *Target annual return* on a position (simple APR). Never defaulted. *vs. target* =
  simple annualized − target, shown once a position has 30+ days.

### API keys: the Data sources page

Keys are never shared between portfolios:

- **Zerion and DeBank keys belong to a portfolio.** Sidebar → **Data sources** sets them for the active
  portfolio; switch portfolio to set another's. A portfolio without a key doesn't sync from that source.
- **Exchange accounts (Extended) belong to one wallet** and are opt-in: nothing exists until you use
  *Link exchange account* on a wallet (or *+ Link exchange account* on Data sources). Other wallets and
  portfolios never see it.

Each key is tested against the provider, saved to `.env` (which `docker-compose.yml` bind-mounts into the
container) as `NAME__REF` (e.g. `ZERION_API_KEY__3F9A1C07D2`, the reference being random per portfolio or
wallet), and applied immediately, with no restart. Deleting a wallet or portfolio deletes its keys. Keys are shown
only as `••••1a2b`, and changing them is limited to this computer unless `APP_PASSWORD` is set.

Older installs with plain `ZERION_API_KEY=` / `DEBANK_ACCESS_KEY=` / `EXTENDED_API_KEY=` lines keep working, but
only for the first portfolio (and the Extended key only for one of its wallets: the one matching
`EXTENDED_WALLET_ADDRESS`, else the one that synced Extended). Saving that key again on the Data sources page
replaces the old line.

### Upgrading an existing install

The first start after upgrading migrates the database automatically. Existing wallets and positions move into a
**Main portfolio**, and reward entries keep their meaning. Back up first:

```bash
docker exec defi-tracker node -e "new (require('node:sqlite').DatabaseSync)('/data/tracker.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

JSON backups from older versions (`version: 1`) still import, into one portfolio.

## Keeping secrets and wallet data out of git

- `.env` (API keys), `data/` and any `*.db` (your positions) are git-ignored.
- `scripts/check-secrets.sh` blocks commits containing API keys/tokens, wallet or contract addresses,
  64-hex hashes/private keys and Solana addresses. Test fixtures use placeholders like `0x1111…1111`.
- Put your own identifiers (wallet addresses, exchange account numbers, position ids) in a local
  `.secrets-denylist`, one per line. It's git-ignored and checked on every commit.
- Enable the hook after cloning: `git config core.hooksPath .githooks`. CI runs the same scan on every push.
