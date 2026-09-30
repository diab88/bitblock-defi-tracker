// Cross-venue hedge detection: a token staked on one venue + a short perp on another (fictional figures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExposure, detectHedges } from '../server/hedges.js';

const stake = { positionId: 8, label: 'Lighter · LIT staking', venue: 'Lighter', symbol: 'LIT', qty: 201.5, kind: 'hold', priceUsd: 2.52, pure: true, pnlUsd: 104.03 };
const short = { positionId: 11, label: 'LIT-USD short', venue: 'Extended', symbol: 'LIT', qty: -200, kind: 'perp', priceUsd: 2.5,
  perp: { entryPrice: 2, markPrice: 2.5, uPnl: -100, realisedPnl: 4, funding: 4.5, liquidationPrice: 3.4 } };

test('long stake + short perp on the same asset is a neutral hedge', () => {
  const [h] = detectHedges(computeExposure([stake, short]));
  assert.equal(h.asset, 'LIT');
  assert.equal(h.status, 'neutral');
  assert.ok(Math.abs(h.ratio - 200 / 201.5) < 1e-9);
  assert.ok(Math.abs(h.netQty - 1.5) < 1e-9);
  assert.equal(h.price, 2.5); // perp mark preferred for pricing the net
  assert.ok(Math.abs(h.perpPnl + h.perpCarry - (-96)) < 1e-9);
  assert.ok(Math.abs(h.liquidationDistance - (3.4 / 2.5 - 1)) < 1e-9);
});

test('stablecoins never count; wrapped tokens net with their underlying', () => {
  const ex = computeExposure([
    { positionId: 1, symbol: 'USDC', qty: 500, kind: 'hold' },
    { positionId: 1, symbol: 'WETH', qty: 0.5, kind: 'hold', priceUsd: 2700 },
    { positionId: 2, symbol: 'ETH', qty: 0.2, kind: 'hold', priceUsd: 2700 },
    { positionId: 3, symbol: 'ETH', qty: -0.7, kind: 'perp', priceUsd: 2700, perp: {} },
  ]);
  assert.deepEqual(ex.map((a) => a.asset), ['ETH']);
  assert.ok(Math.abs(ex[0].net - 0) < 1e-12);
  assert.equal(detectHedges(ex)[0].status, 'neutral');
});

test('small shorts are not hedges; mismatched sizes are flagged', () => {
  assert.equal(detectHedges(computeExposure([{ ...stake, qty: 1000 }, { ...short, qty: -100 }])).length, 0); // 10% < 20%
  assert.equal(detectHedges(computeExposure([{ ...stake, qty: 300 }, short]))[0].status, 'under');
  assert.equal(detectHedges(computeExposure([{ ...stake, qty: 150 }, short]))[0].status, 'over');
});

test('an unhedged long is just exposure', () => {
  const ex = computeExposure([{ positionId: 5, symbol: 'AERO', qty: 120, kind: 'hold', priceUsd: 1.1 }]);
  assert.equal(ex[0].net, 120);
  assert.equal(detectHedges(ex).length, 0);
});
