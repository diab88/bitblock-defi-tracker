import { grvtLogin } from './dexes.js';

// External data sources. Only read-only public data keyed by wallet address is fetched;
// no private keys or signatures are ever requested.

const DEBANK_BASE = 'https://pro-openapi.debank.com';

const DEBANK_CHAINS = {
  eth: 'Ethereum', arb: 'Arbitrum', base: 'Base', op: 'Optimism', matic: 'Polygon', avax: 'Avalanche',
  bsc: 'BNB Chain', hyper: 'HyperEVM', sonic: 'Sonic', bera: 'Berachain', linea: 'Linea', era: 'zkSync Era',
  scrl: 'Scroll', mnt: 'Mantle', xdai: 'Gnosis', plasma: 'Plasma', sei: 'Sei', uni: 'Unichain', ink: 'Ink',
};

// Keys are per portfolio (DeBank, Zerion) or per wallet (Extended): callers pass the one that applies.
export function debankMode(key) {
  if (key) return 'live';
  if (process.env.DEBANK_MOCK === '1') return 'mock';
  return 'off';
}

function guessStrategy(item) {
  const t = item.detail_types || [];
  const debt = item.stats?.debt_usd_value || 0;
  if (t.includes('leveraged_farming')) return 'Looping';
  if (t.includes('lending')) return debt > 0 ? 'Looping' : 'Lending / Supply';
  if (t.includes('perpetuals')) return 'Funding Rate';
  if (t.includes('liquidity_pool')) return item.position_index ? 'V3 Pool' : 'V2 Pool';
  if (t.some((x) => ['staked', 'locked', 'vesting', 'reward'].includes(x))) return 'Staking';
  return 'Vault';
}

export function normalizeProtocols(protocols) {
  const items = [];
  const seen = new Map();
  for (const p of protocols) {
    for (const it of p.portfolio_item_list || []) {
      let key = [p.id, it.pool?.id ?? it.name, it.position_index ?? ''].join('|');
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += `#${n}`;
      const tokens = [
        ...(it.detail?.supply_token_list || []),
        ...(it.detail?.token_list || []),
        ...(it.asset_token_list || []).filter((x) => x.amount > 0),
      ];
      items.push({
        key,
        protocol: p.name,
        protocolId: p.id,
        siteUrl: p.site_url,
        chainId: p.chain,
        chain: DEBANK_CHAINS[p.chain] || p.chain,
        name: it.name,
        detailTypes: it.detail_types || [],
        strategy: guessStrategy(it),
        netUsd: it.stats?.net_usd_value ?? 0,
        assetUsd: it.stats?.asset_usd_value ?? 0,
        debtUsd: it.stats?.debt_usd_value ?? 0,
        tokens: [...new Set(tokens.map((x) => x.optimized_symbol || x.symbol).filter(Boolean))],
        updatedAt: it.update_at ? new Date(it.update_at * 1000).toISOString() : null,
      });
    }
  }
  return items.sort((a, b) => b.netUsd - a.netUsd);
}

