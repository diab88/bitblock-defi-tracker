import { walletSupport, connectMetaMask, connectPhantomSolana, connectPhantomEvm, evmNativeBalance } from './wallets.js';

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = `t${err ? ' err' : ''}`;
  t.textContent = msg;
  $('#toast').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

const usd = (v, compact = false) => v === null || v === undefined ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: compact && Math.abs(v) >= 1e5 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
const amt = (v) => v === null || v === undefined ? '—'
  : new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6 }).format(v);
const pct = (v, d = 2) => v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`;
const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const signed = (s, v) => (v > 0 ? `+${s}` : s);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function statusPill(s) {
  const cls = s === 'Open' ? 'open' : s === 'Closed' ? 'closed' : s.startsWith('Check') ? 'bad' : 'warn';
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(s)}</span>`;
}

// ---------- charts ----------
const charts = [];
function destroyCharts() { while (charts.length) charts.pop().destroy(); }
const seriesColors = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--s${i}`));

function baseOptions(extra = {}) {
  const ink2 = cssVar('--ink-2'), muted = cssVar('--muted'), grid = cssVar('--grid');
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: ink2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
      tooltip: { backgroundColor: cssVar('--surface'), titleColor: cssVar('--ink'), bodyColor: ink2, borderColor: cssVar('--border'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false }, border: { color: cssVar('--axis') } },
      y: { ticks: { color: muted, callback: (v) => usd(v, true) }, grid: { color: grid }, border: { display: false } },
    },
    ...extra,
  };
}
function chart(canvas, config) {
  const c = new Chart(canvas, config);
  charts.push(c);
  return c;
}

// Diverging blue (gain) ↔ gray ↔ red (loss) for returns and P/L.
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
function divergingColor(v, max) {
  const t = Math.min(1, Math.abs(v) / (max || 1));
  return { bg: mix(cssVar('--div-mid'), v >= 0 ? cssVar('--div-pos') : cssVar('--div-neg'), t), ink: t > 0.55 ? '#fff' : cssVar('--ink') };
}

// ---------- state ----------
let meta = { chains: [], strategies: [], currencies: [], wallets: [], protocols: [], debank: 'off' };
const filters = { wallet: '', currency: '', status: '' };
let matrixMetric = 'ret';
let matrixCols = 'venue'; // 'venue' | 'chain'
let allocBy = 'byChain';
async function loadMeta() { meta = await api('GET', '/api/meta'); }

// ---------- router ----------
const routes = { dashboard: renderDashboard, positions: renderPositions, wallets: renderWallets, prices: renderPrices, guide: renderGuide };
async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  destroyCharts();
  try { await (routes[name] || renderDashboard)(); } catch (e) { view.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);
const rerender = () => route();

// ---------- dashboard ----------
function confirmTrackAll(walletId, walletName, n, providerId) {
  const provider = SOURCES[providerId]?.label || providerId;
  const reports = providerId === 'lighter' || providerId === 'extended';
  confirmModal(`Track ${n} position(s) from ${walletName} via ${provider}?`,
    reports
      ? `Each synced ${provider} position becomes a tracked position, using the deposit and entry date ${provider} reports${providerId === 'lighter' ? ', with its past daily values added to the history' : ''}.`
      : `Each synced ${provider} position becomes a tracked position, valued today. ${provider} doesn’t report what you deposited, so the deposit is set to today’s value and profit is measured from today. If you know the original deposit, open the position and edit its deposit and entry date.`,
    'Track all', async () => {
      const r = await api('POST', `/api/wallets/${walletId}/track-all?provider=${providerId}`);
      Object.keys(snapCache).forEach((k) => delete snapCache[k]);
      toast(`Tracking ${r.created} position(s)`);
      rerender();
    });
}

// ---------- account breakdowns ----------
// An exchange account is one position, but its P/L mixes several things (an open hedge leg, closed trades,
// spot holdings). Show them separately so a hedge leg is compared with its counterpart, not with the account.
function breakdownParts(sd) {
  const legs = {};
  const other = [];
  for (const b of sd.breakdown) {
    if (b.market) (legs[b.market] ??= { label: `${b.market} ${b.label.split(':')[0].split(' ').pop()} leg`, usd: 0, parts: [] }), legs[b.market].usd += b.usd, legs[b.market].parts.push(b);
    else other.push(b);
  }
  return { legs: Object.values(legs), other };
}
function breakdownInline(sd) {
  if (!sd?.breakdown?.length) return '';
  const { legs, other } = breakdownParts(sd);
  const item = (l, v) => `${esc(l)} <span class="${signCls(v)}">${signed(usd(v), v)}</span>`;
  return `<span class="sub">incl. ${[...legs.map((l) => item(l.label, l.usd)), ...other.map((o) => item(o.label.replace(' (value − cost)', ''), o.usd))].join(' · ')}</span>`;
}
function breakdownCard(p) {
  const sd = p.sourceDetail;
  if (!sd?.breakdown?.length) return '';
  const { legs, other } = breakdownParts(sd);
  const rows = [
    ...legs.flatMap((l) => l.parts.map((b) => [b.label, b.usd, true])),
    ...other.map((b) => [b.label, b.usd, false]),
  ];
  const off = Math.abs(sd.depositOffset) >= 0.01 ? sd.depositOffset : 0;
  return `<div class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>What’s inside this P/L</h2><p>Reported by ${esc(sourceOf(p.debank_key))}. Compare a hedge leg with its other side, not with the whole account.</p></div></div>
    <table><tbody>
    ${rows.map(([l, v, leg]) => `<tr><td>${leg ? '<span class="tag accent">hedge leg</span> ' : ''}${esc(l)}</td><td class="num ${signCls(v)}">${signed(usd(v), v)}</td></tr>`).join('')}
    ${legs.map((l) => `<tr><td><strong>${esc(l.label)} total</strong></td><td class="num ${signCls(l.usd)}"><strong>${signed(usd(l.usd), l.usd)}</strong></td></tr>`).join('')}
    ${off ? `<tr><td class="muted">Your deposit differs from ${esc(sourceOf(p.debank_key))}’s capital figure by</td><td class="num">${signed(usd(off), off)}</td></tr>` : ''}
    ${sd.excludedTrades?.length ? `<tr><td class="muted" colspan="2">Not counted (before this position’s entry date, ${esc(sd.since)}): ${esc(sd.excludedTrades.map((t) => `${t.market} ${String(t.side).toLowerCase()} ${signed(usd(t.realisedPnl), t.realisedPnl)}`).join(', '))}, and the money moved in/out then.</td></tr>` : ''}
    <tr><td><strong>Account P/L</strong></td><td class="num ${signCls(sd.reconcile.pnl + off)}"><strong>${signed(usd(sd.reconcile.pnl + off), sd.reconcile.pnl + off)}</strong></td></tr>
    </tbody></table>
    <p class="${sd.reconcile.ok ? 'muted' : 'neg'}" style="font-size:12px;margin:8px 0 0">${sd.reconcile.ok ? '✓ Parts add up to the account P/L.' : `⚠ Parts (${usd(sd.reconcile.parts)}) don’t add up to the account P/L (${usd(sd.reconcile.pnl)}), a ${usd(sd.reconcile.diff)} gap. Sync again; if it persists, the source data is inconsistent.`}</p></div>`;
}

// ---------- hedges & exposure ----------
const HEDGE_STATUS = {
  neutral: ['open', 'Delta-neutral'],
  under: ['warn', 'Partially hedged'],
  over: ['warn', 'Over-hedged'],
};
function hedgesCard(hedges) {
  if (!hedges?.length) return '';
  return `<section class="card" style="margin-bottom:16px">
    <div class="card-head"><div><h2>Hedges</h2><p>Same asset held long in one place and shorted in another. Judge these by the combined result: the legs’ price moves are meant to cancel.</p></div></div>
    <div class="stack">${hedges.map((h) => {
      const [cls, label] = HEDGE_STATUS[h.status];
      const warnLiq = h.liquidationDistance !== null && h.liquidationDistance < 0.25;
      return `<div class="hedge">
        <div class="hedge-head">
          <div><span class="hedge-asset">${esc(h.asset)}</span> <span class="pill ${cls}"><span class="dot"></span>${label}</span>
            <span class="muted" style="margin-left:6px">${(h.ratio * 100).toFixed(1)}% hedged · net ${h.netQty >= 0 ? '+' : ''}${amt(h.netQty)} ${esc(h.asset)}${h.netUsd !== null ? ` (${usd(h.netUsd)})` : ''}</span></div>
          <div class="hedge-total"><span class="muted">Combined P/L</span> <strong class="${signCls(h.combinedPnl)}">${h.combinedPnl === null ? '—' : signed(usd(h.combinedPnl), h.combinedPnl)}</strong></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Leg</th><th>Venue</th><th class="num">Size</th><th class="num">Entry → now</th><th class="num">Price P/L</th><th class="num">Carry</th><th class="num">Leg P/L</th></tr></thead><tbody>
        ${h.longs.map((l) => `<tr class="click" data-open="${l.positionId}"><td><span class="tag">Long</span> ${esc(l.label)}</td><td>${esc(l.venue)}</td><td class="num">${amt(l.qty)} ${esc(l.symbol)}</td><td class="num muted">—</td><td class="num muted" colspan="2">${l.pure ? 'in leg P/L (incl. rewards)' : 'inside a mixed position'}</td><td class="num ${signCls(l.pnlUsd)}">${l.pnlUsd === null ? '—' : signed(usd(l.pnlUsd), l.pnlUsd)}</td></tr>`).join('')}
        ${h.shorts.map((l) => `<tr class="click" data-open="${l.positionId}"><td><span class="tag accent">Short</span> ${esc(l.label)}</td><td>${esc(l.venue)}</td><td class="num">${amt(-l.qty)} ${esc(l.symbol)}</td>
          <td class="num">${amt(l.entryPrice)} → ${amt(l.markPrice)}</td><td class="num ${signCls(l.uPnl)}">${signed(usd(l.uPnl), l.uPnl)}</td>
          <td class="num ${signCls(l.carry)}" title="Funding received minus trading fees">${l.carry == null ? '—' : signed(usd(l.carry), l.carry)}</td><td class="num ${signCls((l.uPnl || 0) + (l.carry || 0))}">${signed(usd((l.uPnl || 0) + (l.carry || 0)), (l.uPnl || 0) + (l.carry || 0))}</td></tr>`).join('')}
        </tbody></table></div>
        ${h.liquidationPrice ? `<p class="${warnLiq ? 'neg' : 'muted'}" style="font-size:12px;margin:8px 0 0">${warnLiq ? '⚠ ' : ''}Short liquidates at ${amt(h.liquidationPrice)} ${esc(h.asset)} (${pct(h.liquidationDistance, 0)} above ${amt(h.price)}). Gains on the long leg don’t count as margin on the short’s venue; top up margin there if ${esc(h.asset)} rallies.</p>` : ''}
      </div>`;
    }).join('')}</div></section>`;
}
function exposureCard(exposure) {
  const rows = (exposure || []).filter((a) => a.netUsd === null || Math.abs(a.netUsd) >= 1);
  if (!rows.length) return '';
  const total = rows.reduce((s, a) => s + Math.abs(a.netUsd || 0), 0);
  const max = Math.max(...rows.map((a) => Math.abs(a.netUsd || 0)), 1e-9);
  return `<section class="card" style="margin-bottom:16px">
    <div class="card-head"><div><h2>Net exposure by asset</h2><p>What you gain or lose if each token moves, across all venues. Stablecoins excluded. ${usd(total)} of net directional exposure in total.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Asset</th><th class="num">Long</th><th class="num">Short</th><th class="num">Net</th><th class="num">Net USD</th><th>Where</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td><strong>${esc(a.asset)}</strong>${a.short ? ' <span class="tag accent">hedged</span>' : ''}</td>
      <td class="num">${amt(a.long)}</td><td class="num">${a.short ? amt(a.short) : '—'}</td><td class="num">${amt(a.net)}</td>
      <td class="num">${a.netUsd === null ? '<span class="muted">no price</span>' : returnBarUsd(a.netUsd, max)}</td>
      <td class="ink2" style="font-size:12px">${esc([...new Set(a.legs.map((l) => l.venue))].join(', '))}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}
