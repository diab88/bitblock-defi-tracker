import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, CHAINS, STRATEGIES } from './db.js';
import { computeExposure, detectHedges, underlying } from './hedges.js';
import { computePosition, summarizeByCurrency, portfolioSeries, positionSeries } from './calc.js';
import { fetchCoingeckoHistory, testProviderKey } from './integrations.js';
import { fetchHyperliquidPortfolio, fetchGmxPortfolio, fetchBulkPortfolio, fetchGrvtPortfolio } from './dexes.js';
import { KEYED_SOURCES, DEXES, validateKey, maskKey, envFilePath, envFileStatus, writeEnvValue, removeEnvValues, scopedEnvName, newKeyRef } from './settings.js';
import { debankMode, fetchDebankPortfolio, zerionMode, fetchZerionPortfolio, lighterMode, fetchLighterPortfolio, fetchZerionTransactions, matchTransactions, relinkKeys, accountSince, applyTrackFrom, walletFlow, detectExits, extendedMode, fetchExtendedPortfolio, fetchCoingeckoPrices, fetchSolanaBalance, fetchWalletHoldings, isEvmAddress, isSolanaAddress } from './integrations.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8080);
const AUTO_SYNC_HOURS = Number(process.env.AUTO_SYNC_HOURS ?? 12);
const db = openDb(process.env.DB_PATH || path.join(root, 'data', 'tracker.db'));
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Optional single-user protection for when the container is exposed beyond localhost.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="BitBlock DeFi Tracker"').status(401).send('Authentication required');
  });
}

// Active portfolio: every API call is scoped to one (X-Portfolio header or ?portfolio=). Unknown or missing →
// the first portfolio, so older clients and bookmarks keep working.
app.use('/api', (req, _res, next) => {
  const asked = Number(req.get('x-portfolio') || req.query.portfolio);
  const found = asked ? db.prepare('SELECT id FROM portfolios WHERE id = ?').get(asked) : null;
  req.pid = found ? found.id : db.prepare('SELECT MIN(id) id FROM portfolios').get().id;
  next();
});

app.use(express.static(path.join(root, 'public')));
app.use('/vendor/chart.js', express.static(path.join(root, 'node_modules/chart.js/dist')));

// ---------- helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function priceMap() {
  return Object.fromEntries(db.prepare('SELECT * FROM prices').all().map((p) => [p.symbol, p]));
}

function loadPositions(pid) {
  const prices = priceMap();
  const wallets = Object.fromEntries(db.prepare('SELECT id, name FROM wallets WHERE portfolio_id = ?').all(pid).map((w) => [w.id, w.name]));
  const events = db.prepare('SELECT e.* FROM events e JOIN positions p ON p.id = e.position_id WHERE p.portfolio_id = ?').all(pid);
  const revised = new Set(db.prepare('SELECT DISTINCT event_id FROM event_revisions WHERE position_id IN (SELECT id FROM positions WHERE portfolio_id = ?)').all(pid).map((r) => r.event_id));
  const byPos = {};
  for (const e of events) (byPos[e.position_id] ??= []).push(revised.has(e.id) ? { ...e, corrected: true } : e);
  return db.prepare('SELECT * FROM positions WHERE portfolio_id = ? ORDER BY closed, entry_date DESC, id DESC').all(pid).map((p) => {
    const evs = byPos[p.id] || [];
    return { ...p, wallet: wallets[p.wallet_id] ?? null, events: evs, metrics: computePosition(p, evs, prices[p.currency]) };
  });
}

function positionFields(b) {
  const f = {
    wallet_id: num(b.wallet_id),
    strategy: text(b.strategy), protocol: text(b.protocol), chain: text(b.chain), currency: text(b.currency),
    entry_date: text(b.entry_date), exit_date: text(b.exit_date),
    deposit: num(b.deposit), expected_return: num(b.expected_return),
    comments: text(b.comments), debank_key: text(b.debank_key),
  };
  for (const k of ['entry_date', 'exit_date']) if (f[k] && !isDate(f[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
  if (f.deposit !== null && !(f.deposit >= 0)) throw new HttpError(400, 'deposit must be a non-negative number');
  return f;
}

const EVENT_TYPES = ['valuation', 'withdrawal', 'reward', 'reward_total', 'fee', 'deposit'];

function addEvent(positionId, { type, date, amount, note, source = 'manual' }) {
  if (!EVENT_TYPES.includes(type)) throw new HttpError(400, 'invalid event type');
  if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const a = Number(amount);
  if (!Number.isFinite(a) || a < 0) throw new HttpError(400, 'amount must be a non-negative number');
  return db.prepare('INSERT INTO events (position_id, type, date, amount, note, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(positionId, type, date, a, text(note), source).lastInsertRowid;
}

// With `pid`, anything outside that portfolio is "not found": one portfolio can't read or change another's data.
const getPosition = (id, pid = null) => {
  const p = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
  if (!p || (pid !== null && p.portfolio_id !== pid)) throw new HttpError(404, 'position not found');
  return p;
};
const getWallet = (id, pid = null) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  if (!w || (pid !== null && w.portfolio_id !== pid)) throw new HttpError(404, 'wallet not found');
  return w;
};
// A position's wallet must be in the same portfolio as the position.
const checkWalletFor = (walletId, pid) => { if (walletId !== null && walletId !== undefined) getWallet(walletId, pid); };

// ---------- portfolios ----------
const portfolioRows = () => db.prepare(`SELECT p.id, p.name, p.created_at,
    (SELECT COUNT(*) FROM wallets w WHERE w.portfolio_id = p.id) wallets,
    (SELECT COUNT(*) FROM positions x WHERE x.portfolio_id = p.id) positions
  FROM portfolios p ORDER BY p.id`).all();

app.get('/api/portfolios', (req, res) => res.json({ current: req.pid, portfolios: portfolioRows() }));

app.post('/api/portfolios', (req, res) => {
  const name = text(req.body.name);
  if (!name) throw new HttpError(400, 'portfolio name is required');
  if (name.length > 60) throw new HttpError(400, 'portfolio name is too long (max 60)');
  try {
    const id = Number(db.prepare('INSERT INTO portfolios (name) VALUES (?)').run(name).lastInsertRowid);
    res.status(201).json(portfolioRows().find((p) => p.id === id));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'a portfolio with that name already exists');
    throw e;
  }
});

app.put('/api/portfolios/:id', (req, res) => {
  const name = text(req.body.name);
  if (!name) throw new HttpError(400, 'portfolio name is required');
  if (!db.prepare('SELECT 1 FROM portfolios WHERE id = ?').get(req.params.id)) throw new HttpError(404, 'portfolio not found');
  try { db.prepare('UPDATE portfolios SET name = ? WHERE id = ?').run(name, req.params.id); }
  catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'a portfolio with that name already exists'); throw e; }
  res.json({ ok: true });
});

