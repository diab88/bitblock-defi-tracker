// Closing a pool and returning its tokens to the wallet is money moving, not profit. (Fictional figures.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFlow, detectExit, detectExits } from '../server/integrations.js';

const wallet = (net, exp) => ({ protocol: 'Wallet', netUsd: net, exposure: exp.map(([symbol, qty, priceUsd]) => ({ symbol, qty, priceUsd })) });

test('tokens arriving from a closed pool are a transfer, price moves are profit', () => {
  const before = wallet(100, [['USDC', 60, 1], ['ETH', 0.01, 3000], ['WETH', 0.002, 3000], ['DEGEN', 400, 0.01]]);
  // Pool paid out 0.008 WETH + 3,600 DEGEN ($60 at the old prices); ETH also moved 3000 → 3100.
  const after = wallet(100 + 0.012 * 100 + 0.008 * 3100 + 3600 * 0.01,
    [['USDC', 60, 1], ['ETH', 0.01, 3100], ['WETH', 0.01, 3100], ['DEGEN', 4000, 0.01]]);
  const f = walletFlow(before, after);
  assert.ok(f.significant);
  assert.ok(Math.abs(f.priceEffect - 0.012 * 100) < 1e-9);     // only what was held before
  assert.ok(Math.abs(f.flow - (0.008 * 3100 + 36)) < 1e-9);     // the new tokens, at today's price
});

test('pure price moves and dust are not transfers; missing old prices → no guess', () => {
  const a = wallet(100, [['ETH', 0.037, 2700]]);
  assert.equal(walletFlow(a, wallet(0.037 * 2800, [['ETH', 0.037, 2800]])).significant, false);
  assert.equal(walletFlow(a, wallet(100 - 0.2, [['ETH', 0.037, 2700]])).significant, false); // gas
  assert.equal(walletFlow(wallet(100, [['ETH', 0.037, null]]), a), null);
});

test('a vanished pool is closed at the receipts that paid its tokens back', () => {
  const pool = { protocol: 'Aerodrome', chainId: 'base', tokens: ['WETH', 'DEGEN'], lastValue: 60, lastDate: '2026-06-20' };
  const tx = (id, time, ins) => ({ id, date: '2026-06-20', minedAt: time, op: 'receive', app: null, chainId: 'base', hash: '0x' + id, in: ins.map(([symbol, usd]) => ({ symbol, usd })), out: [] });
  const txs = [
    tx('fee', '10:00', [['DEGEN', 0.8], ['WETH', 0.7]]),                 // last fee collection
    tx('exit', '10:03', [['WETH', 25], ['DEGEN', 0], ['DEGEN', 35.5]]),  // principal
    tx('other', '10:30', [['USDC', 40]]),                                  // unrelated token
  ];
  const x = detectExit(pool, txs);
  assert.deepEqual(x.txIds, ['exit']);
  assert.ok(Math.abs(x.usd - 60.5) < 1e-9);
  assert.equal(x.date, '2026-06-20');
  assert.equal(detectExit(pool, txs.filter((t) => t.id !== 'exit')), null); // no evidence → ask the user
});

test('several pools closed together: each payout counts once, even when they share a token', () => {
  const base = { chainId: 'base', lastDate: '2026-07-01' };
  const pools = [
    { ...base, id: 1, protocol: 'Uniswap V3', tokens: ['USDC', 'WETH'], lastValue: 400 },
    { ...base, id: 2, protocol: 'Uniswap V3', tokens: ['cbBTC', 'USDC'], lastValue: 330 },
    { ...base, id: 3, protocol: 'Aerodrome', tokens: ['USDC', 'AERO'], lastValue: 110 },
  ];
  const tx = (id, op, app, ins) => ({ id, date: '2026-07-01', op, app, chainId: 'base', hash: '0x' + id, in: ins.map(([symbol, usd]) => ({ symbol, usd })), out: [] });
  const txs = [
    tx('p2', 'withdraw', 'Uniswap V3', [['USDC', 329]]),                // USDC-only payout: fits all three pools by token
    tx('p1', 'withdraw', 'Uniswap V3', [['USDC', 340], ['WETH', 61]]),   // exact token set of pool 1
    tx('p3', 'receive', 'Uniswap V3', [['USDC', 22], ['AERO', 89]]),     // exact token set of pool 3
  ];
  const x = detectExits(pools, txs);
  assert.deepEqual(x.get(1).txIds, ['p1']);
  assert.deepEqual(x.get(2).txIds, ['p2']);     // not also counted in pools 1 and 3
  assert.deepEqual(x.get(3).txIds, ['p3']);
  assert.equal(x.get(1).usd, 401);
  assert.equal(x.get(3).usd, 111);
  // An exit far above the pool's last value is not trusted.
  assert.equal(detectExits([{ ...pools[2], lastValue: 50 }], [tx('big', 'receive', null, [['USDC', 200], ['AERO', 10]])]).get(3), null);
});
