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
  'Mantle', 'Gnosis', 'Plasma', 'Tron', 'Cosmos', 'Osmosis', 'Injective', 'Near', 'Sei', 'Robinhood Chain', 'Unichain', 'Lighter', 'Starknet', 'GRVT', 'Multichain'];

export const STRATEGIES = ['Vault', 'Staking', 'V3 Pool', 'V2 Pool', 'Funding Rate', 'LLP', 'Looping',
  'Lending / Supply', 'Lending / Borrow', 'Exposure'];

// Canonical definitions of tables that migrations rebuild (CHECK / UNIQUE changes need a rebuild in SQLite).
const SCHEMA = {
  wallets: `CREATE TABLE wallets (
      id INTEGER PRIMARY KEY,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
      name TEXT NOT NULL,
      address TEXT,
      kind TEXT NOT NULL DEFAULT 'manual',       -- evm | solana | manual
      source TEXT,                               -- metamask | phantom | trustwallet | address | manual
      track_from TEXT,                           -- "start tracking from" date; NULL = all history
      key_ref TEXT,                              -- names this wallet's exchange keys in .env (see server/settings.js)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (portfolio_id, name)
    )`,
  events: `CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('valuation','withdrawal','reward','reward_total','fee','deposit')),
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    )`,
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      key_ref TEXT,                              -- names this portfolio's API keys in .env (see server/settings.js)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ${SCHEMA.wallets.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')};
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY,
      portfolio_id INTEGER REFERENCES portfolios(id),
      wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
      strategy TEXT, protocol TEXT, chain TEXT, currency TEXT,
      entry_date TEXT, exit_date TEXT,
      deposit REAL,
      expected_return REAL,                      -- user-entered target, simple annual return as a decimal (0.08 = 8%)
      comments TEXT,
      closed INTEGER NOT NULL DEFAULT 0,
      debank_key TEXT,                           -- link to a DeBank/Zerion portfolio item for auto-valuation (Zerion keys start with 'zerion|')
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ${SCHEMA.events.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')};
    CREATE INDEX IF NOT EXISTS events_position ON events(position_id);
    CREATE TABLE IF NOT EXISTS event_revisions (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL,                 -- not a foreign key: the history survives when the event is deleted
      position_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('update','delete','restore')),
      before TEXT,                               -- JSON of the event before the change
      after TEXT,                                -- JSON after the change (NULL for a delete)
      reason TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS event_revisions_position ON event_revisions(position_id);
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
    CREATE TABLE IF NOT EXISTS dex_accounts (
      wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      dex TEXT NOT NULL,                         -- a key of DEXES in server/settings.js
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wallet_id, dex)
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

  // Every install has at least one portfolio; existing data lands in it.
  if (!db.prepare('SELECT 1 FROM portfolios LIMIT 1').get()) db.prepare("INSERT INTO portfolios (id, name) VALUES (1, 'Main portfolio')").run();
  const defaultPortfolio = db.prepare('SELECT MIN(id) id FROM portfolios').get().id;

  // Rebuild a table to its canonical definition, keeping ids and every column both versions share.
  // (SQLite can't alter CHECK or UNIQUE constraints in place.) Foreign keys are off during the swap so
  // that dropping the old table doesn't cascade into child tables; the result is checked afterwards.
  const columns = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const rebuild = (table, extra = {}) => {
    const sql = SCHEMA[table].replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_new`);
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      db.exec(sql);
      const shared = columns(table).filter((c) => columns(`${table}_new`).includes(c) && !(c in extra));
      const cols = [...shared, ...Object.keys(extra)];
      const vals = [...shared, ...Object.values(extra)];
      db.exec(`INSERT INTO ${table}_new (${cols.join(', ')}) SELECT ${vals.join(', ')} FROM ${table};
        DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign key check failed after rebuilding ${table}: ${JSON.stringify(broken.slice(0, 3))}`);
      db.exec('COMMIT;');
    } catch (e) { db.exec('ROLLBACK;'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON;'); }
  };
  const tableSql = (t) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql || '';

  // Migration: wallets belong to a portfolio; names are unique per portfolio (not globally).
  if (!columns('wallets').includes('portfolio_id')) rebuild('wallets', { portfolio_id: String(defaultPortfolio) });
  if (!columns('wallets').includes('track_from')) db.exec('ALTER TABLE wallets ADD COLUMN track_from TEXT');
  // Migration: API keys are kept per portfolio / per wallet, each named by a random reference.
  if (!columns('wallets').includes('key_ref')) db.exec('ALTER TABLE wallets ADD COLUMN key_ref TEXT');
  if (!columns('portfolios').includes('key_ref')) db.exec('ALTER TABLE portfolios ADD COLUMN key_ref TEXT');
  // Migration: positions belong to a portfolio (a position needn't have a wallet, so it carries its own).
  if (!columns('positions').includes('portfolio_id')) db.exec('ALTER TABLE positions ADD COLUMN portfolio_id INTEGER REFERENCES portfolios(id)');
  db.prepare(`UPDATE positions SET portfolio_id = COALESCE((SELECT w.portfolio_id FROM wallets w WHERE w.id = positions.wallet_id), ?)
    WHERE portfolio_id IS NULL`).run(defaultPortfolio);
  // Migration: event types gained 'deposit' (capital added) and 'reward_total' (cumulative rewards to date).
  if (!tableSql('events').includes("'reward_total'")) rebuild('events');
  db.exec('CREATE INDEX IF NOT EXISTS events_position ON events(position_id)');
  // Migration: suggestions gained 'close'.
  if (!tableSql('suggestions').includes("'close'")) {
    const sql = tableSql('suggestions').replace("IN ('fee','deposit')", "IN ('fee','deposit','close')");
    SCHEMA.suggestions = sql; rebuild('suggestions');
  }
  // Migration: snapshots gained a provider column when Zerion was added alongside DeBank.
  if (!columns('debank_snapshots').includes('provider')) {
    db.exec("ALTER TABLE debank_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'debank'");
  }
  // Migration: DEX accounts became opt-in per wallet. Wallets already using Lighter (it used to be checked for
  // every EVM wallet) keep it: those with tracked Lighter positions or a Lighter account in their last sync.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dex_migrated'").get()) {
    const usesLighter = (w) => db.prepare("SELECT 1 FROM positions WHERE wallet_id = ? AND debank_key LIKE 'lighter|%'").get(w)
      || (() => { const r = db.prepare("SELECT items FROM debank_snapshots WHERE wallet_id = ? AND provider = 'lighter' ORDER BY id DESC LIMIT 1").get(w);
        if (!r) return false; const m = JSON.parse(r.items); return (Array.isArray(m) ? m : m.items).length > 0; })();
    for (const { id } of db.prepare("SELECT id FROM wallets WHERE kind = 'evm'").all()) {
      if (usesLighter(id)) db.prepare("INSERT OR IGNORE INTO dex_accounts (wallet_id, dex) VALUES (?, 'lighter')").run(id);
    }
    db.exec('CREATE TABLE dex_migrated (done INTEGER)');
  }
  const seed = db.prepare('INSERT OR IGNORE INTO prices (symbol, usd_price, price_date, coingecko_id) VALUES (?, ?, ?, ?)');
  for (const [sym, cg] of DEFAULT_CURRENCIES) seed.run(sym, sym === 'USD' ? 1 : null, null, cg);
  return db;
}
