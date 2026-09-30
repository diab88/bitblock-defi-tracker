// Collected-fee / deposit detection from wallet transactions (fictional Base pools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTransactions } from '../server/integrations.js';

const positions = [
  { id: 1, protocol: 'Uniswap V3', chainId: 'base', tokens: ['USDC', 'WETH'], valueUsd: 400 },
  { id: 2, protocol: 'Uniswap V3', chainId: 'base', tokens: ['USDC', 'cbBTC'], valueUsd: 300 },
  { id: 3, protocol: 'Aerodrome', chainId: 'base', tokens: ['AERO', 'USDC'], valueUsd: 120 },
  { id: 4, protocol: 'Aerodrome', chainId: 'base', tokens: ['WETH', 'DEGEN'], valueUsd: 60 },
  { id: 5, protocol: 'Wallet', chainId: 'base', tokens: ['USDC', 'ETH', 'WETH'], valueUsd: 100 },
];
const tx = (id, op, app, inT, outT = [], nftIn = false) => ({ id, date: '2026-06-10', op, app, chainId: 'base', hash: `0x${id}`, in: inT, out: outT, nftIn });
const t = (symbol, usd, qty = 1) => ({ symbol, usd, qty });

test('Uniswap V3 fee collections match the pool with that token pair', () => {
  const m = matchTransactions([
    tx('a', 'receive', 'Uniswap V3', [t('USDC', 3), t('WETH', 2)]),
    tx('b', 'receive', 'Uniswap V3', [t('cbBTC', 2.5), t('USDC', 2.5)]),
  ], positions);
  assert.deepEqual(m.map((x) => [x.kind, x.positionId, +x.usd.toFixed(2)]), [['fee', 1, 5], ['fee', 2, 5]]);
});

test('payouts without an app name match by tokens; single-token payouts only when unambiguous', () => {
  const m = matchTransactions([
    tx('c', 'receive', null, [t('USDC', 0.2), t('AERO', 0.3)]),
    tx('d', 'receive', null, [t('DEGEN', 0.5)]),
    tx('e', 'receive', null, [t('USDC', 0.5)]), // USDC is in three pools → skipped
  ], positions);
  assert.deepEqual(m.map((x) => [x.id ?? x.tx.id, x.positionId]), [['c', 3], ['d', 4]]);
});

test('large receipts are principal movements, not fees', () => {
  assert.equal(matchTransactions([tx('f', 'receive', null, [t('WETH', 15)])], positions).length, 0); // > 10% of a $60 pool
  assert.equal(matchTransactions([tx('g', 'receive', 'Uniswap V4', [t('USDC', 180)])], positions).length, 0);
});

test('minting a Uniswap V3 NFT with the pool tokens is a deposit', () => {
  const [m] = matchTransactions([tx('h', 'execute', 'Uniswap V3', [], [t('USDC', 200), t('WETH', 180)], true)], positions);
  assert.equal(m.kind, 'deposit');
  assert.equal(m.positionId, 1);
  assert.equal(m.usd, 380);
});

test('other chains and wallet rows are never matched', () => {
  const other = { ...tx('i', 'receive', 'Uniswap V3', [t('USDC', 1), t('WETH', 1)]), chainId: 'arbitrum' };
  assert.equal(matchTransactions([other], positions).length, 0);
  assert.equal(matchTransactions([tx('j', 'receive', null, [t('ETH', 1)])], positions).length, 0);
});