async function debankGet(path, params, key) {
  const url = `${DEBANK_BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { AccessKey: key, accept: 'application/json' } });
  if (!res.ok) throw new Error(`DeBank ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function fetchDebankPortfolio(address, key) {
  const mode = debankMode(key);
  if (mode === 'off') throw Object.assign(new Error('DeBank is not set up for this portfolio. Add a key on the Data sources page.'), { status: 400 });
  if (mode === 'mock') return mockPortfolio(address);
  const [balance, protocols] = await Promise.all([
    debankGet('/v1/user/total_balance', { id: address }, key),
    debankGet('/v1/user/all_complex_protocol_list', { id: address }, key),
  ]);
  return { totalUsd: balance.total_usd_value, chains: balance.chain_list || [], items: normalizeProtocols(protocols) };
}

// Deterministic demo data so the DeBank flow can be exercised without an AccessKey.
// Values drift slowly per call so repeated syncs produce a visible history.
function mockPortfolio(address) {
  const drift = 1 + ((Date.now() / 3.6e6) % 24) / 1000;
  const protocols = [
    { id: 'aave3', chain: 'arb', name: 'Aave V3', site_url: 'https://app.aave.com', portfolio_item_list: [
      { name: 'Lending', detail_types: ['lending'], pool: { id: '0xaave-arb' }, stats: { asset_usd_value: 5200 * drift, debt_usd_value: 0, net_usd_value: 5200 * drift }, detail: { supply_token_list: [{ symbol: 'USDC' }] } }] },
    { id: 'lido', chain: 'eth', name: 'Lido', site_url: 'https://lido.fi', portfolio_item_list: [
      { name: 'Staked', detail_types: ['common'], pool: { id: '0xlido' }, stats: { asset_usd_value: 8150 * drift, debt_usd_value: 0, net_usd_value: 8150 * drift }, detail: { supply_token_list: [{ symbol: 'stETH' }] } }] },
    { id: 'base_aerodrome', chain: 'base', name: 'Aerodrome', site_url: 'https://aerodrome.finance', portfolio_item_list: [
      { name: 'Liquidity Pool', detail_types: ['liquidity_pool'], pool: { id: '0xaero-usdc-weth' }, position_index: '4411', stats: { asset_usd_value: 2310 * drift, debt_usd_value: 0, net_usd_value: 2310 * drift }, detail: { supply_token_list: [{ symbol: 'USDC' }, { symbol: 'WETH' }] } }] },
  ];
  const items = normalizeProtocols(protocols);
  const totalUsd = items.reduce((s, i) => s + i.netUsd, 0) + 640;
  return { totalUsd, chains: [], items, mock: true, address };
}

// ---------- Zerion ----------
// https://developers.zerion.io — Basic auth with the API key as username. Covers EVM DeFi positions;
// for Solana it returns token balances only (Zerion does not index Solana protocol positions yet).

const ZERION_BASE = 'https://api.zerion.io/v1';

const ZERION_CHAINS = {
  ethereum: 'Ethereum', arbitrum: 'Arbitrum', base: 'Base', optimism: 'Optimism', polygon: 'Polygon',
  avalanche: 'Avalanche', 'binance-smart-chain': 'BNB Chain', solana: 'Solana', 'zksync-era': 'zkSync Era',
  linea: 'Linea', scroll: 'Scroll', mantle: 'Mantle', xdai: 'Gnosis', sonic: 'Sonic', berachain: 'Berachain',
  hyperevm: 'HyperEVM', blast: 'Blast', unichain: 'Unichain', ink: 'Ink', robinhood: 'Robinhood Chain',
  'world-chain': 'World Chain', abstract: 'Abstract', katana: 'Katana', plasma: 'Plasma', monad: 'Monad',
};
const LIQUID_STAKING = new Set(['stETH', 'wstETH', 'rETH', 'cbETH', 'weETH', 'JitoSOL', 'mSOL', 'bSOL', 'jupSOL', 'INF', 'sUSDe', 'sUSDS']);

export function zerionMode(key) {
  if (key) return 'live';
  if (process.env.ZERION_MOCK === '1') return 'mock';
  return 'off';
}

function zerionStrategy(parts) {
  const types = new Set(parts.map((p) => p.attributes.position_type));
  const module = parts[0].attributes.protocol_module || '';
  const symbols = parts.map((p) => p.attributes.fungible_info?.symbol);
  if (types.has('loan')) return 'Looping';
  // Concentrated-liquidity positions are NFTs: Zerion names them "… Pool 0.05% #100301".
  const label = `${parts[0].attributes.application_metadata?.name || ''} ${parts[0].attributes.name || ''}`;
  if (/\bV3\b|\bV4\b|#\d+/.test(label) && (module.includes('liquidity') || parts.length > 1)) return 'V3 Pool';
  if (module.includes('liquidity') || (parts.length > 1 && types.has('deposit') && !module.includes('lending'))) return 'V2 Pool';
  if (module.includes('lending')) return 'Lending / Supply';
  if (types.has('staked') || types.has('locked') || symbols.some((s) => LIQUID_STAKING.has(s))) return 'Staking';
  if (types.has('wallet')) return 'Exposure';
  return 'Vault';
}

// Zerion returns one row per token; rows of the same protocol position share a group_id
// (e.g. both sides of an LP, or collateral + debt). Collapse them into one item.
//
// group_id is only consistent *within* one response — Zerion regenerates it for some DEX protocols
// between calls — so it is used to group rows but never in the item key. The key uses fields that stay put:
// chain, protocol, position name and pool address (a Uniswap V3 name includes the NFT id, e.g. "… #100201").
export const zerionStableRef = (a) => [a.name, a.pool_address?.toLowerCase()].filter(Boolean).join('@');

// Zerion sometimes returns the same position row twice (same id, different group_id/value) — a stale copy
// next to the current one. Keep one row per id: the one in the larger group (the complete position),
// then the most recently updated.
export function dedupeZerionRows(rows) {
  const groupSize = new Map();
  for (const r of rows) { const g = r.attributes?.group_id; if (g) groupSize.set(g, (groupSize.get(g) || 0) + 1); }
  const best = new Map();
  const score = (r) => [groupSize.get(r.attributes?.group_id) || 0, Date.parse(r.attributes?.updated_at || 0) || 0];
  for (const r of rows) {
    const cur = best.get(r.id);
    if (!cur) { best.set(r.id, r); continue; }
    const [a1, a2] = score(r), [b1, b2] = score(cur);
    if (a1 > b1 || (a1 === b1 && a2 > b2)) best.set(r.id, r);
  }
  const keep = new Set(best.values());
  return rows.filter((r) => keep.has(r));
}

export function normalizeZerion(rows, { walletByChain = false } = {}) {
  const transient = new Map();
  for (const r of dedupeZerionRows(rows)) {
    const a = r.attributes;
    if (a.flags?.is_trash || a.flags?.displayable === false) continue;
    const chainId = r.relationships?.chain?.data?.id || 'unknown';
    const protocol = a.application_metadata?.name || a.protocol || (a.position_type === 'wallet' ? 'Wallet' : 'Unknown');
    const isWallet = a.position_type === 'wallet';
    const groupRef = isWallet ? (walletByChain ? 'balances' : a.fungible_info?.symbol || r.id) : a.group_id || a.pool_address || a.name || r.id;
    const tk = [chainId, protocol, groupRef].join('|');
    if (!transient.has(tk)) transient.set(tk, { chainId, protocol, isWallet, groupRef, parts: [] });
    transient.get(tk).parts.push(r);
  }
  // Re-key each group by its stable identity; groups that land on the same identity are merged.
  const groups = new Map();
  for (const g of transient.values()) {
    const ref = g.isWallet ? g.groupRef : zerionStableRef(g.parts.find((p) => p.attributes.position_type !== 'loan')?.attributes || g.parts[0].attributes) || g.groupRef;
    const key = ['zerion', g.chainId, g.protocol, ref].join('|');
    if (!groups.has(key)) groups.set(key, { key, chainId: g.chainId, protocol: g.protocol, parts: [] });
    groups.get(key).parts.push(...g.parts);
  }
  const items = [...groups.values()].map((g) => {
    const debt = g.parts.filter((p) => p.attributes.position_type === 'loan').reduce((s, p) => s + (p.attributes.value || 0), 0);
    const asset = g.parts.filter((p) => p.attributes.position_type !== 'loan').reduce((s, p) => s + (p.attributes.value || 0), 0);
    // "reward" rows on an LP are fees earned but not yet collected; they're part of the value.
    const unclaimed = g.parts.filter((p) => p.attributes.position_type === 'reward').reduce((s, p) => s + (p.attributes.value || 0), 0);
    const first = g.parts[0].attributes;
    const exposure = {};
    const unitPrice = {};
    for (const p of g.parts) {
      const sym = p.attributes.fungible_info?.symbol;
      const q = Number(p.attributes.quantity?.float) || 0;
      if (sym && q) exposure[sym] = (exposure[sym] || 0) + (p.attributes.position_type === 'loan' ? -q : q);
      if (sym && p.attributes.price > 0) unitPrice[sym] = p.attributes.price;
    }
    return {
      key: g.key,
      protocol: g.protocol,
      protocolId: first.protocol || g.protocol,
      siteUrl: first.application_metadata?.url || null,
      chainId: g.chainId,
      chain: ZERION_CHAINS[g.chainId] || g.chainId,
      name: first.position_type === 'wallet' ? 'Wallet balance' : first.name || first.protocol_module || 'Position',
      detailTypes: [...new Set(g.parts.map((p) => p.attributes.position_type))],
      strategy: zerionStrategy(g.parts),
      netUsd: asset - debt,
      assetUsd: asset,
      debtUsd: debt,
      unclaimedUsd: unclaimed,
      exposure: Object.entries(exposure).map(([symbol, qty]) => ({ symbol, qty, priceUsd: unitPrice[symbol] ?? null })),
      // Largest holdings first, so a grouped wallet row reads "USDC, ETH, …".
      tokens: [...new Set([...g.parts].sort((x, y) => (y.attributes.value || 0) - (x.attributes.value || 0))
        .filter((p) => g.parts.length < 4 || (p.attributes.value || 0) >= 1).map((p) => p.attributes.fungible_info?.symbol).filter(Boolean))],
      updatedAt: first.updated_at || null,
    };
  });
  return items.filter((i) => Math.abs(i.netUsd) >= 0.01).sort((a, b) => b.netUsd - a.netUsd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zerion keys have low per-second limits: call sequentially and back off on 429.
async function zerionGet(path, params, key, attempt = 0) {
  const url = `${ZERION_BASE}${path}?${new URLSearchParams(params)}`;
  const auth = Buffer.from(`${key}:`).toString('base64');
  const res = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } });
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(15, Number(res.headers.get('retry-after')) || 2 ** attempt * 1.5);
    await sleep(wait * 1000);
    return zerionGet(path, params, key, attempt + 1);
  }
  if (res.status === 429) throw Object.assign(new Error('Zerion rate limit reached — wait a minute and sync again.'), { status: 429 });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Zerion rejected the API key (HTTP ${res.status}). Check this portfolio’s Zerion key on the Data sources page.`), { status: 400 });
  if (!res.ok) throw new Error(`Zerion ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// When a source re-identifies a position (its key changes between syncs), move the tracked link to the new
// key instead of treating the position as new. Match on what the previous sync knew about the item:
// same protocol + chain + name, else same protocol + chain + token set; only an unambiguous match counts.
export function relinkKeys(linked, previousItems, newItems) {
  const newKeys = new Set(newItems.map((i) => i.key));
  const taken = new Set(linked.map((l) => l.key).filter((k) => newKeys.has(k)));
  const moves = [];
  const sameTokens = (a, b) => a.length === b.length && a.every((t) => b.includes(t));
  for (const l of linked) {
    if (newKeys.has(l.key)) continue;
    const old = previousItems.find((i) => i.key === l.key);
    if (!old) continue;
    const pool = newItems.filter((i) => !taken.has(i.key) && i.protocol === old.protocol && i.chainId === old.chainId);
    let cands = pool.filter((i) => i.name === old.name);
    if (cands.length !== 1) cands = pool.filter((i) => sameTokens(i.tokens || [], old.tokens || []));
    if (cands.length === 1) { moves.push({ positionId: l.positionId, from: l.key, to: cands[0].key }); taken.add(cands[0].key); }
  }
  return moves;
}

// ---------- money moving vs money earned ----------
// A wallet's value changes for two reasons: token prices move (profit/loss), or tokens arrive/leave
// (a closed pool paying out, a transfer from an exchange, gas). Only the first is profit. Between two
// syncs: price effect = Σ previous qty × (price now − price then); anything else is a transfer.
export function walletFlow(prev, now) {
  if (!prev || !now) return null;
  const nowPx = Object.fromEntries((now.exposure || []).map((e) => [e.symbol, e.priceUsd]));
  let priceEffect = 0;
  for (const e of prev.exposure || []) {
    if (!(e.priceUsd > 0)) return null; // older snapshot without prices: can't separate, don't guess
    const pNow = nowPx[e.symbol] > 0 ? nowPx[e.symbol] : e.priceUsd;
    priceEffect += e.qty * (pNow - e.priceUsd);
  }
  const flow = now.netUsd - prev.netUsd - priceEffect;
  return { flow, priceEffect, significant: Math.abs(flow) >= Math.max(0.5, 0.005 * Math.abs(prev.netUsd)) };
}

// Tracked pools that disappeared from the source: find the transactions that paid their tokens back to the
// wallet after their last valuation. Large receipts (≥ 25% of a pool's last value) of a pool's own tokens are
// its principal coming out. Several pools can close on the same day and share tokens (e.g. USDC in all of
// them), so receipts are assigned jointly and each transaction counts for at most one pool:
//   1. a receipt whose tokens fit exactly one closing pool → that pool;
//   2. a receipt whose token set equals one pool's full token set → that pool;
//   3. otherwise → the pool whose remaining shortfall (last value − already assigned) it best fills,
//      if it fits (≤ 125% of the shortfall); else it's left unassigned rather than guessed.
// An exit is also capped at 150% of the pool's last value; anything bigger is treated as no evidence.
export function detectExits(pools, txs) {
  const subset = (syms, pool) => syms.length > 0 && syms.every((x) => pool.tokens.includes(x));
  const appOk = (t, pool) => !t.app || t.app === pool.protocol || t.app.startsWith('Uniswap');
  const receipts = txs
    .filter((t) => ['receive', 'withdraw', 'burn'].includes(t.op) && t.in.length)
    .map((t) => ({ t, syms: [...new Set(t.in.map((x) => x.symbol))], usd: t.in.reduce((a, x) => a + x.usd, 0) }))
    .map((r) => ({ ...r, pools: pools.filter((p) => p.chainId === r.t.chainId && r.t.date >= p.lastDate && appOk(r.t, p)
      && subset(r.syms, p) && r.usd >= 0.25 * p.lastValue) }))
    .filter((r) => r.pools.length);
  const got = new Map(pools.map((p) => [p.id, []]));
  const assign = (r, p) => got.get(p.id).push(r);
  const pending = [];
  for (const r of receipts) {
    const exact = r.pools.filter((p) => p.tokens.length === r.syms.length);
    if (r.pools.length === 1) assign(r, r.pools[0]);
    else if (exact.length === 1) assign(r, exact[0]);
    else pending.push(r);
  }
  const shortfall = (p) => p.lastValue - got.get(p.id).reduce((a, r) => a + r.usd, 0);
  for (const r of pending.sort((x, y) => y.usd - x.usd)) {
    const fits = r.pools.filter((p) => r.usd <= 1.25 * shortfall(p)).sort((x, y) => Math.abs(shortfall(x) - r.usd) - Math.abs(shortfall(y) - r.usd));
    if (fits.length) assign(r, fits[0]);
  }
  const out = new Map();
  for (const p of pools) {
    const rs = got.get(p.id);
    const usd = rs.reduce((a, r) => a + r.usd, 0);
    if (!rs.length || usd > 1.5 * p.lastValue) { out.set(p.id, null); continue; }
    out.set(p.id, { date: rs.map((r) => r.t.date).sort().at(-1), usd, txIds: rs.map((r) => r.t.id), hashes: rs.map((r) => r.t.hash) });
  }
  return out;
}

export const detectExit = (pool, txs) => detectExits([{ id: 0, ...pool }], txs).get(0);

// Recent decoded transactions, newest first (up to `pages` × 100).
export async function fetchZerionTransactions(address, { key, pages = 3, chainIds } = {}) {
  if (zerionMode(key) !== 'live') return [];
  const out = [];
  let params = { currency: 'usd', 'page[size]': '100', ...(chainIds?.length ? { 'filter[chain_ids]': chainIds.join(',') } : {}) };
  let path = `/wallets/${address}/transactions/`;
  for (let i = 0; i < pages; i++) {
    const res = await zerionGet(path, params, key);
    out.push(...(res.data || []).map(normalizeZerionTx));
    const next = res.links?.next;
    if (!next || !(res.data || []).length) break;
    const u = new URL(next);
    path = u.pathname.replace(/^\/v1/, '');
    params = Object.fromEntries(u.searchParams);
  }
  return out;
}

export function normalizeZerionTx(t) {
  const a = t.attributes || {};
  const tr = (dir) => (a.transfers || []).filter((x) => x.direction === dir && x.fungible_info && !x.nft_info)
    .map((x) => ({ symbol: x.fungible_info.symbol, qty: x.quantity?.float ?? null, usd: x.value ?? 0 }));
  return {
    id: t.id,
    date: (a.mined_at || '').slice(0, 10),
    minedAt: a.mined_at,
    op: a.operation_type,
    app: a.application_metadata?.name || null,
    chainId: t.relationships?.chain?.data?.id || null,
    hash: a.hash,
    in: tr('in'),
    out: tr('out'),
    nftIn: (a.transfers || []).some((x) => x.direction === 'in' && x.nft_info),
  };
}

// Match transactions to tracked LP positions by chain + token set (+ protocol when Zerion names it).
//   fee:     tokens received from nowhere else, small relative to the position   → "collected fees"
//   deposit: tokens sent into the same protocol, typically minting the LP NFT    → "deposit"
// These are suggestions only; the user confirms each one.
export function matchTransactions(txs, positions) {
  const subset = (syms, pos) => syms.length > 0 && syms.every((x) => pos.tokens.includes(x));
  const pick = (cands, syms) => {
    if (cands.length === 1) return cands[0];
    const exact = cands.filter((p) => p.tokens.length === syms.length);
    return exact.length === 1 ? exact[0] : null; // ambiguous → skip rather than guess
  };
  const out = [];
  for (const t of txs) {
    const onChain = positions.filter((p) => p.chainId === t.chainId && p.tokens.length >= 2 && p.protocol !== 'Wallet');
    if (!onChain.length) continue;
    const appOk = (p) => !t.app || t.app === p.protocol || (t.app.startsWith('Uniswap') && p.protocol !== 'Wallet');
    if ((t.op === 'receive' || t.op === 'claim') && t.in.length && !t.out.length) {
      const syms = [...new Set(t.in.map((x) => x.symbol))];
      const p = pick(onChain.filter((p) => subset(syms, p) && appOk(p)), syms);
      const usd = t.in.reduce((s, x) => s + x.usd, 0);
      if (p && usd > 0 && usd <= Math.max(1, p.valueUsd * 0.1)) out.push({ kind: 'fee', tx: t, positionId: p.id, usd });
    } else if (t.out.length && t.app && (t.nftIn || ['deposit', 'mint', 'execute'].includes(t.op))) {
      const syms = [...new Set(t.out.map((x) => x.symbol))];
      const p = pick(onChain.filter((p) => subset(syms, p) && (t.app === p.protocol)), syms);
      const usd = t.out.reduce((s, x) => s + x.usd, 0);
      if (p && usd > 0) out.push({ kind: 'deposit', tx: t, positionId: p.id, usd });
    }
  }
  return out;
}

export async function fetchZerionPortfolio(address, kind, key) {
  const mode = zerionMode(key);
  if (mode === 'off') throw Object.assign(new Error('Zerion is not set up for this portfolio. Add a key on the Data sources page.'), { status: 400 });
  // EVM: DeFi positions plus plain wallet balances. Solana: Zerion has balances only.
  const filter = kind === 'solana' ? 'only_simple' : 'no_filter';
  const [portfolio, positions] = mode === 'mock'
    ? mockZerion(kind)
    : [
      await zerionGet(`/wallets/${address}/portfolio`, { currency: 'usd', 'filter[positions]': 'no_filter' }, key),
      await zerionGet(`/wallets/${address}/positions/`, { currency: 'usd', 'filter[positions]': filter, 'filter[trash]': 'only_non_trash', sort: '-value' }, key),
    ];
  return {
    totalUsd: portfolio?.data?.attributes?.total?.positions ?? null,
    items: normalizeZerion(positions.data || [], { walletByChain: kind !== 'solana' }),
    mock: mode === 'mock',
    balancesOnly: kind === 'solana',
  };
}

// Demo payloads in Zerion's documented response shape, so the normalizer runs on realistic input.
function mockZerion(kind) {
  const row = (id, chain, type, symbol, value, extra = {}) => ({
    type: 'positions', id,
    attributes: { position_type: type, value, price: 1, quantity: { float: value }, fungible_info: { symbol, name: symbol }, flags: { displayable: true, is_trash: false }, ...extra },
    relationships: { chain: { data: { type: 'chains', id: chain } } },
  });
  if (kind === 'solana') {
    const rows = [row('s1', 'solana', 'wallet', 'JitoSOL', 3120.4), row('s2', 'solana', 'wallet', 'SOL', 845.2), row('s3', 'solana', 'wallet', 'USDC', 410)];
    return [{ data: { attributes: { total: { positions: 4375.6 } } } }, { data: rows }];
  }
  const aave = { protocol: 'Aave V3', protocol_module: 'lending', group_id: 'aave-base-1', name: 'Lending', application_metadata: { name: 'Aave V3', url: 'https://app.aave.com' } };
  const pendle = { protocol: 'Pendle', protocol_module: 'liquidity_pool', group_id: 'pendle-arb-1', name: 'PT-sUSDe', application_metadata: { name: 'Pendle', url: 'https://app.pendle.finance' } };
  const rows = [
    row('z1', 'base', 'deposit', 'cbETH', 6400, aave), row('z2', 'base', 'loan', 'USDC', 2500, aave),
    row('z3', 'arbitrum', 'deposit', 'PT-sUSDe', 3020, pendle),
    row('z4', 'ethereum', 'staked', 'ETH', 5480, { protocol: 'Lido', group_id: 'lido-1', name: 'Staked', application_metadata: { name: 'Lido', url: 'https://lido.fi' } }),
  ];
  return [{ data: { attributes: { total: { positions: 13210.5 } } } }, { data: rows }];
}

// ---------- Wallet holdings ----------
// Every plain token sitting in a wallet (not DeFi positions), from the portfolio's tracker: Zerion (EVM chains and
// Solana) or DeBank (EVM chains). Without either, only the native coin can be read: SOL here via RPC; on EVM the
// browser asks the wallet extension.

export function normalizeZerionHoldings(rows) {
  return dedupeZerionRows(rows)
    .filter((r) => r.attributes.position_type === 'wallet' && !r.attributes.flags?.is_trash && r.attributes.flags?.displayable !== false)
    .map((r) => {
      const a = r.attributes;
      const chainId = r.relationships?.chain?.data?.id || 'unknown';
      return { symbol: a.fungible_info?.symbol || '?', name: a.fungible_info?.name || null, chain: ZERION_CHAINS[chainId] || chainId,
        qty: Number(a.quantity?.float) || 0, priceUsd: a.price ?? null, valueUsd: a.value ?? null };
    })
    .filter((h) => h.qty > 0)
    .sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0));
}

