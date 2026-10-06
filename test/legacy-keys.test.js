// Older installs kept one plain key per source in .env (ZERION_API_KEY=…, EXTENDED_API_KEY=…). After keys became
// per portfolio / per wallet, those lines must only apply to the first portfolio, and the Extended one to one wallet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defi-legacy-keys-'));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const envFile = path.join(dir, '.env');
const LEGACY = { ZERION_API_KEY: 'zk_legacy_0000zzzz', EXTENDED_API_KEY: 'ext_legacy_0000eeee' };
let server;

before(async () => {
  fs.writeFileSync(envFile, `ZERION_API_KEY=${LEGACY.ZERION_API_KEY}\nEXTENDED_API_KEY=${LEGACY.EXTENDED_API_KEY}\nZERION_MOCK=0\n`);
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), AUTO_SYNC_HOURS: '0', ENV_FILE: envFile, APP_PASSWORD: '',
      ZERION_MOCK: '0', DEBANK_MOCK: '0', LIGHTER_DISABLED: '1', DEBANK_ACCESS_KEY: '', EXTENDED_WALLET_ADDRESS: '', ...LEGACY },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function ok(method, url, body, portfolio) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(portfolio ? { 'x-portfolio': String(portfolio) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  assert.ok(res.status < 300, `${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

test('old shared keys apply to the first portfolio only, and the Extended key to one wallet', async () => {
  const first = (await ok('GET', '/api/portfolios')).portfolios[0].id;
  const other = (await ok('POST', '/api/portfolios', { name: 'Someone else' })).id;
  const zerion = (pid) => ok('GET', '/api/settings', null, pid).then((st) => st.sources.find((s) => s.id === 'zerion'));
  assert.deepEqual([(await zerion(first)).from, (await zerion(first)).masked], ['legacy', '••••zzzz']);
  assert.equal((await zerion(other)).configured, false);
  assert.equal((await ok('GET', '/api/meta', null, other)).zerion, 'off');

  const w1 = await ok('POST', '/api/wallets', { name: 'Main', address: '0x1111111111111111111111111111111111111111', track_from: 'all' }, first);
  const w2 = await ok('POST', '/api/wallets', { name: 'Second', address: '0x2222222222222222222222222222222222222222', track_from: 'all' }, first);
  const w3 = await ok('POST', '/api/wallets', { name: 'Theirs', address: '0x3333333333333333333333333333333333333333', track_from: 'all' }, other);
  const ex = async (pid) => Object.fromEntries((await ok('GET', '/api/wallets', null, pid)).map((w) => [w.id, w.exchanges.extended?.masked ?? null]));
  assert.deepEqual(await ex(first), { [w1.id]: '••••eeee', [w2.id]: null });   // one wallet, not every EVM wallet
  assert.deepEqual(await ex(other), { [w3.id]: null });

  // Saving the first portfolio's Zerion key from the UI replaces the old shared line.
  await ok('PUT', '/api/settings/zerion', { key: 'zk_scoped_1111yyyy', test: false }, first);
  assert.equal((await zerion(first)).from, 'own');
  assert.ok(fs.readFileSync(envFile, 'utf8').includes('ZERION_API_KEY=\n'));
  assert.ok(!fs.readFileSync(envFile, 'utf8').includes(LEGACY.ZERION_API_KEY));
  assert.equal((await zerion(other)).configured, false);

  // Removing the wallet that holds the old Extended key removes the key; it doesn't move to another wallet.
  await ok('DELETE', `/api/wallets/${w1.id}`, null, first);
  assert.deepEqual(await ex(first), { [w2.id]: null });
  assert.ok(!fs.readFileSync(envFile, 'utf8').includes(LEGACY.EXTENDED_API_KEY));
});
