// DEX account connectors added through "Add DEX account" (Lighter and Extended live in integrations.js).
// Each fetch* returns { totalUsd, items } like the other sources. The pure *Item functions build the items from
// API payloads, so they're tested without the network.
//
// Exchange accounts report P/L as parts that add up (see extendedItem): open positions' unrealised P/L, closed
// trades / fees / funding by day (so a "start tracking from" date can drop the earlier ones), and a remainder
// for anything the API doesn't itemise. capital = net USD moved into the account (flows).

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Group realised amounts by market and day: [{ market, realisedPnl, closedAt }].
function byMarketDay(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.usd) continue;
    const k = `${r.market}|${r.day}`;
    m.set(k, (m.get(k) || 0) + r.usd);
  }
  return [...m].map(([k, usd]) => { const [market, closedAt] = k.split('|'); return { market, realisedPnl: usd, closedAt }; });
}

// Common shape of an exchange account item; `parts` = unrealised P/L per open position.
// historyFrom: the first day the exchange's trade history reaches back to, when it doesn't cover the whole
// account (Hyperliquid keeps only the latest 10,000 fills). P/L that can't be itemised is then dated the day
// before, as "earlier trades", so a later start-tracking date excludes it like any other earlier trade.
function accountItem({ key, protocol, protocolId, siteUrl, chainId, chain, name, value, flows, closedTrades, positions, extraParts = [], historyFrom = null }) {
  const capital = flows.reduce((a, f) => a + f.usd, 0);
  const pnl = value - capital;
  if (historyFrom) {
    const known = closedTrades.reduce((a, t) => a + t.realisedPnl, 0) + positions.reduce((a, p) => a + (p.uPnl || 0), 0) + extraParts.reduce((a, b) => a + b.usd, 0);
    const earlier = pnl - known;
    if (Math.abs(earlier) >= 0.01) closedTrades = [...closedTrades, { market: 'Earlier trades', realisedPnl: earlier, closedAt: isoDay(Date.parse(historyFrom) - 86400000) }];
  }
  const closedUsd = closedTrades.reduce((a, t) => a + t.realisedPnl, 0);
  const breakdown = [
    ...positions.map((p) => ({ label: `${p.market} ${String(p.side).toLowerCase()}: price move (unrealised)`, usd: p.uPnl || 0, market: p.market, kind: 'upnl' })),
    ...(closedTrades.length ? [{ label: `Trades, fees & funding (${[...new Set(closedTrades.map((t) => t.market))].join(', ')})`, usd: closedUsd, kind: 'closed' }] : []),
    ...extraParts,
  ];
  const itemised = breakdown.reduce((a, b) => a + b.usd, 0);
  if (Math.abs(pnl - itemised) >= 0.01) breakdown.push({ label: 'Other (not itemised by the exchange)', usd: pnl - itemised, kind: 'other' });
  const parts = breakdown.reduce((a, b) => a + b.usd, 0);
  const firstIn = flows.filter((f) => f.usd > 0).map((f) => f.date).sort()[0] || null;
  return {
    key, protocol, protocolId, siteUrl, chainId, chain, name, detailTypes: ['perpetuals'], strategy: 'Exposure',
    netUsd: value, assetUsd: value, debtUsd: 0, valueUsd: value,
    tokens: positions.length ? positions.map((p) => `${p.market} ${String(p.side).toLowerCase()}`) : ['USD'],
    depositUsd: capital > 0 ? Math.round(capital * 100) / 100 : null, entryDate: firstIn,
    flows, closedTrades, spotCost: 0, positions, breakdown,
    reconcile: { pnl, parts, diff: parts - pnl, ok: Math.abs(parts - pnl) < 0.5 },
    updatedAt: new Date().toISOString(),
  };
}

// ---------- Hyperliquid (public info API, by address) ----------
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
const HL_URL = process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz/info';