export function normalizeDebankHoldings(tokens) {
  return (tokens || [])
    .filter((t) => t.is_wallet !== false && t.amount > 0)
    .map((t) => ({ symbol: t.optimized_symbol || t.symbol || '?', name: t.name || null, chain: DEBANK_CHAINS[t.chain] || t.chain,
      qty: t.amount, priceUsd: t.price ?? null, valueUsd: t.price != null ? t.amount * t.price : null }))
    .sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0));
}

export async function fetchWalletHoldings({ address, kind, zerionKey, debankKey }) {
  if (zerionMode(zerionKey) === 'live') {
    const res = await zerionGet(`/wallets/${address}/positions/`, { currency: 'usd', 'filter[positions]': 'only_simple', 'filter[trash]': 'only_non_trash', sort: '-value' }, zerionKey);
    return { source: 'zerion', holdings: normalizeZerionHoldings(res.data || []) };
  }
  if (kind === 'evm' && debankMode(debankKey) === 'live') {
    return { source: 'debank', holdings: normalizeDebankHoldings(await debankGet('/v1/user/all_token_list', { id: address, is_all: 'false' }, debankKey)) };
  }
  if (zerionMode(zerionKey) === 'mock') {
    const row = (id, chain, symbol, qty, price) => ({ id, type: 'positions', attributes: { position_type: 'wallet', quantity: { float: qty }, price, value: qty * price, fungible_info: { symbol, name: symbol }, flags: { displayable: true, is_trash: false } }, relationships: { chain: { data: { id: chain } } } });
    const rows = kind === 'solana' ? mockZerion('solana')[1].data
      : [row('h1', 'ethereum', 'ETH', 1.25, 3200), row('h2', 'base', 'USDC', 840.5, 1), row('h3', 'arbitrum', 'ARB', 300, 0.42), row('h4', 'base', 'DEGEN', 12, 0.004)];
    return { source: 'zerion', holdings: normalizeZerionHoldings(rows), mock: true };
  }
  if (kind === 'solana') return { source: 'solana-rpc', nativeOnly: true, holdings: [{ symbol: 'SOL', name: 'Solana', chain: 'Solana', qty: await fetchSolanaBalance(address), priceUsd: null, valueUsd: null }] };
  return { source: null, holdings: [] };
}

