// API keys entered in the UI are validated, masked, and written to .env without disturbing anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKey, updateEnvText, maskKey } from '../server/settings.js';

test('keys must be a single plain token', () => {
  assert.equal(validateKey('  zk_dev_abc123DEF456  ').key, 'zk_dev_abc123DEF456'); // trimmed
  assert.equal(validateKey('').ok, false);
  assert.equal(validateKey('short').ok, false);
  for (const bad of ['abc 12345678', 'abc12345678\nAPP_PASSWORD=x', '"abc12345678"', 'abc12345678#x', 'a=b12345678']) {
    assert.equal(validateKey(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('updating .env replaces one line and keeps comments and other settings', () => {
  const env = '# Zerion key\nZERION_API_KEY=\nZERION_MOCK=0\n# keep me\nAPP_PASSWORD=secret\n';
  const next = updateEnvText(env, 'ZERION_API_KEY', 'zk_new_12345678');
  assert.equal(next, '# Zerion key\nZERION_API_KEY=zk_new_12345678\nZERION_MOCK=0\n# keep me\nAPP_PASSWORD=secret\n');
  assert.equal(updateEnvText(next, 'ZERION_API_KEY', ''), env);                      // clearing
  assert.equal(updateEnvText('A=1\n', 'EXTENDED_API_KEY', 'k1234567'), 'A=1\nEXTENDED_API_KEY=k1234567\n'); // appended
  assert.equal(updateEnvText('', 'X_KEY', 'k1234567'), 'X_KEY=k1234567\n');
  assert.equal(updateEnvText('ZERION_API_KEY_OLD=1\nZERION_API_KEY=a\n', 'ZERION_API_KEY', 'b'), 'ZERION_API_KEY_OLD=1\nZERION_API_KEY=b\n'); // exact name only
});

test('only the last four characters are ever shown', () => {
  assert.equal(maskKey('zk_dev_abcdefgh1a2b'), '••••1a2b');
  assert.equal(maskKey(''), null);
});