async function hlInfo(body, attempt = 0) {
  const res = await fetch(HL_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 429 && attempt < 2) { await sleep(5000 * (attempt + 1)); return hlInfo(body, attempt + 1); }
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} → HTTP ${res.status}`);
  return res.json();
}

// Time-ranged calls return a capped page (oldest first): continue from the last timestamp.
async function hlAll(type, user, startTime = 0, maxPages = 20) {
  const out = [];
  let t = startTime;
  for (let i = 0; i < maxPages; i++) {
    const page = await hlInfo({ type, user, startTime: t });
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    const last = page.at(-1).time;
    if (last + 1 <= t || page.length < 500) break;
    t = last + 1;
  }
  return out;
}

// USD moved in (+) or out (−) of the trading account. Vault deposits leave it (into a vault item).
export function hyperliquidFlows(ledger, address) {
  const me = address.toLowerCase();
  const flows = [];
  const vaults = {};
  const add = (time, usd, type) => { if (usd) flows.push({ date: isoDay(time), usd, type }); };
  for (const { time, delta: d } of ledger || []) {
    const incoming = String(d.destination || '').toLowerCase() === me;
    // Moving your own funds between spot and perps is logged as a send from you to yourself: not a flow.
    if (incoming && String(d.user || '').toLowerCase() === me) continue;
    switch (d.type) {
      case 'deposit': add(time, num(d.usdc), 'DEPOSIT'); break;
      case 'withdraw': add(time, -num(d.usdc), 'WITHDRAWAL'); break;
      case 'internalTransfer': case 'subAccountTransfer': add(time, incoming ? num(d.usdc) : -num(d.usdc), 'TRANSFER'); break;
      case 'spotTransfer': case 'send': add(time, (incoming ? 1 : -1) * num(d.usdcValue ?? d.usdc), 'TRANSFER'); break;
      case 'vaultDeposit': case 'vaultCreate':
        add(time, -num(d.usdc), 'VAULT_DEPOSIT');
        (vaults[String(d.vault).toLowerCase()] ??= []).push({ date: isoDay(time), usd: num(d.usdc) });
        break;
      case 'vaultWithdraw': {
        const usd = num(d.netWithdrawnUsd ?? d.requestedUsd);
        add(time, usd, 'VAULT_WITHDRAWAL');
        (vaults[String(d.vault).toLowerCase()] ??= []).push({ date: isoDay(time), usd: -usd });
        break;
      }
      default: break; // accountClassTransfer (perps ↔ spot) stays inside the account; liquidations aren't flows
    }
  }
  return { flows, vaults };
}

// USD price of each spot token (by token index) from its USDC pair; ctx rows carry the pair name in `coin`.
export function hyperliquidSpotPrices(spotMeta) {
  const [meta, ctxs] = spotMeta || [];
  const ctxByCoin = Object.fromEntries((ctxs || []).map((c) => [c.coin, c]));
  const out = { 0: 1 }; // USDC
  for (const u of meta?.universe || []) {
    if (u.tokens?.[1] !== 0) continue;
    const c = ctxByCoin[u.name];
    const px = num(c?.midPx) || num(c?.markPx);
    if (px > 0) out[u.tokens[0]] = px;
  }
  const hype = (meta?.tokens || []).find((t) => t.name === 'HYPE');
  return { byToken: out, hype: hype ? out[hype.index] ?? null : null };
}

export function hyperliquidItems({ address, state, spot, mids = {}, spotPrices = { byToken: { 0: 1 }, hype: null }, staking = null, ledger = [], fills = [], funding = [], vaultEquities = [], vaultNames = {} }) {
  const { flows, vaults } = hyperliquidFlows(ledger, address);
  // When each open position was opened: its last fill that started from a flat position.
  const openedAt = {};
  for (const f of fills) if (num(f.startPosition) === 0) openedAt[f.coin] = isoDay(f.time);
  const markOf = (coin, p) => num(mids[coin]) || (num(p.szi) ? num(p.positionValue) / Math.abs(num(p.szi)) : null);
  const positions = (state?.assetPositions || []).map(({ position: p }) => ({
    market: `${p.coin}-USD`, side: num(p.szi) > 0 ? 'LONG' : 'SHORT', size: Math.abs(num(p.szi)), valueUsd: num(p.positionValue),
    entryPrice: num(p.entryPx), markPrice: markOf(p.coin, p), liquidationPrice: p.liquidationPx ? num(p.liquidationPx) : null,
    leverage: num(p.leverage?.value), uPnl: num(p.unrealizedPnl), realisedPnl: null, funding: null, openedAt: openedAt[p.coin] || null,
  }));
  // Only the latest 10,000 fills are served: if the oldest one we got is well after the account's first
  // ledger entry and we hit a full page, the trade history doesn't reach back to the start.
  const firstFill = fills.length ? fills[0].time : null;
  const historyFrom = fills.length >= 2000 && ledger.length && firstFill > ledger[0].time + 86400000 ? isoDay(firstFill) : null;
  const closedTrades = byMarketDay([
    ...fills.map((f) => ({ market: `${f.coin}-USD`, day: isoDay(f.time), usd: num(f.closedPnl) - (f.feeToken && f.feeToken !== 'USDC' ? 0 : num(f.fee)) })),
    ...funding.map((x) => ({ market: `${x.delta.coin}-USD`, day: isoDay(x.time), usd: num(x.delta.usdc) })),
  ]);
  // Spot tokens at their spot price (falling back to the perp mid), plus staked HYPE (moved out of spot by
  // cStakingTransfer, which isn't a flow: it stays the user's).
  const balances = (spot?.balances || []).filter((b) => num(b.total) > 0);
  const priceOf = (b) => (b.coin === 'USDC' ? 1 : spotPrices.byToken[b.token] ?? num(mids[b.coin]));
  const spotUsd = balances.reduce((a, b) => a + num(b.total) * priceOf(b), 0);
  const nonUsdc = balances.filter((b) => b.coin !== 'USDC');
  const stakedHype = staking ? num(staking.delegated) + num(staking.undelegated) + num(staking.totalPendingWithdrawal) : 0;
  const hypePx = spotPrices.hype ?? num(mids.HYPE);
  const stakedUsd = stakedHype * hypePx;
  const value = num(state?.marginSummary?.accountValue) + spotUsd + stakedUsd;
  const items = [];
  if (value >= 0.01 || positions.length || flows.length) {
    items.push({
      ...accountItem({ key: 'hyperliquid|account', protocol: 'Hyperliquid', protocolId: 'hyperliquid', siteUrl: 'https://app.hyperliquid.xyz',
        chainId: 'hyperliquid', chain: 'Hyperliquid', name: 'Perps & spot account', value, flows, closedTrades, positions, historyFrom }),
      historyFrom,
      spot: [...nonUsdc.map((b) => ({ symbol: b.coin, qty: num(b.total), valueUsd: num(b.total) * priceOf(b), costUsd: num(b.entryNtl) })),
        ...(stakedHype ? [{ symbol: 'HYPE (staked)', qty: stakedHype, valueUsd: stakedUsd, costUsd: null }] : [])],
      cashUsd: balances.filter((b) => b.coin === 'USDC').reduce((a, b) => a + num(b.total), 0),
    });
  }
  // Vault deposits (e.g. HLP): their own positions, deposit = net USD put in.
  for (const v of vaultEquities || []) {
    const addr = String(v.vaultAddress).toLowerCase();
    const moves = vaults[addr] || [];
    const deposit = moves.reduce((a, m) => a + m.usd, 0);
    items.push({
      key: `hyperliquid|vault|${addr}`, protocol: 'Hyperliquid', protocolId: 'hyperliquid', siteUrl: `https://app.hyperliquid.xyz/vaults/${addr}`,
      chainId: 'hyperliquid', chain: 'Hyperliquid', name: vaultNames[addr] || 'Vault', detailTypes: ['vault'], strategy: 'Vault',
      netUsd: num(v.equity), assetUsd: num(v.equity), debtUsd: 0, tokens: ['USDC'],
      depositUsd: deposit > 0 ? Math.round(deposit * 100) / 100 : null, entryDate: moves.find((m) => m.usd > 0)?.date || null, history: [],
      updatedAt: new Date().toISOString(),
    });
  }
  return items.sort((a, b) => b.netUsd - a.netUsd);
}

