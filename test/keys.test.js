// Zerion can regenerate group_id between calls for some protocols. Tracked positions must keep matching
// the same pool, or every sync offers it as "new" → duplicates. (Fictional pools.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZerion, relinkKeys } from '../server/integrations.js';

const row = (id, groupId, symbol, value, extra = {}) => ({
  id, attributes: { position_type: 'deposit', value, quantity: { float: 1 }, fungible_info: { symbol }, flags: {},
    protocol: 'Aerodrome', group_id: groupId, name: 'Aerodrome AERO/USDC Pool', pool_address: '0xAbC', application_metadata: { name: 'Aerodrome' }, ...extra },
  relationships: { chain: { data: { id: 'base' } } },
});

test('same pool with a new group_id keeps the same key', () => {
  const a = normalizeZerion([row('1', 'g-first', 'USDC', 60), row('2', 'g-first', 'AERO', 50)]);
  const b = normalizeZerion([row('3', 'g-second', 'USDC', 61), row('4', 'g-second', 'AERO', 49)]);
  assert.equal(a.length, 1);
  assert.equal(a[0].key, b[0].key);
  assert.equal(a[0].key, 'zerion|base|Aerodrome|Aerodrome AERO/USDC Pool@0xabc');
  assert.equal(b[0].netUsd, 110);
});

test('different pools stay separate; Uniswap NFT names keep positions in one pool apart', () => {
  const uni = (id, g, name, v) => row(id, g, 'USDC', v, { protocol: 'Uniswap V3', name, pool_address: '0xpool', application_metadata: { name: 'Uniswap V3' } });
  const items = normalizeZerion([uni('1', 'g1', 'USDC/WETH Pool 0.05% #100201', 200), uni('2', 'g2', 'USDC/WETH Pool 0.05% #100202', 100),
    row('3', 'g3', 'WETH', 25, { name: 'Aerodrome WETH/DEGEN Pool', pool_address: '0xdef' })]);
  assert.equal(new Set(items.map((i) => i.key)).size, 3);
});

test('a tracked position whose key changed is re-linked to the same pool, not offered as new', () => {
  const previous = [
    { key: 'zerion|base|Aerodrome|g-first', protocol: 'Aerodrome', chainId: 'base', name: 'Aerodrome AERO/USDC Pool', tokens: ['AERO', 'USDC'] },
    { key: 'zerion|base|Aerodrome|g-other', protocol: 'Aerodrome', chainId: 'base', name: 'Aerodrome WETH/DEGEN Pool', tokens: ['WETH', 'DEGEN'] },
  ];
  const now = [
    { key: 'zerion|base|Aerodrome|Aerodrome AERO/USDC Pool@0x1', protocol: 'Aerodrome', chainId: 'base', name: 'Aerodrome AERO/USDC Pool', tokens: ['AERO', 'USDC'] },
    { key: 'zerion|base|Aerodrome|Aerodrome WETH/DEGEN Pool@0x2', protocol: 'Aerodrome', chainId: 'base', name: 'Aerodrome WETH/DEGEN Pool', tokens: ['DEGEN', 'WETH'] },
  ];
  const moves = relinkKeys([{ positionId: 3, key: 'zerion|base|Aerodrome|g-first' }, { positionId: 4, key: 'zerion|base|Aerodrome|g-other' }], previous, now);
  assert.deepEqual(moves.map((m) => [m.positionId, m.to]), [[3, now[0].key], [4, now[1].key]]);
});

test('ambiguous or vanished positions are left alone', () => {
  const previous = [{ key: 'old', protocol: 'Aerodrome', chainId: 'base', name: 'Pool', tokens: ['A', 'B'] }];
  const twins = [
    { key: 'n1', protocol: 'Aerodrome', chainId: 'base', name: 'Pool', tokens: ['A', 'B'] },
    { key: 'n2', protocol: 'Aerodrome', chainId: 'base', name: 'Pool', tokens: ['A', 'B'] },
  ];
  assert.equal(relinkKeys([{ positionId: 1, key: 'old' }], previous, twins).length, 0);
  assert.equal(relinkKeys([{ positionId: 1, key: 'old' }], previous, []).length, 0); // withdrawn → stays as is
});

test('a duplicated row id (stale copy in another group) is counted once', () => {
  // Zerion can list the same row id twice: a stale copy alone in one group, the current one next to its pair.
  const rows = [
    { ...row('dup', 'g-stale', 'AERO', 100) },
    { ...row('dup', 'g-live', 'AERO', 95) },
    { ...row('usdc', 'g-live', 'USDC', 5) },
  ];
  const items = normalizeZerion(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].netUsd, 100); // the complete group (95 + 5), not 200
  assert.deepEqual(items[0].tokens.sort(), ['AERO', 'USDC']);
});
