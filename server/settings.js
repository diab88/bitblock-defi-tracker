// API keys managed from the UI. They live in the same .env file the app is started with (docker compose
// loads it as env_file and bind-mounts it at /app/.env so the app can update it), and are applied to the
// running process immediately — no restart. Keys are never sent back to the browser, only a masked form.
//
// Keys are never shared between portfolios. Each portfolio (Zerion, DeBank) or wallet (exchange accounts such
// as Extended) that gets a key is given a random reference, and its key is stored as NAME__REF
// (e.g. ZERION_API_KEY__3F9A1C07D2). A random reference rather than the row id means a deleted wallet's key
// can never be picked up by a new wallet that reuses its id, or by another install's restored backup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Portfolio trackers: on-chain aggregators that read a wallet by its address. One key per portfolio.
export const TRACKERS = {
  zerion: { label: 'Zerion', env: 'ZERION_API_KEY', scope: 'portfolio', url: 'https://dashboard.zerion.io', what: 'EVM DeFi positions, wallet balances, Solana balances, fee & deposit suggestions' },
  debank: { label: 'DeBank', env: 'DEBANK_ACCESS_KEY', scope: 'portfolio', url: 'https://cloud.debank.com', what: 'EVM DeFi positions (paid API units)' },
};

// DEX accounts: opt-in, each linked to one wallet with "Add DEX account". auth 'address' = found from the
// wallet's address, no key; 'key' = needs a read-only API key, which opens one specific account.
export const DEXES = {
  lighter: { label: 'Lighter', auth: 'address', kinds: ['evm'], url: 'https://app.lighter.xyz', what: 'Perps account, LLP / public pools and LIT staking, with deposits and daily history' },
  extended: { label: 'Extended', auth: 'key', env: 'EXTENDED_API_KEY', kinds: ['evm'], url: 'https://app.extended.exchange', keyHelp: 'Extended → API management → create a read-only key', what: 'Perps account equity, positions and net deposits' },
  hyperliquid: { label: 'Hyperliquid', auth: 'address', kinds: ['evm'], url: 'https://app.hyperliquid.xyz', what: 'Perps and spot account, vault deposits (e.g. HLP), with net deposits, trades and funding' },
  gmx: { label: 'GMX', auth: 'address', kinds: ['evm'], url: 'https://app.gmx.io', what: 'Open perps positions on Arbitrum and Avalanche, each with its collateral (GM pool tokens show up through Zerion / DeBank)' },
  grvt: { label: 'GRVT', auth: 'key', env: 'GRVT_API_KEY', kinds: ['evm', 'solana'], beta: true, url: 'https://grvt.io', keyHelp: 'GRVT → Settings → API keys → create a Trading API key with no trading or transfer permissions', what: 'Trading account equity, positions, transfers in and trades' },
  bulk: { label: 'Bulk', auth: 'address', kinds: ['solana'], beta: true, url: 'https://bulk.trade', what: 'Solana perps account: equity, positions, deposits, closed trades' },
  variational: { label: 'Variational', auth: 'none', kinds: ['evm'], available: false, url: 'https://omni.variational.io', what: 'Variational has no API for reading your account yet (their trading API is still in development)' },
};

// Everything whose credential can be set from the UI, and what one key belongs to.
export const KEYED_SOURCES = {
  ...TRACKERS,
  ...Object.fromEntries(Object.entries(DEXES).filter(([, d]) => d.auth === 'key').map(([id, d]) => [id, { ...d, scope: 'wallet' }])),
};

export const scopedEnvName = (src, ref) => `${src.env}__${ref}`;
export const newKeyRef = () => crypto.randomBytes(5).toString('hex').toUpperCase();

// A key is one token: letters, digits and _ - . : only. This also guarantees nothing can be smuggled into
// .env (no newlines, spaces, quotes, # or =).
export function validateKey(v) {
  const key = String(v ?? '').trim();
  if (!key) return { ok: false, error: 'Paste a key first' };
  if (key.length < 8 || key.length > 200) return { ok: false, error: 'That doesn’t look like an API key (expected 8–200 characters)' };
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) return { ok: false, error: 'Keys can only contain letters, digits and _ - . : (check for spaces or quotes)' };
  return { ok: true, key };
}

export const maskKey = (k) => (k ? `••••${String(k).slice(-4)}` : null);

// Set (or, with value '', clear) NAME=value in .env text, keeping every other line and comment as is.
export function updateEnvText(text, name, value) {
  const lines = String(text ?? '').split('\n');
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name}=${value}`, '');
  }
  return lines.join('\n');
}

export function envFilePath(root) {
  return process.env.ENV_FILE || path.join(root, '.env');
}

// Can the app update the .env file? (In Docker that needs the bind mount from docker-compose.yml.)
export function envFileStatus(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { writable: false, reason: `${file} is not a file` };
    fs.accessSync(file, fs.constants.W_OK);
    return { writable: true };
  } catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.accessSync(path.dirname(file), fs.constants.W_OK); return { writable: true, willCreate: true }; } catch {}
      return { writable: false, reason: 'no .env file is connected to the app' };
    }
    return { writable: false, reason: e.code === 'EACCES' ? 'the .env file is read-only for the app' : e.message };
  }
}

// Remove NAME=… lines entirely (used when a wallet or portfolio is deleted).
export function removeEnvText(text, names) {
  const res = names.map((n) => new RegExp(`^\\s*${n}\\s*=`));
  return String(text ?? '').split('\n').filter((l) => !res.some((re) => re.test(l))).join('\n');
}

export function removeEnvValues(file, names) {
  if (!names.length || !fs.existsSync(file)) return;
  fs.writeFileSync(file, removeEnvText(fs.readFileSync(file, 'utf8'), names), { mode: 0o600 });
}

// Write in place (not write-and-rename): a bind-mounted file can't be replaced, only rewritten.
export function writeEnvValue(file, name, value) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, updateEnvText(current, name, value), { mode: 0o600 });
}