export async function fetchHyperliquidPortfolio(address) {
  const user = address.toLowerCase();
  const state = await hlInfo({ type: 'clearinghouseState', user });
  const spot = await hlInfo({ type: 'spotClearinghouseState', user });
  const vaultEquities = await hlInfo({ type: 'userVaultEquities', user }).catch(() => []);
  const ledger = await hlAll('userNonFundingLedgerUpdates', user);
  if (!ledger.length && !num(state?.marginSummary?.accountValue) && !(spot?.balances || []).some((b) => num(b.total) > 0) && !vaultEquities.length) return { totalUsd: 0, items: [] };
  const mids = await hlInfo({ type: 'allMids' });
  const spotPrices = hyperliquidSpotPrices(await hlInfo({ type: 'spotMetaAndAssetCtxs' }));
  const staking = await hlInfo({ type: 'delegatorSummary', user }).catch(() => null);
  const start = ledger[0]?.time ?? 0;
  const fills = await hlAll('userFillsByTime', user, start, 5);
  const funding = await hlAll('userFunding', user, start, 20);
  const vaultNames = {};
  for (const v of vaultEquities) {
    const d = await hlInfo({ type: 'vaultDetails', vaultAddress: v.vaultAddress }).catch(() => null);
    if (d?.name) vaultNames[String(v.vaultAddress).toLowerCase()] = d.name;
  }
  const items = hyperliquidItems({ address: user, state, spot, mids, spotPrices, staking, ledger, fills, funding, vaultEquities, vaultNames });
  return { totalUsd: items.reduce((a, i) => a + i.netUsd, 0), items };
}

