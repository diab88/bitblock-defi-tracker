// Zerion returns one row per token; the app must merge rows of one protocol position and net out debt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZerion } from '../server/integrations.js';

const row = (id, chain, type, symbol, value, extra = {}) => ({
  type: 'positions', id,
  attributes: { position_type: type, value, fungible_info: { symbol }, flags: { displayable: true, is_trash: false }, ...extra },
  relationships: { chain: { data: { type: 'chains', id: chain } } },
});
const aave = { protocol: 'Aave V3', protocol_module: 'lending', group_id: 'g1', name: 'Lending', application_metadata: { name: 'Aave V3' } };

test('collateral and debt in one group become one net position', () => {
  const [i] = normalizeZerion([row('a', 'base', 'deposit', 'cbETH', 6400, aave), row('b', 'base', 'loan', 'USDC', 2500, aave)]);
  assert.equal(i.netUsd, 3900);
  assert.equal(i.debtUsd, 2500);
  assert.equal(i.chain, 'Base');
  assert.equal(i.strategy, 'Looping');
  assert.deepEqual(i.tokens, ['cbETH', 'USDC']);
  assert.ok(i.key.startsWith('zerion|base|Aave V3|'));
});

test('trash and dust are dropped; wallet tokens stay separate', () => {
  const items = normalizeZerion([
    row('t', 'solana', 'wallet', 'SCAM', 99, { flags: { is_trash: true } }),
    row('d', 'solana', 'wallet', 'DUST', 0.001),
    row('j', 'solana', 'wallet', 'JitoSOL', 3000),
    row('s', 'solana', 'wallet', 'SOL', 800),
  ]);
  assert.deepEqual(items.map((i) => i.tokens[0]), ['JitoSOL', 'SOL']);
  assert.equal(items[0].strategy, 'Staking');
  assert.equal(items[1].strategy, 'Exposure');
});

test('keys are stable across syncs so linked positions keep updating', () => {
  const a = normalizeZerion([row('x', 'ethereum', 'staked', 'ETH', 5000, { protocol: 'Lido', group_id: 'lido', application_metadata: { name: 'Lido' } })]);
  const b = normalizeZerion([row('y', 'ethereum', 'staked', 'ETH', 5100, { protocol: 'Lido', group_id: 'lido', application_metadata: { name: 'Lido' } })]);
  assert.equal(a[0].key, b[0].key);
});

test('Uniswap V3 NFT pools are V3 Pool; known chains get display names', () => {
  const uni = { protocol: 'Uniswap V3', protocol_module: 'liquidity_pool', group_id: 'u1', name: 'USDC/WETH Pool 0.05% #100301', application_metadata: { name: 'Uniswap V3' } };
  const [i] = normalizeZerion([row('a', 'unichain', 'deposit', 'USDC', 200, uni), row('b', 'unichain', 'deposit', 'WETH', 150, uni)]);
  assert.equal(i.strategy, 'V3 Pool');
  assert.equal(i.chain, 'Unichain');
  const aero = { protocol: 'Aerodrome', protocol_module: 'liquidity_pool', group_id: 's1', name: 'Aerodrome AERO/USDC Pool', application_metadata: { name: 'Aerodrome' } };
  assert.equal(normalizeZerion([row('c', 'base', 'deposit', 'USDC', 60, aero), row('d', 'base', 'deposit', 'AERO', 55, aero)])[0].strategy, 'V2 Pool');
});