// ---------- Lighter (public API, no key) ----------
// https://apidocs.lighter.xyz — accounts are looked up by the wallet's L1 address. Pool shares report
// the principal deposited and entry time, and pools publish daily share prices, so history can be backfilled.

const LIGHTER_BASE = process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai/api/v1';
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function lighterMode() {
  return process.env.LIGHTER_DISABLED === '1' ? 'off' : 'live';
}

async function lighterGet(path) {
  const res = await fetch(`${LIGHTER_BASE}${path}`, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 404 || body?.code === 21100) return null; // no Lighter account for this address
  if (!res.ok) throw new Error(`Lighter ${path} → HTTP ${res.status}`);
  return body;
}

// value(t) = shares × share_price(t) in USD; only from the entry date, since shares may have changed before.
// Staking pools (account_type 4) hold a token such as LIT: principal is in that token, so the position is
// tracked in the token (amount = shares × pool balance ÷ total shares) and USD comes from its price.
export function lighterPoolItem(account, share, pool) {
  const stakeAsset = pool?.account_type === 4 ? (pool.assets || []).find((a) => Number(a.balance) > 0) : null;
  if (stakeAsset) {
    const total = Number(pool.pool_info?.total_shares) || 0;
    const prices = (pool.pool_info?.share_prices || []).filter((p) => p.share_price > 0);
    const amount = total ? (Number(share.shares_amount) * Number(stakeAsset.balance)) / total : 0;
    const usdNow = prices.length ? Number(share.shares_amount) * prices.at(-1).share_price : null;
    const principal = Number(share.principal_amount);
    return {
      key: `lighter|pool|${share.public_pool_index}|${account.index}`, protocol: 'Lighter', protocolId: 'lighter', siteUrl: 'https://app.lighter.xyz',
      chainId: 'lighter', chain: 'Lighter', name: pool.name || `${stakeAsset.symbol} staking`, detailTypes: ['staking_pool'], strategy: 'Staking',
      currency: stakeAsset.symbol, amount, depositAmount: principal > 0 ? principal : null,
      exposure: [{ symbol: stakeAsset.symbol, qty: amount }],
      impliedPrice: usdNow && amount ? usdNow / amount : null,
      netUsd: usdNow ?? 0, assetUsd: usdNow ?? 0, debtUsd: 0, tokens: [stakeAsset.symbol],
      depositUsd: null, entryDate: share.entry_timestamp ? isoDay(share.entry_timestamp) : null, history: [],
      apy: pool.pool_info?.annual_percentage_yield ?? null, updatedAt: prices.length ? new Date(prices.at(-1).timestamp * 1000).toISOString() : null,
    };
  }
  const prices = (pool?.pool_info?.share_prices || []).filter((p) => p.share_price > 0).sort((a, b) => a.timestamp - b.timestamp);
  const last = prices.at(-1);
  const shares = Number(share.shares_amount) || 0;
  const entryDate = share.entry_timestamp ? isoDay(share.entry_timestamp) : null;
  const byDay = new Map();
  for (const p of prices) { const d = isoDay(p.timestamp * 1000); if (!entryDate || d >= entryDate) byDay.set(d, shares * p.share_price); }
  const principal = Number(share.principal_amount);
  return {
    key: `lighter|pool|${share.public_pool_index}|${account.index}`,
    protocol: 'Lighter',
    protocolId: 'lighter',
    siteUrl: 'https://app.lighter.xyz',
    chainId: 'lighter',
    chain: 'Lighter',
    name: pool?.name || `Public pool #${share.public_pool_index}`,
    detailTypes: ['public_pool'],
    strategy: 'LLP',
    netUsd: last ? shares * last.share_price : 0,
    assetUsd: last ? shares * last.share_price : 0,
    debtUsd: 0,
    tokens: ['USDC'],
    depositUsd: principal > 0 ? principal : null,
    entryDate,
    history: entryDate ? [...byDay].map(([date, value]) => ({ date, value })) : [],
    apy: pool?.pool_info?.annual_percentage_yield ?? null,
    updatedAt: last ? new Date(last.timestamp * 1000).toISOString() : null,
  };
}