function returnBarUsd(v, max) {
  const w = Math.min(50, (Math.abs(v) / (max || 1)) * 50);
  const style = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
  return `<div class="rbar"><span>${usd(v)}</span><span class="track"><span class="mid"></span><span class="fill" style="${style};background:${cssVar(v >= 0 ? '--div-pos' : '--div-neg')}"></span></span></div>`;
}
let hedgeTags = {};
async function loadHedgeTags() {
  const r = await api('GET', '/api/hedges').catch(() => null);
  hedgeTags = {};
  for (const h of r?.hedges || []) for (const l of [...h.longs, ...h.shorts]) hedgeTags[l.positionId] = h.asset;
  return r;
}
const hedgeTag = (id) => (hedgeTags[id] ? ` <span class="tag accent" title="Leg of a cross-venue hedge — see Dashboard → Hedges">${esc(hedgeTags[id])} hedge</span>` : '');

// Collected fees / deposits found in the wallet's transactions, waiting for the user to confirm.
function suggestionsCard(list, { title = 'Found in your transactions', showPosition = true } = {}) {
  if (!list?.length) return '';
  const fees = list.filter((x) => x.kind === 'fee');
  const feeTotal = fees.reduce((a, x) => a + x.amount_usd, 0);
  return `<section class="card" style="margin-bottom:16px" id="sgCard">
    <div class="card-head"><div><h2>${title}</h2><p>${fees.length ? `${fees.length} fee collection(s) worth ${usd(feeTotal)}` : ''}${fees.length && fees.length < list.length ? ' and ' : ''}${list.length - fees.length ? `${list.length - fees.length} deposit(s)` : ''} matched to your tracked pools by token and protocol. Confirm the ones that are right.</p></div>
      ${fees.length > 1 ? '<button class="btn sm primary" data-sg-all>Add all fees</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th>${showPosition ? '<th>Position</th>' : ''}<th>Type</th><th>Tokens</th><th class="num">Amount</th><th></th></tr></thead><tbody>
    ${list.map((x) => `<tr data-sg="${x.id}"><td class="num" style="text-align:left">${esc(x.date)}</td>
      ${showPosition ? `<td><strong>${esc(x.protocol)}</strong><span class="sub">${esc((x.comments || '').split(' (imported')[0].split(' · ')[0])}</span></td>` : ''}
      <td>${x.kind === 'fee' ? '<span class="tag accent">Collected fees</span>' : x.kind === 'close' ? '<span class="tag accent">Position closed?</span>' : '<span class="tag">Deposit</span>'}</td>
      <td>${x.kind === 'close' ? `<span class="ink2">No longer reported by the source. If you withdrew it, close it here.</span>` : ''}${esc(x.kind === 'close' ? '' : (x.detail.tokens || []).map((t) => `${amt(t.qty)} ${t.symbol}`).join(' + '))}${x.detail.hash ? `<span class="sub">${esc(x.detail.app || x.detail.op || '')} · ${esc(x.detail.hash.slice(0, 10))}…</span>` : ''}</td>
      <td class="num">${usd(x.amount_usd)}</td>
      <td class="num"><div class="actions" style="justify-content:flex-end"><button class="btn sm primary" data-sg-apply>${x.kind === 'fee' ? 'Add as fees' : x.kind === 'close' ? `Close at ${usd(x.amount_usd)}` : 'Set as deposit'}</button><button class="btn sm" data-sg-ignore>Ignore</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">Fees you collected leave the pool, so they’re added as rewards (profit = value + withdrawals + rewards − fees − deposit). Uncollected fees are already inside the pool’s value. “Set as deposit” replaces the import-day deposit with what you actually put in; several deposits to one pool are added up.</p></section>`;
}
function bindSuggestions(list, after) {
  $$('#sgCard tr[data-sg]').forEach((tr) => {
    const id = tr.dataset.sg;
    $('[data-sg-apply]', tr).onclick = guard(async () => { await api('POST', `/api/suggestions/${id}/apply`); toast('Added'); after(); });
    $('[data-sg-ignore]', tr).onclick = guard(async () => { await api('POST', `/api/suggestions/${id}/ignore`); after(); });
  });
  const all = $('#sgCard [data-sg-all]');
  if (all) all.onclick = guard(async () => {
    for (const x of list.filter((y) => y.kind === 'fee')) await api('POST', `/api/suggestions/${x.id}/apply`);
    toast('Collected fees added');
    after();
  });
}

function untrackedCard(list) {
  if (!list?.length) return '';
  const label = (p) => SOURCES[p]?.label || p;
  return `<section class="card" style="margin-bottom:16px;border-color:rgba(227,116,44,.28)">
    <div class="card-head"><div><h2>Synced but not tracked yet</h2><p>These positions came from your wallet sync but aren’t in your performance figures until you track them.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Wallet</th><th>Source</th><th class="num">Positions</th><th class="num">Untracked value</th><th class="num">Wallet total</th><th>Last sync</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td><strong>${esc(u.wallet)}</strong><span class="sub">${esc([...new Set(u.items.map((i) => i.protocol))].slice(0, 3).join(', '))}</span></td>
      <td><span class="tag accent">${esc(label(u.provider))}</span></td><td class="num">${u.items.length}</td><td class="num"><strong>${usd(u.untrackedUsd)}</strong></td>
      <td class="num">${usd(u.totalUsd)}</td><td>${esc(u.fetchedAt)} UTC</td>
      <td class="num"><div class="actions" style="justify-content:flex-end"><a class="btn sm" href="#/wallets">Review</a><button class="btn sm primary" data-trackall="${u.walletId}" data-provider="${u.provider}">Track all</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">Wallet total can be higher than the positions listed: it also includes plain token balances that aren’t in a DeFi protocol.</p></section>`;
}
function bindUntracked(list) {
  $$('[data-trackall]').forEach((b) => (b.onclick = () => {
    const u = list.find((x) => String(x.walletId) === b.dataset.trackall && x.provider === b.dataset.provider);
    confirmTrackAll(u.walletId, u.wallet, u.items.length, u.provider);
  }));
}

