import { walletSupport, connectMetaMask, connectPhantomSolana, connectPhantomEvm, connectTrustWallet, evmNativeBalance } from './wallets.js';

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Every API call is scoped to the active portfolio; the server falls back to the first one if unknown.
let currentPortfolio = (() => { try { return Number(localStorage.getItem('portfolio')) || null; } catch { return null; } })();
async function api(method, url, body) {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(currentPortfolio ? { 'x-portfolio': String(currentPortfolio) } : {}) };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
async function loadMeta() {
  meta = await api('GET', '/api/meta');
  // Every DEX the server knows becomes a sync source on the wallets it's linked to.
  for (const d of meta.dexes || []) if (d.available) SOURCES[d.id] ??= { label: d.label, kinds: d.kinds, exchange: true, where: d.what };
  if (meta.portfolio && meta.portfolio.id !== currentPortfolio) setPortfolioId(meta.portfolio.id);
  renderPortfolioSwitch();
}
function setPortfolioId(id) {
  currentPortfolio = id;
  try { localStorage.setItem('portfolio', String(id)); } catch {}
}

// ---------- portfolios ----------
function renderPortfolioSwitch() {
  const sel = $('#portfolioSel');
  if (!sel || !meta.portfolios) return;
  sel.innerHTML = meta.portfolios.map((p) => `<option value="${p.id}" ${p.id === currentPortfolio ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  sel.title = meta.portfolios.map((p) => `${p.name}: ${p.wallets} wallet(s), ${p.positions} position(s)`).join('\n');
}
async function switchPortfolio(id) {
  setPortfolioId(id);
  filters.wallet = ''; // a wallet filter from another portfolio wouldn't apply
  Object.keys(snapCache).forEach((k) => delete snapCache[k]);
  closeDrawer();
  await loadMeta();
  toast(`Switched to “${meta.portfolio?.name}”`);
  showSyncStatus();
  rerender();
}
function openPortfolioManager() {
  const rows = meta.portfolios.map((p) => `<tr><td><strong>${esc(p.name)}</strong>${p.id === currentPortfolio ? ' <span class="tag accent">active</span>' : ''}<span class="sub">${p.wallets} wallet(s) · ${p.positions} position(s)</span></td>
    <td class="num"><div class="actions" style="justify-content:flex-end">${p.id === currentPortfolio ? '' : `<button class="btn sm" data-open-pf="${p.id}">Open</button>`}<button class="btn sm" data-rename-pf="${p.id}">Rename</button>
    <button class="btn sm danger" data-del-pf="${p.id}" ${p.wallets || p.positions || meta.portfolios.length === 1 ? `disabled title="${meta.portfolios.length === 1 ? 'You need at least one portfolio' : 'Only empty portfolios can be deleted'}"` : ''}>Delete</button></div></td></tr>`).join('');
  openModal(`<div class="modal-body"><h2>Portfolios</h2><p>Each portfolio has its own wallets, positions, totals and syncs. A portfolio can hold any mix of wallets (MetaMask, Phantom, Trust Wallet, watched addresses).</p>
      <table><tbody>${rows}</tbody></table>
      <div class="form" style="margin-top:14px"><label class="full">New portfolio<input name="name" placeholder="e.g. Long-term holdings" maxlength="60"></label></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Close</button><button class="btn primary" type="submit">Create portfolio</button></div>`,
  async (f) => {
    if (!f.name.trim()) throw new Error('Enter a name for the new portfolio');
    const p = await api('POST', '/api/portfolios', { name: f.name });
    await switchPortfolio(p.id);
  });
  const form = modal.querySelector('form');
  $$('[data-open-pf]', form).forEach((b) => (b.onclick = guard(async () => { modal.close(); await switchPortfolio(Number(b.dataset.openPf)); })));
  $$('[data-rename-pf]', form).forEach((b) => (b.onclick = guard(async () => {
    const p = meta.portfolios.find((x) => x.id === Number(b.dataset.renamePf));
    const name = prompt('Rename portfolio', p.name);
    if (!name || name === p.name) return;
    await api('PUT', `/api/portfolios/${p.id}`, { name });
    modal.close(); await loadMeta(); toast('Renamed'); rerender();
  })));
  $$('[data-del-pf]', form).forEach((b) => (b.onclick = guard(async () => {
    const p = meta.portfolios.find((x) => x.id === Number(b.dataset.delPf));
    if (!confirm(`Delete the empty portfolio “${p.name}”?`)) return;
    await api('DELETE', `/api/portfolios/${p.id}`);
    modal.close(); await loadMeta(); toast('Portfolio deleted'); rerender();
  })));
}

// ---------- router ----------
const routes = { dashboard: renderDashboard, positions: renderPositions, wallets: renderWallets, prices: renderPrices, settings: renderSettings, guide: renderGuide };
async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  destroyCharts();
  try { await loadMeta(); await (routes[name] || renderDashboard)(); } catch (e) { view.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`; }
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
    ${kpi('Annualized (simple, weighted)', pct(k.weightedApr), 'Deposit-weighted, positions held 30+ days')}
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
    <div class="card-head"><div><h2>Performance matrix</h2><p>Every position: actual vs. your own target annual return (set per position; blank = none)</p></div></div>
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

// Target = the user's own "target annual return" on the position (never defaulted). vs. target needs both a
// target and 30+ days of history (MIN_DAYS_FOR_ANNUALIZED on the server).
const targetValue = (r) => (r.expected_return === null || r.expected_return === undefined ? '<span class="muted" title="No target set. Add one with Edit → Target annual return.">Not set</span>' : pct(r.expected_return));
function vsTargetCell(m) {
  const t = m.target || { status: 'none' };
  if (t.status === 'none') return '<span class="muted" title="No target set for this position">—</span>';
  if (t.status === 'too-early') return `<span class="muted" title="Compared after 30 days: annualizing ${m.duration ?? 0} day(s) of P/L would exaggerate it">after 30 d</span>`;
  return `<span class="${signCls(t.gap)}" title="Simple annualized return ${pct(m.annualized)} − your target ${pct(t.target)}">${signed(pct(t.gap), t.gap)}</span>`;
}
const annualizedNote = (m) => (m.annualized !== null && !m.annualizedReliable ? `<span class="sub" title="Held under 30 days: annualizing this short a period exaggerates it">under 30 days</span>` : '');

function performanceTable(rows) {
  // Scale the bars on positions with a meaningful annual figure, so one 2-day outlier doesn't flatten the rest.
  const max = Math.max(...rows.filter((r) => r.metrics.annualizedReliable).map((r) => Math.abs(r.metrics.annualized ?? 0)), 1e-9);
  const maxT = Math.max(...rows.map((r) => Math.abs(r.metrics.totalReturn ?? 0)), 1e-9);
  return `<table><thead><tr><th>Position</th><th>Status</th><th class="num">Deposit</th><th class="num">Value</th><th class="num">P/L</th><th class="num">Total return</th><th class="num">Annualized</th><th class="num" title="Your own target, set on each position (Edit → Target annual return). Never filled in by the app.">Your target</th><th class="num" title="Annualized (simple) − your target, once a position has 30+ days">vs. target</th><th class="num">Days</th></tr></thead><tbody>
  ${rows.map((r) => {
    const m = r.metrics;
    return `<tr class="click ${m.status === 'Closed' ? 'closed' : ''}" data-id="${r.id}">
      <td class="name-col"><strong>${esc(r.protocol || r.strategy || 'Untitled')}</strong>${hedgeTag(r.id)}<span class="sub">${esc([r.strategy, r.chain, r.wallet].filter(Boolean).join(' · '))}</span></td>
      <td>${statusPill(m.status)}</td>
      <td class="num">${amt(m.capital ?? r.deposit)} <span class="muted">${esc(r.currency || '')}</span></td>
      <td class="num">${amt(m.currentValue)}</td>
      <td class="num ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)}<span class="sub">${m.pnlUsd !== null ? usd(m.pnlUsd) : ''}</span></td>
      <td class="num">${returnBar(m.totalReturn, maxT)}</td>
      <td class="num">${returnBar(m.annualized, max)}${annualizedNote(m)}</td>
      <td class="num">${targetValue(r)}</td>
      <td class="num">${vsTargetCell(m)}</td>
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
    <div class="card">${rows.length ? `<div class="table-wrap"><table id="pTable"><thead><tr><th>Wallet</th><th>Strategy</th><th>Protocol</th><th>Chain</th><th>Entry</th><th>Valued</th><th class="num">Deposit</th><th class="num">Current value</th><th class="num">Withdrawn</th><th class="num">Rewards</th><th class="num">Fees</th><th class="num">P/L</th><th class="num">Return</th><th class="num">Annualized</th><th class="num" title="Your own target, set on each position (Edit → Target annual return)">Your target</th><th class="num" title="Annualized − your target, once a position has 30+ days">vs. target</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => { const m = r.metrics; return `<tr class="click ${m.status === 'Closed' ? 'closed' : ''}" data-id="${r.id}" data-q="${esc([r.wallet, r.strategy, r.protocol, r.chain, r.currency, r.comments].join(' ').toLowerCase())}">
      <td>${esc(r.wallet || '—')}</td><td>${esc(r.strategy || '—')}</td><td><strong>${esc(r.protocol || '—')}</strong>${hedgeTag(r.id)}${r.debank_key ? ` <span class="tag accent" title="Auto-valued from ${sourceOf(r.debank_key)}">${sourceOf(r.debank_key)}</span>` : ''}${breakdownInline(r.sourceDetail)}</td><td>${esc(r.chain || '—')}</td>
      <td class="num">${esc(r.entry_date || '—')}</td><td class="num">${esc(r.closed ? r.exit_date : m.valuationDate || '—')}</td>
      <td class="num">${amt(m.capital ?? r.deposit)} <span class="muted">${esc(r.currency || '')}</span>${m.added ? `<span class="sub">incl. ${amt(m.added)} added</span>` : ''}</td><td class="num">${amt(m.currentValue)}</td>
      <td class="num">${m.withdrawals ? amt(m.withdrawals) : '—'}</td><td class="num">${m.rewards ? amt(m.rewards) : '—'}</td><td class="num">${m.fees ? amt(m.fees) : '—'}</td>
      <td class="num ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)}</td><td class="num ${signCls(m.totalReturn)}">${pct(m.totalReturn)}</td><td class="num ${signCls(m.annualized)}">${pct(m.annualized)}${annualizedNote(m)}</td>
      <td class="num">${targetValue(r)}</td><td class="num">${vsTargetCell(m)}</td>
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
      <label>Target annual return (optional) <span class="hint">your own goal, as a simple APR in %, e.g. 8. Leave blank for no target. The app never sets one for you.</span><input name="expected_return" type="number" step="any" value="${v.expected_return != null ? +(v.expected_return * 100).toFixed(6) : ''}"></label>
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
  reward: ['Add a reward payment', 'Rewards received separately — only if not already in the position value or a withdrawal. Convert other tokens to this position’s currency first.'],
  deposit: ['Add capital', 'Money or tokens added to this position after it started (a top-up). Raises the amount invested, not the profit.'],
  fee: ['Record fee', 'Costs not already deducted from the position value, withdrawals or rewards (e.g. gas, bridge fees).'],
};
// Rewards: either the platform's total-to-date (replaces the total) or one payment (adds to it).
function openRewardForm(p) {
  const cur = esc(p.currency || '');
  const now = p.metrics.rewards || 0;
  openModal(`<div class="modal-body"><h2>Rewards</h2><p>Rewards to date on this position: <strong>${amt(now)} ${cur}</strong>. Fees are recorded separately with <em>Fee</em>.</p>
    <div class="mode-choice">
      <label><input type="radio" name="mode" value="total" checked><div><b>Update total rewards to date</b><span>Enter the total the platform shows now. It <u>replaces</u> the current total: ${amt(now)} → your number.</span></div></label>
      <label><input type="radio" name="mode" value="payment"><div><b>Add one reward payment</b><span>A single payment you received. It is <u>added</u> to the current total.</span></div></label>
    </div>
    <div class="form">
      <label>Date<input name="date" type="date" value="${today()}" required></label>
      <label><span data-amount-label>Total rewards to date (${cur})</span><input name="amount" type="number" step="any" min="0" required autofocus></label>
      <label class="full">Note<input name="note" placeholder="optional, e.g. claimed on the platform"></label>
      <p class="full muted" data-preview style="margin:0;font-size:12px"></p></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
  async (f) => {
    const type = f.mode === 'total' ? 'reward_total' : 'reward';
    await api('POST', `/api/positions/${p.id}/events`, { type, date: f.date, amount: f.amount, note: f.note });
    toast(type === 'reward_total' ? `Rewards to date set to ${amt(Number(f.amount))} ${p.currency || ''}` : 'Reward payment added');
    openDrawer(p.id); rerender();
  });
  const form = modal.querySelector('form');
  const preview = () => {
    const mode = form.mode.value, v = Number(form.amount.value);
    $('[data-amount-label]', form).textContent = mode === 'total' ? `Total rewards to date (${p.currency || ''})` : `Payment amount (${p.currency || ''})`;
    $('[data-preview]', form).textContent = form.amount.value === '' ? '' : `After saving, rewards to date will be ${amt(mode === 'total' ? v : now + v)} ${p.currency || ''}.${mode === 'total' && v < now ? ' (Lower than now: that is fine if you are correcting the total.)' : ''}`;
  };
  form.addEventListener('input', preview); form.addEventListener('change', preview);
}

// Correct an entry in place. The server keeps the previous values, so it can be undone.
const EVENT_NAMES = { valuation: 'value update', withdrawal: 'withdrawal', reward: 'reward payment', reward_total: 'rewards to date', fee: 'fee', deposit: 'capital in' };
function openEditEventForm(p, e) {
  const cur = esc(p.currency || '');
  const rewardFamily = e.type === 'reward' || e.type === 'reward_total';
  openModal(`<div class="modal-body"><h2>Correct this entry (${EVENT_NAMES[e.type] || e.type})</h2>
    <p>Currently <strong>${amt(e.amount)} ${cur}</strong> on ${esc(e.date)}. Your change replaces it everywhere (P/L, returns, charts), and the old value is kept in the correction history so you can undo it.</p>
    <div class="form">
      ${rewardFamily ? `<label class="full">Recorded as<select name="type">
        <option value="reward_total" ${e.type === 'reward_total' ? 'selected' : ''}>Total rewards to date (replaces the total)</option>
        <option value="reward" ${e.type === 'reward' ? 'selected' : ''}>One reward payment (adds to the total)</option></select></label>` : ''}
      <label>Date<input name="date" type="date" value="${esc(e.date)}" required></label>
      <label>Amount (${cur})<input name="amount" type="number" step="any" min="0" value="${e.amount}" required autofocus></label>
      <label class="full">Note<input name="note" value="${esc(e.note || '')}"></label>
      <label class="full">Reason for the correction <span class="hint">optional, e.g. “typo: 977 → 77”</span><input name="reason"></label></div></div>
    <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Save correction</button></div>`,
  async (f) => {
    const r = await api('PUT', `/api/events/${e.id}`, { ...(f.type ? { type: f.type } : {}), date: f.date, amount: f.amount, note: f.note, reason: f.reason });
    toast(r.changed ? 'Corrected. Previous value kept in history' : 'Nothing changed');
    openDrawer(p.id); rerender();
  });
}

function revisionsCard(p, revs) {
  if (!revs?.length) return '';
  const cur = esc(p.currency || '');
  const show = (x) => (x ? `${esc(EVENT_NAMES[x.type] || x.type)} ${amt(x.amount)} ${cur} · ${esc(x.date)}` : '—');
  return `<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Correction history</h2><p>Every edit, deletion and restore, newest first. Restore puts an entry back the way it was before that change.</p></div></div>
    <table><tbody>${revs.map((r) => `<tr><td class="num" style="text-align:left;white-space:nowrap">${esc(r.changed_at.slice(0, 16))}</td>
      <td><span class="tag ${r.action === 'delete' ? '' : 'accent'}">${r.action === 'update' ? 'corrected' : r.action === 'delete' ? 'deleted' : 'restored'}</span>
      <span class="sub">${r.action === 'restore' ? `back to ${show(r.after)}` : `${show(r.before)} → ${r.action === 'delete' ? 'removed' : show(r.after)}`}${r.reason ? ` · “${esc(r.reason)}”` : ''}</span></td>
      <td class="num">${r.before && r.action !== 'restore' ? `<button class="btn sm" data-restore="${r.id}">Restore</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

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
  const [rows, series, sugg, revs] = await Promise.all([api('GET', '/api/positions'), api('GET', `/api/positions/${id}/series`), api('GET', `/api/suggestions?position=${id}`).catch(() => []), api('GET', `/api/positions/${id}/revisions`).catch(() => [])]);
  const p = rows.find((r) => r.id === id);
  if (!p) return closeDrawer();
  const m = p.metrics;
  const cur = esc(p.currency || '');
  const evs = [...p.events].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  panel.innerHTML = `<div class="drawer-head"><div><div class="muted" style="font-size:12px">${esc([p.wallet || 'Unassigned', p.chain].join(' · '))}</div>
      <h1 id="drawerTitle">${esc(p.protocol || p.strategy || 'Position')}</h1><div style="margin-top:6px;display:flex;gap:6px;align-items:center">${statusPill(m.status)} <span class="tag">${esc(p.strategy || '')}</span>${p.debank_key ? `<span class="tag accent">${sourceOf(p.debank_key)}-linked</span>` : ''}${hedgeTag(p.id)}</div></div>
      <button class="icon-btn" id="dClose" aria-label="Close">✕</button></div>
    <div class="actions" style="margin-bottom:14px">
      ${p.closed ? '<button class="btn sm" data-act="reopen">Reopen</button>' : `<button class="btn sm primary" data-act="valuation">Update value</button><button class="btn sm" data-act="withdrawal">Withdrawal</button><button class="btn sm" data-act="rewards" title="Update total rewards to date, or add one payment">Rewards</button><button class="btn sm" data-act="fee">Fee</button><button class="btn sm" data-act="deposit">Add capital</button><button class="btn sm" data-act="close">Close position</button>`}
      <button class="btn sm" data-act="edit">Edit</button><button class="btn sm danger" data-act="delete">Delete</button></div>
    <div class="metric-grid" style="margin-bottom:14px">
      <div><div class="label">Deposit${m.added ? ' (incl. capital added)' : ''}</div><div class="v">${amt(m.capital ?? p.deposit)} ${cur}</div></div>
      <div><div class="label">${p.closed ? 'Exit value' : 'Current value'}</div><div class="v">${amt(m.currentValue)} ${cur}</div></div>
      <div><div class="label">Profit / loss</div><div class="v ${signCls(m.pnl)}">${m.pnl === null ? '—' : signed(amt(m.pnl), m.pnl)} ${cur}</div></div>
      <div><div class="label">Total return</div><div class="v ${signCls(m.totalReturn)}">${pct(m.totalReturn)}</div></div>
      <div><div class="label">Annualized (simple)</div><div class="v ${signCls(m.annualized)}">${pct(m.annualized)}${annualizedNote(m)}</div></div>
      <div><div class="label" title="Your own target on this position (Edit → Target annual return)">Your target → vs. target</div><div class="v" style="font-size:14px">${targetValue(p)} → ${vsTargetCell(m)}</div></div>
      <div><div class="label">Withdrawn</div><div class="v">${amt(m.withdrawals)}</div></div>
      <div><div class="label">Rewards to date · fees</div><div class="v" style="font-size:14px">${amt(m.rewards)} · −${amt(m.fees)}</div></div>
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
      ${evs.length ? `<table><tbody>${evs.map((e) => `<tr><td class="num" style="text-align:left">${esc(e.date)}</td><td><span class="tag">${esc(EVENT_NAMES[e.type] || e.type)}</span>${SOURCES[e.source] ? ` <span class="tag">${SOURCES[e.source].label}</span>` : ''}${e.corrected ? ' <span class="tag accent" title="This entry was corrected; see Correction history">corrected</span>' : ''}<span class="sub">${esc(e.note || '')}</span></td><td class="num">${e.type === 'withdrawal' || e.type === 'fee' ? '−' : e.type === 'deposit' ? '+' : e.type === 'reward_total' ? '= ' : ''}${amt(e.amount)} ${cur}</td><td style="width:1%;white-space:nowrap"><button class="btn sm" data-edit="${e.id}" aria-label="Correct entry" title="Correct this entry">✎</button> <button class="btn sm danger" data-del="${e.id}" aria-label="Delete entry">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No activity yet.</p>'}</div>
    ${revisionsCard(p, revs)}`;

  $('#dClose').onclick = closeDrawer;
  $$('[data-act]', panel).forEach((b) => (b.onclick = guard(async () => {
    const a = b.dataset.act;
    if (a === 'rewards') return openRewardForm(p);
    if (EVENT_LABELS[a]) return openEventForm(p, a);
    if (a === 'close') return openCloseForm(p);
    if (a === 'edit') return openPositionForm(p);
    if (a === 'reopen') { await api('POST', `/api/positions/${p.id}/reopen`); toast('Reopened'); openDrawer(p.id); return rerender(); }
    if (a === 'delete') return confirmModal('Delete position?', 'This removes the position and all of its activity. This cannot be undone.', 'Delete', async () => { await api('DELETE', `/api/positions/${p.id}`); closeDrawer(); toast('Deleted'); rerender(); });
  })));
  $$('[data-edit]', panel).forEach((b) => (b.onclick = () => openEditEventForm(p, p.events.find((e) => e.id === Number(b.dataset.edit)))));
  $$('[data-del]', panel).forEach((b) => (b.onclick = () => {
    const e = p.events.find((x) => x.id === Number(b.dataset.del));
    openModal(`<div class="modal-body"><h2>Delete this ${esc(EVENT_NAMES[e.type] || e.type)}?</h2><p>${amt(e.amount)} ${esc(p.currency || '')} on ${esc(e.date)}. It's kept in the correction history, so you can restore it. To fix a wrong amount, use ✎ instead.</p>
      <div class="form"><label class="full">Reason <span class="hint">optional</span><input name="reason"></label></div></div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Delete entry</button></div>`,
    async (f) => { await api('DELETE', `/api/events/${e.id}?reason=${encodeURIComponent(f.reason || '')}`); toast('Deleted. Restorable from Correction history'); openDrawer(p.id); rerender(); });
  }));
  $$('[data-restore]', panel).forEach((b) => (b.onclick = guard(async () => { await api('POST', `/api/revisions/${b.dataset.restore}/restore`); toast('Restored'); openDrawer(p.id); rerender(); })));
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
// exchange: a DEX account, linked to one wallet with "Add DEX account" (opt-in), rather than a source for the whole portfolio.
const SOURCES = {
  debank: { label: 'DeBank', kinds: ['evm'], where: 'EVM DeFi positions.' },
  zerion: { label: 'Zerion', kinds: ['evm', 'solana'], where: 'EVM DeFi positions + wallet balances, Solana balances.' },
  lighter: { label: 'Lighter', kinds: ['evm'], exchange: true, where: 'Perps account + LLP / public pools, with your deposit and daily history. Public API, no key needed.' },
  extended: { label: 'Extended', kinds: ['evm'], exchange: true, where: 'Perps account equity + net deposits (read-only key from Extended → API management).' },
};
// A source's state for one wallet: portfolio sources from meta, exchanges only where this wallet has one linked.
const sourceMode = (id, w) => (SOURCES[id]?.exchange || !SOURCES[id] ? (w.exchanges?.[id] ? 'live' : 'off') : meta[id]);
const dexLabel = (id) => meta.dexes?.find((d) => d.id === id)?.label || SOURCES[id]?.label || id;
const sourceOf = (key) => SOURCES[key?.split('|')[0]]?.label || 'DeBank';
const snapCache = {};

function sourcesBanner() {
  const portfolioSources = Object.entries(SOURCES).filter(([, s]) => !s.exchange);
  const on = portfolioSources.filter(([id]) => meta[id] === 'live').map(([, s]) => s.label);
  const off = portfolioSources.filter(([id]) => meta[id] === 'off').map(([, s]) => s.label);
  return `<div class="banner"><span>ℹ</span><div style="flex:1"><strong>Step 1: data sources</strong> for this portfolio. Portfolio trackers: ${on.length ? `${esc(on.join(', '))} connected` : 'none connected yet'}${off.length ? ` · ${esc(off.join(', '))} not set up` : ''}. DEX accounts (Lighter, Extended…) are optional: add them to a wallet with <em>Add DEX account</em>.
    <a href="#/settings">Manage data sources →</a><br><strong>Step 2: wallets</strong> (below): add each address once; then <em>Sync</em> pulls its positions from the connected sources.</div></div>`;
}

async function renderWallets() {
  await loadMeta();
  const wallets = await api('GET', '/api/wallets');
  const sup = walletSupport();

  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Portfolio</div><h1>Wallets in “${esc(meta.portfolio?.name || '')}”</h1><p>Wallets belong to the active portfolio; a portfolio can mix MetaMask, Phantom, Trust Wallet and watched addresses. Connect a browser wallet or paste an address. Read-only: the app only asks for your public address — never a signature or transaction.</p></div></div>
  ${sourcesBanner()}
  <section class="grid connect-grid">
    <div class="card connect"><div class="ico" style="background:#f6851b">M</div><h2>MetaMask</h2><p>Connect your EVM address (Ethereum, Arbitrum, Base…). Syncs with DeBank or Zerion.</p>
      <button class="btn primary" id="cMetaMask" ${sup.metamask ? '' : 'disabled'}>${sup.metamask ? 'Connect MetaMask' : 'MetaMask not detected'}</button></div>
    <div class="card connect"><div class="ico" style="background:#ab9ff2">P</div><h2>Phantom</h2><p>Connect your Solana address (balances via Zerion), or Phantom’s EVM address.</p>
      <div class="actions"><button class="btn primary" id="cPhantom" ${sup.phantomSolana ? '' : 'disabled'}>${sup.phantomSolana ? 'Connect Solana' : 'Phantom not detected'}</button>
      ${sup.phantomEvm ? '<button class="btn" id="cPhantomEvm">Connect EVM</button>' : ''}</div></div>
    <div class="card connect"><div class="ico" style="background:#3375bb">T</div><h2>Trust Wallet</h2><p>Connect the Trust Wallet browser extension’s EVM address. Syncs with Zerion or DeBank.</p>
      <button class="btn primary" id="cTrust" ${sup.trust ? '' : 'disabled'}>${sup.trust ? 'Connect Trust Wallet' : 'Trust Wallet not detected'}</button></div>
    <div class="card connect"><div class="ico" style="background:var(--accent)">#</div><h2>Watch an address</h2><p>Paste any EVM (0x…) or Solana address — no extension needed. Or add a named wallet without an address.</p>
      <button class="btn" id="cAddress">Add address</button></div>
  </section>
  ${!sup.metamask && !sup.phantomSolana && !sup.trust ? '<p class="muted" style="margin:-8px 0 20px">No wallet extension found in this browser. Open this page in Chrome/Brave/Firefox with MetaMask or Phantom installed — extensions work on <code>http://localhost</code>.</p>' : ''}
  <section class="stack">${wallets.length ? wallets.map(walletCard).join('') : '<div class="card empty"><h2>No wallets yet</h2><p>Connect or add one above. Positions can then be assigned to it.</p></div>'}</section>`;

  const connected = (name, address, source) => openWalletForm({ name, address, source, title: 'Wallet connected', lockAddress: true }, rerender);
  $('#cMetaMask').onclick = guard(async () => { const a = await connectMetaMask(); connected(`MetaMask ${short(a)}`, a, 'metamask'); });
  $('#cPhantom').onclick = guard(async () => { const a = await connectPhantomSolana(); connected(`Phantom SOL ${short(a)}`, a, 'phantom'); });
  $('#cPhantomEvm') && ($('#cPhantomEvm').onclick = guard(async () => { const a = await connectPhantomEvm(); connected(`Phantom EVM ${short(a)}`, a, 'phantom'); }));
  $('#cTrust').onclick = guard(async () => { const a = await connectTrustWallet(); connected(`Trust Wallet ${short(a)}`, a, 'trustwallet'); });
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
  const usable = Object.entries(SOURCES).filter(([id, s]) => s.kinds.includes(w.kind) && sourceMode(id, w) !== 'off');
  const main = (usable.find(([id]) => sourceMode(id, w) === 'live') || usable.find(([id]) => sourceMode(id, w) === 'mock'))?.[0];
  return usable.map(([id, s]) =>
    `<button class="btn sm ${id === main ? 'primary' : ''}" data-sync="${id}">Sync from ${s.label}${sourceMode(id, w) === 'mock' ? ' (demo)' : ''}</button>`).join('');
}

// DEX accounts linked to this wallet, and a way to add one.
function exchangeTags(w) {
  if (!(meta.dexes || []).some((d) => d.kinds.includes(w.kind))) return '';
  const linked = Object.entries(w.exchanges || {}).map(([id, x]) => `<span class="tag accent" title="${x.auth === 'key' ? 'DEX account with its own read-only key (last 4 characters shown)' : 'DEX account found from this wallet’s address'}">${esc(dexLabel(id))}${x.masked ? ` ${esc(x.masked)}` : ''}</span>`).join(' ');
  return `<p>${linked}${linked ? ' ' : ''}<button class="btn sm" data-add-dex>+ Add DEX account</button></p>`;
}

// Add a DEX account to a wallet. wallet: preset, or chosen from `wallets`.
function openDexForm({ wallet = null, wallets = [] } = {}, onDone) {
  const all = (meta.dexes || []).filter((d) => (wallet ? [wallet] : wallets).some((w) => d.kinds.includes(w.kind)));
  const choices = all.filter((d) => d.available);
  const unavailable = all.filter((d) => !d.available);
  if (!choices.length) { toast('Add an EVM wallet first: DEX accounts are linked to a wallet.', true); return; }
  const walletsFor = (d) => (wallet ? [wallet] : wallets).filter((w) => d.kinds.includes(w.kind) && !w.exchanges?.[d.id]);
  openModal(`<div class="modal-body"><h2>Add a DEX account</h2><p>The account is linked to one wallet only: other wallets and portfolios never see it.</p><div class="form">
      <label class="full">DEX<select name="dex">${choices.map((d) => `<option value="${d.id}">${esc(d.label)}${d.auth === 'key' ? ' · API key' : ' · no key needed'}${d.beta ? ' · beta' : ''}</option>`).join('')}${unavailable.map((d) => `<option disabled>${esc(d.label)} · not available yet</option>`).join('')}</select><span class="hint" data-dex-what></span></label>
      ${unavailable.length ? `<p class="full muted" style="margin:0;font-size:12px">${unavailable.map((d) => `<strong>${esc(d.label)}</strong>: ${esc(d.what)}.`).join(' ')}</p>` : ''}
      ${wallet ? `<input type="hidden" name="wallet" value="${wallet.id}">` : '<label class="full">Wallet<select name="wallet"></select></label>'}
      <label class="full" data-key-field>Read-only API key <span class="hint" data-key-help></span><input name="key" type="password" autocomplete="new-password" spellcheck="false"></label>
      <p class="full muted" data-dex-note style="margin:0;font-size:12px"></p></div></div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Add account</button></div>`,
  async (f) => {
    const d = choices.find((x) => x.id === f.dex);
    if (!f.wallet) throw new Error(`Every wallet here already has a ${d.label} account`);
    const w = (wallet ? [wallet] : wallets).find((x) => x.id === Number(f.wallet));
    const r = await api('POST', `/api/wallets/${w.id}/dex`, { dex: d.id, ...(d.auth === 'key' ? { key: f.key } : {}) });
    toast(d.auth === 'key' ? `${d.label} account linked to ${w.name}${r.saved ? ' and saved to .env' : ''}`
      : r.found === false ? `${d.label} added to ${w.name}, but no ${d.label} account was found at this address yet` : `${d.label} account added to ${w.name}; sync it from the wallet card`, r.found === false);
    if (r.warning) toast(r.warning, true);
    onDone?.();
  });
  const form = modal.querySelector('form');
  const sel = form.querySelector('[name=dex]');
  const update = () => {
    const d = choices.find((x) => x.id === sel.value);
    form.querySelector('[data-dex-what]').textContent = `${d.what}.${d.beta ? ' Beta: built from the official API docs but not yet checked against a real account; check the numbers against the exchange after the first sync.' : ''}`;
    const key = d.auth === 'key';
    form.querySelector('[data-key-field]').style.display = key ? '' : 'none';
    form.querySelector('[name=key]').required = key;
    form.querySelector('[data-key-help]').textContent = key ? `${d.keyHelp || `create one in ${d.label}`}. Checked with ${d.label} before saving; stored in your .env file, never shown again.` : '';
    form.querySelector('[data-dex-note]').textContent = key ? '' : `No key needed: ${d.label} finds the account from the wallet’s address.`;
    if (!wallet) {
      const ws = walletsFor(d);
      form.querySelector('select[name=wallet]').innerHTML = ws.length ? ws.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('') : '<option value="">(every wallet already has one)</option>';
    }
  };
  sel.onchange = update;
  update();
}

function walletCard(w) {
  const last = w.lastSync ? ` · Last sync: ${SOURCES[w.lastSync.provider]?.label || 'DeBank'}, ${esc(w.lastSync.fetched_at)} UTC · ${usd(w.lastSync.total_usd)} total` : '';
  return `<div class="card wallet-card" id="w${w.id}">
    <div class="card-head"><div><h2>${esc(w.name)} <span class="tag">${w.kind === 'evm' ? 'EVM' : w.kind === 'solana' ? 'Solana' : 'Manual'}</span>${({ metamask: 'MetaMask', phantom: 'Phantom', trustwallet: 'Trust Wallet' })[w.source] ? ` <span class="tag">${({ metamask: 'MetaMask', phantom: 'Phantom', trustwallet: 'Trust Wallet' })[w.source]}</span>` : ''}</h2>
      <div class="addr">${esc(w.address || 'No address')}</div>
      <p>${w.positions} position(s)${last}</p>
      <p><span class="tag ${w.track_from ? 'accent' : ''}" title="Profit before this date isn’t counted for this wallet">${esc(trackFromLabel(w.track_from))}</span></p>
      ${exchangeTags(w)}</div>
      <div class="actions">
        ${syncButtons(w)}
        ${w.kind === 'evm' ? `<a class="btn sm" href="https://debank.com/profile/${esc(w.address)}" target="_blank" rel="noopener">DeBank ↗</a><a class="btn sm" href="https://app.zerion.io/${esc(w.address)}/overview" target="_blank" rel="noopener">Zerion ↗</a><button class="btn sm" data-bal>Wallet balance</button>` : ''}
        ${w.kind === 'solana' ? `<button class="btn sm" data-bal>Wallet balance</button><a class="btn sm" href="https://solscan.io/account/${esc(w.address)}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}
        <button class="btn sm" data-rename>Edit</button><button class="btn sm danger" data-remove>Remove</button></div></div>
    <div data-balance class="ink2"></div>
    <div data-items></div></div>`;
}

// Every token in the wallet right now, from this portfolio's tracker. Without one: the native coin only.
const TRACKER_LABEL = { zerion: 'Zerion', debank: 'DeBank', 'solana-rpc': 'Solana RPC' };
async function walletBalanceHtml(w) {
  const r = await api('GET', `/api/wallets/${w.id}/holdings`);
  if (!r.source) {
    const n = await evmNativeBalance(w.address).catch(() => null);
    return `<div class="holdings"><p class="muted">${n ? `Native balance on ${esc(n.chain)}: <strong>${amt(n.balance)} ${esc(n.symbol)}</strong> (from your wallet extension). ` : ''}To see every token in this wallet across chains, add a Zerion or DeBank key for this portfolio on <a href="#/settings">Data sources</a>.</p></div>`;
  }
  const small = (h) => h.valueUsd !== null && h.valueUsd < 1;
  const nSmall = r.holdings.filter(small).length;
  const rows = r.holdings.map((h) => `<tr ${small(h) ? 'data-small hidden' : ''}><td><strong>${esc(h.symbol)}</strong>${h.name && h.name !== h.symbol ? `<span class="sub">${esc(h.name)}</span>` : ''}</td><td>${esc(h.chain)}</td>
    <td class="num">${amt(h.qty)}</td><td class="num">${h.priceUsd != null ? usd(h.priceUsd) : '—'}</td><td class="num">${h.valueUsd != null ? usd(h.valueUsd) : '—'}</td></tr>`).join('');
  return `<div class="holdings"><div class="card-head" style="margin:6px 0 8px"><h3>Wallet balance <span class="tag accent">via ${esc(TRACKER_LABEL[r.source] || r.source)}</span>${r.mock ? ' <span class="tag">demo data — not your wallet</span>' : ''}</h3>
      <div class="actions"><strong>${usd(r.totalUsd)}</strong></div></div>
    ${r.holdings.length ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Chain</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No tokens in this wallet.</p>'}
    ${nSmall ? `<button class="btn sm" data-dust>Show ${nSmall} balance(s) under $1</button>` : ''}
    <p class="muted" style="font-size:12px">Tokens held directly in the wallet, at current prices. DeFi positions (pools, staking, lending) are listed under “Detected DeFi positions”.${r.nativeOnly ? ' Only SOL is shown: add a Zerion key for this portfolio to see every Solana token.' : ''}</p></div>`;
}

async function bindWalletCard(w) {
  const el = $(`#w${w.id}`);
  const items = $('[data-items]', el);
  const sources = Object.keys(SOURCES).filter((id) => SOURCES[id].kinds.includes(w.kind) && (!SOURCES[id].exchange || w.exchanges?.[id]));
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
  $('[data-bal]', el)?.addEventListener('click', guard(async (e) => {
    const out = $('[data-balance]', el);
    if (out.dataset.open) { out.innerHTML = ''; delete out.dataset.open; e.target.textContent = 'Wallet balance'; return; }
    out.innerHTML = '<p class="muted">Loading wallet balance…</p>';
    try { out.innerHTML = await walletBalanceHtml(w); out.dataset.open = '1'; e.target.textContent = 'Hide wallet balance'; }
    catch (err) { out.innerHTML = ''; throw err; }
    $('[data-dust]', out)?.addEventListener('click', (ev) => { $$('tr[data-small]', out).forEach((tr) => (tr.hidden = !tr.hidden)); ev.target.remove(); });
  }));
  $('[data-rename]', el).onclick = () => {
    openModal(`<div class="modal-body"><h2>Edit wallet</h2><p>Changing the start date applies to positions you track from now on and to fee/deposit suggestions. Positions already tracked keep their deposit and entry date; edit those one by one if needed.</p><div class="form">
      <label class="full">Name<input name="name" value="${esc(w.name)}" required></label>
      ${w.address ? trackFromField(w.track_from) : ''}</div></div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>`,
    async (f) => { Object.keys(snapCache).forEach((k) => delete snapCache[k]); await api('PUT', `/api/wallets/${w.id}`, { name: f.name, ...(w.address ? { track_from: trackFromValue(f) } : {}) }); rerender(); });
    bindTrackFrom(modal.querySelector('form'));
  };
  $('[data-remove]', el).onclick = () => confirmModal('Remove wallet?', `Positions assigned to “${w.name}” are kept and become unassigned.${Object.keys(w.exchanges || {}).length ? ' Its DEX account keys are deleted from .env.' : ''}`, 'Remove', async () => { await api('DELETE', `/api/wallets/${w.id}`); rerender(); });
  $('[data-add-dex]', el)?.addEventListener('click', () => openDexForm({ wallet: w }, rerender));
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

// ---------- data sources (API keys) ----------
// Keys belong to the active portfolio (Zerion, DeBank) or to one of its wallets (exchange accounts).
const keyPill = (mode) => (mode === 'live' ? '<span class="pill open"><span class="dot"></span>Connected</span>'
  : mode === 'mock' ? '<span class="pill warn"><span class="dot"></span>Demo data</span>' : '<span class="pill"><span class="dot"></span>Not set up</span>');

// One key form: save & test, test, remove. `q` adds ?wallet= for exchange accounts.
function bindKeyCard(card, { id, label, q = '', configured }) {
  const result = $('[data-result]', card);
  $('[data-key-form]', card).onsubmit = guard(async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', card), input = $('input[name=key]', card);
    btn.disabled = true; btn.textContent = 'Testing…'; result.textContent = '';
    try {
      const r = await api('PUT', `/api/settings/${id}${q}`, { key: input.value });
      input.value = '';
      toast(`${label} connected${r.saved ? ' and saved to .env' : ''}`);
      if (r.warning) toast(r.warning, true);
      await loadMeta(); rerender();
    } catch (err) { result.textContent = err.message; result.className = 'full neg'; }
    finally { btn.disabled = false; btn.textContent = 'Save & test'; }
  });
  if (!configured) return;
  bindKeyTest(card, id, label, q);
  $('[data-remove]', card).addEventListener('click', () => confirmModal(`Remove the ${label} key?`, `${label} stops syncing here until you add a key again. Positions already tracked are kept.`, 'Remove key',
    async () => { await api('DELETE', `/api/settings/${id}${q}`); toast(`${label} key removed`); await loadMeta(); rerender(); }));
}

function bindKeyTest(card, id, label, q = '') {
  $('[data-test]', card).addEventListener('click', guard(async (e) => {
    e.target.disabled = true; e.target.textContent = 'Testing…';
    try { const r = await api('POST', `/api/settings/${id}/test${q}`); toast(`${label}: ${r.message}`, !r.ok); }
    finally { e.target.disabled = false; e.target.textContent = 'Test connection'; }
  }));
}

const keyActions = (k) => (k.configured ? `<div class="actions"><span class="tag" title="Only the last 4 characters are shown">${esc(k.masked)}</span><button class="btn sm" data-test>Test connection</button><button class="btn sm danger" data-remove>Remove key</button></div>` : '');
const legacyNote = (k, wallet) => (k.from === 'legacy' ? `<p class="muted" style="font-size:12px;margin:4px 0 0">This key comes from the older <code>${esc(k.legacyEnv)}</code> line in .env, which ${wallet ? 'is linked to this wallet only' : 'only applies to your first portfolio'}. Saving a key here replaces it.</p>` : '');
const keyForm = (label, url, hint, configured) => `<form class="form" data-key-form autocomplete="off">
    <label class="full">${configured ? 'Replace key' : 'API key'} <span class="hint">get one at <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace('https://', ''))}</a>. ${hint}</span>
      <div style="display:flex;gap:8px"><input name="key" type="password" placeholder="Paste your ${esc(label)} key" autocomplete="new-password" spellcheck="false" style="flex:1"><button class="btn primary" type="submit">Save &amp; test</button></div></label>
    <p class="full muted" data-result style="margin:0;font-size:12px"></p></form>`;

const sectionHead = (title, text) => `<div class="section-head"><h2>${title}</h2><p>${text}</p></div>`;

async function renderSettings() {
  await loadMeta();
  const st = await api('GET', '/api/settings');
  const pname = esc(st.portfolio?.name || '');
  const linked = st.wallets.flatMap((w) => Object.entries(w.exchanges).map(([id, x]) => ({ w, id, x })));
  const evmWallets = st.wallets.filter((w) => w.kind === 'evm');
  const dex = Object.fromEntries(st.dexes.map((d) => [d.id, d]));
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Portfolio setup</div><h1>Data sources for “${pname}”</h1>
      <p>Everything here belongs to <strong>this portfolio only</strong>; switch portfolio at the top to set up another. Wallets are added on the <a href="#/wallets">Wallets</a> page.</p></div></div>
    ${st.envFile.writable ? '' : `<div class="banner"><span>⚠</span><div><strong>Keys can’t be saved to .env:</strong> ${esc(st.envFile.reason || '')}. Keys you enter still work until the app restarts. To make them permanent, run <code>cp .env.example .env</code> in the app folder, then <code>docker compose up -d</code>, and enter them again.</div></div>`}

    ${sectionHead('Portfolio trackers', `On-chain data aggregators: they read everything a wallet holds across chains (DeFi positions and token balances) from its address. One key each, used by every wallet in “${pname}”.`)}
    <section class="stack">
      ${st.sources.map((s) => `<div class="card" data-src="${s.id}"><div class="card-head"><div><h2>${esc(s.label)} ${keyPill(s.mode)}</h2><p>${esc(s.what)}.</p>${legacyNote(s)}</div>${keyActions(s)}</div>
        ${keyForm(s.label, s.url, `It’s checked with ${esc(s.label)} before saving and stored in your .env file for this portfolio.`, s.configured)}</div>`).join('')}
    </section>

    ${sectionHead('DEX accounts', 'Your accounts on decentralized exchanges: trading positions, liquidity pools and staking, with deposits so profit is exact. Optional: nothing is set up until you add an account, and each account belongs to one wallet.')}
    <div class="actions" style="margin:-4px 0 12px">${evmWallets.length ? '<button class="btn primary" data-add-dex>+ Add DEX account</button>' : '<span class="muted">Add a wallet first: DEX accounts are linked to a wallet.</span>'}
      <span class="muted" style="font-size:12px">Available: ${esc(st.dexes.filter((d) => d.available).map((d) => d.label + (d.beta ? ' (beta)' : '')).join(', '))}${st.dexes.some((d) => !d.available) ? ` · not available yet: ${esc(st.dexes.filter((d) => !d.available).map((d) => d.label).join(', '))}` : ''}</span></div>
    <section class="stack">
      ${linked.length ? linked.map(({ w, id, x }) => { const d = dex[id] || { label: id }; const a = x.account;
        const status = !a?.synced ? '<span class="muted">not synced yet: use <em>Sync</em> on the wallet card</span>'
          : a.found ? `<span class="muted">${usd(a.totalUsd)} · last sync ${esc(a.fetchedAt)} UTC</span>` : '<span class="muted">no account found at this address in the last sync</span>';
        return `<div class="card" data-ex="${id}:${w.id}"><div class="card-head"><div><h2>${esc(d.label)} · ${esc(w.name)} ${keyPill('live')}${d.beta ? ' <span class="tag">beta</span>' : ''}</h2><p>${esc(d.what || '')}. ${d.auth === 'key' ? 'Read-only API key.' : 'No key: found from the wallet’s address.'}</p><p>${status}</p>${x.from === 'legacy' ? legacyNote({ from: 'legacy', legacyEnv: `${id.toUpperCase()}_API_KEY` }, true) : ''}</div>
          <div class="actions">${d.auth === 'key' ? `<span class="tag" title="Only the last 4 characters are shown">${esc(x.masked)}</span><button class="btn sm" data-test>Test connection</button>` : ''}<button class="btn sm danger" data-unlink>Remove account</button></div></div>
          ${d.auth === 'key' ? keyForm(d.label, d.url || '', `Linked to ${esc(w.name)} only.`, true) : ''}</div>`; }).join('')
        : '<div class="card"><p class="muted" style="margin:0">No DEX accounts in this portfolio yet.</p></div>'}
    </section>
    <p class="muted" style="font-size:12px;margin-top:14px">Keys stay on this computer, in the app’s .env file, one line per portfolio or wallet. The app never shows them again (only the last 4 characters) and changing them is only allowed from this computer, unless APP_PASSWORD protects the app.</p>`;

  for (const s of st.sources) bindKeyCard($(`[data-src="${s.id}"]`), { id: s.id, label: s.label, configured: s.configured });
  for (const { w, id } of linked) {
    const card = $(`[data-ex="${id}:${w.id}"]`);
    const label = `${dex[id]?.label || id} (${w.name})`;
    if (dex[id]?.auth === 'key') bindKeyCard(card, { id, label, q: `?wallet=${w.id}`, configured: false }), bindKeyTest(card, id, label, `?wallet=${w.id}`);
    $('[data-unlink]', card).addEventListener('click', () => confirmModal(`Remove the ${label} account?`, `It stops syncing${dex[id]?.auth === 'key' ? ' and its key is deleted from .env' : ''}. Positions already tracked from it are kept.`, 'Remove account',
      async () => { await api('DELETE', `/api/wallets/${w.id}/dex/${id}`); toast(`${label} removed`); await loadMeta(); rerender(); }));
  }
  $('[data-add-dex]')?.addEventListener('click', () => openDexForm({ wallets: st.wallets }, async () => { await loadMeta(); rerender(); }));
}

// ---------- guide ----------
function renderGuide() {
  view.innerHTML = `<div class="guide"><div class="page-head"><div><h1>Guide</h1><p>How to set the app up and where its numbers come from.</p></div></div>
  <div class="card">
  <h2 style="margin-top:0">Getting started in four steps</h2>
  <ol>
    <li><strong>Pick a portfolio</strong> (sidebar switcher). Everything below is set up per portfolio.</li>
    <li><strong>Data sources</strong>: add a portfolio tracker key (Zerion or DeBank) on the <a href="#/settings">Data sources</a> page.</li>
    <li><strong>Wallets</strong>: add each wallet address on the <a href="#/wallets">Wallets</a> page, and add a DEX account to it for every exchange you’ve deposited funds into.</li>
    <li><strong>Sync, then Track</strong>: sync a wallet, then <em>Track</em> (or <em>Track all</em>) the positions you want to follow. From then on every sync, and the automatic one every 12 hours, adds a new value to each tracked position.</li>
  </ol>

  <h2>Portfolios</h2>
  <p>Use the <em>Portfolio</em> switcher in the sidebar to create, name and switch portfolios. Each one is fully separate: its own wallets, positions, totals, suggestions, <strong>and its own API keys</strong>. Nothing set up in one portfolio is ever used by another. <em>Sync all</em> only syncs the active portfolio. A portfolio can mix wallet types (MetaMask, Phantom, Trust Wallet, watched addresses). Market prices are the only thing shared.</p>

  <h2>Data sources: two kinds</h2>
  <p>The <a href="#/settings">Data sources</a> page has two sections, because there are two places your money can be.</p>
  <ul>
    <li><strong>Portfolio trackers (Zerion, DeBank)</strong> read the blockchain. Give them a wallet address and they return what it holds across many chains: tokens, and on-chain DeFi positions such as liquidity pools, lending and staking. One key per portfolio is enough. It doesn’t point to a wallet: it’s your permission to use the service, and the app asks it about each wallet address in the portfolio when it syncs.</li>
    <li><strong>DEX accounts (Lighter, Extended, Hyperliquid, GMX, GRVT, Bulk)</strong> read your account <em>inside</em> an exchange. Once you deposit into an exchange, your balance, positions and P/L live in the exchange’s own system. A portfolio tracker sees the money leave your wallet, but not what happens to it after. Each DEX account belongs to one wallet and is optional: nothing is set up until you add it. Some need only the wallet’s address; others need a read-only API key. Beta means built from the exchange’s official docs but not yet checked against a real account. Variational can’t be connected yet: it has no API for reading accounts.</li>
  </ul>
  <div class="table-wrap"><table><thead><tr><th>Where the money is</th><th>What reads it</th></tr></thead><tbody>
    <tr><td>Tokens in your wallet</td><td>Portfolio tracker (Zerion / DeBank)</td></tr>
    <tr><td>On-chain DeFi: pools, lending, staking, vaults</td><td>Portfolio tracker (Zerion / DeBank)</td></tr>
    <tr><td>Deposited into an exchange (perps, exchange pools, exchange staking)</td><td>That exchange’s DEX account</td></tr>
  </tbody></table></div>
  <p><strong>Do I need both?</strong> Only a portfolio tracker, if you only hold tokens and use on-chain DeFi. Add one DEX account for each exchange you’ve deposited into: without it, that money is invisible to the app. GMX runs on-chain, so Zerion may also list a GMX position. If both show the same position, track it from one source only.</p>

  <h2>Zerion or DeBank?</h2>
  <ul><li><strong>Zerion</strong>: EVM chains plus Solana token balances (it doesn’t index Solana DeFi positions yet). Needed for fee and deposit suggestions. Key from dashboard.zerion.io.</li>
  <li><strong>DeBank</strong>: EVM chains, very broad protocol coverage. Paid API (AccessKey from cloud.debank.com).</li></ul>
  <h2>Wallets</h2>
  <ul>
    <li><strong>Adding a wallet:</strong> connect MetaMask, Phantom or Trust Wallet (read-only: the app only asks for your public address, never a signature), or paste any address. Browser extensions need Chrome, Brave or Firefox; in Safari, paste the address instead.</li>
    <li><strong>Wallet balance</strong> lists every token sitting directly in the wallet, across chains, with amount, price and value (needs a portfolio tracker key). DeFi positions are listed separately under “Detected DeFi positions”, so nothing is counted twice.</li>
    <li><strong>+ Add DEX account</strong> on a wallet links an exchange account to it. The wallet then gets a <em>Sync from …</em> button for that exchange.</li>
    <li><strong>Track</strong> turns something a source found into a position. It’s re-valued on every later sync from that same source.</li>
  </ul>

  <h2>Exchange accounts and their P/L</h2>
  <p>An exchange account’s profit = account value − net money moved in (deposits − withdrawals ± transfers). It’s shown in parts that add up: each open position’s unrealised P/L, then trades, fees and funding by day. Anything the exchange doesn’t itemise is shown as “Other” rather than hidden. Hyperliquid only keeps your latest 10,000 trades; for busier accounts, older P/L appears as one dated “Earlier trades” line. When a long on one venue hedges a short on another, the two legs are compared with each other, never with a whole account.</p>

  <h2>API keys and privacy</h2>
  <p>Keys are entered in the app, tested with the provider first (a wrong key is never saved), and stored only in the app’s <code>.env</code> file on this computer, one line per portfolio or wallet. The app never shows a key again, only its last 4 characters, and keys can only be changed from this computer unless the app is password-protected. Use read-only keys. Removing a wallet or portfolio deletes its keys.</p>

  <h2>Positions and manual entries</h2>
  <ul>
    <li><strong>Synced positions</strong> (tracked from a data source) update themselves on every sync. You don’t need to enter values for them.</li>
    <li><strong>Manual positions</strong> are for anything no source can read. Record everything in the position’s currency (all in USDC, or all in ETH), and use <em>Update value</em> whenever you check the platform. Each value becomes a point on the charts.</li>
    <li><strong>Money added later</strong> to a position is recorded as <em>capital in</em>: it raises the amount invested, never the profit.</li>
  </ul>
  <h2>How profit is calculated</h2>
  <ul>
    <li><strong>Profit / loss</strong> = current (or exit) value + withdrawals + rewards − fees − money invested (deposit + capital added). A withdrawal alone never changes profit.</li>
    <li><strong>Current value</strong> = the latest value, minus withdrawals and plus capital added after it.</li>
    <li><strong>Total return</strong> = P/L ÷ money invested. <strong>Annualized</strong> = total return × 365 ÷ days held (a simple rate: not APY or XIRR).</li>
    <li><strong>Duration</strong> = exit date (or latest value date) − entry date.</li>
    <li><strong>USD</strong>: positions held in a token are converted at its current price from the Prices page. Charts also use today’s price for past dates, so they show performance in token terms at today’s rate.</li>
  </ul>
  <h2>Pool fees</h2>
  <ul>
    <li><strong>Uncollected fees</strong> are still in the pool, so they’re already part of the pool’s value (the Wallets page shows how much).</li>
    <li><strong>Collected fees</strong> leave the pool and land in your wallet. They count as rewards: profit = value + withdrawals + rewards − fees − deposit.</li>
    <li>With Zerion connected, each sync scans your transactions and suggests collected fees and deposits for your tracked pools. Confirm them on the Dashboard, the Positions page, or inside a position. Anything it can’t match confidently (e.g. a token that’s in several pools) is skipped; add those with <em>Reward</em> yourself.</li>
  </ul>
  <h2>Rewards and corrections</h2>
  <p><em>Rewards</em> offers two clearly labelled choices: <strong>Update total rewards to date</strong> (replaces the total: 112 → 120 shows 120) or <strong>Add one reward payment</strong> (adds to it). Fees stay separate. To fix a wrong entry (e.g. 977 instead of 77), use ✎ in Activity. The correction applies everywhere, and the old value is kept in <em>Correction history</em> with a Restore button.</p>
  <h2>Your target</h2>
  <p>“Your target” is the optional <em>Target annual return</em> you enter on a position (a simple APR). The app never fills it in. “vs. target” is the simple annualized return minus your target, shown once a position has 30+ days. Annualizing a few days of P/L would exaggerate it.</p>
  <h2>Closing positions</h2>
  <p><em>Close position</em> asks for the exit date and final proceeds; earlier partial withdrawals remain. <em>Reopen</em> clears the exit date; add a fresh value afterwards.</p>
  <p>Money moving between your positions is never profit. When a synced pool disappears and your transactions show its tokens coming back, the app closes the pool at the amount you withdrew; without that evidence it asks you on the Dashboard (“Position closed?”). A wallet’s profit is only the price change of tokens it already held. Tokens arriving or leaving (a closed pool paying out, a transfer from an exchange, gas) are recorded as <em>capital in</em> / <em>withdrawal</em>, so the same dollars are never counted twice.</p>
  <h2>Start tracking from</h2>
  <p>Each wallet has a start date, chosen when you add or connect it (default: today). Profit made before that date is never counted. Exchange trades closed earlier and money moved earlier are ignored, positions start from their value on that date, and only later fee collections are suggested. Change it with <em>Edit</em> on the wallet. Positions you already track keep their own deposit and entry date.</p>
  <h2>Status</h2>
  <p><strong>Complete inputs</strong> (strategy, chain, currency, entry date, deposit missing) · <strong>Enter position value</strong> · <strong>Check withdrawals</strong> (value would go negative) · <strong>Check dates</strong> (valuation or exit before entry) · <strong>Open</strong> · <strong>Closed</strong>. Only Open and Closed positions count in results.</p>
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
    toast(`${meta.portfolio?.name || ''}: synced ${ok.map((x) => x.source).join(', ') || 'nothing'} · ${updated} position(s) updated${suggested ? ` · ${suggested} new suggestion(s)` : ''}${r.prices ? ' · prices refreshed' : ''}`);
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
$('#portfolioSel').onchange = guard(async (e) => switchPortfolio(Number(e.target.value)));
$('#portfolioManage').onclick = guard(async () => { await loadMeta(); openPortfolioManager(); });
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