export async function fetchLighterPortfolio(address) {
  const res = await lighterGet(`/account?by=l1_address&value=${address}`);
  const items = [];
  for (const a of res?.accounts || []) {
    const open = (a.positions || []).filter((p) => Number(p.position) !== 0);
    const tav = Number(a.total_asset_value) || 0;
    if (tav >= 0.01 || open.length) {
      items.push({
        key: `lighter|account|${a.index}`, protocol: 'Lighter', protocolId: 'lighter', siteUrl: 'https://app.lighter.xyz',
        chainId: 'lighter', chain: 'Lighter', name: `Trading account #${a.index}`, detailTypes: ['perpetuals'],
        strategy: 'Exposure', netUsd: tav, assetUsd: tav, debtUsd: 0,
        tokens: open.length ? open.map((p) => `${p.symbol} ${Number(p.sign) > 0 ? 'long' : 'short'}`) : ['USDC'],
        positions: open.map((p) => ({
          market: `${p.symbol}-USD`, side: Number(p.sign) > 0 ? 'LONG' : 'SHORT', size: Math.abs(Number(p.position)),
          valueUsd: Number(p.position_value), entryPrice: Number(p.avg_entry_price), markPrice: Number(p.position) ? Number(p.position_value) / Math.abs(Number(p.position)) : null,
          liquidationPrice: Number(p.liquidation_price) || null, uPnl: Number(p.unrealized_pnl), realisedPnl: Number(p.realized_pnl), funding: null,
        })),
        updatedAt: null,
      });
    }
    for (const share of a.shares || []) {
      if (!(Number(share.shares_amount) > 0)) continue;
      const pool = await lighterGet(`/account?by=index&value=${share.public_pool_index}`);
      items.push(lighterPoolItem(a, share, pool?.accounts?.[0]));
    }
  }
  items.sort((x, y) => y.netUsd - x.netUsd);
  return { totalUsd: items.reduce((s, i) => s + i.netUsd, 0), items };
}