function filterBar() {
  const w = meta.wallets.map((x) => `<option value="${x.id}" ${filters.wallet == x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const c = meta.currencies.map((x) => `<option ${filters.currency === x ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const seg = [['', 'All'], ['open', 'Open'], ['closed', 'Closed']].map(([v, l]) => `<button data-status="${v}" class="${filters.status === v ? 'on' : ''}">${l}</button>`).join('');
  return `<div class="filters">
    <label>Wallet <select id="fWallet"><option value="">All wallets</option>${w}<option value="none" ${filters.wallet === 'none' ? 'selected' : ''}>Unassigned</option></select></label>
    <label>Currency <select id="fCurrency"><option value="">All (in USD)</option>${c}</select></label>
    <div class="segmented" id="fStatus">${seg}</div>
  </div>`;
}
function bindFilters() {
  $('#fWallet').onchange = (e) => { filters.wallet = e.target.value; rerender(); };
  $('#fCurrency').onchange = (e) => { filters.currency = e.target.value; rerender(); };
  $$('#fStatus button').forEach((b) => (b.onclick = () => { filters.status = b.dataset.status; rerender(); }));
}

async function renderDashboard() {
  await loadMeta();
  const [d, sugg, hx] = await Promise.all([api('GET', `/api/dashboard?${new URLSearchParams(filters)}`), api('GET', '/api/suggestions').catch(() => []), loadHedgeTags()]);
  const k = d.kpis;
  const head = `<div class="page-head"><div><div class="eyebrow">Overview</div><h1>Portfolio dashboard</h1><p>All figures in USD at your current prices. Per-currency totals are in the table below.</p></div></div>`;

  if (!k.positions) {
    view.innerHTML = head + filterBar() + untrackedCard(d.untracked) + `<div class="card empty"><h2>No tracked positions yet</h2><p>${d.untracked?.length ? 'Track your synced positions above to see performance, charts and the matrix here.' : 'Add your first DeFi position, or connect a wallet and import positions from DeBank or Zerion.'}</p>
      <div class="actions" style="justify-content:center;margin-top:14px"><button class="btn primary" id="emptyNew">+ New position</button><a class="btn" href="#/wallets">Connect wallet</a></div></div>`;
    bindFilters();
    bindUntracked(d.untracked);
    $('#emptyNew').onclick = () => openPositionForm();
    return;
  }

  const warn = [];
  if (k.unpriced) warn.push(`${k.unpriced} position(s) have no USD price and are left out of USD totals — <a href="#/prices">set prices</a>.`);
  if (k.incomplete) warn.push(`${k.incomplete} position(s) are incomplete and excluded from results — see <a href="#/positions">Positions</a>.`);

  view.innerHTML = head + filterBar() + (warn.length ? `<div class="banner"><span>⚠</span><div>${warn.join('<br>')}</div></div>` : '') + untrackedCard(d.untracked) + suggestionsCard(sugg) + `
  <section class="grid kpis">
    ${kpi('Open position value', usd(k.valueOpenUsd), `${usd(k.investedOpenUsd)} deposited`, true)}
    ${kpi('Total profit / loss', `<span class="${signCls(k.pnlUsd)}">${signed(usd(k.pnlUsd), k.pnlUsd)}</span>`, `Open ${usd(k.pnlOpenUsd)} · Closed ${usd(k.pnlClosedUsd)}`)}
    ${kpi('Total return', `<span class="${signCls(k.totalReturn)}">${pct(k.totalReturn)}</span>`, `on ${usd(k.depositedUsd)} total deposits`)}
    ${kpi('Annualized (simple, weighted)', pct(k.weightedApr), 'Deposit-weighted average of positions')}
    ${kpi('Positions', `${k.open} <span class="muted" style="font-size:15px">open</span> · ${k.closed} <span class="muted" style="font-size:15px">closed</span>`, k.incomplete ? `${k.incomplete} incomplete` : `${k.positions} total`)}
    ${kpi('Withdrawn + rewards', usd(k.withdrawalsUsd + k.rewardsUsd), `${usd(k.withdrawalsUsd)} withdrawn · ${usd(k.rewardsUsd)} rewards`)}
  </section>

  ${hedgesCard(hx?.hedges)}
  <section class="grid cols-3-2" style="margin-bottom:16px">
    <div class="card"><div class="card-head"><div><h2>Portfolio value vs. deposits</h2><p>Open positions over time, valued at current prices</p></div></div><div class="chart-box"><canvas id="cValue"></canvas></div></div>
    <div class="card"><div class="card-head"><div><h2>Cumulative profit / loss</h2><p>Open + closed, incl. withdrawals and rewards</p></div></div><div class="chart-box"><canvas id="cPnl"></canvas></div></div>
  </section>

  <section class="grid cols-2" style="margin-bottom:16px">
    <div class="card"><div class="card-head"><div><h2>Return by strategy</h2><p>Total return on deposits, per strategy type</p></div></div><div class="chart-box sm"><canvas id="cStrategy"></canvas></div></div>
    <div class="card"><div class="card-head"><div><h2>Allocation</h2><p>Current value of open positions</p></div>
      <div class="segmented" id="allocSeg">${[['byChain', 'Chain'], ['byProtocol', 'Protocol'], ['byWallet', 'Wallet'], ['byStrategy', 'Strategy']].map(([v, l]) => `<button data-v="${v}" class="${allocBy === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="chart-box sm"><canvas id="cAlloc"></canvas></div></div>
  </section>

  <section class="card" style="margin-bottom:16px" id="matrixCard"></section>
  ${exposureCard(hx?.exposure)}

  <section class="card" style="margin-bottom:16px">
    <div class="card-head"><div><h2>Performance matrix</h2><p>Every position: actual vs. expected annual return</p></div></div>
    <div class="table-wrap">${performanceTable(d.positions)}</div>
  </section>

  <section class="card">
    <div class="card-head"><div><h2>By currency</h2><p>Native amounts — the spreadsheet's Overview sheet, one row per currency</p></div></div>
    <div class="table-wrap">${currencyTable(d.currencySummary)}</div>
  </section>`;

  bindFilters();
  bindUntracked(d.untracked);
  bindSuggestions(sugg, rerender);
  $$('#allocSeg button').forEach((b) => (b.onclick = () => { allocBy = b.dataset.v; $$('#allocSeg button').forEach((x) => x.classList.toggle('on', x === b)); drawAlloc(d); }));
  $$('tr[data-id]').forEach((tr) => (tr.onclick = () => openDrawer(Number(tr.dataset.id))));
  $$('.hedge tr[data-open]').forEach((tr) => (tr.onclick = () => openDrawer(Number(tr.dataset.open))));

  const [c1, c2] = seriesColors();
  const labels = d.series.map((p) => p.date);
  chart($('#cValue'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Value', data: d.series.map((p) => p.value), borderColor: c1, backgroundColor: c1, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, cubicInterpolationMode: 'monotone' },
      { label: 'Deposited', data: d.series.map((p) => p.invested), borderColor: c2, backgroundColor: c2, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 5, stepped: 'before' },
    ] },
    options: baseOptions({ plugins: { ...baseOptions().plugins, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${usd(c.parsed.y)}` } } } }),
  });
  const pnlColor = cssVar(k.pnlUsd >= 0 ? '--div-pos' : '--div-neg');
  chart($('#cPnl'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Cumulative P/L', data: d.series.map((p) => p.pnl), borderColor: pnlColor, backgroundColor: pnlColor + '22', fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, cubicInterpolationMode: 'monotone' }] },
    options: baseOptions({ plugins: { ...baseOptions().plugins, legend: { display: false }, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: (c) => ` P/L: ${usd(c.parsed.y)}` } } } }),
  });

  const strat = d.byStrategy.filter((s) => s.ret !== null);
  chart($('#cStrategy'), {
    type: 'bar',
    data: { labels: strat.map((s) => s.name), datasets: [{ label: 'Total return', data: strat.map((s) => s.ret * 100), backgroundColor: strat.map((s) => cssVar(s.ret >= 0 ? '--div-pos' : '--div-neg')), borderRadius: 4, borderSkipped: 'start', barThickness: 18 }] },
    options: baseOptions({
      indexAxis: 'y',
      interaction: { mode: 'nearest', axis: 'y', intersect: false },
      plugins: { ...baseOptions().plugins, legend: { display: false }, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: (c) => { const s = strat[c.dataIndex]; return [` Return: ${pct(s.ret)}`, ` P/L: ${usd(s.pnl)}`, ` Deposited: ${usd(s.deposit)}`, ` Positions: ${s.count}`]; } } } },
      scales: { x: { ticks: { color: cssVar('--muted'), callback: (v) => `${v}%` }, grid: { color: cssVar('--grid') }, border: { display: false } }, y: { ticks: { color: cssVar('--ink-2') }, grid: { display: false }, border: { color: cssVar('--axis') } } },
    }),
  });
  drawAlloc(d);
  drawMatrix(d);
}