// Deleting is only allowed for an empty portfolio (and never the last one), so nothing is lost by accident.
app.delete('/api/portfolios/:id', (req, res) => {
  const p = portfolioRows().find((x) => x.id === Number(req.params.id));
  if (!p) throw new HttpError(404, 'portfolio not found');
  if (portfolioRows().length === 1) throw new HttpError(400, 'you need at least one portfolio');
  if (p.wallets || p.positions) throw new HttpError(400, `“${p.name}” still has ${p.wallets} wallet(s) and ${p.positions} position(s); remove or move them first`);
  const row = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(p.id);
  for (const id of portfolioSourceIds) if (portfolioKey(id, p.id).key) forgetKey(id, { table: 'portfolios', row });
  db.prepare('DELETE FROM portfolios WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- meta ----------
app.get('/api/meta', (req, res) => {
  res.json({
    portfolio: portfolioRows().find((p) => p.id === req.pid),
    portfolios: portfolioRows(),
    chains: CHAINS,
    strategies: STRATEGIES,
    currencies: db.prepare('SELECT symbol FROM prices ORDER BY rowid').all().map((r) => r.symbol),
    wallets: db.prepare('SELECT * FROM wallets WHERE portfolio_id = ? ORDER BY name').all(req.pid),
    protocols: db.prepare('SELECT DISTINCT protocol FROM positions WHERE protocol IS NOT NULL AND portfolio_id = ? ORDER BY protocol').all(req.pid).map((r) => r.protocol),
    debank: debankMode(portfolioKey('debank', req.pid).key),
    zerion: zerionMode(portfolioKey('zerion', req.pid).key),
    lighter: lighterMode(),
    // Exchange accounts are opt-in per wallet: 'live' only once a wallet in this portfolio has one linked.
    extended: db.prepare('SELECT * FROM wallets WHERE portfolio_id = ?').all(req.pid).some((w) => walletKey('extended', w).key) ? 'live' : 'off',
    dexes: dexList(),
    autoSyncHours: AUTO_SYNC_HOURS,
  });
});

// ---------- positions ----------
// Positions plus, for synced ones, what the source reports inside them (e.g. an exchange account's
// P/L breakdown), so a single account row can be read part by part.
app.get('/api/positions', (req, res) => res.json(loadPositions(req.pid).map((p) => {
  if (!p.debank_key || !p.wallet_id) return p;
  const item = accountSince(latestSnapshotItem(p.wallet_id, p.debank_key), p.entry_date, historicalPrices(p.entry_date));
  if (!item?.breakdown) return p;
  // The source's P/L is against its own capital figure; if the user changed the deposit, show the offset.
  const depositOffset = item.depositUsd != null && p.deposit != null ? item.depositUsd - p.deposit : 0;
  return { ...p, sourceDetail: { breakdown: item.breakdown, reconcile: item.reconcile, depositOffset, positions: item.positions, excludedTrades: item.excludedTrades || [], since: p.entry_date } };
})));

app.post('/api/positions', (req, res) => {
  const f = positionFields(req.body);
  checkWalletFor(f.wallet_id, req.pid);
  const id = db.prepare(`INSERT INTO positions (portfolio_id, wallet_id, strategy, protocol, chain, currency, entry_date, exit_date, deposit, expected_return, comments, debank_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.pid, f.wallet_id, f.strategy, f.protocol, f.chain, f.currency, f.entry_date, f.exit_date, f.deposit, f.expected_return, f.comments, f.debank_key).lastInsertRowid;
  const cv = num(req.body.current_value);
  const vd = text(req.body.valuation_date) || f.entry_date || today();
  if (cv !== null) addEvent(id, { type: 'valuation', date: vd, amount: cv, source: f.debank_key ? keyProvider(f.debank_key) : 'manual' });
  if (f.debank_key && f.wallet_id) backfillHistory(Number(id), f.wallet_id, f.debank_key, f.currency, vd, f.entry_date);
  res.status(201).json({ id: Number(id) });
});

app.put('/api/positions/:id', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  const f = positionFields({ ...p, ...req.body });
  checkWalletFor(f.wallet_id, req.pid);
  db.prepare(`UPDATE positions SET wallet_id=?, strategy=?, protocol=?, chain=?, currency=?, entry_date=?, exit_date=?, deposit=?, expected_return=?, comments=?, debank_key=? WHERE id=?`)
    .run(f.wallet_id, f.strategy, f.protocol, f.chain, f.currency, f.entry_date, f.exit_date, f.deposit, f.expected_return, f.comments, f.debank_key, p.id);
  res.json({ ok: true });
});

app.delete('/api/positions/:id', (req, res) => {
  db.prepare('DELETE FROM positions WHERE id = ?').run(getPosition(req.params.id, req.pid).id);
  res.json({ ok: true });
});

app.get('/api/positions/:id/series', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  res.json(positionSeries(p, db.prepare('SELECT * FROM events WHERE position_id = ?').all(p.id)));
});

app.post('/api/positions/:id/events', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  res.status(201).json({ id: Number(addEvent(p.id, req.body)) });
});

// ---------- corrections ----------
// Entries are edited in place (no delete-and-recreate), and every change is kept in event_revisions with
// the values before and after, so a correction can be reviewed and undone. Calculations always read the
// current events, so a corrected amount flows through P/L, returns and charts immediately.
const getEvent = (id, pid) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new HttpError(404, 'entry not found');
  getPosition(e.position_id, pid);
  return e;
};
const snapshotOf = (e) => ({ id: e.id, type: e.type, date: e.date, amount: e.amount, note: e.note, source: e.source });
const logRevision = (e, action, before, after, reason) => db.prepare('INSERT INTO event_revisions (event_id, position_id, action, before, after, reason) VALUES (?, ?, ?, ?, ?, ?)')
  .run(e.id, e.position_id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, text(reason));

function updateEvent(e, b, action = 'update') {
  const next = { ...e,
    type: b.type ?? e.type,
    date: b.date ?? e.date,
    amount: b.amount === undefined ? e.amount : Number(b.amount),
    note: b.note === undefined ? e.note : text(b.note) };
  if (!EVENT_TYPES.includes(next.type)) throw new HttpError(400, 'invalid event type');
  // Only swaps within the same family are allowed: a correction mustn't turn a fee into a valuation.
  const family = (t) => (t === 'reward' || t === 'reward_total' ? 'reward' : t);
  if (family(next.type) !== family(e.type)) throw new HttpError(400, `can't change a ${e.type} entry into ${next.type}`);
  if (!isDate(next.date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (!Number.isFinite(next.amount) || next.amount < 0) throw new HttpError(400, 'amount must be a non-negative number');
  const before = snapshotOf(e), after = snapshotOf(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false };
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE events SET type = ?, date = ?, amount = ?, note = ? WHERE id = ?').run(next.type, next.date, next.amount, next.note, e.id);
    logRevision(e, action, before, after, b.reason);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { changed: true, before, after };
}

app.put('/api/events/:id', (req, res) => res.json(updateEvent(getEvent(req.params.id, req.pid), req.body)));

app.delete('/api/events/:id', (req, res) => {
  const e = getEvent(req.params.id, req.pid);
  const sg = db.prepare('SELECT id FROM suggestions WHERE event_id = ?').get(e.id);
  db.exec('BEGIN');
  try {
    logRevision(e, 'delete', { ...snapshotOf(e), suggestionId: sg?.id ?? null }, null, req.query.reason || req.body?.reason);
    db.prepare("UPDATE suggestions SET status = 'pending', event_id = NULL WHERE event_id = ?").run(e.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json({ ok: true });
});

app.get('/api/positions/:id/revisions', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  res.json(db.prepare('SELECT * FROM event_revisions WHERE position_id = ? ORDER BY id DESC').all(p.id)
    .map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null })));
});

// Undo a change: put the entry back the way it was before that revision (re-creating it if it was deleted).
app.post('/api/revisions/:id/restore', (req, res) => {
  const r = db.prepare('SELECT * FROM event_revisions WHERE id = ?').get(req.params.id);
  if (!r?.before) throw new HttpError(404, 'nothing to restore');
  const p = getPosition(r.position_id, req.pid);
  const before = JSON.parse(r.before);
  const current = db.prepare('SELECT * FROM events WHERE id = ?').get(r.event_id);
  if (current) return res.json(updateEvent(current, { ...before, reason: `restored revision #${r.id}` }, 'restore'));
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO events (id, position_id, type, date, amount, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(before.id, p.id, before.type, before.date, before.amount, before.note, before.source || 'manual');
    if (before.suggestionId) db.prepare("UPDATE suggestions SET status = 'applied', event_id = ? WHERE id = ? AND status = 'pending'").run(before.id, before.suggestionId);
    logRevision({ id: before.id, position_id: p.id }, 'restore', null, before, `restored revision #${r.id}`);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json({ changed: true, restored: before });
});

// Close = final valuation at the exit date (exit proceeds) + mark closed. Mirrors sheet column X + G.
app.post('/api/positions/:id/close', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  const { exit_date, exit_value } = req.body;
  if (!isDate(exit_date)) throw new HttpError(400, 'exit_date must be YYYY-MM-DD');
  if (p.entry_date && exit_date < p.entry_date) throw new HttpError(400, 'exit date is before entry date');
  if (num(exit_value) !== null) addEvent(p.id, { type: 'valuation', date: exit_date, amount: exit_value, note: 'Exit proceeds' });
  db.prepare('UPDATE positions SET closed = 1, exit_date = ? WHERE id = ?').run(exit_date, p.id);
  res.json({ ok: true });
});

app.post('/api/positions/:id/reopen', (req, res) => {
  db.prepare('UPDATE positions SET closed = 0, exit_date = NULL WHERE id = ?').run(getPosition(req.params.id, req.pid).id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const { wallet, currency, status } = req.query;
  let rows = loadPositions(req.pid);
  if (wallet === 'none') rows = rows.filter((r) => !r.wallet_id);
  else if (wallet) rows = rows.filter((r) => String(r.wallet_id) === wallet);
  if (currency) rows = rows.filter((r) => r.currency === currency);
  if (status === 'open') rows = rows.filter((r) => r.metrics.status === 'Open');
  if (status === 'closed') rows = rows.filter((r) => r.metrics.status === 'Closed');

  const counted = rows.filter((r) => ['Open', 'Closed'].includes(r.metrics.status));
  const priced = counted.filter((r) => r.metrics.usdPrice);
  const sum = (arr, f) => arr.reduce((s, r) => s + (f(r) || 0), 0);
  const open = priced.filter((r) => r.metrics.status === 'Open');
  const closedRows = priced.filter((r) => r.metrics.status === 'Closed');

  const kpis = {
    positions: rows.length,
    open: counted.filter((r) => r.metrics.status === 'Open').length,
    closed: counted.filter((r) => r.metrics.status === 'Closed').length,
    incomplete: rows.length - counted.length,
    unpriced: counted.length - priced.length,
    investedOpenUsd: sum(open, (r) => r.metrics.depositUsd),
    valueOpenUsd: sum(open, (r) => r.metrics.valueUsd),
    pnlOpenUsd: sum(open, (r) => r.metrics.pnlUsd),
    pnlClosedUsd: sum(closedRows, (r) => r.metrics.pnlUsd),
    withdrawalsUsd: sum(priced, (r) => r.metrics.withdrawals * r.metrics.usdPrice),
    rewardsUsd: sum(priced, (r) => r.metrics.rewards * r.metrics.usdPrice),
    depositedUsd: sum(priced, (r) => r.metrics.depositUsd),
  };
  kpis.pnlUsd = kpis.pnlOpenUsd + kpis.pnlClosedUsd;
  kpis.totalReturn = kpis.depositedUsd ? kpis.pnlUsd / kpis.depositedUsd : null;
  // Deposit-weighted simple annualized return, matching the sheet's per-row definition.
  // Only positions held long enough for an annual figure to mean something (see MIN_DAYS_FOR_ANNUALIZED).
  const w = priced.filter((r) => r.metrics.annualized !== null && r.metrics.annualizedReliable);
  kpis.weightedApr = sum(w, (r) => r.metrics.depositUsd) ? sum(w, (r) => r.metrics.annualized * r.metrics.depositUsd) / sum(w, (r) => r.metrics.depositUsd) : null;

  const group = (key) => {
    const g = {};
    for (const r of priced) {
      const k = r[key] || '—';
      const o = (g[k] ??= { name: k, deposit: 0, value: 0, pnl: 0, count: 0 });
      o.deposit += r.metrics.depositUsd; o.value += r.metrics.valueUsd || 0; o.pnl += r.metrics.pnlUsd; o.count++;
    }
    return Object.values(g).map((o) => ({ ...o, ret: o.deposit ? o.pnl / o.deposit : null })).sort((a, b) => b.deposit - a.deposit);
  };

  // Strategy × Chain and Strategy × Venue matrices. Venue = protocol without its sub-label
  // ("Lighter · LLP" → "Lighter"), so exchanges like Extended show by name rather than by settlement chain.
  const venueOf = (r) => { const v = (r.protocol || '—').split(' · ')[0]; return v.startsWith('Wallet') ? 'Wallet' : v; };
  // Components: most positions are one component. An exchange account whose source reports a breakdown is
  // split: each hedged perp leg becomes its own component (P/L only), the rest stays with the account.
  // Hedge legs — both the long position and the short leg — go to one "Delta-neutral hedge" row, so the
  // legs sit side by side and the row total is the hedge's net. Totals are unchanged by the split.
  const { hedges } = hedgeReport(rows);
  const hedgeOf = new Map();
  for (const h of hedges) for (const l of [...h.longs, ...h.shorts]) hedgeOf.set(`${l.positionId}|${l.kind === 'perp' ? l.symbol : ''}`, h.asset);
  const HEDGE_ROW = (asset) => `Delta-neutral hedge (${asset})`;
  const components = [];
  for (const r of priced) {
    const base = { chain: r.chain, venue: venueOf(r), deposit: r.metrics.depositUsd, value: r.metrics.valueUsd || 0, pnl: r.metrics.pnlUsd, strategy: r.strategy };
    const longHedge = hedgeOf.get(`${r.id}|`);
    if (longHedge) { components.push({ ...base, strategy: HEDGE_ROW(longHedge) }); continue; }
    const item = r.debank_key && r.wallet_id ? accountSince(latestSnapshotItem(r.wallet_id, r.debank_key), r.entry_date, historicalPrices(r.entry_date)) : null;
    let rest = base.pnl;
    for (const [market, parts] of Object.entries(Object.groupBy?.(item?.breakdown?.filter((b) => b.market) || [], (b) => b.market) || {})) {
      const asset = hedgeOf.get(`${r.id}|${market.split('-')[0]}`);
      if (!asset) continue;
      const legPnl = parts.reduce((a, b) => a + b.usd, 0);
      components.push({ ...base, strategy: HEDGE_ROW(asset), deposit: 0, value: 0, pnl: legPnl, leg: true });
      rest -= legPnl;
    }
    components.push({ ...base, pnl: rest });
  }
  const buildMatrix = (colOf) => {
    const m = {};
    for (const c of components) {
      const cell = ((m[c.strategy] ??= {})[colOf(c) || '—'] ??= { deposit: 0, pnl: 0, value: 0, count: 0, legs: 0 });
      cell.deposit += c.deposit; cell.pnl += c.pnl; cell.value += c.value; cell.count++;
      if (c.leg) cell.legs++;
    }
    return m;
  };
  const matrix = buildMatrix((c) => c.chain);
  const matrixByVenue = buildMatrix((c) => c.venue);

  res.json({
    kpis,
    untracked: currency && currency !== 'USD' ? [] : untrackedHoldings(req.pid, wallet).map((u) => ({ ...u, items: u.items.map(({ base, ...i }) => i) })),
    series: portfolioSeries(counted),
    byStrategy: group('strategy'),
    byChain: group('chain'),
    byProtocol: group('protocol'),
    byWallet: group('wallet'),
    matrix,
    matrixByVenue,
    currencySummary: summarizeByCurrency(rows),
    positions: rows.map(({ events, ...r }) => r),
  });
});

// ---------- wallets ----------
app.get('/api/wallets', (req, res) => {
  const wallets = db.prepare('SELECT * FROM wallets WHERE portfolio_id = ? ORDER BY name').all(req.pid);
  const snap = db.prepare('SELECT provider, fetched_at, total_usd FROM debank_snapshots WHERE wallet_id = ? ORDER BY id DESC LIMIT 1');
  const count = db.prepare('SELECT COUNT(*) n FROM positions WHERE wallet_id = ?');
  res.json(wallets.map(({ key_ref, ...w }) => ({ ...w, positions: count.get(w.id).n, lastSync: snap.get(w.id) ?? null, exchanges: walletExchanges({ key_ref, ...w }) })));
});

app.post('/api/wallets', (req, res) => {
  const name = text(req.body.name);
  const address = text(req.body.address);
  if (!name) throw new HttpError(400, 'wallet name is required');
  let kind = 'manual';
  if (address) {
    if (isEvmAddress(address)) kind = 'evm';
    else if (isSolanaAddress(address)) kind = 'solana';
    else throw new HttpError(400, 'address is neither a valid EVM (0x…) nor Solana address');
    // The same address may be tracked in several portfolios (each keeps its own positions); within one
    // portfolio it's added once.
    const existing = db.prepare('SELECT * FROM wallets WHERE lower(address) = lower(?) AND portfolio_id = ?').get(address, req.pid);
    if (existing) return res.json(existing);
  }
  const trackFrom = parseTrackFrom(req.body.track_from ?? 'today');
  try {
    const source = text(req.body.source) || (address ? 'address' : 'manual');
    if (!WALLET_SOURCES.includes(source)) throw new HttpError(400, `unknown wallet source "${source}"`);
    const id = db.prepare('INSERT INTO wallets (portfolio_id, name, address, kind, source, track_from) VALUES (?, ?, ?, ?, ?, ?)').run(req.pid, name, address, kind, source, trackFrom).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'a wallet with that name already exists in this portfolio');
    throw e;
  }
});

// How a wallet was connected. A portfolio can mix any of these.
const WALLET_SOURCES = ['metamask', 'phantom', 'trustwallet', 'address', 'manual'];

// "today" → today's date, "all"/empty → NULL (all history), or an explicit YYYY-MM-DD not in the future.
function parseTrackFrom(v) {
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  if (v === 'today') return today();
  if (!isDate(v)) throw new HttpError(400, 'track_from must be "today", "all" or YYYY-MM-DD');
  if (v > today()) throw new HttpError(400, 'track_from cannot be in the future');
  return v;
}

app.put('/api/wallets/:id', (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  const name = req.body.name === undefined ? w.name : text(req.body.name);
  if (!name) throw new HttpError(400, 'wallet name is required');
  const trackFrom = req.body.track_from === undefined ? w.track_from : parseTrackFrom(req.body.track_from);
  try { db.prepare('UPDATE wallets SET name = ?, track_from = ? WHERE id = ?').run(name, trackFrom, w.id); }
  catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'a wallet with that name already exists in this portfolio'); throw e; }
  res.json({ ok: true, track_from: trackFrom });
});

app.delete('/api/wallets/:id', (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  for (const id of walletSourceIds) if (walletKey(id, w).key) forgetKey(id, { table: 'wallets', row: w });
  db.prepare('DELETE FROM wallets WHERE id = ?').run(w.id);
  res.json({ ok: true });
});

// Every token in the wallet now, from this portfolio's tracker (see fetchWalletHoldings).
app.get('/api/wallets/:id/holdings', wrap(async (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  if (!w.address) throw new HttpError(400, 'This wallet has no address.');
  const r = await fetchWalletHoldings({ address: w.address, kind: w.kind, zerionKey: portfolioKey('zerion', w.portfolio_id).key, debankKey: portfolioKey('debank', w.portfolio_id).key });
  const prices = priceMap();
  for (const h of r.holdings) if (h.priceUsd == null && prices[h.symbol]?.usd_price > 0) { h.priceUsd = prices[h.symbol].usd_price; h.valueUsd = h.qty * h.priceUsd; }
  res.json({ ...r, totalUsd: r.holdings.reduce((t, h) => t + (h.valueUsd || 0), 0), fetchedAt: new Date().toISOString() });
}));

app.get('/api/wallets/:id/balance', wrap(async (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  if (w.kind !== 'solana') throw new HttpError(400, 'native balance lookup on the server is only for Solana wallets');
  res.json({ symbol: 'SOL', balance: await fetchSolanaBalance(w.address) });
}));

// ---------- API keys (per portfolio / per wallet) ----------
// Zerion and DeBank keys belong to a portfolio, exchange accounts (Extended) to one wallet; nothing is shared
// between portfolios. Each key is stored in .env as NAME__REF, REF being the portfolio's or wallet's random
// key_ref (server/settings.js).
// Before keys were scoped, .env held one plain key per source (ZERION_API_KEY=…). Such a key still works, but
// only for the first portfolio, and a plain EXTENDED_API_KEY only for one wallet of it (legacyExtendedWallet).
// Saving or removing that portfolio's / wallet's key from the UI replaces it.
const ENV_FILE = envFilePath(root);
const portfolioSourceIds = Object.keys(KEYED_SOURCES).filter((id) => KEYED_SOURCES[id].scope === 'portfolio');
const walletSourceIds = Object.keys(KEYED_SOURCES).filter((id) => KEYED_SOURCES[id].scope === 'wallet');
const firstPortfolioId = () => db.prepare('SELECT MIN(id) id FROM portfolios').get().id;
const NO_KEY = { key: null, from: null };

function portfolioKey(id, pid) {
  const src = KEYED_SOURCES[id];
  const p = db.prepare('SELECT id, key_ref FROM portfolios WHERE id = ?').get(pid);
  if (!p) return NO_KEY;
  const own = p.key_ref && process.env[scopedEnvName(src, p.key_ref)];
  if (own) return { key: own, from: 'own' };
  if (p.id === firstPortfolioId() && process.env[src.env]) return { key: process.env[src.env], from: 'legacy' };
  return NO_KEY;
}

// The one wallet an old unscoped EXTENDED_API_KEY belongs to: the first portfolio's EVM wallet matching
// EXTENDED_WALLET_ADDRESS, else the one that last synced Extended, else its first EVM wallet.
function legacyExtendedWallet() {
  if (!process.env.EXTENDED_API_KEY) return null;
  const evm = db.prepare("SELECT id, address FROM wallets WHERE portfolio_id = ? AND kind = 'evm' ORDER BY id").all(firstPortfolioId());
  const pin = process.env.EXTENDED_WALLET_ADDRESS?.trim().toLowerCase();
  if (pin) return evm.find((w) => w.address?.toLowerCase() === pin)?.id ?? null;
  const ids = new Set(evm.map((w) => w.id));
  const synced = db.prepare("SELECT wallet_id FROM debank_snapshots WHERE provider = 'extended' ORDER BY id DESC").all().find((r) => ids.has(r.wallet_id));
  return synced?.wallet_id ?? evm[0]?.id ?? null;
}

function walletKey(id, w) {
  const src = KEYED_SOURCES[id];
  if (!w || !src.kinds.includes(w.kind)) return NO_KEY;
  const own = w.key_ref && process.env[scopedEnvName(src, w.key_ref)];
  if (own) return { key: own, from: 'own' };
  if (id === 'extended' && legacyExtendedWallet() === w.id) return { key: process.env.EXTENDED_API_KEY, from: 'legacy' };
  return NO_KEY;
}

// DEX accounts are opt-in per wallet: a key DEX is linked when the wallet has its key, an address DEX when
// it was added (dex_accounts).
function dexLinked(id, w) {
  const d = DEXES[id];
  if (!d || !w || !d.kinds.includes(w.kind)) return false;
  if (d.auth === 'key') return !!walletKey(id, w).key;
  return !!db.prepare('SELECT 1 FROM dex_accounts WHERE wallet_id = ? AND dex = ?').get(w.id, id);
}

// DEX accounts linked to a wallet, for the browser (keys masked).
const walletExchanges = (w) => Object.fromEntries(Object.keys(DEXES).filter((id) => dexLinked(id, w)).map((id) => {
  const k = DEXES[id].auth === 'key' ? walletKey(id, w) : null;
  return [id, { auth: DEXES[id].auth, ...(k ? { masked: maskKey(k.key), from: k.from } : {}) }];
}));

// Write a key for a portfolio or wallet (t = { table, row, current }) to .env and apply it now.
function storeKey(id, t, key) {
  const src = KEYED_SOURCES[id];
  let ref = t.row.key_ref;
  if (!ref) { ref = newKeyRef(); db.prepare(`UPDATE ${t.table} SET key_ref = ? WHERE id = ?`).run(ref, t.row.id); }
  const name = scopedEnvName(src, ref);
  const file = envFileStatus(ENV_FILE);
  if (file.writable) writeEnvValue(ENV_FILE, name, key);
  process.env[name] = key;
  if (t.current.from === 'legacy') clearLegacy(src, file.writable); // the old shared line is replaced by this one
  console.log(`settings: ${src.label} key ${t.current.key ? 'replaced' : 'added'} for ${t.table === 'wallets' ? 'wallet' : 'portfolio'} #${t.row.id}${file.writable ? ' in .env' : ' for this session only (.env not writable)'}`);
  return { saved: file.writable, reason: file.reason };
}

function forgetKey(id, t) {
  const src = KEYED_SOURCES[id];
  const file = envFileStatus(ENV_FILE);
  if (t.row.key_ref) {
    const name = scopedEnvName(src, t.row.key_ref);
    if (file.writable) removeEnvValues(ENV_FILE, [name]);
    delete process.env[name];
  }
  if (t.current?.from === 'legacy' || (!t.current && (t.table === 'wallets' ? walletKey(id, t.row) : portfolioKey(id, t.row.id)).from === 'legacy')) clearLegacy(src, file.writable);
  console.log(`settings: ${src.label} key removed from ${t.table === 'wallets' ? 'wallet' : 'portfolio'} #${t.row.id}`);
  return file.writable;
}

function clearLegacy(src, writable) {
  if (writable) writeEnvValue(ENV_FILE, src.env, '');
  delete process.env[src.env];
}

function linkedPositions(walletId) {
  return db.prepare('SELECT id, debank_key, currency, closed FROM positions WHERE wallet_id = ? AND debank_key IS NOT NULL').all(walletId);
}

// key(w): the credential this wallet syncs with: its portfolio's key (DeBank, Zerion), its own linked
// exchange account (Extended), or none (Lighter is public). mode(key) says whether the source is usable.
const PROVIDERS = {
  debank: { label: 'DeBank', mode: debankMode, kinds: ['evm'], key: (w) => portfolioKey('debank', w.portfolio_id).key, fetch: (w, key) => fetchDebankPortfolio(w.address, key) },
  zerion: { label: 'Zerion', mode: zerionMode, kinds: ['evm', 'solana'], key: (w) => portfolioKey('zerion', w.portfolio_id).key, fetch: (w, key) => fetchZerionPortfolio(w.address, w.kind, key) },
  // One key = one Extended account, linked to one wallet.
  extended: { label: 'Extended', mode: extendedMode, kinds: ['evm'], key: (w) => walletKey('extended', w).key, fetch: (_w, key) => fetchExtendedPortfolio(key) },
  // After Extended on purpose: a hedged token's long leg is priced at the perp's mark (set during Extended's sync).
  lighter: { label: 'Lighter', mode: lighterMode, kinds: ['evm'], key: () => null, fetch: (w) => fetchLighterPortfolio(w.address) },
  hyperliquid: { label: 'Hyperliquid', mode: () => 'live', kinds: ['evm'], key: () => null, fetch: (w) => fetchHyperliquidPortfolio(w.address) },
  gmx: { label: 'GMX', mode: () => 'live', kinds: ['evm'], key: () => null, fetch: (w) => fetchGmxPortfolio(w.address) },
  bulk: { label: 'Bulk', mode: () => 'live', kinds: ['solana'], key: () => null, fetch: (w) => fetchBulkPortfolio(w.address) },
  grvt: { label: 'GRVT', mode: (key) => (key ? 'live' : 'off'), kinds: ['evm', 'solana'], key: (w) => walletKey('grvt', w).key, fetch: (_w, key) => fetchGrvtPortfolio(key) },
};
const providerMode = (id, w) => (DEXES[id] && !dexLinked(id, w) ? 'off' : PROVIDERS[id].mode(PROVIDERS[id].key(w)));
const keyProvider = (key) => {
  const prefix = key?.split('|')[0];
  return PROVIDERS[prefix] && prefix !== 'debank' ? prefix : 'debank'; // DeBank keys predate the prefix
};

function latestSnapshotItem(walletId, key) {
  const s = db.prepare('SELECT * FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 1').get(walletId, keyProvider(key));
  const v = snapshotView(s, walletId);
  return v?.items.find((i) => i.key === key) ?? null;
}

// Sources that publish history (Lighter share prices) get past valuations filled in on tracking,
// so charts start at the real entry date instead of today.
function backfillHistory(positionId, walletId, key, currency, beforeDate, entryDate) {
  const item = latestSnapshotItem(walletId, key);
  if (!item?.history?.length) return 0;
  const px = currency === 'USD' ? 1 : priceMap()[currency]?.usd_price;
  if (!px) return 0;
  const provider = keyProvider(key);
  let n = 0;
  for (const h of item.history) {
    if (h.date >= beforeDate || (entryDate && h.date < entryDate)) continue;
    addEvent(positionId, { type: 'valuation', date: h.date, amount: h.value / px, note: `${PROVIDERS[provider].label} history`, source: provider });
    n++;
  }
  return n;
}

const historicalPrices = (date) => Object.fromEntries(db.prepare('SELECT symbol, usd_price FROM price_history WHERE date = ?').all(date).map((r) => [r.symbol, r.usd_price]));

// Make sure we have each needed token's price on `date` (cached forever; CoinGecko ids from the prices table).
async function ensureHistoricalPrices(symbols, date) {
  for (const sym of new Set(symbols)) {
    if (db.prepare('SELECT 1 FROM price_history WHERE symbol = ? AND date = ?').get(sym, date)) continue;
    const id = db.prepare('SELECT coingecko_id FROM prices WHERE symbol = ?').get(sym)?.coingecko_id;
    if (!id) { console.warn(`no CoinGecko id for ${sym}; can't price it on ${date}`); continue; }
    try {
      const px = await fetchCoingeckoHistory(id, date);
      if (px > 0) db.prepare('INSERT OR REPLACE INTO price_history (symbol, date, usd_price) VALUES (?, ?, ?)').run(sym, date, px);
    } catch (e) { console.warn(e.message); }
  }
}

// The internal copy of a source's original numbers (`base`) stays server-side.
const forClient = (v) => (v ? { ...v, items: v.items.map(({ base, ...i }) => i) } : v);

function snapshotView(s, walletId) {
  if (!s) return null;
  const links = Object.fromEntries(linkedPositions(walletId).map((p) => [p.debank_key, p.id]));
  const meta = JSON.parse(s.items);
  const since = db.prepare('SELECT track_from FROM wallets WHERE id = ?').get(walletId)?.track_from || null;
  const priceAt = since ? historicalPrices(since) : {};
  const items = (Array.isArray(meta) ? meta : meta.items).map((i) => applyTrackFrom(i, since, priceAt)); // older snapshots stored the bare array
  return {
    trackFrom: since,
    provider: s.provider, fetchedAt: s.fetched_at, totalUsd: s.total_usd,
    mock: !!meta.mock, balancesOnly: !!meta.balancesOnly,
    items: items.map((i) => ({ ...i, positionId: links[i.key] ?? null })),
  };
}

// Latest snapshot for the wallet (from whichever source synced last), or for one provider.
app.get('/api/wallets/:id/snapshot', (req, res) => {
  getWallet(req.params.id, req.pid);
  const p = req.query.provider;
  const s = p
    ? db.prepare('SELECT * FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 1').get(req.params.id, p)
    : db.prepare('SELECT * FROM debank_snapshots WHERE wallet_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id);
  res.json(forClient(snapshotView(s, Number(req.params.id))));
});

// Pull the wallet's positions from a data source and record a valuation on every linked open position.
async function syncWallet(walletId, provider) {
  const src = PROVIDERS[provider];
  if (!src) throw new HttpError(400, `unknown provider "${provider}"`);
  const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!w) throw new HttpError(404, 'wallet not found');
  if (!src.kinds.includes(w.kind)) {
    throw new HttpError(400, w.kind === 'solana'
      ? `${src.label} covers EVM addresses only. Use Zerion for Solana.`
      : 'This wallet has no address to sync.');
  }
  const key = src.key(w);
  if (DEXES[provider] && !dexLinked(provider, w)) throw new HttpError(400, `No ${src.label} account is linked to this wallet. Add it with “Add DEX account”.`);
  if (src.mode(key) === 'off') throw new HttpError(400, `${src.label} isn’t set up for this portfolio. Add its key on the Data sources page.`);
  const pf = await src.fetch(w, key);
  if (w.track_from && w.track_from < today()) {
    const needs = pf.items.flatMap((i) => [
      ...(i.positions || []).filter((p) => p.openedAt && p.openedAt < w.track_from).map((p) => String(p.market).split('-')[0]),
      ...(i.currency && i.currency !== 'USD' && (!i.entryDate || i.entryDate < w.track_from) ? [i.currency] : []),
    ]);
    if (needs.length) await ensureHistoricalPrices(needs, w.track_from);
  }

  // Re-link tracked positions whose key the source changed, using earlier snapshots to know what they were.
  const linkedHere = linkedPositions(w.id).filter((p) => keyProvider(p.debank_key) === provider);
  if (linkedHere.some((p) => !pf.items.some((i) => i.key === p.debank_key))) {
    const previous = db.prepare('SELECT items FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 50').all(w.id, provider)
      .flatMap((r) => { const m = JSON.parse(r.items); return Array.isArray(m) ? m : m.items; });
    for (const mv of relinkKeys(linkedHere.map((p) => ({ positionId: p.id, key: p.debank_key })), previous, pf.items)) {
      db.prepare('UPDATE positions SET debank_key = ? WHERE id = ?').run(mv.to, mv.positionId);
      console.log(`relinked position #${mv.positionId}: ${mv.from} → ${mv.to}`);
    }
  }

  const prevRaw = db.prepare('SELECT items FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 1').get(w.id, provider);
  const prevItems = prevRaw ? (((m) => (Array.isArray(m) ? m : m.items))(JSON.parse(prevRaw.items))) : [];
  const id = db.prepare('INSERT INTO debank_snapshots (wallet_id, provider, total_usd, items) VALUES (?, ?, ?, ?)')
    .run(w.id, provider, pf.totalUsd, JSON.stringify({ items: pf.items, mock: !!pf.mock, balancesOnly: !!pf.balancesOnly })).lastInsertRowid;

  // A perp's mark becomes the price of its token for the day, so a hedge's long leg (e.g. staked LIT) and its
  // short are valued at the same price and moment. Otherwise two feeds (CoinGecko vs the exchange mark)
  // create a fake P/L gap between legs that should cancel.
  for (const i of pf.items) for (const pos of i.positions || []) {
    const sym = String(pos.market || '').split('-')[0];
    if (!sym || !(pos.markPrice > 0)) continue;
    const row = db.prepare('SELECT symbol FROM prices WHERE symbol = ?').get(sym);
    if (row) db.prepare('UPDATE prices SET usd_price = ?, price_date = ? WHERE symbol = ?').run(pos.markPrice, today(), sym);
  }
  // Items tracked in a token (e.g. Lighter LIT staking) need that token's USD price.
  for (const i of pf.items) {
    if (!i.currency || i.currency === 'USD') continue;
    db.prepare('INSERT OR IGNORE INTO prices (symbol, coingecko_id) VALUES (?, ?)').run(i.currency, i.currency === 'LIT' ? 'lighter' : null);
    if (i.impliedPrice > 0) db.prepare('UPDATE prices SET usd_price = ?, price_date = ? WHERE symbol = ? AND usd_price IS NULL').run(i.impliedPrice, today(), i.currency);
  }
  const prices = priceMap();
  const byKey = Object.fromEntries(pf.items.map((i) => [i.key, i]));
  const d = today();
  const updated = [];
  for (const p of linkedPositions(w.id)) {
    if (keyProvider(p.debank_key) !== provider) continue;
    const item = byKey[p.debank_key];
    const px = p.currency === 'USD' ? 1 : prices[p.currency]?.usd_price;
    const native = item?.currency && item.currency === p.currency && item.amount != null;
    if (!item || p.closed || (!px && !native)) continue;
    // Wallet balances: separate tokens arriving/leaving (capital moved) from price moves (profit).
    if (item.protocol === 'Wallet' && p.currency === 'USD' && !pf.mock) {
      const f = walletFlow(prevItems.find((i) => i.key === p.debank_key), item);
      if (f?.significant) {
        addEvent(p.id, { type: f.flow > 0 ? 'deposit' : 'withdrawal', date: d, amount: Math.round(Math.abs(f.flow) * 100) / 100,
          note: f.flow > 0 ? 'Transfer in: tokens arrived (e.g. from a closed pool), not profit' : 'Transfer out: tokens left the wallet, not a loss', source: provider });
      }
    }
    // One synced valuation per day and source: replace today's instead of stacking duplicates.
    db.prepare('DELETE FROM events WHERE position_id = ? AND type = \'valuation\' AND source = ? AND date = ?').run(p.id, provider, d);
    // A token-denominated item (e.g. Lighter LIT staking) tracked in USD: value its live token amount at
    // today's token price. Lighter's USD share price only updates once a day, so using it would mix
    // yesterday's LIT price on this leg with today's price on a hedge's short leg.
    const tokenPx = item.currency && item.amount != null ? prices[item.currency] : null;
    const liveUsd = tokenPx?.usd_price > 0 && tokenPx.price_date === d ? item.amount * tokenPx.usd_price : null;
    const usdValue = liveUsd ?? item.netUsd;
    addEvent(p.id, { type: 'valuation', date: d, amount: native ? item.amount : usdValue / px,
      note: `${src.label} sync ($${usdValue.toFixed(2)}${liveUsd !== null ? ` = ${item.amount.toFixed(4)} ${item.currency} × $${tokenPx.usd_price}` : ''})`, source: provider });
    updated.push(p.id);
  }
  const closed = provider === 'zerion' && !pf.mock ? await closeVanished(w, pf.items, byKey).catch((e) => { console.warn(`close detection failed: ${e.message}`); return []; }) : [];
  let suggested = 0;
  if (provider === 'zerion' && !pf.mock) suggested = await scanActivity(w).catch((e) => { console.warn(`activity scan failed: ${e.message}`); return 0; });
  return { ...forClient(snapshotView(db.prepare('SELECT * FROM debank_snapshots WHERE id = ?').get(id), w.id)), updated, suggested, closed };
}

// A tracked (non-wallet) position the source no longer reports was most likely closed. If the wallet's
// transactions show its tokens paid back, close it at that amount on that date; otherwise ask the user.
async function closeVanished(w, items, byKey) {
  const gone = linkedPositions(w.id).filter((p) => keyProvider(p.debank_key) === 'zerion' && !p.closed && !byKey[p.debank_key] && !p.debank_key.includes('|Wallet|'));
  if (!gone.length) return [];
  const history = db.prepare("SELECT items FROM debank_snapshots WHERE wallet_id = ? AND provider = 'zerion' ORDER BY id DESC LIMIT 200").all(w.id)
    .flatMap((r) => { const m = JSON.parse(r.items); return Array.isArray(m) ? m : m.items; });
  const pools = gone.map((p) => {
    const last = history.find((i) => i.key === p.debank_key);
    const lastVal = db.prepare("SELECT date, amount FROM events WHERE position_id = ? AND type = 'valuation' ORDER BY date DESC, id DESC LIMIT 1").get(p.id);
    return last && lastVal && { id: p.id, protocol: last.protocol, chainId: last.chainId, tokens: last.tokens, name: last.name, lastValue: lastVal.amount, lastDate: lastVal.date };
  }).filter(Boolean);
  if (!pools.length) return [];
  const txs = await fetchZerionTransactions(w.address, { pages: 1, chainIds: [...new Set(pools.map((x) => x.chainId))] });
  const out = [];
  const exits = detectExits(pools, txs); // jointly: one transaction never pays out two pools
  for (const pool of pools) {
    const exit = exits.get(pool.id);
    if (exit) {
      db.exec('BEGIN');
      try {
        addEvent(pool.id, { type: 'valuation', date: exit.date, amount: Math.round(exit.usd * 100) / 100, note: `Exit: withdrawn to wallet (tx ${exit.hashes.map((h) => (h || '').slice(0, 10)).join(', ')}…)`, source: 'zerion' });
        db.prepare('UPDATE positions SET closed = 1, exit_date = ? WHERE id = ?').run(exit.date, pool.id);
        db.prepare("UPDATE suggestions SET status = 'ignored' WHERE position_id = ? AND status = 'pending' AND kind = 'close'").run(pool.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      console.log(`closed position #${pool.id} (${pool.name}) at $${exit.usd.toFixed(2)} on ${exit.date}`);
      out.push({ positionId: pool.id, name: pool.name, exitUsd: exit.usd, date: exit.date, automatic: true });
    } else {
      const r = db.prepare('INSERT OR IGNORE INTO suggestions (position_id, kind, tx_id, date, amount_usd, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pool.id, 'close', `vanished:${pool.lastDate}`, today(), pool.lastValue, JSON.stringify({ tokens: pool.tokens.map((symbol) => ({ symbol })), app: pool.protocol, op: 'no longer reported by Zerion' }));
      if (r.changes) out.push({ positionId: pool.id, name: pool.name, exitUsd: pool.lastValue, suggested: true });
    }
  }
  return out;
}

// One-off repair for wallet positions tracked before transfer detection existed: walk the stored snapshots,
// and record each past transfer (tokens in/out not explained by price) as capital moved, on the day it happened.
function rebuildWalletFlows(position) {
  const snaps = db.prepare("SELECT fetched_at, items FROM debank_snapshots WHERE wallet_id = ? AND provider = 'zerion' ORDER BY id").all(position.wallet_id)
    .map((r) => ({ date: r.fetched_at.slice(0, 10), item: (((m) => (Array.isArray(m) ? m : m.items))(JSON.parse(r.items))).find((i) => i.key === position.debank_key) }))
    .filter((x) => x.item && x.date >= position.entry_date);
  db.prepare("DELETE FROM events WHERE position_id = ? AND type IN ('deposit','withdrawal') AND note LIKE 'Transfer %'").run(position.id);
  const perDay = {};
  for (let k = 1; k < snaps.length; k++) {
    const f = walletFlow(snaps[k - 1].item, snaps[k].item);
    if (f?.significant) perDay[snaps[k].date] = (perDay[snaps[k].date] || 0) + f.flow;
  }
  for (const [date, flow] of Object.entries(perDay)) {
    if (Math.abs(flow) < 0.5) continue;
    addEvent(position.id, { type: flow > 0 ? 'deposit' : 'withdrawal', date, amount: Math.round(Math.abs(flow) * 100) / 100,
      note: flow > 0 ? 'Transfer in: tokens arrived (e.g. from a closed pool), not profit' : 'Transfer out: tokens left the wallet, not a loss', source: 'zerion' });
    // keep that day's valuation after the transfer, so current value = last valuation
    const v = db.prepare("SELECT * FROM events WHERE position_id = ? AND type = 'valuation' AND date = ? ORDER BY id DESC LIMIT 1").get(position.id, date);
    if (v) { db.prepare('DELETE FROM events WHERE id = ?').run(v.id); addEvent(position.id, { type: 'valuation', date, amount: v.amount, note: v.note, source: v.source }); }
  }
  return perDay;
}

app.post('/api/positions/:id/rebuild-transfers', (req, res) => {
  const p = getPosition(req.params.id, req.pid);
  if (!p.debank_key?.includes('|Wallet|')) throw new HttpError(400, 'only wallet-balance positions have transfers to rebuild');
  res.json({ transfers: rebuildWalletFlows(p) });
});

// ---------- activity suggestions (collected fees, deposits) from Zerion transactions ----------
async function scanActivity(w) {
  // Open pools, plus pools closed in the last 30 days (their final fee collection often lands on the closing day).
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const tracked = db.prepare('SELECT id, debank_key, currency, closed, exit_date FROM positions WHERE wallet_id = ? AND debank_key IS NOT NULL').all(w.id)
    .filter((p) => keyProvider(p.debank_key) === 'zerion' && p.currency === 'USD' && (!p.closed || (p.exit_date && p.exit_date >= cutoff)));
  const history = tracked.some((p) => p.closed)
    ? db.prepare("SELECT items FROM debank_snapshots WHERE wallet_id = ? AND provider = 'zerion' ORDER BY id DESC LIMIT 200").all(w.id)
      .flatMap((r) => { const m = JSON.parse(r.items); return Array.isArray(m) ? m : m.items; })
    : [];
  const exitOf = Object.fromEntries(tracked.map((p) => [p.id, p.closed ? p.exit_date : null]));
  const positions = tracked.map((p) => {
    const item = latestSnapshotItem(w.id, p.debank_key) || history.find((i) => i.key === p.debank_key);
    return item && { id: p.id, protocol: item.protocol, chainId: item.chainId, tokens: item.tokens, valueUsd: item.netUsd };
  }).filter(Boolean);
  if (!positions.length) return 0;
  const txs = (await fetchZerionTransactions(w.address, { key: portfolioKey('zerion', w.portfolio_id).key, chainIds: [...new Set(positions.map((p) => p.chainId))] }))
    .filter((t) => !w.track_from || t.date >= w.track_from);
  const ins = db.prepare('INSERT OR IGNORE INTO suggestions (position_id, kind, tx_id, date, amount_usd, detail) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const m of matchTransactions(txs, positions).filter((x) => !exitOf[x.positionId] || x.tx.date <= exitOf[x.positionId])) {
    const detail = { tokens: (m.kind === 'fee' ? m.tx.in : m.tx.out).map((x) => ({ symbol: x.symbol, qty: x.qty, usd: x.usd })), app: m.tx.app, hash: m.tx.hash, op: m.tx.op };
    n += ins.run(m.positionId, m.kind, m.tx.id, m.tx.date, m.usd, JSON.stringify(detail)).changes;
  }
  return n;
}

app.post('/api/wallets/:id/scan-activity', wrap(async (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  if (zerionMode(portfolioKey('zerion', w.portfolio_id).key) !== 'live') throw new HttpError(400, 'Scanning transactions needs a Zerion key for this portfolio (Data sources page).');
  res.json({ suggested: await scanActivity(w) });
}));

app.get('/api/suggestions', (req, res) => {
  const rows = db.prepare(`SELECT s.*, p.protocol, p.chain, p.deposit, p.entry_date, p.comments FROM suggestions s JOIN positions p ON p.id = s.position_id
    WHERE s.status = ? AND p.portfolio_id = ? ${req.query.position ? 'AND s.position_id = ?' : ''} ORDER BY s.date DESC, s.id DESC`)
    .all(...[req.query.status || 'pending', req.pid, ...(req.query.position ? [req.query.position] : [])]);
  res.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
});

// fee → a Reward event on the position. deposit → the position's deposit becomes the total of its confirmed
// deposit transactions and its entry date the earliest of them (replacing the "value on import day" default).
app.post('/api/suggestions/:id/apply', (req, res) => {
  const sg = db.prepare("SELECT * FROM suggestions WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!sg) throw new HttpError(404, 'suggestion not found or already handled');
  getPosition(sg.position_id, req.pid);
  db.exec('BEGIN');
  try {
    if (sg.kind === 'close') {
      // Confirmed close without a matching transaction: exit at the last known value.
      const p = getPosition(sg.position_id);
      const lastVal = db.prepare("SELECT date FROM events WHERE position_id = ? AND type = 'valuation' ORDER BY date DESC, id DESC LIMIT 1").get(p.id);
      const exitDate = lastVal?.date && lastVal.date > sg.date ? lastVal.date : sg.date;
      addEvent(p.id, { type: 'valuation', date: exitDate, amount: Math.round(sg.amount_usd * 100) / 100, note: 'Exit: confirmed closed (no longer reported by the source)', source: 'manual' });
      db.prepare('UPDATE positions SET closed = 1, exit_date = ? WHERE id = ?').run(exitDate, p.id);
      db.prepare("UPDATE suggestions SET status = 'applied' WHERE id = ?").run(sg.id);
    } else if (sg.kind === 'fee') {
      const d = JSON.parse(sg.detail || '{}');
      const eid = addEvent(sg.position_id, { type: 'reward', date: sg.date, amount: Math.round(sg.amount_usd * 100) / 100, note: `Collected fees: ${(d.tokens || []).map((t) => t.symbol).join(' + ')}${d.hash ? ` (tx ${d.hash.slice(0, 10)}…)` : ''}`, source: 'zerion' });
      db.prepare("UPDATE suggestions SET status = 'applied', event_id = ? WHERE id = ?").run(Number(eid), sg.id);
    } else {
      db.prepare("UPDATE suggestions SET status = 'applied' WHERE id = ?").run(sg.id);
      const agg = db.prepare("SELECT SUM(amount_usd) total, MIN(date) first FROM suggestions WHERE position_id = ? AND kind = 'deposit' AND status = 'applied'").get(sg.position_id);
      db.prepare('UPDATE positions SET deposit = ?, entry_date = ? WHERE id = ?').run(Math.round(agg.total * 100) / 100, agg.first, sg.position_id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

app.post('/api/suggestions/:id/ignore', (req, res) => {
  const sg = db.prepare('SELECT position_id FROM suggestions WHERE id = ?').get(req.params.id);
  if (!sg) throw new HttpError(404, 'suggestion not found');
  getPosition(sg.position_id, req.pid);
  db.prepare("UPDATE suggestions SET status = 'ignored' WHERE id = ? AND status = 'pending'").run(req.params.id);
  res.json({ ok: true });
});

// Latest snapshot per wallet and source, reduced to the items not yet tracked as positions.
function untrackedHoldings(pid, walletFilter, providerFilter) {
  const wallets = db.prepare('SELECT id, name FROM wallets WHERE portfolio_id = ?').all(pid);
  const latest = db.prepare('SELECT * FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 1');
  const out = [];
  for (const w of wallets) {
    if (walletFilter === 'none' || (walletFilter && String(w.id) !== String(walletFilter))) continue;
    for (const provider of Object.keys(PROVIDERS)) {
      if (providerFilter && provider !== providerFilter) continue;
      const v = snapshotView(latest.get(w.id, provider), w.id);
      if (!v || v.mock) continue;
      const items = v.items.filter((i) => !i.positionId && i.netUsd > 0);
      if (items.length) out.push({ walletId: w.id, wallet: w.name, provider, fetchedAt: v.fetchedAt, totalUsd: v.totalUsd, untrackedUsd: items.reduce((a, i) => a + i.netUsd, 0), items });
    }
  }
  return out;
}

const positionLabel = (i) => {
  if (i.protocol === 'Wallet') return i.tokens.length === 1 ? `Wallet · ${i.tokens[0]}` : 'Wallet balance';
  if (i.protocolId === 'lighter') return `Lighter · ${i.name.replace('Lighter Liquidity Provider (LLP)', 'LLP').replace(/ #\d+$/, '')}`;
  return i.protocol;
};

// Track every untracked item from the wallet's latest sync(s). Uses the deposit and entry date the source
// reports (Lighter, Extended); otherwise the deposit is today's value, so profit is measured from today.
app.post('/api/wallets/:id/track-all', (req, res) => {
  const w = getWallet(req.params.id, req.pid);
  const holdings = untrackedHoldings(w.portfolio_id, w.id, text(req.query.provider));
  const d = today();
  const ins = db.prepare(`INSERT INTO positions (portfolio_id, wallet_id, strategy, protocol, chain, currency, entry_date, deposit, comments, debank_key)
    VALUES (${w.portfolio_id}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let created = 0;
  const r2 = (x) => Math.round(x * 1e6) / 1e6;
  db.exec('BEGIN');
  try {
    for (const h of holdings) {
      const label = PROVIDERS[h.provider]?.label || h.provider;
      for (const i of h.items) {
        const currency = i.trackUsd ? 'USD' : i.currency || 'USD';
        const livePx = i.currency ? db.prepare('SELECT usd_price, price_date FROM prices WHERE symbol = ?').get(i.currency) : null;
        const liveUsd = i.amount != null && livePx?.usd_price > 0 && livePx.price_date === d ? i.amount * livePx.usd_price : null;
        const value = i.trackUsd ? liveUsd ?? i.netUsd : i.amount ?? i.netUsd; // in the position's currency
        const reportedDeposit = i.depositAmount ?? i.depositUsd;
        const reported = reportedDeposit > 0;
        const deposit = r2(reported ? reportedDeposit : value);
        const entry = reported && i.entryDate ? i.entryDate : d;
        const note = i.rebased === 'price' ? `held before the wallet's start date: valued at $${+i.startPrice.toPrecision(6)} ${i.currency} on ${i.entryDate}`
          : i.rebasedPositions?.length ? `open positions before the start date restated at that day's price (${i.rebasedPositions.map((r) => `${r.market} $${+r.price.toPrecision(6)}`).join(', ')})`
          : reported ? `deposit${i.entryDate ? ' and entry date' : ''} reported by ${label}` : `deposit set to value on ${d} — edit if you know the original deposit`;
        const id = Number(ins.run(w.id, i.strategy, positionLabel(i), i.chain, currency, entry, deposit, `${i.name} · ${i.tokens.join('/')} (imported from ${label}; ${note})`, i.key).lastInsertRowid);
        addEvent(id, { type: 'valuation', date: d, amount: r2(value), note: `${label} sync`, source: h.provider });
        if (currency === 'USD') backfillHistory(id, w.id, i.key, 'USD', d, entry);
        created++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ created });
});

// ---------- exposure & hedges ----------
// Legs come from each open tracked position's latest synced data: token holdings (long) and perps (±).
function exposureLegs(rows) {
  const prices = priceMap();
  const legs = [];
  for (const r of rows) {
    if (r.metrics.status !== 'Open' || !r.debank_key || !r.wallet_id) continue;
    const raw = latestSnapshotItem(r.wallet_id, r.debank_key);
    if (!raw) continue;
    const item = raw.flows ? accountSince(raw, r.entry_date, historicalPrices(r.entry_date)) : raw;
    const venue = item.protocol === 'Wallet' ? `Wallet (${r.chain})` : item.protocol || sourceLabel(r.debank_key);
    const holds = (item.exposure || []).filter((e) => e.qty);
    const perps = item.positions || [];
    const pure = holds.length === 1 && !perps.length; // the position is exposure to this one asset only
    for (const e of holds) {
      const single = pure && item.netUsd > 0 ? item.netUsd / e.qty : null;
      legs.push({ positionId: r.id, label: r.protocol, venue, chain: r.chain, symbol: e.symbol, qty: e.qty, kind: 'hold',
        priceUsd: e.priceUsd || prices[underlying(e.symbol)]?.usd_price || prices[e.symbol]?.usd_price || single, pure, pnlUsd: pure ? r.metrics.pnlUsd : null, valueUsd: r.metrics.valueUsd });
    }
    for (const p of perps) {
      legs.push({ positionId: r.id, label: `${p.market} ${String(p.side).toLowerCase()}`, venue, chain: r.chain, symbol: p.market.split('-')[0],
        qty: String(p.side).toUpperCase() === 'SHORT' ? -p.size : p.size, kind: 'perp', priceUsd: p.markPrice, perp: p });
    }
  }
  return legs;
}
const sourceLabel = (key) => PROVIDERS[keyProvider(key)]?.label || '';

function hedgeReport(rows) {
  const exposure = computeExposure(exposureLegs(rows));
  const hedges = detectHedges(exposure).map((h) => {
    const allPure = h.longs.every((l) => l.pure && l.pnlUsd !== null);
    const longPnl = allPure ? h.longs.reduce((a, l) => a + l.pnlUsd, 0) : null;
    return { ...h, longPnl, combinedPnl: longPnl === null ? null : longPnl + h.perpPnl + h.perpCarry };
  });
  return { exposure: exposure.map(({ legs, ...a }) => ({ ...a, legs: legs.map(({ perp, ...l }) => l) })), hedges };
}

app.get('/api/hedges', (req, res) => res.json(hedgeReport(loadPositions(req.pid))));

app.post('/api/wallets/:id/sync', wrap(async (req, res) => res.json(await syncWallet(getWallet(req.params.id, req.pid).id, req.query.provider || req.body?.provider))));
app.post('/api/wallets/:id/debank-sync', wrap(async (req, res) => res.json(await syncWallet(getWallet(req.params.id, req.pid).id, 'debank'))));

// ---------- prices ----------
app.get('/api/prices', (_req, res) => res.json(db.prepare('SELECT * FROM prices ORDER BY rowid').all()));

app.post('/api/prices', (req, res) => {
  const symbol = text(req.body.symbol);
  if (!symbol) throw new HttpError(400, 'symbol is required');
  db.prepare('INSERT OR IGNORE INTO prices (symbol, coingecko_id) VALUES (?, ?)').run(symbol, text(req.body.coingecko_id));
  res.status(201).json({ ok: true });
});

app.put('/api/prices/:symbol', (req, res) => {
  const price = num(req.body.usd_price);
  if (price !== null && !(price > 0)) throw new HttpError(400, 'price must be positive');
  const date = text(req.body.price_date) || (price !== null ? today() : null);
  db.prepare('UPDATE prices SET usd_price = ?, price_date = ?, coingecko_id = ? WHERE symbol = ?')
    .run(price, date, text(req.body.coingecko_id), req.params.symbol);
  res.json({ ok: true });
});

app.delete('/api/prices/:symbol', (req, res) => {
  db.prepare('DELETE FROM prices WHERE symbol = ?').run(req.params.symbol);
  res.json({ ok: true });
});

async function refreshPrices() {
  const rows = db.prepare('SELECT * FROM prices').all();
  const ids = [...new Set(rows.map((r) => r.coingecko_id).filter(Boolean))];
  const { data, eurUsd } = await fetchCoingeckoPrices(ids);
  const d = today();
  const upd = db.prepare('UPDATE prices SET usd_price = ?, price_date = ? WHERE symbol = ?');
  let n = 0;
  for (const r of rows) {
    const p = r.symbol === 'USD' ? 1 : r.symbol === 'EUR' ? eurUsd : data[r.coingecko_id]?.usd;
    if (p > 0) { upd.run(p, d, r.symbol); n++; }
  }
  return { updated: n, total: rows.length };
}
app.post('/api/prices/refresh', wrap(async (_req, res) => res.json(await refreshPrices())));

// ---------- settings: API keys ----------
// Routes for keys kept in .env (see server/settings.js); the key lookup itself is in "API keys" above.
// Changing keys is limited to this computer unless APP_PASSWORD protects the app.
const isLocalHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.get('host') || '');
const settingsWriteGuard = (req) => {
  if (!process.env.APP_PASSWORD && !isLocalHost(req)) throw new HttpError(403, 'Set APP_PASSWORD before changing API keys over the network.');
};
const sourceOrThrow = (id) => { const s = KEYED_SOURCES[id]; if (!s) throw new HttpError(404, 'unknown data source'); return s; };

const dexList = () => Object.entries(DEXES).map(([id, d]) => ({ id, label: d.label, auth: d.auth, kinds: d.kinds, url: d.url, what: d.what, keyHelp: d.keyHelp || null, beta: !!d.beta, available: d.available !== false }));

// What the last sync of a DEX account found.
function dexAccountStatus(w, id) {
  const s = db.prepare('SELECT fetched_at, total_usd, items FROM debank_snapshots WHERE wallet_id = ? AND provider = ? ORDER BY id DESC LIMIT 1').get(w.id, id);
  if (!s) return { synced: false };
  const m = JSON.parse(s.items);
  return { synced: true, found: (Array.isArray(m) ? m : m.items).length > 0, totalUsd: s.total_usd, fetchedAt: s.fetched_at };
}

// What a request's key belongs to: the active portfolio, or (exchange accounts) one of its wallets (?wallet=).
function keyTarget(req) {
  const src = sourceOrThrow(req.params.id);
  if (src.scope === 'wallet') {
    const wid = Number(req.query.wallet ?? req.body?.wallet);
    if (!wid) throw new HttpError(400, `${src.label} accounts are linked to a wallet: choose one`);
    const w = getWallet(wid, req.pid);
    if (!src.kinds.includes(w.kind)) throw new HttpError(400, `${src.label} accounts can only be linked to EVM wallets`);
    return { src, table: 'wallets', row: w, current: walletKey(req.params.id, w) };
  }
  return { src, table: 'portfolios', row: db.prepare('SELECT * FROM portfolios WHERE id = ?').get(req.pid), current: portfolioKey(req.params.id, req.pid) };
}
const keyView = (id, k, mode) => ({ configured: !!k.key, masked: maskKey(k.key), mode, from: k.from, legacyEnv: k.from === 'legacy' ? KEYED_SOURCES[id].env : null });

app.get('/api/settings', (req, res) => {
  const file = envFileStatus(ENV_FILE);
  const wallets = db.prepare("SELECT * FROM wallets WHERE portfolio_id = ? ORDER BY name").all(req.pid);
  res.json({
    portfolio: portfolioRows().find((p) => p.id === req.pid),
    envFile: { ...file, path: process.env.ENV_FILE ? ENV_FILE : '.env' },
    sources: portfolioSourceIds.map((id) => {
      const s = KEYED_SOURCES[id], k = portfolioKey(id, req.pid);
      return { id, label: s.label, url: s.url, what: s.what, scope: s.scope, ...keyView(id, k, PROVIDERS[id].mode(k.key)) };
    }),
    dexes: dexList(),
    wallets: wallets.map((w) => ({ id: w.id, name: w.name, address: w.address, kind: w.kind,
      exchanges: Object.fromEntries(Object.entries(walletExchanges(w)).map(([id, x]) => [id, { ...x, account: dexAccountStatus(w, id) }])) })),
    lighter: lighterMode(),
  });
});

// Save a key: validate → test it against the provider (unless test=false) → write .env → apply now.
app.put('/api/settings/:id', wrap(async (req, res) => {
  settingsWriteGuard(req);
  const t = keyTarget(req);
  const v = validateKey(req.body?.key);
  if (!v.ok) throw new HttpError(400, v.error);
  if (req.body?.test !== false) {
    const r = await testProviderKey(req.params.id, v.key);
    if (!r.ok) throw new HttpError(400, `${r.message}. The key was not saved.`);
  }
  const { saved, reason } = storeKey(req.params.id, t, v.key);
  res.json({ ok: true, masked: maskKey(v.key), saved, mode: PROVIDERS[req.params.id].mode(v.key),
    warning: saved ? null : `Applied until the app restarts, but not saved: ${reason}. Add it to .env by hand to keep it.` });
}));

app.delete('/api/settings/:id', (req, res) => {
  settingsWriteGuard(req);
  const t = keyTarget(req);
  if (!t.current.key) throw new HttpError(404, `No ${t.src.label} key is set here`);
  const saved = forgetKey(req.params.id, t);
  res.json({ ok: true, saved });
});

app.post('/api/settings/:id/test', wrap(async (req, res) => {
  const t = keyTarget(req);
  if (!t.current.key) throw new HttpError(400, `No ${t.src.label} key is set here`);
  res.json(await testProviderKey(req.params.id, t.current.key));
}));

// Add a DEX account to a wallet ("Add DEX account"): a key DEX tests and stores the key; an address DEX is
// looked up once so you know straight away whether an account exists at that address.
app.post('/api/wallets/:id/dex', wrap(async (req, res) => {
  settingsWriteGuard(req);
  const w = getWallet(req.params.id, req.pid);
  const id = String(req.body?.dex || '');
  const d = DEXES[id];
  if (!d) throw new HttpError(404, 'unknown DEX');
  if (d.available === false) throw new HttpError(400, `${d.label} can’t be connected yet: ${d.what}.`);
  if (!d.kinds.includes(w.kind)) throw new HttpError(400, `${d.label} accounts can only be added to ${d.kinds.map((k) => k.toUpperCase()).join(' / ')} wallets`);
  if (d.auth === 'key') {
    const v = validateKey(req.body?.key);
    if (!v.ok) throw new HttpError(400, v.error);
    if (req.body?.test !== false) {
      const r = await testProviderKey(id, v.key);
      if (!r.ok) throw new HttpError(400, `${r.message}. The key was not saved.`);
    }
    const { saved, reason } = storeKey(id, { src: KEYED_SOURCES[id], table: 'wallets', row: w, current: walletKey(id, w) }, v.key);
    db.prepare('INSERT OR IGNORE INTO dex_accounts (wallet_id, dex) VALUES (?, ?)').run(w.id, id);
    return res.json({ ok: true, dex: id, masked: maskKey(v.key), saved, warning: saved ? null : `Applied until the app restarts, but not saved: ${reason}. Add it to .env by hand to keep it.` });
  }
  db.prepare('INSERT OR IGNORE INTO dex_accounts (wallet_id, dex) VALUES (?, ?)').run(w.id, id);
  let found = null;
  if (req.body?.test !== false && PROVIDERS[id].mode(null) !== 'off') {
    try { found = (await PROVIDERS[id].fetch(w, null)).items.length > 0; } catch (e) { console.warn(`${d.label} lookup failed: ${e.message}`); }
  }
  res.json({ ok: true, dex: id, found });
}));

// Remove a DEX account from a wallet. Positions already tracked from it are kept; they just stop updating.
app.delete('/api/wallets/:id/dex/:dex', (req, res) => {
  settingsWriteGuard(req);
  const w = getWallet(req.params.id, req.pid);
  const d = DEXES[req.params.dex];
  if (!d || !dexLinked(req.params.dex, w)) throw new HttpError(404, 'that DEX account is not linked to this wallet');
  if (d.auth === 'key') forgetKey(req.params.dex, { src: KEYED_SOURCES[req.params.dex], table: 'wallets', row: w, current: walletKey(req.params.dex, w) });
  db.prepare('DELETE FROM dex_accounts WHERE wallet_id = ? AND dex = ?').run(w.id, req.params.dex);
  res.json({ ok: true });
});

// ---------- backup ----------
// Full backup of every portfolio (version 2 adds portfolios and correction history; version 1 files still import).
app.get('/api/export', (_req, res) => {
  res.set('Content-Disposition', `attachment; filename="defi-tracker-${today()}.json"`);
  res.json({
    version: 2,
    exportedAt: new Date().toISOString(),
    portfolios: db.prepare('SELECT * FROM portfolios').all(),
    event_revisions: db.prepare('SELECT * FROM event_revisions').all(),
    dex_accounts: db.prepare('SELECT * FROM dex_accounts').all(),
    wallets: db.prepare('SELECT * FROM wallets').all(),
    positions: db.prepare('SELECT * FROM positions').all(),
    events: db.prepare('SELECT * FROM events').all(),
    prices: db.prepare('SELECT * FROM prices').all(),
  });
});

const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
app.get('/api/export.csv', (req, res) => {
  const cols = ['Wallet', 'Strategy', 'Protocol', 'Chain', 'Currency', 'Entry Date', 'Exit Date', 'Valuation Date', 'Deposit', 'Current Value', 'Distributed Rewards', 'Additional Fees', 'Expected Annual Return', 'Profit / Loss', 'Total Return', 'Annualized Return', 'Duration (Days)', 'Status', 'Comments', 'USD Price', 'Profit / Loss USD', 'USD Price Date', 'Withdrawal'];
  const lines = [cols.join(',')];
  for (const p of loadPositions(req.pid)) {
    const m = p.metrics;
    lines.push([p.wallet, p.strategy, p.protocol, p.chain, p.currency, p.entry_date, p.exit_date, m.valuationDate, p.deposit, m.currentValue, m.rewards, m.fees, p.expected_return, m.pnl, m.totalReturn, m.annualized, m.duration, m.status, p.comments, m.usdPrice, m.pnlUsd, m.usdPriceDate, m.withdrawals].map(csvCell).join(','));
  }
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="defi-positions-${today()}.csv"`).send(lines.join('\n'));
});

app.post('/api/import', (req, res) => {
  const b = req.body;
  if (![1, 2].includes(b?.version) || !Array.isArray(b.positions)) throw new HttpError(400, 'not a BitBlock DeFi Tracker export file');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM dex_accounts; DELETE FROM suggestions; DELETE FROM event_revisions; DELETE FROM events; DELETE FROM positions; DELETE FROM debank_snapshots; DELETE FROM wallets; DELETE FROM portfolios;');
    const ins = (table, rows) => {
      const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const r of rows || []) {
        const keys = Object.keys(r).filter((k) => allowed.has(k));
        db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
      }
    };
    // Version 1 backups predate portfolios: everything goes into one "Main portfolio".
    ins('portfolios', b.portfolios?.length ? b.portfolios : [{ id: 1, name: 'Main portfolio' }]);
    const pid1 = db.prepare('SELECT MIN(id) id FROM portfolios').get().id;
    ins('wallets', (b.wallets || []).map((w) => ({ portfolio_id: pid1, ...w })));
    ins('positions', (b.positions || []).map((x) => ({ portfolio_id: (b.wallets || []).find((w) => w.id === x.wallet_id)?.portfolio_id ?? pid1, ...x })));
    ins('events', b.events); ins('prices', b.prices); ins('event_revisions', b.event_revisions); ins('dex_accounts', b.dex_accounts);
    // Backups from before DEX accounts were opt-in: keep Lighter on wallets that track Lighter positions.
    if (!b.dex_accounts) db.exec("INSERT OR IGNORE INTO dex_accounts (wallet_id, dex) SELECT DISTINCT p.wallet_id, 'lighter' FROM positions p JOIN wallets w ON w.id = p.wallet_id WHERE p.debank_key LIKE 'lighter|%'");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw new HttpError(400, `import failed: ${e.message}`); }
  res.json({ ok: true, positions: b.positions.length });
});

// Background sync so every tracked position gets a fresh valuation (a new chart point) without clicking.
// "Sync all" from the UI syncs the current portfolio's wallets only; the background sync covers every
// portfolio. Each wallet sync writes only to that wallet's own positions, snapshots and suggestions, so one
// portfolio's sync never changes another's records. (Market prices are shared: one LIT price for everyone.)
const syncing = new Map();
async function syncAll(trigger = 'auto', pid = null) {
  const results = [];
  const wallets = db.prepare(`SELECT * FROM wallets WHERE address IS NOT NULL AND kind != 'manual' ${pid ? 'AND portfolio_id = ?' : ''}`).all(...(pid ? [pid] : []));
  for (const w of wallets) {
    for (const [id, src] of Object.entries(PROVIDERS)) {
      if (!src.kinds.includes(w.kind) || providerMode(id, w) === 'off') continue;
      try {
        const r = await syncWallet(w.id, id);
        results.push({ wallet: w.name, source: src.label, ok: true, items: r.items.length, updated: r.updated.length, suggested: r.suggested || 0, closedList: r.closed || [] });
        console.log(`${trigger}-sync ${w.name} via ${src.label}: ${r.items.length} item(s), ${r.updated.length} updated`);
      } catch (e) {
        results.push({ wallet: w.name, source: src.label, ok: false, error: e.message });
        console.warn(`${trigger}-sync ${w.name} via ${src.label} failed: ${e.message}`);
      }
    }
  }
  const at = new Date().toISOString();
  for (const id of pid ? [pid] : portfolioRows().map((p) => p.id)) lastSyncAt.set(id, at);
  return results;
}
const lastSyncAt = new Map();
// One sync per portfolio at a time; a second click while one is running waits for the same run.
const runSync = (trigger, pid = null) => {
  const k = pid ?? 'all';
  if (!syncing.has(k)) syncing.set(k, syncAll(trigger, pid).finally(() => syncing.delete(k)));
  return syncing.get(k);
};
const autoSync = async () => { await refreshPrices().catch((e) => console.warn(`price refresh failed: ${e.message}`)); return runSync('auto'); };

app.post('/api/sync-all', wrap(async (req, res) => {
  const prices = await refreshPrices().catch(() => null);
  const results = await runSync('manual', req.pid);
  res.json({ results, prices, lastSyncAt: lastSyncAt.get(req.pid) ?? null, portfolio: req.pid });
}));
app.get('/api/sync-status', (req, res) => res.json({ lastSyncAt: lastSyncAt.get(req.pid) ?? null, running: syncing.has(req.pid) || syncing.has('all') }));
if (AUTO_SYNC_HOURS > 0) {
  setTimeout(autoSync, 60_000);
  setInterval(autoSync, AUTO_SYNC_HOURS * 3_600_000);
}

// ---------- errors ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, () => {
  const pids = portfolioRows().map((p) => p.id);
  const keyed = (id) => pids.filter((pid) => portfolioKey(id, pid).key).length;
  const exchanges = db.prepare("SELECT * FROM wallets WHERE kind = 'evm'").all().filter((w) => walletKey('extended', w).key).length;
  console.log(`BitBlock DeFi Tracker is running: open http://localhost:${process.env.PUBLIC_PORT || PORT} (portfolios with a key: Zerion ${keyed('zerion')}/${pids.length}, DeBank ${keyed('debank')}/${pids.length}; Extended accounts linked: ${exchanges}; Lighter: ${lighterMode()}; auto-sync: ${AUTO_SYNC_HOURS ? `every ${AUTO_SYNC_HOURS}h` : 'off'})`);
});
