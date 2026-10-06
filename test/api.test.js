// End-to-end API tests: a real server on a throwaway database, no network (demo data sources only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defi-api-test-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  fs.writeFileSync(path.join(dir, '.env'), '# test env\nZERION_API_KEY=\nZERION_MOCK=1\nAPP_PASSWORD=\n');
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), AUTO_SYNC_HOURS: '0', ENV_FILE: path.join(dir, '.env'), APP_PASSWORD: '',
      ZERION_MOCK: '1', DEBANK_MOCK: '0', LIGHTER_DISABLED: '1', ZERION_API_KEY: '', DEBANK_ACCESS_KEY: '', EXTENDED_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, portfolio) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(portfolio ? { 'x-portfolio': String(portfolio) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const position = (overrides = {}) => ({ strategy: 'Staking', protocol: 'Test', chain: 'Base', currency: 'USD', entry_date: '2026-01-01', deposit: 1000, current_value: 1000, valuation_date: '2026-01-01', ...overrides });

let A, B, walletA, walletsB;

test('existing data starts in a default portfolio; new portfolios can be created and named', async () => {
  const p = await ok('GET', '/api/portfolios');
  assert.equal(p.portfolios.length, 1);
  A = p.portfolios[0].id;
  B = (await ok('POST', '/api/portfolios', { name: 'Long-term' })).id;
  assert.equal((await call('POST', '/api/portfolios', { name: 'Long-term' })).status, 409); // names are unique
  await ok('PUT', `/api/portfolios/${B}`, { name: 'Long-term holdings' });
  assert.deepEqual((await ok('GET', '/api/portfolios')).portfolios.map((x) => x.name), ['Main portfolio', 'Long-term holdings']);
});

test('a portfolio holds several wallet types; wallets are separate per portfolio', async () => {
  walletA = await ok('POST', '/api/wallets', { name: 'MetaMask main', address: '0x1111111111111111111111111111111111111111', source: 'metamask', track_from: 'all' }, A);
  walletsB = [
    await ok('POST', '/api/wallets', { name: 'MetaMask', address: '0x2222222222222222222222222222222222222222', source: 'metamask', track_from: 'all' }, B),
    await ok('POST', '/api/wallets', { name: 'Trust', address: '0x3333333333333333333333333333333333333333', source: 'trustwallet', track_from: 'all' }, B),
    await ok('POST', '/api/wallets', { name: 'Phantom', address: '11111111111111111111111111111111', source: 'phantom', track_from: 'all' }, B),
  ];
  const listB = await ok('GET', '/api/wallets', null, B);
  assert.deepEqual(listB.map((w) => w.source).sort(), ['metamask', 'phantom', 'trustwallet']);
  assert.deepEqual(listB.map((w) => w.kind).sort(), ['evm', 'evm', 'solana']);
  assert.deepEqual((await ok('GET', '/api/wallets', null, A)).map((w) => w.name), ['MetaMask main']);
  // Same name is fine in another portfolio; the same address can be tracked separately in two portfolios.
  await ok('POST', '/api/wallets', { name: 'MetaMask', address: '0x1111111111111111111111111111111111111111', track_from: 'all' }, A);
  assert.equal((await call('POST', '/api/wallets', { name: 'MetaMask', track_from: 'all' }, B)).status, 409);
});

test('positions, totals and suggestions are separate per portfolio', async () => {
  await ok('POST', '/api/positions', position({ protocol: 'A-pos', wallet_id: walletA.id, deposit: 500, current_value: 600 }), A);
  await ok('POST', '/api/positions', position({ protocol: 'B-pos-1', wallet_id: walletsB[0].id, deposit: 100, current_value: 110 }), B);
  await ok('POST', '/api/positions', position({ protocol: 'B-pos-2', wallet_id: walletsB[2].id, deposit: 200, current_value: 190 }), B);
  const dashA = await ok('GET', '/api/dashboard', null, A);
  const dashB = await ok('GET', '/api/dashboard', null, B);
  assert.deepEqual(dashA.positions.map((p) => p.protocol), ['A-pos']);
  assert.deepEqual(dashB.positions.map((p) => p.protocol).sort(), ['B-pos-1', 'B-pos-2']);
  assert.equal(dashA.kpis.pnlUsd, 100);
  assert.equal(dashB.kpis.pnlUsd, 0); // +10 and −10, both wallets of B counted together
  // A position can't use a wallet from another portfolio.
  assert.equal((await call('POST', '/api/positions', position({ wallet_id: walletA.id }), B)).status, 404);
});

test('nothing in one portfolio can be read or changed from another', async () => {
  const [a] = await ok('GET', '/api/positions', null, A);
  const ev = a.events[0];
  for (const [m, u, b] of [['GET', `/api/positions/${a.id}/series`], ['PUT', `/api/positions/${a.id}`, { deposit: 1 }],
    ['DELETE', `/api/positions/${a.id}`], ['POST', `/api/positions/${a.id}/events`, { type: 'fee', date: '2026-01-02', amount: 1 }],
    ['PUT', `/api/events/${ev.id}`, { amount: 1 }], ['DELETE', `/api/events/${ev.id}`], ['GET', `/api/positions/${a.id}/revisions`],
    ['PUT', `/api/wallets/${walletA.id}`, { name: 'x' }], ['DELETE', `/api/wallets/${walletA.id}`], ['GET', `/api/wallets/${walletA.id}/snapshot`],
    ['POST', `/api/wallets/${walletA.id}/sync?provider=zerion`]]) {
    assert.equal((await call(m, u, b, B)).status, 404, `${m} ${u} from portfolio B should be 404`);
  }
  const again = (await ok('GET', '/api/positions', null, A))[0];
  assert.equal(again.deposit, 500);
  assert.equal(again.events.length, a.events.length);
});

test('Sync all in one portfolio only syncs and changes that portfolio', async () => {
  const eventsA = (await ok('GET', '/api/positions', null, A)).flatMap((p) => p.events).length;
  const r = await ok('POST', '/api/sync-all', null, B);
  const synced = new Set(r.results.map((x) => x.wallet));
  assert.ok(synced.has('MetaMask') && synced.has('Trust') && synced.has('Phantom'), JSON.stringify(r.results));
  assert.ok(!synced.has('MetaMask main'));
  // B's wallets got synced data; A's wallet got none, and A's positions and events are untouched.
  for (const w of walletsB) assert.ok((await ok('GET', `/api/wallets/${w.id}/snapshot`, null, B))?.items?.length, `${w.name} has synced data`);
  assert.equal(await ok('GET', `/api/wallets/${walletA.id}/snapshot`, null, A), null);
  await ok('POST', '/api/sync-all', null, B);
  assert.equal((await ok('GET', '/api/positions', null, A)).flatMap((p) => p.events).length, eventsA);
  assert.deepEqual((await ok('GET', '/api/positions', null, A)).map((p) => p.protocol), ['A-pos']);
  assert.equal((await ok('GET', '/api/dashboard', null, A)).untracked.length, 0);
  assert.deepEqual(await ok('GET', '/api/suggestions', null, A), []);
  // And the reverse: syncing A leaves B's records alone.
  const eventsB = (await ok('GET', '/api/positions', null, B)).flatMap((p) => p.events).length;
  const rA = await ok('POST', '/api/sync-all', null, A);
  assert.ok(rA.results.every((x) => x.wallet === 'MetaMask main' || x.wallet === 'MetaMask'), JSON.stringify(rA.results));
  assert.equal((await ok('GET', '/api/positions', null, B)).flatMap((p) => p.events).length, eventsB);
});

test('rewards: updating the total replaces it (112 → 120 shows 120); a payment adds; fees separate', async () => {
  const { id } = await ok('POST', '/api/positions', position({ protocol: 'Rewards test', deposit: 1000, current_value: 1000 }), A);
  const get = async () => (await ok('GET', '/api/positions', null, A)).find((p) => p.id === id).metrics;
  await ok('POST', `/api/positions/${id}/events`, { type: 'reward_total', date: '2026-02-01', amount: 112 }, A);
  assert.equal((await get()).rewards, 112);
  await ok('POST', `/api/positions/${id}/events`, { type: 'reward_total', date: '2026-02-10', amount: 120 }, A);
  assert.equal((await get()).rewards, 120);
  await ok('POST', `/api/positions/${id}/events`, { type: 'reward', date: '2026-02-11', amount: 5 }, A);
  await ok('POST', `/api/positions/${id}/events`, { type: 'fee', date: '2026-02-11', amount: 3 }, A);
  const m = await get();
  assert.equal(m.rewards, 125);
  assert.equal(m.fees, 3);
  assert.equal(m.pnl, 122);
});

test('corrections: 977 → 77 in place, kept in history, flows through P/L, and can be undone', async () => {
  const { id } = await ok('POST', '/api/positions', position({ protocol: 'Correction test', deposit: 1000, current_value: 1000 }), A);
  const ev = Number((await ok('POST', `/api/positions/${id}/events`, { type: 'reward_total', date: '2026-03-01', amount: 977 }, A)).id);
  const pos = async () => (await ok('GET', '/api/positions', null, A)).find((p) => p.id === id);
  assert.equal((await pos()).metrics.pnl, 977);
  const r = await ok('PUT', `/api/events/${ev}`, { amount: 77, reason: 'typo: 977 → 77' }, A);
  assert.equal(r.before.amount, 977);
  assert.equal(r.after.amount, 77);
  let p = await pos();
  assert.equal(p.metrics.rewards, 77);
  assert.equal(p.metrics.pnl, 77);
  assert.equal(p.events.find((e) => e.id === ev).corrected, true);
  assert.equal(p.events.length, 2); // corrected in place, not duplicated
  const revs = await ok('GET', `/api/positions/${id}/revisions`, null, A);
  assert.equal(revs[0].action, 'update');
  assert.equal(revs[0].reason, 'typo: 977 → 77');
  // Reward entries can switch between "total" and "payment"; other types can't change family.
  assert.equal((await call('PUT', `/api/events/${ev}`, { type: 'fee' }, A)).status, 400);
  assert.equal((await call('PUT', `/api/events/${ev}`, { amount: -5 }, A)).status, 400);
  // Undo the correction, then delete and restore the entry.
  await ok('POST', `/api/revisions/${revs[0].id}/restore`, null, A);
  assert.equal((await pos()).metrics.rewards, 977);
  await ok('DELETE', `/api/events/${ev}?reason=test`, null, A);
  assert.equal((await pos()).metrics.rewards, 0);
  const del = (await ok('GET', `/api/positions/${id}/revisions`, null, A)).find((x) => x.action === 'delete');
  await ok('POST', `/api/revisions/${del.id}/restore`, null, A);
  p = await pos();
  assert.equal(p.metrics.rewards, 977);
  assert.ok(p.events.some((e) => e.id === ev));
});

test('vs. target over the API: none unless configured, compared after 30 days', async () => {
  const none = await ok('POST', '/api/positions', position({ protocol: 'No target', entry_date: '2026-01-01', current_value: 1020, valuation_date: '2026-03-15' }), A);
  const withT = await ok('POST', '/api/positions', position({ protocol: 'With target', entry_date: '2026-01-01', current_value: 1020, valuation_date: '2026-03-15', expected_return: 0.08 }), A);
  const rows = await ok('GET', '/api/positions', null, A);
  assert.equal(rows.find((p) => p.id === none.id).metrics.target.status, 'none');
  assert.equal(rows.find((p) => p.id === none.id).expected_return, null);
  const t = rows.find((p) => p.id === withT.id).metrics.target;
  assert.equal(t.status, 'ok');
  assert.ok(Math.abs(t.gap - 0.02) < 1e-12);
});

test('portfolios with data cannot be deleted; empty ones can', async () => {
  assert.equal((await call('DELETE', `/api/portfolios/${B}`)).status, 400);
  const C = (await ok('POST', '/api/portfolios', { name: 'Empty' })).id;
  await ok('DELETE', `/api/portfolios/${C}`);
  // An unknown portfolio id falls back to the first portfolio instead of failing.
  assert.ok((await ok('GET', '/api/positions', null, 99999)).some((p) => p.protocol === 'A-pos'));
});

const envText = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');
const envLine = (prefix) => envText().split('\n').find((l) => l.startsWith(prefix));

test('Data sources: a key saved in the UI goes to .env, applies at once, and is never shown again', async () => {
  let st = await ok('GET', '/api/settings', null, A);
  assert.equal(st.envFile.writable, true);
  assert.equal(st.sources.find((s) => s.id === 'zerion').configured, false);
  assert.equal((await call('PUT', '/api/settings/zerion', { key: 'bad key with spaces' }, A)).status, 400);
  assert.equal((await call('PUT', '/api/settings/zerion', { key: 'zk_test_12345678\nAPP_PASSWORD=x' }, A)).status, 400);
  assert.equal((await call('PUT', '/api/settings/nope', { key: 'zk_test_12345678' }, A)).status, 404);
  const r = await ok('PUT', '/api/settings/zerion', { key: 'zk_test_1234abcd', test: false }, A);
  assert.equal(r.masked, '••••abcd');
  assert.equal(r.saved, true);
  assert.equal(r.mode, 'live');                                         // applied without a restart
  assert.equal((await ok('GET', '/api/meta', null, A)).zerion, 'live');
  assert.match(envLine('ZERION_API_KEY__'), /^ZERION_API_KEY__[0-9A-F]{10}=zk_test_1234abcd$/); // stored for this portfolio
  assert.ok(!/^ZERION_API_KEY=/m.test(envText().replace('ZERION_API_KEY=\n', '')));            // not as a shared key
  assert.ok(envText().startsWith('# test env\n') && envText().includes('ZERION_MOCK=1'));        // rest of .env untouched
  st = await ok('GET', '/api/settings', null, A);
  assert.ok(!JSON.stringify(st).includes('zk_test_1234abcd'));           // never sent back
  assert.equal(st.sources.find((s) => s.id === 'zerion').masked, '••••abcd');
});

test('Data sources: each portfolio has its own keys; a key in one is never used by another', async () => {
  // B has no key of its own: it stays on the .env demo setting even though A has a live key.
  assert.equal((await ok('GET', '/api/meta', null, B)).zerion, 'mock');
  assert.equal((await ok('GET', '/api/settings', null, B)).sources.find((s) => s.id === 'zerion').configured, false);
  await ok('PUT', '/api/settings/zerion', { key: 'zk_other_5678wxyz', test: false }, B);
  assert.equal((await ok('GET', '/api/settings', null, A)).sources.find((s) => s.id === 'zerion').masked, '••••abcd');
  assert.equal((await ok('GET', '/api/settings', null, B)).sources.find((s) => s.id === 'zerion').masked, '••••wxyz');
  assert.equal(envText().split('\n').filter((l) => l.startsWith('ZERION_API_KEY__')).length, 2);
  // Removing A's key leaves B's alone.
  await ok('DELETE', '/api/settings/zerion', null, A);
  assert.ok(!envText().includes('zk_test_1234abcd'));
  assert.equal((await ok('GET', '/api/meta', null, A)).zerion, 'mock');
  assert.equal((await ok('GET', '/api/meta', null, B)).zerion, 'live');
  assert.equal((await call('DELETE', '/api/settings/zerion', null, A)).status, 404);              // nothing left to remove
  await ok('DELETE', '/api/settings/zerion', null, B);
  assert.ok(!envText().includes('ZERION_API_KEY__'));
});

test('Exchange accounts are opt-in and linked to one wallet only', async () => {
  // Nothing by default: no wallet has one, and the portfolio shows Extended as off.
  assert.equal((await ok('GET', '/api/meta', null, A)).extended, 'off');
  assert.deepEqual((await ok('GET', '/api/wallets', null, A)).find((w) => w.id === walletA.id).exchanges, {});
  assert.ok(!/EXTENDED/.test(envText()));
  assert.equal((await call('POST', `/api/wallets/${walletA.id}/sync?provider=extended`, null, A)).status, 400);
  // It must name a wallet of this portfolio, and an EVM one.
  assert.equal((await call('PUT', '/api/settings/extended', { key: 'ext_key_0001aaaa', test: false }, A)).status, 400);
  assert.equal((await call('PUT', `/api/settings/extended?wallet=${walletsB[0].id}`, { key: 'ext_key_0001aaaa', test: false }, A)).status, 404);
  assert.equal((await call('PUT', `/api/settings/extended?wallet=${walletsB[2].id}`, { key: 'ext_key_0001aaaa', test: false }, B)).status, 400); // Solana
  const second = await ok('POST', '/api/wallets', { name: 'Second EVM', address: '0x4444444444444444444444444444444444444444', track_from: 'all' }, A);
  await ok('PUT', `/api/settings/extended?wallet=${second.id}`, { key: 'ext_key_0001aaaa', test: false }, A);
  const wallets = await ok('GET', '/api/wallets', null, A);
  assert.equal(wallets.find((w) => w.id === second.id).exchanges.extended.masked, '••••aaaa');
  assert.deepEqual(wallets.find((w) => w.id === walletA.id).exchanges, {});                       // not the other wallet
  assert.ok(wallets.every((w) => !('key_ref' in w)));
  assert.equal((await ok('GET', '/api/meta', null, A)).extended, 'live');
  assert.equal((await ok('GET', '/api/meta', null, B)).extended, 'off');                           // not the other portfolio
  assert.ok((await ok('GET', '/api/wallets', null, B)).every((w) => !Object.keys(w.exchanges).length));
  assert.match(envLine('EXTENDED_API_KEY__'), /^EXTENDED_API_KEY__[0-9A-F]{10}=ext_key_0001aaaa$/);
  // Deleting the wallet deletes its key.
  await ok('DELETE', `/api/wallets/${second.id}`, null, A);
  assert.ok(!envText().includes('ext_key_0001aaaa'));
  assert.equal((await ok('GET', '/api/meta', null, A)).extended, 'off');
});

test('DEX accounts: none by default; added and removed per wallet with "Add DEX account"', async () => {
  const meta = await ok('GET', '/api/meta', null, B);
  assert.ok(['lighter', 'extended'].every((id) => meta.dexes.some((d) => d.id === id)));
  const w = walletsB[0];
  assert.deepEqual((await ok('GET', '/api/wallets', null, B)).find((x) => x.id === w.id).exchanges, {});   // not even Lighter
  assert.equal((await call('POST', `/api/wallets/${w.id}/sync?provider=lighter`, null, B)).status, 400);
  assert.equal((await call('POST', `/api/wallets/${w.id}/dex`, { dex: 'nope' }, B)).status, 404);
  assert.equal((await call('POST', `/api/wallets/${walletsB[2].id}/dex`, { dex: 'lighter', test: false }, B)).status, 400); // Solana wallet
  assert.equal((await call('POST', `/api/wallets/${w.id}/dex`, { dex: 'lighter', test: false }, A)).status, 404);           // other portfolio's wallet
  await ok('POST', `/api/wallets/${w.id}/dex`, { dex: 'lighter', test: false }, B);
  await ok('POST', `/api/wallets/${w.id}/dex`, { dex: 'extended', key: 'ext_key_0002bbbb', test: false }, B);
  assert.equal((await call('POST', `/api/wallets/${w.id}/dex`, { dex: 'extended', key: 'bad key' }, B)).status, 400);
  let ex = (await ok('GET', '/api/wallets', null, B)).find((x) => x.id === w.id).exchanges;
  assert.deepEqual(Object.keys(ex).sort(), ['extended', 'lighter']);
  assert.equal(ex.extended.masked, '••••bbbb');
  assert.ok(!('masked' in ex.lighter));
  assert.deepEqual((await ok('GET', '/api/wallets', null, B)).find((x) => x.id === walletsB[1].id).exchanges, {}); // other wallet untouched
  const st = await ok('GET', '/api/settings', null, B);
  assert.deepEqual(Object.keys(st.wallets.find((x) => x.id === w.id).exchanges).sort(), ['extended', 'lighter']);
  await ok('DELETE', `/api/wallets/${w.id}/dex/extended`, null, B);
  await ok('DELETE', `/api/wallets/${w.id}/dex/lighter`, null, B);
  assert.equal((await call('DELETE', `/api/wallets/${w.id}/dex/lighter`, null, B)).status, 404);
  assert.deepEqual((await ok('GET', '/api/wallets', null, B)).find((x) => x.id === w.id).exchanges, {});
  assert.ok(!envText().includes('ext_key_0002bbbb'));
});

test('Wallet balance lists the tokens in a wallet of this portfolio only', async () => {
  const r = await ok('GET', `/api/wallets/${walletsB[0].id}/holdings`, null, B);
  assert.equal(r.mock, true);
  assert.ok(r.holdings.length > 0 && r.holdings.every((h) => h.symbol && h.chain && h.qty > 0));
  assert.ok(Math.abs(r.totalUsd - r.holdings.reduce((t, h) => t + h.valueUsd, 0)) < 1e-9);
  assert.equal((await call('GET', `/api/wallets/${walletsB[0].id}/holdings`, null, A)).status, 404);
  const sol = await ok('GET', `/api/wallets/${walletsB[2].id}/holdings`, null, B);
  assert.ok(sol.holdings.some((h) => h.chain === 'Solana'));
});

test('Data sources: changing keys from another computer is refused without APP_PASSWORD', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/settings/zerion', method: 'PUT',
      headers: { host: 'tracker.example.com', 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify({ key: 'zk_test_12345678', test: false }));
  });
  assert.equal(status, 403);
  assert.ok(!fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('zk_test_12345678'));
});