function kpi(label, value, sub, hero = false) {
  return `<div class="card kpi${hero ? ' hero' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

let allocChart = null;
function drawAlloc(d) {
  if (allocChart) { allocChart.destroy(); charts.splice(charts.indexOf(allocChart), 1); }
  let groups = d[allocBy].filter((g) => g.value > 0).sort((a, b) => b.value - a.value);
  if (groups.length > 8) { // fold the tail into "Other" rather than generating a 9th hue
    const rest = groups.slice(7);
    groups = [...groups.slice(0, 7), { name: 'Other', value: rest.reduce((s, g) => s + g.value, 0) }];
  }
  const total = groups.reduce((s, g) => s + g.value, 0);
  allocChart = chart($('#cAlloc'), {
    type: 'doughnut',
    data: { labels: groups.map((g) => g.name), datasets: [{ data: groups.map((g) => g.value), backgroundColor: seriesColors(), borderColor: cssVar('--surface'), borderWidth: 2, hoverOffset: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'right', labels: { color: cssVar('--ink-2'), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3,
        generateLabels: (c) => c.data.labels.map((l, i) => ({ text: `${l}  ${total ? Math.round((c.data.datasets[0].data[i] / total) * 100) : 0}%`, fillStyle: c.data.datasets[0].backgroundColor[i], strokeStyle: 'transparent', fontColor: cssVar('--ink-2'), index: i })) } },
        tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: (c) => ` ${usd(c.parsed)} (${pct(c.parsed / total, 1)})` } } } },
  });
  if (!groups.length) $('#cAlloc').parentElement.insertAdjacentHTML('beforeend', '<p class="muted" style="position:absolute;inset:45% 0;text-align:center">No open value</p>');
}

function drawMatrix(d) {
  const M = matrixCols === 'venue' ? d.matrixByVenue : d.matrix;
  const colName = matrixCols === 'venue' ? 'protocol / venue' : 'chain';
  // Hedge rows first, so both legs and their net are read together.
  const strategies = Object.keys(M).sort((a, b) => (b.startsWith('Delta-neutral') - a.startsWith('Delta-neutral')));
  const chains = [...new Set(strategies.flatMap((s) => Object.keys(M[s])))];
  const sumRow = (s) => Object.values(M[s]).reduce((t, c) => ({ deposit: t.deposit + c.deposit, pnl: t.pnl + c.pnl, value: t.value + c.value, count: t.count + c.count, legs: t.legs + (c.legs || 0) }), { deposit: 0, pnl: 0, value: 0, count: 0, legs: 0 });
  const ret = (c) => (c.deposit ? c.pnl / c.deposit : null);
  const val = (c) => (matrixMetric === 'ret' ? ret(c) : matrixMetric === 'pnl' ? c.pnl : c.value);
  const cells = strategies.flatMap((s) => chains.map((ch) => M[s][ch]).filter(Boolean));
  const max = Math.max(...cells.map((c) => Math.abs(val(c) ?? 0)), 1e-9);
  const fmt = (v) => (v === null ? '—' : matrixMetric === 'ret' ? pct(v, 1) : usd(v, true));
  const seqColor = (v) => { const t = Math.min(1, v / max); return { bg: mix(cssVar('--div-mid'), cssVar('--div-pos'), t), ink: t > 0.55 ? '#fff' : cssVar('--ink') }; };
  const color = (v) => (v === null ? { bg: cssVar('--div-mid'), ink: cssVar('--ink') } : matrixMetric === 'value' ? seqColor(v) : divergingColor(v, max));
  const sub = (c) => (c.legs && c.legs === c.count ? `hedge leg · P/L only` : `${c.count} pos · ${usd(c.deposit, true)}`);
  const cell = (s, ch, c) => {
    if (!c) return '<td class="cell empty">·</td>';
    const v = val(c), col = color(v);
    return `<td class="cell" style="background:${col.bg};color:${col.ink}" title="${esc(s)} · ${esc(ch)}: P/L ${usd(c.pnl)}${c.deposit ? `, return ${pct(ret(c))}, deposited ${usd(c.deposit)}` : ''}, value ${usd(c.value)}${c.legs ? ` (${c.legs} hedge leg${c.legs > 1 ? 's' : ''} split out of an exchange account)` : ''}">${fmt(v)}<span class="n">${sub(c)}</span></td>`;
  };
  const body = strategies.map((s) => {
    const t = sumRow(s);
    const tv = val(t);
    return `<tr${s.startsWith('Delta-neutral') ? ' class="hedge-row"' : ''}><th class="row">${esc(s)}</th>${chains.map((ch) => cell(s, ch, M[s][ch])).join('')}
      <td class="cell total"><strong class="${matrixMetric === 'value' ? '' : signCls(tv)}">${fmt(tv)}</strong><span class="n">${s.startsWith('Delta-neutral') ? 'net of both legs' : `${t.count} pos`}</span></td></tr>`;
  }).join('');
  const all = strategies.map(sumRow).reduce((t, c) => ({ deposit: t.deposit + c.deposit, pnl: t.pnl + c.pnl, value: t.value + c.value }), { deposit: 0, pnl: 0, value: 0 });
  const gradient = matrixMetric === 'value'
    ? `linear-gradient(90deg, ${cssVar('--div-mid')}, ${cssVar('--div-pos')})`
    : `linear-gradient(90deg, ${cssVar('--div-neg')}, ${cssVar('--div-mid')}, ${cssVar('--div-pos')})`;
  const scale = matrixMetric === 'value' ? `<span>$0</span><span class="bar" style="background:${gradient}"></span><span>${fmt(max)}</span>`
    : `<span>${fmt(-max)}</span><span class="bar" style="background:${gradient}"></span><span>${fmt(max)}</span>`;
  $('#matrixCard').innerHTML = `<div class="card-head"><div><h2>Strategy × ${colName} matrix</h2><p>Where your returns come from. Hover a cell for details. Hedge legs are split out of exchange accounts so each leg sits next to its counterpart.${matrixCols === 'chain' ? ' Exchanges appear under the chain they settle on (Extended → Starknet).' : ''}</p></div>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div class="scale">${scale}</div>
    <div class="segmented" id="mCols">${[['venue', 'By venue'], ['chain', 'By chain']].map(([v, l]) => `<button data-v="${v}" class="${matrixCols === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="segmented" id="mSeg">${[['ret', 'Return'], ['pnl', 'P/L'], ['value', 'Value']].map(([v, l]) => `<button data-v="${v}" class="${matrixMetric === v ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    ${strategies.length ? `<div class="table-wrap"><table class="heat"><thead><tr><th></th>${chains.map((c) => `<th style="text-align:center">${esc(c)}</th>`).join('')}<th style="text-align:center">Total</th></tr></thead><tbody>${body}
      <tr class="grand"><th class="row">All strategies</th>${chains.map(() => '<td></td>').join('')}<td class="cell total"><strong class="${matrixMetric === 'value' ? '' : signCls(val(all))}">${fmt(val(all))}</strong><span class="n">matches the Total profit / loss tile</span></td></tr>
      </tbody></table></div>` : '<p class="muted">No priced, complete positions to show.</p>'}`;
  $$('#mSeg button').forEach((b) => (b.onclick = () => { matrixMetric = b.dataset.v; drawMatrix(d); }));
  $$('#mCols button').forEach((b) => (b.onclick = () => { matrixCols = b.dataset.v; drawMatrix(d); }));
}

function returnBar(v, max) {
  if (v === null) return '—';
  const w = Math.min(50, (Math.abs(v) / (max || 1)) * 50);
  const col = cssVar(v >= 0 ? '--div-pos' : '--div-neg');
  const style = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
  return `<div class="rbar"><span class="${signCls(v)}">${pct(v)}</span><span class="track"><span class="mid"></span><span class="fill" style="${style};background:${col}"></span></span></div>`;
}

function performanceTable(rows) {
  const max = Math.max(...rows.map((r) => Math.abs(r.metrics.annualized ?? 0)), 1e-9);
  const maxT = Math.max(...rows.map((r) => Math.abs(r.metrics.totalReturn ?? 0)), 1e-9);
  return `<table><thead><tr><th>Position</th><th>Status</th><th class="num">Deposit</th><th class="num">Value</th><th class="num">P/L</th><th class="num">Total return</th><th class="num">Annualized</th><th class="num">Expected</th><th class="num">vs. target</th><th class="num">Days</th></tr></thead><tbody>
  ${rows.map((r) => {
    const m = r.metrics;
    const gap = m.annualized !== null && r.expected_return !== null ? m.annualized - r.expected_return : null;
    return `<tr class="click ${m.status === 'Closed' ? 'closed' : ''}" data-id="${r.id}">
      <td class="name-col"><strong>${esc(r.protocol || r.strategy || 'Untitled')}</strong>${hedgeTag(r.id)}<span class="sub">${esc([r.strategy, r.chain, r.wallet].filter(Boolean).join(' · '))}</span></td>
      <td>${statusPill(m.status)}</td>
      <td class="num">${amt(r.deposit)} <span class="muted">${esc(r.currency || '')}</span></td>
      <td class="num">${amt(m.currentValue)}</td>
      <td class="num ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)}<span class="sub">${m.pnlUsd !== null ? usd(m.pnlUsd) : ''}</span></td>
      <td class="num">${returnBar(m.totalReturn, maxT)}</td>
      <td class="num">${returnBar(m.annualized, max)}</td>
      <td class="num">${pct(r.expected_return)}</td>
      <td class="num ${signCls(gap)}">${gap === null ? '—' : signed(pct(gap), gap)}</td>
      <td class="num">${m.duration ?? '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function currencyTable(rows) {
  return `<table><thead><tr><th>Currency</th><th class="num">Positions</th><th class="num">Open</th><th class="num">Closed</th><th class="num">Incomplete</th><th class="num">Deposit</th><th class="num">Open value</th><th class="num">Open P/L</th><th class="num">Closed P/L</th><th class="num">Total P/L</th><th class="num">Withdrawals</th><th class="num">USD price</th><th class="num">Total P/L (USD)</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td><strong>${esc(r.currency)}</strong></td><td class="num">${r.total}</td><td class="num">${r.open}</td><td class="num">${r.closed}</td><td class="num">${r.incomplete}</td>
    <td class="num">${amt(r.deposit)}</td><td class="num">${amt(r.openValue)}</td><td class="num ${signCls(r.openPnl)}">${amt(r.openPnl)}</td><td class="num ${signCls(r.closedPnl)}">${amt(r.closedPnl)}</td>
    <td class="num ${signCls(r.totalPnl)}"><strong>${amt(r.totalPnl)}</strong></td><td class="num">${amt(r.withdrawals)}</td><td class="num">${r.usdPrice ? usd(r.usdPrice) : '<a href="#/prices">set</a>'}</td><td class="num ${signCls(r.totalPnlUsd)}">${usd(r.totalPnlUsd)}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- positions ----------
let posSearch = '';
async function renderPositions() {
  await loadMeta();
  const [rows, sugg] = await Promise.all([api('GET', '/api/positions'), api('GET', '/api/suggestions').catch(() => []), loadHedgeTags()]);
  view.innerHTML = `<div class="page-head"><div><h1>Positions</h1><p>Your journal of DeFi strategies — the spreadsheet's Strategies sheet. Click a row to update it.</p></div>
    <div class="actions"><input id="pSearch" placeholder="Search protocol, chain, wallet…" value="${esc(posSearch)}" style="width:240px"><a class="btn" href="/api/export.csv">Export CSV</a></div></div>
    ${suggestionsCard(sugg)}
    <div class="card">${rows.length ? `<div class="table-wrap"><table id="pTable"><thead><tr><th>Wallet</th><th>Strategy</th><th>Protocol</th><th>Chain</th><th>Entry</th><th>Valued</th><th class="num">Deposit</th><th class="num">Current value</th><th class="num">Withdrawn</th><th class="num">Rewards</th><th class="num">Fees</th><th class="num">P/L</th><th class="num">Return</th><th class="num">Annualized</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => { const m = r.metrics; return `<tr class="click ${m.status === 'Closed' ? 'closed' : ''}" data-id="${r.id}" data-q="${esc([r.wallet, r.strategy, r.protocol, r.chain, r.currency, r.comments].join(' ').toLowerCase())}">
      <td>${esc(r.wallet || '—')}</td><td>${esc(r.strategy || '—')}</td><td><strong>${esc(r.protocol || '—')}</strong>${hedgeTag(r.id)}${r.debank_key ? ` <span class="tag accent" title="Auto-valued from ${sourceOf(r.debank_key)}">${sourceOf(r.debank_key)}</span>` : ''}${breakdownInline(r.sourceDetail)}</td><td>${esc(r.chain || '—')}</td>
      <td class="num">${esc(r.entry_date || '—')}</td><td class="num">${esc(r.closed ? r.exit_date : m.valuationDate || '—')}</td>
      <td class="num">${amt(m.capital ?? r.deposit)} <span class="muted">${esc(r.currency || '')}</span>${m.added ? `<span class="sub">incl. ${amt(m.added)} added</span>` : ''}</td><td class="num">${amt(m.currentValue)}</td>
      <td class="num">${m.withdrawals ? amt(m.withdrawals) : '—'}</td><td class="num">${m.rewards ? amt(m.rewards) : '—'}</td><td class="num">${m.fees ? amt(m.fees) : '—'}</td>
      <td class="num ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)}</td><td class="num ${signCls(m.totalReturn)}">${pct(m.totalReturn)}</td><td class="num ${signCls(m.annualized)}">${pct(m.annualized)}</td>
      <td>${statusPill(m.status)}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty"><h2>No positions yet</h2><p>Start with “+ New position”, or import from a connected wallet.</p></div>`}</div>`;
  $$('#pTable tbody tr').forEach((tr) => (tr.onclick = () => openDrawer(Number(tr.dataset.id))));
  bindSuggestions(sugg, rerender);
  const s = $('#pSearch');
  const apply = () => { posSearch = s.value; const q = s.value.toLowerCase(); $$('#pTable tbody tr').forEach((tr) => tr.classList.toggle('hidden', !tr.dataset.q.includes(q))); };
  s.oninput = apply; apply();
}

// ---------- modal & forms ----------
const modal = $('#modal');
function openModal(html, onSubmit) {
  modal.innerHTML = `<form method="dialog">${html}</form>`;
  const form = modal.querySelector('form');
  // Cancel must not be a submit button, or Enter in a field would trigger it instead of Save.
  form.querySelectorAll('[data-cancel]').forEach((b) => { b.type = 'button'; b.onclick = () => modal.close(); });
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form)), form); modal.close(); } finally { btn.disabled = false; }
  });
  modal.showModal();
  (form.querySelector('[autofocus]') || form.querySelector('input:not([type=hidden]), select'))?.focus();
}
const opts = (list, sel) => list.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');