// An account item counted from `since`: profit realised before that date is not counted as profit — it
// becomes part of the starting capital, like any money already in the account. So
//   capital = all USDC moved in/out + P/L of trades closed before `since` + cost of spot held
// and only trades closed on/after `since` plus open positions count as P/L. (A withdrawn earlier profit nets
// out: it was added by its trade and removed by its withdrawal.) Parts still reconcile: value − capital = Σ parts.
// Open positions opened before `since` count from their entry: the API has no mark-price history to rebase them.
// With `priceAt` (token → USD price on `since`), an open position opened before `since` is restated as if
// opened at that price: its price P/L up to `since` moves into starting capital. That keeps it comparable
// with other legs (e.g. a hedge's long side) started on the same date.
export function accountSince(item, since, priceAt = {}) {
  if (!item?.flows || !since) return item;
  item = item.base || item; // always derive from the source's original numbers (idempotent)
  const earlier = (item.closedTrades || []).filter((t) => t.closedAt && t.closedAt < since);
  const rebases = [];
  const positions = (item.positions || []).map((p) => {
    const sym = String(p.market || '').split('-')[0];
    const px = priceAt[sym];
    if (!(p.openedAt && p.openedAt < since && px > 0)) return p;
    const sign = String(p.side).toUpperCase() === 'SHORT' ? -1 : 1;
    const before = sign * p.size * (px - p.entryPrice); // P/L accrued before `since`
    rebases.push({ market: p.market, before, price: px });
    return { ...p, entryPrice: px, uPnl: p.uPnl - before, rebasedFrom: { date: since, originalEntry: p.entryPrice } };
  });
  const capital = item.flows.reduce((a, f) => a + f.usd, 0) + earlier.reduce((a, t) => a + t.realisedPnl, 0) + (item.spotCost || 0)
    + rebases.reduce((a, r) => a + r.before, 0);
  const trades = (item.closedTrades || []).filter((t) => !t.closedAt || t.closedAt >= since);
  const excluded = earlier;
  const breakdown = [
    ...item.breakdown.filter((b) => b.kind !== 'closed').map((b) => {
      const r = b.kind === 'upnl' && rebases.find((x) => x.market === b.market);
      return r ? { ...b, usd: b.usd - r.before, label: b.label.replace('(unrealised)', `(unrealised, since ${since} at ${+r.price.toPrecision(6)})`) } : b;
    }),
    ...(trades.length ? [{ label: `Closed trades (${[...new Set(trades.map((t) => t.market))].join(', ')})`, usd: trades.reduce((a, t) => a + t.realisedPnl, 0), kind: 'closed' }] : []),
  ];
  const pnl = item.valueUsd - capital;
  const parts = breakdown.reduce((a, b) => a + b.usd, 0);
  return { ...item, base: item, positions, rebasedPositions: rebases, depositUsd: Math.round(capital * 100) / 100, breakdown, excludedTrades: excluded,
    entryDate: item.entryDate && item.entryDate < since ? since : item.entryDate,
    reconcile: { pnl, parts, diff: parts - pnl, ok: Math.abs(parts - pnl) < 0.5 } };
}

