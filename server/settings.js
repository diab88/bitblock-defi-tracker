// API keys managed from the UI. They live in the same .env file the app is started with (docker compose
// loads it as env_file and bind-mounts it at /app/.env so the app can update it), and are applied to the
// running process immediately — no restart. Keys are never sent back to the browser, only a masked form.
import fs from 'node:fs';
import path from 'node:path';

// The data sources whose credentials can be set from Settings.
export const KEYED_SOURCES = {
  zerion: { label: 'Zerion', env: 'ZERION_API_KEY', url: 'https://dashboard.zerion.io', what: 'EVM DeFi positions, wallet balances, Solana balances, fee & deposit suggestions' },
  debank: { label: 'DeBank', env: 'DEBANK_ACCESS_KEY', url: 'https://cloud.debank.com', what: 'EVM DeFi positions (paid API units)' },
  extended: { label: 'Extended', env: 'EXTENDED_API_KEY', url: 'https://app.extended.exchange', what: 'Perps account equity and net deposits (read-only key from Extended → API management)' },
};

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

// Write in place (not write-and-rename): a bind-mounted file can't be replaced, only rewritten.
export function writeEnvValue(file, name, value) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, updateEnvText(current, name, value), { mode: 0o600 });
}