function openPositionForm(p = null, prefill = {}) {
  const v = { ...(p || {}), ...prefill };
  const edit = !!p;
  const walletOpts = meta.wallets.map((w) => `<option value="${w.id}" ${v.wallet_id == w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  openModal(`<div class="modal-body"><h2>${edit ? 'Edit position' : 'New position'}</h2>
    <p>${edit ? 'Change the position details. Use the position’s actions to record valuations, withdrawals, rewards or fees.' : 'One row per wallet and deposit. Record all amounts in the position’s currency.'}</p>
    <div class="form">
      <label>Wallet<select name="wallet_id"><option value="">— Unassigned —</option>${walletOpts}</select></label>
      <label>Strategy *<select name="strategy" required><option value=""></option>${opts(meta.strategies, v.strategy)}</select></label>
      <label>Protocol / platform<input name="protocol" list="dlProtocols" value="${esc(v.protocol)}" placeholder="e.g. Aave V3"></label>
      <label>Chain *<input name="chain" list="dlChains" value="${esc(v.chain)}" required placeholder="e.g. Arbitrum"></label>
      <label>Currency *<input name="currency" list="dlCurrencies" value="${esc(v.currency)}" required placeholder="e.g. USDC"></label>
      <label>Expected annual return <span class="hint">%, e.g. 8 (note APR/APY in comments)</span><input name="expected_return" type="number" step="any" value="${v.expected_return != null ? +(v.expected_return * 100).toFixed(6) : ''}"></label>
      <label>Entry date *<input name="entry_date" type="date" value="${esc(v.entry_date || today())}" required></label>
      <label>Deposit *<input name="deposit" type="number" step="any" min="0" value="${v.deposit ?? ''}" required></label>
      ${edit ? '' : `<label>Current value <span class="hint">what the platform shows now</span><input name="current_value" type="number" step="any" min="0" value="${v.current_value ?? ''}" placeholder="defaults to deposit"></label>
      <label>Valuation date<input name="valuation_date" type="date" value="${today()}"></label>`}
      <label class="full">Comments<textarea name="comments" rows="2">${esc(v.comments)}</textarea></label>
      <input type="hidden" name="debank_key" value="${esc(v.debank_key)}">
    </div>
    <datalist id="dlChains">${opts(meta.chains)}</datalist><datalist id="dlCurrencies">${opts(meta.currencies)}</datalist><datalist id="dlProtocols">${opts(meta.protocols)}</datalist>
    </div><div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">${edit ? 'Save' : 'Add position'}</button></div>`,
  async (f) => {
    const body = { ...f, expected_return: f.expected_return === '' ? null : Number(f.expected_return) / 100 };
    if (!edit && body.current_value === '') body.current_value = body.deposit;
    if (edit) { await api('PUT', `/api/positions/${p.id}`, body); toast('Position saved'); openDrawer(p.id); }
    else { const r = await api('POST', '/api/positions', body); Object.keys(snapCache).forEach((k) => delete snapCache[k]); toast('Position added'); openDrawer(r.id); }
    rerender();
  });
}

const EVENT_LABELS = {
  valuation: ['Update value', 'Enter the actual remaining value the platform shows now. Withdrawals recorded before this date are treated as already reflected in it.'],
  withdrawal: ['Record withdrawal', 'Money taken out of the position. Deposit and profit stay unchanged; current value goes down.'],
  reward: ['Record reward', 'Rewards received separately — only if not already in the position value or a withdrawal. Convert other tokens to this position’s currency first.'],
  deposit: ['Add capital', 'Money or tokens added to this position after it started (a top-up). Raises the amount invested, not the profit.'],
  fee: ['Record fee', 'Costs not already deducted from the position value, withdrawals or rewards (e.g. gas, bridge fees).'],
};
function openEventForm(p, type) {
  const [title, hint] = EVENT_LABELS[type];
  openModal(`<div class="modal-body"><h2>${title}</h2><p>${hint}</p><div class="form">
    <label>Date<input name="date" type="date" value="${today()}" required></label>
    <label>Amount (${esc(p.currency || '')})<input name="amount" type="number" step="any" min="0" required autofocus></label>
    <label class="full">Note<input name="note" placeholder="optional"></label></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
  async (f) => { await api('POST', `/api/positions/${p.id}/events`, { ...f, type }); toast('Saved'); openDrawer(p.id); rerender(); });
}
function openCloseForm(p) {
  openModal(`<div class="modal-body"><h2>Close position</h2><p>Enter the final exit proceeds (what you received when exiting). Earlier partial withdrawals stay as recorded.</p><div class="form">
    <label>Exit date<input name="exit_date" type="date" value="${today()}" required></label>
    <label>Exit value (${esc(p.currency || '')})<input name="exit_value" type="number" step="any" min="0" required></label></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Close position</button></div>`,
  async (f) => { await api('POST', `/api/positions/${p.id}/close`, f); toast('Position closed'); openDrawer(p.id); rerender(); });
}
function confirmModal(title, text, label, fn) {
  openModal(`<div class="modal-body"><h2>${esc(title)}</h2><p>${esc(text)}</p></div><div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">${esc(label)}</button></div>`, fn);
}

// ---------- position drawer ----------
const drawer = $('#drawer');
const panel = $('.drawer-panel', drawer);
let drawerChart = null;
function closeDrawer() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); drawerChart?.destroy(); drawerChart = null; }
drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.open) closeDrawer(); });