// ---------- GMX v2 (public API, by address) ----------
// https://docs.gmx.io/docs/api/gmx-api/get-positions-info/ — USD amounts and prices are scaled by 1e30.
// GMX positions are funded straight from the wallet: each open position is its own item, deposit = its collateral.
// (GM / GLV pool tokens are plain wallet tokens: Zerion and DeBank show them.)
const GMX_CHAINS = { arbitrum: { url: 'https://arbitrum.gmxapi.io/v1', chain: 'Arbitrum' }, avalanche: { url: 'https://avalanche.gmxapi.io/v1', chain: 'Avalanche' } };
const e30 = (v) => Number(BigInt(String(v ?? 0).split('.')[0]) / 10n ** 18n) / 1e12;

export function gmxItems(chainId, positions) {
  const c = GMX_CHAINS[chainId];
  return (positions || []).filter((p) => e30(p.sizeInUsd) > 0).map((p) => {
    const market = `${String(p.indexName || '?').split('/')[0]}-USD`;
    const side = p.isLong ? 'LONG' : 'SHORT';
    const mark = e30(p.markPrice);
    const entry = e30(p.entryPrice);
    const net = e30(p.netValue);
    const collateral = e30(p.collateralUsd);
    return {
      key: `gmx|${chainId}|${p.key}`, protocol: 'GMX', protocolId: 'gmx', siteUrl: 'https://app.gmx.io', chainId, chain: c.chain,
      name: `${p.indexName}${p.poolName ? ` [${p.poolName}]` : ''} ${side.toLowerCase()}`, detailTypes: ['perpetuals'], strategy: 'Exposure',
      netUsd: net, assetUsd: net, debtUsd: 0, tokens: [`${market} ${side.toLowerCase()}`],
      depositUsd: collateral > 0 ? Math.round(collateral * 100) / 100 : null,
      entryDate: p.increasedAtTime ? isoDay(Number(p.increasedAtTime) * 1000) : null,
      positions: [{ market, side, size: entry ? e30(p.sizeInUsd) / entry : null, valueUsd: e30(p.sizeInUsd), entryPrice: entry, markPrice: mark,
        liquidationPrice: e30(p.liquidationPrice) || null, leverage: num(p.leverage) / 10000, uPnl: e30(p.pnlAfterFees), realisedPnl: null, funding: null,
        openedAt: p.increasedAtTime ? isoDay(Number(p.increasedAtTime) * 1000) : null }],
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function fetchGmxPortfolio(address) {
  const items = [];
  for (const [id, c] of Object.entries(GMX_CHAINS)) {
    const res = await fetch(`${c.url}/positions?address=${address}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GMX ${c.chain} positions → HTTP ${res.status}`);
    const body = await res.json();
    items.push(...gmxItems(id, Array.isArray(body) ? body : body.positions || body.data || []));
  }
  return { totalUsd: items.reduce((a, i) => a + i.netUsd, 0), items };
}

// ---------- Bulk (Solana perps, public API, by Solana address) ----------
// https://docs.bulk.trade/api-reference/getAccount — history timestamps are nanoseconds.
const BULK_URL = process.env.BULK_API_URL || 'https://mainnet-api1.bulk.trade/api/v1';

async function bulkAccount(body) {
  const res = await fetch(`${BULK_URL}/account`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 404) return null; // ACCOUNT_NOT_FOUND
  if (res.status === 429) throw Object.assign(new Error('Bulk rate limit reached — wait a minute and sync again.'), { status: 429 });
  if (!res.ok) throw new Error(`Bulk ${body.type} → HTTP ${res.status}`);
  return res.json();
}

async function bulkAll(type, user, maxPages = 10) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const r = await bulkAccount({ type, user, limit: 1000, ...(cursor ? { cursor } : {}) });
    const rows = Array.isArray(r) ? r : r?.data || [];
    out.push(...rows);
    cursor = r?.page?.nextCursor;
    if (!r?.page?.hasMore || !cursor) break;
  }
  return out;
}

const nsDay = (ns) => isoDay(Number(BigInt(String(ns).split('.')[0]) / 1000000n));

export function bulkItem({ address, account, activity = [], closed = [] }) {
  const fa = (Array.isArray(account) ? account[0]?.fullAccount : account?.fullAccount) || null;
  if (!fa) return null;
  const flows = [];
  for (const a of activity) {
    if (a.status && a.status !== 'completed') continue;
    if (a.symbol && a.symbol !== 'USD' && a.symbol !== 'USDC') continue;
    const amt = Math.abs(num(a.amount));
    let usd = 0;
    if (a.activityType === 'deposit') usd = amt;
    else if (a.activityType === 'withdrawal') usd = -amt;
    else if (a.activityType === 'transferInternal' || a.activityType === 'transferExternal') usd = a.to === address ? amt : a.from === address ? -amt : 0;
    if (usd) flows.push({ date: nsDay(a.timestamp), usd, type: a.activityType });
  }
  const positions = (fa.positions || []).filter((p) => num(p.size)).map((p) => ({
    market: p.symbol, side: num(p.size) > 0 ? 'LONG' : 'SHORT', size: Math.abs(num(p.size)), valueUsd: Math.abs(num(p.notional)),
    entryPrice: num(p.price), markPrice: num(p.fairPrice), liquidationPrice: num(p.liquidationPrice) || null, leverage: num(p.leverage),
    uPnl: num(p.unrealizedPnl), realisedPnl: num(p.realizedPnl), funding: num(p.funding), openedAt: p.averageEntryTime ? nsDay(p.averageEntryTime) : null,
  }));
  // Closed positions: realised P/L with their fees and funding (costs are negative).
  const closedTrades = byMarketDay(closed.map((c) => ({ market: c.symbol, day: nsDay(c.closeTime), usd: num(c.realizedPnl) + num(c.fees) + num(c.funding) })));
  const m = fa.margin || {};
  const value = num(m.aggTotalMargin ?? m.totalMargin) + num(m.aggUnrealizedPnl ?? m.unrealizedPnl);
  return accountItem({ key: 'bulk|account', protocol: 'Bulk', protocolId: 'bulk', siteUrl: 'https://bulk.trade', chainId: 'solana', chain: 'Solana',
    name: 'Perps account', value, flows, closedTrades, positions });
}

export async function fetchBulkPortfolio(address) {
  const account = await bulkAccount({ type: 'fullAccount', user: address });
  if (!account) return { totalUsd: 0, items: [] };
  const activity = await bulkAll('activityHistory', address);
  const closed = await bulkAll('positions', address);
  const item = bulkItem({ address, account, activity, closed });
  return { totalUsd: item?.netUsd || 0, items: item ? [item] : [] };
}

// ---------- GRVT (API key → session cookie) ----------
// https://api-docs.grvt.io/auth/ · https://github.com/gravity-technologies/api-spec — log in with the key, then
// send the "gravity" cookie and X-Grvt-Account-Id on every call. A Trading API key reports its sub-account id.
// Times are nanoseconds. Deposits land in the funding account; the trading sub-account's capital is what was
// transferred into it.
const GRVT_AUTH = process.env.GRVT_AUTH_URL || 'https://edge.grvt.io';
const GRVT_TRADES = process.env.GRVT_TRADES_URL || 'https://trades.grvt.io';

export async function grvtLogin(key) {
  const res = await fetch(`${GRVT_AUTH}/auth/api_key/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'rm=true;' }, body: JSON.stringify({ api_key: key }) });
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
  if (!res.ok) throw new Error(`GRVT login → HTTP ${res.status}`);
  const cookie = (res.headers.get('set-cookie') || '').match(/gravity=([^;]+)/)?.[1];
  const body = await res.json().catch(() => ({}));
  return { ok: !!cookie, status: res.status, cookie, accountId: res.headers.get('x-grvt-account-id'), subAccountId: body.sub_account_id || body.subAccountId || null };
}

async function grvtPost(session, path, body) {
  const res = await fetch(`${GRVT_TRADES}/full/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `gravity=${session.cookie}`, 'X-Grvt-Account-Id': session.accountId || '' }, body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`GRVT refused ${path} (HTTP ${res.status}). Use a Trading API key with read access.`), { status: 400 });
  if (!res.ok) throw new Error(`GRVT ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function grvtAll(session, path, body, maxPages = 10) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const r = await grvtPost(session, path, { ...body, limit: 500, ...(cursor ? { cursor } : {}) });
    out.push(...(r.result || []));
    cursor = r.next;
    if (!cursor) break;
  }
  return out;
}

export function grvtItem({ subAccountId, summary, transfers = [], fills = [] }) {
  if (!summary) return null;
  const sub = String(subAccountId);
  const flows = [];
  for (const t of transfers) {
    const amt = num(t.num_tokens);
    if (t.currency && !['USDT', 'USDC', 'USD'].includes(t.currency)) continue;
    const usd = String(t.to_sub_account_id) === sub ? amt : String(t.from_sub_account_id) === sub ? -amt : 0;
    if (usd) flows.push({ date: nsDay(t.event_time), usd, type: 'TRANSFER' });
  }
  const positions = (summary.positions || []).filter((p) => num(p.size)).map((p) => ({
    market: String(p.instrument).replace(/_Perp$/, '').replace(/_USD[TC]?$/, '-USD'), side: num(p.size) > 0 ? 'LONG' : 'SHORT', size: Math.abs(num(p.size)),
    valueUsd: Math.abs(num(p.notional)), entryPrice: num(p.entry_price), markPrice: num(p.mark_price), liquidationPrice: num(p.est_liquidation_price) || null,
    leverage: num(p.leverage), uPnl: num(p.unrealized_pnl), realisedPnl: num(p.realized_pnl), funding: num(p.cumulative_realized_funding_payment), openedAt: null,
  }));
  const closedTrades = byMarketDay(fills.map((f) => ({ market: String(f.instrument).replace(/_Perp$/, '').replace(/_USD[TC]?$/, '-USD'), day: nsDay(f.event_time), usd: num(f.realized_pnl) - num(f.fee) })));
  return accountItem({ key: `grvt|account|${sub}`, protocol: 'GRVT', protocolId: 'grvt', siteUrl: 'https://grvt.io', chainId: 'grvt', chain: 'GRVT',
    name: `Trading account ${sub}`, value: num(summary.total_equity), flows, closedTrades, positions });
}

export async function fetchGrvtPortfolio(key) {
  const session = await grvtLogin(key);
  if (!session.ok) throw Object.assign(new Error('GRVT rejected the API key. Check the GRVT key linked to this wallet.'), { status: 400 });
  if (!session.subAccountId) throw Object.assign(new Error('This GRVT key isn’t tied to a trading account. Create a Trading API key (not a Funding key).'), { status: 400 });
  const summary = (await grvtPost(session, 'account_summary', { sub_account_id: session.subAccountId })).result;
  const transfers = await grvtAll(session, 'transfer_history', {}).catch((e) => { console.warn(`GRVT transfers: ${e.message}`); return []; });
  const fills = await grvtAll(session, 'fill_history', { sub_account_id: session.subAccountId, kind: ['PERPETUAL'] }).catch((e) => { console.warn(`GRVT fills: ${e.message}`); return []; });
  const item = grvtItem({ subAccountId: session.subAccountId, summary, transfers, fills });
  return { totalUsd: item?.netUsd || 0, items: item ? [item] : [] };
}