// A wallet's "start tracking from" date applied to a synced item, so profit made before that date never
// counts. Exchange accounts drop earlier flows and closed trades (accountSince). Items that report a deposit
// made before the date start from their value on that date (from daily history), else from today's value.
export function applyTrackFrom(item, since, priceAt = {}) {
  if (!item || !since) return item;
  if (item.flows) return accountSince(item, since, priceAt);
  const history = (item.history || []).filter((h) => h.date >= since);
  const reportsDeposit = item.depositUsd != null || item.depositAmount != null;
  if (!reportsDeposit || (item.entryDate && item.entryDate >= since)) return { ...item, history };
  const start = history[0];
  if (start && !item.currency) return { ...item, depositUsd: Math.round(start.value * 100) / 100, depositAmount: null, entryDate: start.date, history, rebased: 'history' };
  // A token holding (e.g. staked LIT): value its current amount at the token's price on `since`, in USD.
  // (Approximation: rewards earned since `since` are counted as if held from the start.)
  const px = item.currency ? priceAt[item.currency] : null;
  if (px > 0 && item.amount != null) return { ...item, depositUsd: Math.round(item.amount * px * 100) / 100, depositAmount: null, entryDate: since, history, rebased: 'price', trackUsd: true, startPrice: px };
  return { ...item, depositUsd: null, depositAmount: null, entryDate: null, history, rebased: 'today' };
}

// ---------- Extended (read-only API key) ----------
// https://api.docs.extended.exchange — the key is per sub-account, created in Extended's API management page.

const EXTENDED_BASE = process.env.EXTENDED_API_URL || 'https://api.starknet.extended.exchange/api/v1';

export function extendedMode(key) {
  return key ? 'live' : 'off';
}

