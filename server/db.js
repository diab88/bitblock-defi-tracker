import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Defaults from the spreadsheet's Lists sheet, with CoinGecko ids for price refresh.
export const DEFAULT_CURRENCIES = [
  ['USDC', 'usd-coin'], ['USDT', 'tether'], ['DAI', 'dai'], ['USDS', 'usds'], ['USDG', 'global-dollar'],
  ['USDe', 'ethena-usde'], ['sUSDe', 'ethena-staked-usde'], ['crvUSD', 'crvusd'], ['GHO', 'gho'],
  ['FRAX', 'frax'], ['LUSD', 'liquity-usd'], ['PYUSD', 'paypal-usd'], ['RLUSD', 'ripple-usd'],
  ['EURC', 'euro-coin'], ['ETH', 'ethereum'], ['WETH', 'weth'], ['stETH', 'staked-ether'],
  ['wstETH', 'wrapped-steth'], ['weETH', 'wrapped-eeth'], ['rETH', 'rocket-pool-eth'],
  ['cbETH', 'coinbase-wrapped-staked-eth'], ['BTC', 'bitcoin'], ['WBTC', 'wrapped-bitcoin'],
  ['cbBTC', 'coinbase-wrapped-btc'], ['tBTC', 'tbtc'], ['SOL', 'solana'], ['WSOL', 'wrapped-solana'],
  ['JitoSOL', 'jito-staked-sol'], ['mSOL', 'msol'], ['BNB', 'binancecoin'], ['AVAX', 'avalanche-2'],
  ['POL', 'polygon-ecosystem-token'], ['ARB', 'arbitrum'], ['OP', 'optimism'], ['HYPE', 'hyperliquid'],
  ['SUI', 'sui'], ['APT', 'aptos'], ['AAVE', 'aave'], ['LINK', 'chainlink'], ['UNI', 'uniswap'],
  ['CRV', 'curve-dao-token'], ['PENDLE', 'pendle'], ['ENA', 'ethena'], ['MORPHO', 'morpho'],
  ['SKY', 'sky'], ['SEI', 'sei-network'], ['INJ', 'injective-protocol'], ['ATOM', 'cosmos'],
  ['NEAR', 'near'], ['TRX', 'tron'], ['LIT', 'lighter'], ['EUR', null], ['USD', null],
];

export const CHAINS = ['Ethereum', 'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Solana', 'Avalanche', 'BNB Chain',
  'HyperEVM', 'Hyperliquid', 'Sonic', 'Sui', 'Aptos', 'Bitcoin', 'Berachain', 'Linea', 'zkSync Era', 'Scroll',
  'Mantle', 'Gnosis', 'Plasma', 'Tron', 'Cosmos', 'Osmosis', 'Injective', 'Near', 'Sei', 'Robinhood Chain', 'Unichain', 'Lighter', 'Starknet', 'Multichain'];

export const STRATEGIES = ['Vault', 'Staking', 'V3 Pool', 'V2 Pool', 'Funding Rate', 'LLP', 'Looping',
  'Lending / Supply', 'Lending / Borrow', 'Exposure'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT,
      kind TEXT NOT NULL DEFAULT 'manual',       -- evm | solana | manual
      source TEXT,                               -- metamask | phantom | address | manual
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY,
      wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
      strategy TEXT, protocol TEXT, chain TEXT, currency TEXT,
      entry_date TEXT, exit_date TEXT,
      deposit REAL,
      expected_return REAL,                      -- decimal, e.g. 0.08
      comments TEXT,
      closed INTEGER NOT NULL DEFAULT 0,
      debank_key TEXT,                           -- link to a DeBank/Zerion portfolio item for auto-valuation (Zerion keys start with 'zerion|')
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('valuation','withdrawal','reward','fee','deposit')),
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS events_position ON events(position_id);
    CREATE TABLE IF NOT EXISTS prices (
      symbol TEXT PRIMARY KEY,
      usd_price REAL,
      price_date TEXT,
      coingecko_id TEXT
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('fee','deposit','close')),
      tx_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      detail TEXT,                               -- JSON: tokens, app, hash
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','ignored')),
      event_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (position_id, kind, tx_id)
    );
    CREATE TABLE IF NOT EXISTS price_history (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      usd_price REAL NOT NULL,
      PRIMARY KEY (symbol, date)
    );
    CREATE TABLE IF NOT EXISTS debank_snapshots (
      id INTEGER PRIMARY KEY,
      wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      total_usd REAL,
      items TEXT NOT NULL                        -- JSON array of normalized portfolio items
    );
  `);
  // Migration: widen CHECK constraints (events: 'deposit' = capital added; suggestions: 'close').
  // SQLite can't alter a CHECK, so rebuild the table when the old definition is still in place.
  const widen = (table, needle) => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || '';
    if (!sql || sql.includes(needle)) return;
    const next = sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_new`)
      .replace("IN ('valuation','withdrawal','reward','fee')", "IN ('valuation','withdrawal','reward','fee','deposit')")
      .replace("IN ('fee','deposit')", "IN ('fee','deposit','close')");
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    db.exec(next);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
  };
  widen('events', "'fee','deposit')");
  widen('suggestions', "'deposit','close')");
  db.exec('CREATE INDEX IF NOT EXISTS events_position ON events(position_id)');

  // Migration: wallets gained a "start tracking from" date (NULL = all history).
  if (!db.prepare('PRAGMA table_info(wallets)').all().some((c) => c.name === 'track_from')) {
    db.exec('ALTER TABLE wallets ADD COLUMN track_from TEXT');
  }
  // Migration: snapshots gained a provider column when Zerion was added alongside DeBank.
  if (!db.prepare('PRAGMA table_info(debank_snapshots)').all().some((c) => c.name === 'provider')) {
    db.exec("ALTER TABLE debank_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'debank'");
  }
  const seed = db.prepare('INSERT OR IGNORE INTO prices (symbol, usd_price, price_date, coingecko_id) VALUES (?, ?, ?, ?)');
  for (const [sym, cg] of DEFAULT_CURRENCIES) seed.run(sym, sym === 'USD' ? 1 : null, null, cg);
  return db;
}