async function openDrawer(id) {
  const [rows, series, sugg] = await Promise.all([api('GET', '/api/positions'), api('GET', `/api/positions/${id}/series`), api('GET', `/api/suggestions?position=${id}`).catch(() => [])]);
  const p = rows.find((r) => r.id === id);
  if (!p) return closeDrawer();
  const m = p.metrics;
  const cur = esc(p.currency || '');
  const evs = [...p.events].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  panel.innerHTML = `<div class="drawer-head"><div><div class="muted" style="font-size:12px">${esc([p.wallet || 'Unassigned', p.chain].join(' · '))}</div>
      <h1 id="drawerTitle">${esc(p.protocol || p.strategy || 'Position')}</h1><div style="margin-top:6px;display:flex;gap:6px;align-items:center">${statusPill(m.status)} <span class="tag">${esc(p.strategy || '')}</span>${p.debank_key ? `<span class="tag accent">${sourceOf(p.debank_key)}-linked</span>` : ''}${hedgeTag(p.id)}</div></div>
      <button class="icon-btn" id="dClose" aria-label="Close">✕</button></div>
    <div class="actions" style="margin-bottom:14px">
      ${p.closed ? '<button class="btn sm" data-act="reopen">Reopen</button>' : `<button class="btn sm primary" data-act="valuation">Update value</button><button class="btn sm" data-act="withdrawal">Withdrawal</button><button class="btn sm" data-act="reward">Reward</button><button class="btn sm" data-act="fee">Fee</button><button class="btn sm" data-act="deposit">Add capital</button><button class="btn sm" data-act="close">Close position</button>`}
      <button class="btn sm" data-act="edit">Edit</button><button class="btn sm danger" data-act="delete">Delete</button></div>
    <div class="metric-grid" style="margin-bottom:14px">
      <div><div class="label">Deposit${m.added ? ' (incl. capital added)' : ''}</div><div class="v">${amt(m.capital ?? p.deposit)} ${cur}</div></div>
      <div><div class="label">${p.closed ? 'Exit value' : 'Current value'}</div><div class="v">${amt(m.currentValue)} ${cur}</div></div>
      <div><div class="label">Profit / loss</div><div class="v ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)} ${cur}</div></div>
      <div><div class="label">Total return</div><div class="v ${signCls(m.totalReturn)}">${pct(m.totalReturn)}</div></div>
      <div><div class="label">Annualized (simple)</div><div class="v ${signCls(m.annualized)}">${pct(m.annualized)}</div></div>
      <div><div class="label">Expected</div><div class="v">${pct(p.expected_return)}</div></div>
      <div><div class="label">Withdrawn</div><div class="v">${amt(m.withdrawals)}</div></div>
      <div><div class="label">Rewards − fees</div><div class="v">${amt(m.rewards - m.fees)}</div></div>
      <div><div class="label">Duration</div><div class="v">${m.duration ?? '—'} days</div></div>
      <div><div class="label">P/L in USD</div><div class="v ${signCls(m.pnlUsd)}">${usd(m.pnlUsd)}</div></div>
      <div><div class="label">USD price</div><div class="v">${m.usdPrice ? usd(m.usdPrice) : '—'}</div></div>
      <div><div class="label">Entry → ${p.closed ? 'exit' : 'valued'}</div><div class="v" style="font-size:13px">${esc(p.entry_date || '—')} → ${esc((p.closed ? p.exit_date : m.valuationDate) || '—')}</div></div>
    </div>
    ${breakdownCard(p)}
    ${suggestionsCard(sugg, { title: 'Suggested from your transactions', showPosition: false })}
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Value history (${cur})</h2></div><div class="chart-box sm"><canvas id="dChart"></canvas></div></div>
    ${p.comments ? `<div class="card" style="margin-bottom:14px"><h3>Comments</h3><p class="ink2" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.comments)}</p></div>` : ''}
    <div class="card"><div class="card-head"><h2>Activity</h2></div>
      ${evs.length ? `<table><tbody>${evs.map((e) => `<tr><td class="num" style="text-align:left">${esc(e.date)}</td><td><span class="tag">${esc(e.type === 'deposit' ? 'capital in' : e.type)}</span>${SOURCES[e.source] ? ` <span class="tag">${SOURCES[e.source].label}</span>` : ''}<span class="sub">${esc(e.note || '')}</span></td><td class="num">${e.type === 'withdrawal' || e.type === 'fee' ? '−' : e.type === 'deposit' ? '+' : ''}${amt(e.amount)} ${cur}</td><td style="width:1%"><button class="btn sm danger" data-del="${e.id}" aria-label="Delete entry">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No activity yet.</p>'}</div>`;

  $('#dClose').onclick = closeDrawer;
  $$('[data-act]', panel).forEach((b) => (b.onclick = guard(async () => {
    const a = b.dataset.act;
    if (EVENT_LABELS[a]) return openEventForm(p, a);
    if (a === 'close') return openCloseForm(p);
    if (a === 'edit') return openPositionForm(p);
    if (a === 'reopen') { await api('POST', `/api/positions/${p.id}/reopen`); toast('Reopened'); openDrawer(p.id); return rerender(); }
    if (a === 'delete') return confirmModal('Delete position?', 'This removes the position and all of its activity. This cannot be undone.', 'Delete', async () => { await api('DELETE', `/api/positions/${p.id}`); closeDrawer(); toast('Deleted'); rerender(); });
  })));
  $$('[data-del]', panel).forEach((b) => (b.onclick = guard(async () => { await api('DELETE', `/api/events/${b.dataset.del}`); openDrawer(p.id); rerender(); })));
  bindSuggestions(sugg, () => { openDrawer(p.id); rerender(); });

  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  drawerChart?.destroy();
  const [c1, c2, c3] = seriesColors();
  drawerChart = new Chart($('#dChart'), {
    type: 'line',
    data: { labels: series.map((s) => s.date), datasets: [
      { label: 'Value', data: series.map((s) => s.value), borderColor: c1, backgroundColor: c1, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, cubicInterpolationMode: 'monotone' },
      ...(series.some((s) => s.withdrawals) || m.rewards || m.fees
        ? [{ label: 'Total incl. withdrawn & rewards', data: series.map((s) => (s.pnl === null ? null : s.pnl + p.deposit)), borderColor: c3, backgroundColor: c3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, cubicInterpolationMode: 'monotone' }] : []),
      { label: 'Deposit', data: series.map(() => p.deposit), borderColor: c2, backgroundColor: c2, borderWidth: 2, borderDash: [5, 4], pointRadius: 0 },
    ] },
    options: baseOptions({ scales: { ...baseOptions().scales, y: { ...baseOptions().scales.y, ticks: { color: cssVar('--muted'), callback: (v) => amt(v) } } },
      plugins: { ...baseOptions().plugins, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${amt(c.parsed.y)} ${p.currency || ''}` } } } }),
  });
}

// ---------- wallets ----------
const SOURCES = {
  debank: { label: 'DeBank', env: 'DEBANK_ACCESS_KEY', mockEnv: 'DEBANK_MOCK', kinds: ['evm'], where: 'EVM DeFi positions.' },
  zerion: { label: 'Zerion', env: 'ZERION_API_KEY', mockEnv: 'ZERION_MOCK', kinds: ['evm', 'solana'], where: 'EVM DeFi positions + wallet balances, Solana balances.' },
  lighter: { label: 'Lighter', env: null, kinds: ['evm'], where: 'Perps account + LLP / public pools, with your deposit and daily history. Public API, no key needed.' },
  extended: { label: 'Extended', env: 'EXTENDED_API_KEY', kinds: ['evm'], where: 'Perps account equity + net deposits (read-only key from Extended → API management).' },
};
const sourceOf = (key) => SOURCES[key?.split('|')[0]]?.label || 'DeBank';
const snapCache = {};

function sourcesBanner() {
  const rows = Object.entries(SOURCES).map(([id, s]) => {
    const mode = meta[id];
    const state = mode === 'live' ? '<span class="pill open"><span class="dot"></span>Connected</span>'
      : mode === 'mock' ? '<span class="pill warn"><span class="dot"></span>Demo data</span>'
      : '<span class="pill"><span class="dot"></span>Not configured</span>';
    const hint = mode === 'live' ? s.where
      : mode === 'mock' ? `Sync returns sample positions, not your wallet. Set <code>${s.env}</code> and <code>${s.mockEnv}=0</code> for real data.`
      : `${s.where} Set <code>${s.env}</code> in <code>.env</code> and restart.`;
    return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong style="min-width:62px">${s.label}</strong>${state}<span>${hint}</span></div>`;
  }).join('');
  return `<div class="banner"><span>ℹ</span><div style="display:flex;flex-direction:column;gap:8px;flex:1"><div><strong>Position data sources.</strong> Each imports positions for a wallet address.${meta.autoSyncHours > 0 ? ` Connected sources re-sync automatically every ${meta.autoSyncHours}h, adding a new point to each tracked position’s history.` : ''}</div>${rows}</div></div>`;
}

async function renderWallets() {
  await loadMeta();
  const wallets = await api('GET', '/api/wallets');
  const sup = walletSupport();

  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Portfolio</div><h1>Wallets</h1><p>Connect a browser wallet or paste an address. Read-only: the app only asks for your public address — never a signature or transaction.</p></div></div>
  ${sourcesBanner()}
  <section class="grid connect-grid">
    <div class="card connect"><div class="ico" style="background:#f6851b">M</div><h2>MetaMask</h2><p>Connect your EVM address (Ethereum, Arbitrum, Base…). Syncs with DeBank or Zerion.</p>
      <button class="btn primary" id="cMetaMask" ${sup.metamask ? '' : 'disabled'}>${sup.metamask ? 'Connect MetaMask' : 'MetaMask not detected'}</button></div>
    <div class="card connect"><div class="ico" style="background:#ab9ff2">P</div><h2>Phantom</h2><p>Connect your Solana address (balances via Zerion), or Phantom’s EVM address.</p>
      <div class="actions"><button class="btn primary" id="cPhantom" ${sup.phantomSolana ? '' : 'disabled'}>${sup.phantomSolana ? 'Connect Solana' : 'Phantom not detected'}</button>
      ${sup.phantomEvm ? '<button class="btn" id="cPhantomEvm">Connect EVM</button>' : ''}</div></div>
    <div class="card connect"><div class="ico" style="background:var(--accent)">#</div><h2>Watch an address</h2><p>Paste any EVM (0x…) or Solana address — no extension needed. Or add a named wallet without an address.</p>
      <button class="btn" id="cAddress">Add address</button></div>
  </section>
  ${!sup.metamask && !sup.phantomSolana ? '<p class="muted" style="margin:-8px 0 20px">No wallet extension found in this browser. Open this page in Chrome/Brave/Firefox with MetaMask or Phantom installed — extensions work on <code>http://localhost</code>.</p>' : ''}
  <section class="stack">${wallets.length ? wallets.map(walletCard).join('') : '<div class="card empty"><h2>No wallets yet</h2><p>Connect or add one above. Positions can then be assigned to it.</p></div>'}</section>`;

  const connected = (name, address, source) => openWalletForm({ name, address, source, title: 'Wallet connected', lockAddress: true }, rerender);
  $('#cMetaMask').onclick = guard(async () => { const a = await connectMetaMask(); connected(`MetaMask ${short(a)}`, a, 'metamask'); });
  $('#cPhantom').onclick = guard(async () => { const a = await connectPhantomSolana(); connected(`Phantom SOL ${short(a)}`, a, 'phantom'); });
  $('#cPhantomEvm') && ($('#cPhantomEvm').onclick = guard(async () => { const a = await connectPhantomEvm(); connected(`Phantom EVM ${short(a)}`, a, 'phantom'); }));
  $('#cAddress').onclick = () => openWalletForm({}, rerender);

  for (const w of wallets) bindWalletCard(w);
}

// "Start tracking from": today (default), a custom date, or all history.
function trackFromField(current) {
  const mode = current === undefined ? 'today' : current === null ? 'all' : current === today() ? 'today' : 'date';
  return `<label class="full">Start tracking from
    <span class="hint">Profit made before this date is not counted: earlier trades, deposits and fee collections are ignored, and positions start from their value on that date.</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select name="track_mode" data-trackmode style="flex:1;min-width:180px">
        <option value="today" ${mode === 'today' ? 'selected' : ''}>Today (recommended)</option>
        <option value="date" ${mode === 'date' ? 'selected' : ''}>A specific date…</option>
        <option value="all" ${mode === 'all' ? 'selected' : ''}>All history</option>
      </select>
      <input type="date" name="track_date" max="${today()}" value="${mode === 'date' ? esc(current) : ''}" ${mode === 'date' ? '' : 'hidden'} style="flex:1;min-width:160px">
    </div></label>`;
}
function bindTrackFrom(form) {
  const sel = form.querySelector('[data-trackmode]');
  const date = form.querySelector('[name=track_date]');
  if (!sel) return;
  sel.onchange = () => { date.hidden = sel.value !== 'date'; date.required = sel.value === 'date'; if (!date.hidden) date.focus(); };
}
const trackFromValue = (f) => (f.track_mode === 'date' ? f.track_date : f.track_mode);
const trackFromLabel = (v) => (v ? `Tracking from ${v}` : 'Tracking all history');

// Add or connect a wallet: always ask where tracking starts.
function openWalletForm({ name = '', address = '', source = 'address', title = 'Add wallet', lockAddress = false } = {}, onDone) {
  openModal(`<div class="modal-body"><h2>${esc(title)}</h2><p>Give it a name you’ll recognize.${lockAddress ? '' : ' The address is optional but needed for syncing.'}</p><div class="form">
      <label class="full">Name<input name="name" required value="${esc(name)}" placeholder="e.g. Main Ledger"></label>
      <label class="full">Address <span class="hint">EVM 0x… or Solana</span><input name="address" value="${esc(address)}" ${lockAddress ? 'readonly' : ''} placeholder="0x…" autocomplete="off" spellcheck="false"></label>
      ${trackFromField(undefined)}</div></div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Add wallet</button></div>`,
  async (f) => {
    const w = await api('POST', '/api/wallets', { name: f.name, address: f.address, source: f.address ? source : 'manual', track_from: trackFromValue(f) });
    toast(`Wallet “${w.name}” added · ${trackFromLabel(w.track_from).toLowerCase()}`);
    onDone?.(w);
  });
  bindTrackFrom(modal.querySelector('form'));
}

function syncButtons(w) {
  const usable = Object.entries(SOURCES).filter(([id, s]) => s.kinds.includes(w.kind) && meta[id] !== 'off');
  const main = (usable.find(([id]) => meta[id] === 'live') || usable.find(([id]) => meta[id] === 'mock'))?.[0];
  return usable.map(([id, s]) =>
    `<button class="btn sm ${id === main ? 'primary' : ''}" data-sync="${id}" ${meta[id] === 'off' ? `disabled title="Set ${s.env} first"` : ''}>Sync from ${s.label}${meta[id] === 'mock' ? ' (demo)' : ''}</button>`).join('');
}

function walletCard(w) {
  const last = w.lastSync ? ` · Last sync: ${SOURCES[w.lastSync.provider]?.label || 'DeBank'}, ${esc(w.lastSync.fetched_at)} UTC · ${usd(w.lastSync.total_usd)} total` : '';
  return `<div class="card wallet-card" id="w${w.id}">
    <div class="card-head"><div><h2>${esc(w.name)} <span class="tag">${w.kind === 'evm' ? 'EVM' : w.kind === 'solana' ? 'Solana' : 'Manual'}</span>${w.source === 'metamask' || w.source === 'phantom' ? ` <span class="tag">${esc(w.source)}</span>` : ''}</h2>
      <div class="addr">${esc(w.address || 'No address')}</div>
      <p>${w.positions} position(s)${last}</p>
      <p><span class="tag ${w.track_from ? 'accent' : ''}" title="Profit before this date isn’t counted for this wallet">${esc(trackFromLabel(w.track_from))}</span></p></div>
      <div class="actions">
        ${syncButtons(w)}
        ${w.kind === 'evm' ? `<a class="btn sm" href="https://debank.com/profile/${esc(w.address)}" target="_blank" rel="noopener">DeBank ↗</a><a class="btn sm" href="https://app.zerion.io/${esc(w.address)}/overview" target="_blank" rel="noopener">Zerion ↗</a><button class="btn sm" data-bal>Native balance</button>` : ''}
        ${w.kind === 'solana' ? `<button class="btn sm" data-bal>SOL balance</button><a class="btn sm" href="https://solscan.io/account/${esc(w.address)}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}
        <button class="btn sm" data-rename>Edit</button><button class="btn sm danger" data-remove>Remove</button></div></div>
    <div data-balance class="ink2"></div>
    <div data-items></div></div>`;
}

async function bindWalletCard(w) {
  const el = $(`#w${w.id}`);
  const items = $('[data-items]', el);
  const sources = Object.keys(SOURCES).filter((id) => SOURCES[id].kinds.includes(w.kind));
  const showItems = (data) => {
    if (!data) { items.innerHTML = ''; return; }
    const label = SOURCES[data.provider]?.label || 'DeBank';
    const switcher = sources.length > 1 ? `<div class="segmented" data-src>${sources.map((id) => `<button data-v="${id}" class="${id === data.provider ? 'on' : ''}">${SOURCES[id].label}</button>`).join('')}</div>` : '';
    const title = data.balancesOnly ? 'Token balances' : 'Detected DeFi positions';
    const open = (data.items || []).filter((i) => !i.positionId && i.netUsd > 0).length;
    const trackAll = !data.mock && open ? `<button class="btn sm primary" data-trackall-w>Track all (${open})</button>` : '';
    const head = `<div class="card-head" style="margin:6px 0 8px"><h3>${title} <span class="tag accent">via ${label}</span>${data.mock ? ' <span class="tag">demo data — not your wallet</span>' : ''}</h3><div class="actions">${trackAll}${switcher}</div></div>`;
    const note = data.balancesOnly ? '<p class="muted" style="font-size:12px">Zerion does not index Solana protocol positions yet, so these are plain token balances. Liquid-staking tokens (JitoSOL, mSOL…) can still be tracked as Staking positions.</p>' : '';
    if (data.empty) { items.innerHTML = head + `<p class="muted">Not synced with ${label} yet — use “Sync from ${label}”.</p>`; bindSwitch(); return; }
    if (!data.items?.length) { items.innerHTML = head + `<p class="muted">${label} found no ${data.balancesOnly ? 'token balances' : 'DeFi protocol positions'} for this address.</p>`; bindSwitch(); return; }
    items.innerHTML = head + note + `<div class="table-wrap"><table><thead><tr><th>Protocol</th><th>Chain</th><th>Position</th><th>Tokens</th><th class="num">Net value</th><th class="num">Debt</th><th></th></tr></thead><tbody>
      ${data.items.map((i, n) => `<tr><td><strong>${esc(i.protocol)}</strong></td><td>${esc(i.chain)}</td><td>${esc(i.name)} <span class="sub">${esc(i.strategy)}</span></td><td>${esc(i.tokens.join(', '))}</td>
        <td class="num">${usd(i.netUsd)}${i.amount != null && i.currency ? `<span class="sub">${amt(i.amount)} ${esc(i.currency)}</span>` : ''}${i.unclaimedUsd >= 0.01 ? `<span class="sub">incl. ${usd(i.unclaimedUsd)} uncollected fees</span>` : ''}${i.rebased ? `<span class="sub">deposit was before ${esc(data.trackFrom)}; starts from ${i.rebased === 'history' ? 'its value that day' : 'today’s value'}</span>` : ''}${i.depositUsd || i.depositAmount ? `<span class="sub">${i.rebased ? 'starts at' : 'deposited'} ${i.depositAmount ? `${amt(i.depositAmount)} ${esc(i.currency)}` : usd(i.depositUsd)}${i.entryDate ? ` · ${esc(i.entryDate)}` : ''}</span>` : ''}${i.positions?.length ? i.positions.map((x) => `<span class="sub">${esc(x.market)} ${esc(String(x.side).toLowerCase())} ${amt(x.size)} @ ${amt(x.entryPrice)} → ${amt(x.markPrice)} · uPnL <span class="${signCls(x.uPnl)}">${usd(x.uPnl)}</span>${x.liquidationPrice ? ` · liq. ${amt(x.liquidationPrice)}` : ''}</span>`).join('') : ''}${i.spot?.length ? `<span class="sub">incl. ${esc(i.spot.map((x) => `${amt(x.qty)} ${x.symbol} (${usd(x.valueUsd)})`).join(', '))}${i.cashUsd != null ? ` + ${usd(i.cashUsd)} cash` : ''}</span>` : ''}</td><td class="num">${i.debtUsd ? usd(i.debtUsd) : '—'}</td>
        <td class="num">${i.positionId ? `<button class="btn sm" data-open="${i.positionId}">Linked ✓</button>` : `<button class="btn sm primary" data-track="${n}">Track</button>`}</td></tr>`).join('')}
    </tbody></table></div><p class="muted" style="font-size:12px">“Track” creates a position valued from ${label} (in USD, or in the staked token where that’s what you deposited); every later ${label} sync records a new valuation automatically. ${data.items.some((i) => i.depositUsd || i.depositAmount) ? `Where ${label} reports your deposit and entry date, they’re filled in${data.items.some((i) => i.history?.length) ? ' and past daily values are added to the chart' : ''}; otherwise you enter the deposit.` : 'You enter the deposit.'}</p>`;
    $$('[data-open]', items).forEach((b) => (b.onclick = () => openDrawer(Number(b.dataset.open))));
    const ta = $('[data-trackall-w]', items);
    if (ta) ta.onclick = () => confirmTrackAll(w.id, w.name, open, data.provider);
    $$('[data-track]', items).forEach((b) => (b.onclick = () => {
      const i = data.items[Number(b.dataset.track)];
      openPositionForm(null, {
        wallet_id: w.id, strategy: i.strategy, chain: i.chain, currency: i.currency || 'USD', debank_key: i.key,
        protocol: i.protocol === 'Wallet' ? (i.tokens.length === 1 ? `Wallet · ${i.tokens[0]}` : 'Wallet balance')
          : i.protocolId === 'lighter' ? `Lighter · ${i.name.replace('Lighter Liquidity Provider (LLP)', 'LLP').replace(/ #\d+$/, '')}` : i.protocol,
        current_value: +(i.amount ?? i.netUsd).toFixed(6),
        deposit: (i.depositAmount ?? i.depositUsd) ? +(i.depositAmount ?? i.depositUsd).toFixed(6) : undefined,
        entry_date: i.entryDate || undefined,
        comments: `${i.name} · ${i.tokens.join('/')} (imported from ${label}${i.depositUsd || i.depositAmount ? '; deposit reported by ' + label : ''})`,
      });
    }));
    bindSwitch();
  };
  const load = async (provider) => {
    const k = `${w.id}:${provider || ''}`;
    snapCache[k] ??= await api('GET', `/api/wallets/${w.id}/snapshot${provider ? `?provider=${provider}` : ''}`).catch(() => null);
    return snapCache[k];
  };
  function bindSwitch() {
    $$('[data-src] button', items).forEach((b) => (b.onclick = guard(async () => {
      const data = await load(b.dataset.v);
      showItems(data || { provider: b.dataset.v, items: [], empty: true });
    })));
  }
  if (sources.length) showItems(await load());
  $$('[data-sync]', el).forEach((btn) => btn.addEventListener('click', guard(async () => {
    const provider = btn.dataset.sync;
    const text = btn.textContent;
    btn.disabled = true; btn.textContent = 'Syncing…';
    try {
      const r = await api('POST', `/api/wallets/${w.id}/sync?provider=${provider}`);
      snapCache[`${w.id}:`] = r; snapCache[`${w.id}:${provider}`] = r;
      (r.closed || []).forEach((c) => toast(c.automatic ? `Closed ${c.name} at ${usd(c.exitUsd)} (withdrawn to wallet on ${c.date})` : `${c.name} is no longer reported — confirm on the Dashboard`));
      toast(`${SOURCES[provider].label}: ${r.items.length} item(s)${r.updated.length ? `, updated ${r.updated.length} linked position(s)` : ''}${r.suggested ? `, ${r.suggested} new fee/deposit suggestion(s) — see Dashboard` : ''}`);
      rerender();
    } finally { btn.disabled = false; btn.textContent = text; }
  })));
  $('[data-bal]', el)?.addEventListener('click', guard(async () => {
    const out = $('[data-balance]', el);
    out.textContent = 'Loading…';
    if (w.kind === 'solana') { const r = await api('GET', `/api/wallets/${w.id}/balance`); out.textContent = `Balance: ${amt(r.balance)} SOL`; }
    else { const r = await evmNativeBalance(w.address); out.textContent = `Balance on ${r.chain}: ${amt(r.balance)} ${r.symbol} (via your wallet extension)`; }
  }));
  $('[data-rename]', el).onclick = () => {
    openModal(`<div class="modal-body"><h2>Edit wallet</h2><p>Changing the start date applies to positions you track from now on and to fee/deposit suggestions. Positions already tracked keep their deposit and entry date; edit those one by one if needed.</p><div class="form">
      <label class="full">Name<input name="name" value="${esc(w.name)}" required></label>
      ${w.address ? trackFromField(w.track_from) : ''}</div></div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async (f) => { Object.keys(snapCache).forEach((k) => delete snapCache[k]); await api('PUT', `/api/wallets/${w.id}`, { name: f.name, ...(w.address ? { track_from: trackFromValue(f) } : {}) }); rerender(); });
    bindTrackFrom(modal.querySelector('form'));
  };
  $('[data-remove]', el).onclick = () => confirmModal('Remove wallet?', `Positions assigned to “${w.name}” are kept and become unassigned.`, 'Remove', async () => { await api('DELETE', `/api/wallets/${w.id}`); rerender(); });
}

// ---------- prices ----------
async function renderPrices() {
  const prices = await api('GET', '/api/prices');
  view.innerHTML = `<div class="page-head"><div><h1>Currencies & USD prices</h1><p>Used to convert each position’s profit into USD. Refresh from CoinGecko or type a price manually — stablecoins use their market quote, not an assumed $1.</p></div>
    <div class="actions"><button class="btn" id="addCur">+ Add currency</button><button class="btn primary" id="refresh">Refresh from CoinGecko</button></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Currency</th><th class="num">USD price / unit</th><th>Price date</th><th>CoinGecko id</th><th></th></tr></thead><tbody>
    ${prices.map((p) => `<tr data-sym="${esc(p.symbol)}"><td><strong>${esc(p.symbol)}</strong></td>
      <td class="num"><input type="number" step="any" min="0" name="usd_price" value="${p.usd_price ?? ''}" style="width:140px;text-align:right" ${p.symbol === 'USD' ? 'disabled' : ''}></td>
      <td><input type="date" name="price_date" value="${esc(p.price_date || '')}" ${p.symbol === 'USD' ? 'disabled' : ''}></td>
      <td><input name="coingecko_id" value="${esc(p.coingecko_id || '')}" placeholder="manual only" style="width:210px" ${p.symbol === 'USD' ? 'disabled' : ''}></td>
      <td class="num">${p.symbol === 'USD' ? '' : '<button class="btn sm danger" data-rm>Remove</button>'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('tr[data-sym] input').forEach((inp) => (inp.onchange = guard(async () => {
    const tr = inp.closest('tr');
    const body = Object.fromEntries($$('input', tr).map((i) => [i.name, i.value]));
    if (inp.name === 'usd_price') body.price_date = today();
    await api('PUT', `/api/prices/${encodeURIComponent(tr.dataset.sym)}`, body);
    $('input[name=price_date]', tr).value = body.price_date;
    toast(`${tr.dataset.sym} saved`);
  })));
  $$('[data-rm]').forEach((b) => (b.onclick = guard(async () => { await api('DELETE', `/api/prices/${encodeURIComponent(b.closest('tr').dataset.sym)}`); rerender(); })));
  $('#refresh').onclick = guard(async (e) => {
    e.target.disabled = true; e.target.textContent = 'Refreshing…';
    try { const r = await api('POST', '/api/prices/refresh'); toast(`Updated ${r.updated} of ${r.total} prices`); rerender(); }
    finally { e.target.disabled = false; e.target.textContent = 'Refresh from CoinGecko'; }
  });
  $('#addCur').onclick = () => openModal(`<div class="modal-body"><h2>Add currency</h2><p>Use the exact label you use on positions (ETH and Ethereum are different labels).</p><div class="form">
    <label>Symbol<input name="symbol" required placeholder="e.g. PENDLE"></label><label>CoinGecko id <span class="hint">optional</span><input name="coingecko_id" placeholder="e.g. pendle"></label></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Add</button></div>`,
  async (f) => { await api('POST', '/api/prices', f); rerender(); });
}

// ---------- guide ----------
function renderGuide() {
  view.innerHTML = `<div class="guide"><div class="page-head"><div><h1>Guide</h1><p>How the app maps to the BitBlock Excel tracker.</p></div></div>
  <div class="card">
  <h2 style="margin-top:0">The basics</h2>
  <ul>
    <li><strong>One position per wallet and deposit.</strong> For an additional deposit, add another position (no time-weighted cash flows, same as the sheet).</li>
    <li><strong>Record everything in the position’s currency</strong> — deposit, values, withdrawals, rewards and fees (e.g. all in USDC, or all in ETH).</li>
    <li><strong>Update value</strong> whenever you check the platform. Each update becomes a point on the charts — this is what builds your performance history.</li>
  </ul>
  <h2>Formulas (same as the spreadsheet)</h2>
  <ul>
    <li><strong>Current value</strong> = last recorded value − withdrawals made after it. You no longer need the Inputs sheet’s “withdrawals already reflected” column: the app knows from the dates.</li>
    <li><strong>Profit / loss</strong> = current (or exit) value + all withdrawals + separate rewards − additional fees − deposit. A withdrawal alone never changes profit.</li>
    <li><strong>Total return</strong> = P/L ÷ deposit. <strong>Annualized (simple)</strong> = total return × 365 ÷ days. Not APY or XIRR.</li>
    <li><strong>Duration</strong> = exit date (or latest valuation date) − entry date.</li>
    <li><strong>USD</strong> = native P/L × current USD price from the Prices page. Charts use today’s prices for past dates too, so they show performance in coin terms converted at today’s rate — not historical USD P/L.</li>
  </ul>
  <h2>Pool fees</h2>
  <ul>
    <li><strong>Uncollected fees</strong> are still in the pool, so they’re already part of the pool’s value (the Wallets page shows how much).</li>
    <li><strong>Collected fees</strong> leave the pool and land in your wallet. They count as rewards: profit = value + withdrawals + rewards − fees − deposit.</li>
    <li>With Zerion connected, each sync scans your transactions and suggests collected fees and deposits for your tracked pools. Confirm them on the Dashboard, the Positions page, or inside a position. Anything it can’t match confidently (e.g. a token that’s in several pools) is skipped; add those with <em>Reward</em> yourself.</li>
  </ul>
  <h2>Closing a position and moving money to the wallet</h2>
  <p>Money moving between your positions is never profit. When a synced pool disappears and your transactions show its tokens coming back, the app closes the pool at the amount you withdrew; without that evidence it asks you on the Dashboard (“Position closed?”). A wallet’s profit is only the price change of tokens it already held. Tokens arriving or leaving (a closed pool paying out, a transfer from an exchange, gas) are recorded as <em>capital in</em> / <em>withdrawal</em>, so the same dollars are never counted twice.</p>
  <h2>Start tracking from</h2>
  <p>Each wallet has a start date, chosen when you add or connect it (default: today). Profit made before that date is never counted. Exchange trades closed earlier and money moved earlier are ignored, positions start from their value on that date, and only later fee collections are suggested. Change it with <em>Edit</em> on the wallet. Positions you already track keep their own deposit and entry date.</p>
  <h2>Status</h2>
  <p><strong>Complete inputs</strong> (strategy, chain, currency, entry date, deposit missing) · <strong>Enter position value</strong> · <strong>Check withdrawals</strong> (value would go negative) · <strong>Check dates</strong> (valuation or exit before entry) · <strong>Open</strong> · <strong>Closed</strong>. Only Open and Closed positions count in results.</p>
  <h2>Closing & reopening</h2>
  <p>“Close position” asks for the exit date and final proceeds. Earlier partial withdrawals remain. “Reopen” clears the exit date; add a fresh value afterwards.</p>
  <h2>Wallets, DeBank & Zerion</h2>
  <p>MetaMask and Phantom connect read-only to give the app your public address. A data source then lists the DeFi positions it sees for that address; “Track” turns one into a position that is re-valued on every sync from that same source.</p>
  <ul><li><strong>DeBank</strong> — EVM chains, very broad protocol coverage. Paid API (AccessKey from cloud.debank.com).</li>
  <li><strong>Zerion</strong> — EVM chains plus Solana token balances (Zerion does not index Solana protocol positions yet). API key from dashboard.zerion.io.</li></ul>
  <h2>Backup</h2>
  <p>Data lives in a SQLite file in the <code>data/</code> volume. <a href="/api/export">Download a JSON backup</a> · <a href="/api/export.csv">Export positions as CSV</a> (columns match the Strategies sheet) · <label style="display:inline"><a href="#" id="importLink">Restore from backup…</a><input type="file" id="importFile" accept=".json" class="hidden"></label></p>
  </div></div>`;
  $('#importLink').onclick = (e) => { e.preventDefault(); $('#importFile').click(); };
  $('#importFile').onchange = guard(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    confirmModal('Restore backup?', `This replaces all current data with ${data.positions?.length ?? 0} position(s) from ${file.name}.`, 'Replace data', async () => { const r = await api('POST', '/api/import', data); toast(`Restored ${r.positions} positions`); location.hash = '#/dashboard'; });
  });
}

// ---------- boot ----------
$('#newPositionBtn').onclick = guard(async () => { await loadMeta(); openPositionForm(); });

// One click: every wallet × every connected source, then prices. Updates tracked values and suggestions.
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
async function showSyncStatus() {
  const s = await api('GET', '/api/sync-status').catch(() => null);
  $('#syncNote').textContent = s?.running ? 'Syncing…' : s?.lastSyncAt ? `Last synced ${ago(s.lastSyncAt)}` : '';
}
$('#syncAllBtn').onclick = guard(async () => {
  const b = $('#syncAllBtn');
  b.disabled = true; b.classList.add('busy'); $('#syncAllBtn span').textContent = 'Syncing…';
  try {
    const r = await api('POST', '/api/sync-all');
    Object.keys(snapCache).forEach((k) => delete snapCache[k]);
    const ok = r.results.filter((x) => x.ok);
    const failed = r.results.filter((x) => !x.ok);
    const updated = ok.reduce((a, x) => a + x.updated, 0);
    const suggested = ok.reduce((a, x) => a + x.suggested, 0);
    toast(`Synced ${ok.map((x) => x.source).join(', ') || 'nothing'} · ${updated} position(s) updated${suggested ? ` · ${suggested} new suggestion(s)` : ''}${r.prices ? ' · prices refreshed' : ''}`);
    ok.flatMap((x) => x.closedList || []).forEach((c) => toast(c.automatic ? `Closed ${c.name} at ${usd(c.exitUsd)} (withdrawn to wallet on ${c.date})` : `${c.name} is no longer reported — confirm on the Dashboard`));
    failed.forEach((x) => toast(`${x.source} (${x.wallet}): ${x.error}`, true));
    rerender();
  } finally {
    b.disabled = false; b.classList.remove('busy'); $('#syncAllBtn span').textContent = 'Sync all';
    showSyncStatus();
  }
});
showSyncStatus();
setInterval(showSyncStatus, 60000);
// Dark navy is the brand default; light is opt-in.
const isLight = () => document.documentElement.dataset.theme === 'light';
const syncThemeLabel = () => { $('#themeToggle span').textContent = isLight() ? 'Dark mode' : 'Light mode'; };
$('#themeToggle').onclick = () => {
  document.documentElement.dataset.theme = isLight() ? 'dark' : 'light';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch {}
  syncThemeLabel();
  rerender();
};
syncThemeLabel();
$('#menuBtn').onclick = () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', String(open));
};
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
route();