async function extendedGet(path, key) {
  const res = await fetch(`${EXTENDED_BASE}${path}`, {
    headers: { 'X-Api-Key': key, 'User-Agent': 'BitBlockDeFiTracker/1.0', accept: 'application/json' },
  });
  if (res.status === 404) return null; // Extended answers 404 for an empty balance
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Extended rejected the API key (HTTP ${res.status}). Check the Extended key linked to this wallet.`), { status: 400 });
  if (!res.ok) throw new Error(`Extended ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Capital in the account = USDC deposits − withdrawals ± transfers, plus the cost of spot assets still held
// (e.g. XVS vault shares at their average entry price). Vault redemptions routed to another account
// (counterpartyAccountId) move nothing into this one, so they're ignored.
// Value = USD cash + full notional of spot holdings + unrealised P/L. Extended's "equity" haircuts spot
// collateral (contributionFactor 0.9) for margin purposes, which understates what you actually own.
const EXTENDED_COLLATERAL_ASSET = 1;

export function extendedItem(balance, positions, operations, spotBalances = [], history = []) {
  const ops = (operations || []).filter((o) => o.status === 'COMPLETED');
  let net = 0;
  let first = null;
  const flows = []; // USDC in/out of this account, dated — lets a position count only flows after its entry date
  for (const o of ops) {
    const amt = Number(o.amount) || 0;
    const usdc = o.asset === undefined || Number(o.asset) === EXTENDED_COLLATERAL_ASSET;
    let signed = 0;
    if (o.type === 'DEPOSIT') signed = Math.abs(amt);
    else if (o.type === 'WITHDRAWAL') signed = -Math.abs(amt);
    else if (o.type === 'TRANSFER') signed = amt;
    else if (o.type.startsWith('VAULT_') && !o.counterpartyAccountId) signed = o.type === 'VAULT_WITHDRAWAL' ? Math.abs(amt) : -Math.abs(amt);
    if (signed > 0) first = first === null ? o.time : Math.min(first, o.time);
    if (usdc) { net += signed; flows.push({ date: isoDay(o.time), usd: signed, type: o.type }); }
  }
  const spot = (spotBalances || []).filter((b) => b.asset !== 'USD' && Number(b.balance) > 0);
  const spotValue = spot.reduce((a, b) => a + (Number(b.notionalValue) || 0), 0);
  const spotCost = spot.reduce((a, b) => a + (Number(b.averageEntryPrice) > 0 ? Number(b.balance) * Number(b.averageEntryPrice) : Number(b.notionalValue) || 0), 0);
  const cash = Number((spotBalances || []).find((b) => b.asset === 'USD')?.balance ?? balance?.balance) || 0;
  const upnl = Number(balance?.unrealisedPnl) || 0;
  const value = spotBalances?.length ? cash + spotValue + upnl : Number(balance?.equity) || 0;
  const capital = net + spotCost;
  const open = positions || [];
  // Break the account P/L into parts so a hedge leg is never compared against the whole account.
  // Identity: value − capital = Σ open uPnL + Σ open realised (funding − fees) + Σ closed realised + (spot − cost).
  const openIds = new Set(open.map((p) => String(p.id)));
  const closed = (history || []).filter((p) => !openIds.has(String(p.id)) && (p.closedTime || p.exitPrice));
  const closedTrades = closed.map((p) => ({ market: p.market, side: p.side, realisedPnl: Number(p.realisedPnl) || 0,
    openedAt: p.createdTime ? isoDay(p.createdTime) : null, closedAt: p.closedTime ? isoDay(p.closedTime) : null }));
  const breakdown = [
    ...open.map((p) => ({ label: `${p.market} ${String(p.side).toLowerCase()}: price move (unrealised)`, usd: Number(p.unrealisedPnl) || 0, market: p.market, kind: 'upnl' })),
    ...open.map((p) => ({ label: `${p.market} ${String(p.side).toLowerCase()}: funding − fees`, usd: Number(p.realisedPnl) || 0, market: p.market, kind: 'carry' })),
    ...(closed.length ? [{ label: `Closed trades (${[...new Set(closed.map((p) => p.market))].join(', ')})`, usd: closed.reduce((a, p) => a + (Number(p.realisedPnl) || 0), 0), kind: 'closed' }] : []),
    ...(spot.length ? [{ label: `${spot.map((b) => b.asset).join(', ')} spot (value − cost)`, usd: spotValue - spotCost, kind: 'spot' }] : []),
  ];
  const parts = breakdown.reduce((a, b) => a + b.usd, 0);
  const pnl = (spotBalances?.length ? cash + spotValue + upnl : Number(balance?.equity) || 0) - capital;
  return {
    key: 'extended|account', protocol: 'Extended', protocolId: 'extended', siteUrl: 'https://app.extended.exchange',
    chainId: 'starknet', chain: 'Starknet', name: 'Perps account', detailTypes: ['perpetuals'], strategy: 'Exposure',
    netUsd: value, assetUsd: value, debtUsd: 0,
    tokens: open.length ? open.map((p) => `${p.market} ${String(p.side).toLowerCase()}`) : ['USD'],
    depositUsd: capital > 0 ? Math.round(capital * 100) / 100 : null,
    entryDate: first ? isoDay(first) : null,
    cashUsd: cash, unrealisedPnl: upnl, spotUsd: spotValue,
    spot: spot.map((b) => ({ symbol: b.asset, qty: Number(b.balance), valueUsd: Number(b.notionalValue), costUsd: Number(b.balance) * Number(b.averageEntryPrice || 0) })),
    breakdown,
    reconcile: { pnl, parts, diff: parts - pnl, ok: Math.abs(parts - pnl) < 0.5 },
    flows, closedTrades, spotCost, valueUsd: value,
    positions: open.map((p) => ({ market: p.market, side: p.side, size: Number(p.size), valueUsd: Number(p.value), entryPrice: Number(p.openPrice), openedAt: p.createdAt ? isoDay(Number(p.createdAt)) : null, markPrice: Number(p.markPrice), liquidationPrice: Number(p.liquidationPrice), leverage: Number(p.leverage), uPnl: Number(p.unrealisedPnl), realisedPnl: Number(p.realisedPnl), funding: Number(p.paidFundingFee) })),
    updatedAt: balance?.updatedTime ? new Date(Number(balance.updatedTime)).toISOString() : null,
  };
}

export async function fetchExtendedPortfolio(key) {
  if (extendedMode(key) === 'off') throw Object.assign(new Error('No Extended account is linked to this wallet.'), { status: 400 });
  const balance = await extendedGet('/user/balance', key);
  const positions = await extendedGet('/user/positions', key);
  const ops = await extendedGet('/user/assetOperations?limit=1000', key);
  const spot = await extendedGet('/user/spot/balances', key);
  const history = await extendedGet('/user/positions/history?limit=500', key);
  const item = extendedItem(balance?.data, positions?.data, ops?.data, spot?.data || [], history?.data || []);
  if (!item.reconcile.ok) console.warn(`Extended P/L does not reconcile: parts ${item.reconcile.parts.toFixed(2)} vs account ${item.reconcile.pnl.toFixed(2)}`);
  return { totalUsd: item.netUsd, items: item.netUsd > 0 || item.depositUsd ? [item] : [] };
}

// USD price of a CoinGecko coin on a given day (YYYY-MM-DD). Free endpoint, low rate limit: callers cache.
export async function fetchCoingeckoHistory(id, date) {
  const [y, m, d] = date.split('-');
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${m}-${y}&localization=false`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko history ${id} ${date} → HTTP ${res.status}`);
  return (await res.json())?.market_data?.current_price?.usd ?? null;
}

// Check an API key with one cheap authenticated call. 401/403 = rejected; anything else unexpected = unknown.
export async function testProviderKey(provider, key) {
  const req = {
    zerion: () => fetch(`${ZERION_BASE}/chains/`, { headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json' } }),
    debank: () => fetch(`${DEBANK_BASE}/v1/account/units`, { headers: { AccessKey: key, accept: 'application/json' } }),
    extended: () => fetch(`${EXTENDED_BASE}/user/balance`, { headers: { 'X-Api-Key': key, 'User-Agent': 'BitBlockDeFiTracker/1.0', accept: 'application/json' } }),
    grvt: async () => {
      const r = await grvtLogin(key);
      if (r.ok && !r.subAccountId) return { ok: false, status: 400, custom: 'This GRVT key isn’t tied to a trading account: create a Trading API key (not a Funding key)' };
      return { ok: r.ok, status: r.ok ? 200 : r.status };
    },
  }[provider];
  if (!req) return { ok: false, message: 'unknown provider' };
  try {
    const res = await req();
    if (res.custom) return { ok: false, message: res.custom };
    if (res.ok || (provider === 'extended' && res.status === 404)) return { ok: true, message: 'Key accepted' }; // Extended: 404 = empty account
    if (res.status === 401 || res.status === 403) return { ok: false, message: `The ${provider} API rejected this key (HTTP ${res.status})` };
    if (res.status === 429) return { ok: false, message: 'Rate limited by the provider; try again in a minute' };
    return { ok: false, message: `Unexpected response from ${provider} (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, message: `Couldn’t reach ${provider}: ${e.message}` };
  }
}

export async function fetchCoingeckoPrices(ids) {
  const url = `https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=${ids.join(',')}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  // EUR per USD, derived from USDT's EUR quote.
  const fx = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=eur,usd').then((r) => r.json()).catch(() => null);
  return { data, eurUsd: fx?.tether?.eur ? fx.tether.usd / fx.tether.eur : null };
}

export async function fetchSolanaBalance(address) {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result.value / 1e9;
}

export const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const isSolanaAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
