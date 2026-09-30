// Checks the app's math against the worked examples in the spreadsheet (Guide + Examples sheets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePosition, stateAt, portfolioSeries } from '../server/calc.js';

const base = { strategy: 'Staking', chain: 'Arbitrum', currency: 'USDC', entry_date: '2026-01-01', deposit: 1000, closed: 0 };
let id = 0;
const ev = (type, date, amount) => ({ id: ++id, type, date, amount });
const price = { usd_price: 1, price_date: '2026-06-01' };

test('Examples sheet: withdrawal leaves deposit and profit unchanged', () => {
  // Deposit 1,000; value 2,000; withdraw 1,000 → Current Value 1,000, Profit 1,000.
  const events = [ev('valuation', '2026-03-01', 2000), ev('withdrawal', '2026-03-02', 1000)];
  const m = computePosition(base, events, price);
  assert.equal(m.currentValue, 1000);
  assert.equal(m.pnl, 1000);
  assert.equal(m.totalReturn, 1);
  // Another 200 withdrawal: value 800, profit still 1,000.
  const m2 = computePosition(base, [...events, ev('withdrawal', '2026-03-03', 200)], price);
  assert.equal(m2.currentValue, 800);
  assert.equal(m2.pnl, 1000);
});

test('Guide: update after profit, then further withdrawal', () => {
  // After a 1,000 withdrawal, new platform value 1,200 (already reflects it) → CV 1,200, profit 1,200.
  const events = [ev('valuation', '2026-02-01', 2000), ev('withdrawal', '2026-02-02', 1000), ev('valuation', '2026-03-01', 1200)];
  let m = computePosition(base, events, price);
  assert.equal(m.currentValue, 1200);
  assert.equal(m.pnl, 1200);
  // Raise W from 1,000 to 1,200 → CV 1,000, profit stays 1,200.
  m = computePosition(base, [...events, ev('withdrawal', '2026-03-05', 200)], price);
  assert.equal(m.currentValue, 1000);
  assert.equal(m.pnl, 1200);
});

test('rewards, fees, duration and simple annualized return', () => {
  const events = [ev('valuation', '2026-04-11', 1050), ev('reward', '2026-02-01', 20), ev('fee', '2026-01-01', 10)];
  const m = computePosition(base, events, price);
  assert.equal(m.pnl, 60);
  assert.equal(m.duration, 100);
  assert.ok(Math.abs(m.annualized - 0.06 * 365 / 100) < 1e-12);
  assert.equal(m.status, 'Open');
});

test('status validation mirrors column R', () => {
  assert.equal(computePosition({ ...base, chain: null }, [], price).status, 'Complete inputs');
  assert.equal(computePosition(base, [], price).status, 'Enter position value');
  assert.equal(computePosition(base, [ev('valuation', '2026-02-01', 100), ev('withdrawal', '2026-02-02', 500)], price).status, 'Check withdrawals');
  assert.equal(computePosition(base, [ev('valuation', '2025-12-01', 100)], price).status, 'Check dates');
  const closed = computePosition({ ...base, closed: 1, exit_date: '2026-07-01' }, [ev('valuation', '2026-07-01', 1100)], price);
  assert.equal(closed.status, 'Closed');
  assert.equal(closed.duration, 181);
  assert.equal(closed.valueUsd, 0);
  assert.equal(closed.pnlUsd, 100);
});

test('USD conversion needs a positive price', () => {
  const eth = { ...base, currency: 'ETH', deposit: 2 };
  const events = [ev('valuation', '2026-03-01', 2.5)];
  assert.equal(computePosition(eth, events, { usd_price: 3000 }).pnlUsd, 1500);
  assert.equal(computePosition(eth, events, null).pnlUsd, null);
});

test('stateAt respects the date cutoff', () => {
  const events = [ev('valuation', '2026-02-01', 1100), ev('valuation', '2026-05-01', 1300)];
  assert.equal(stateAt(base, events, '2026-03-01').currentValue, 1100);
  assert.equal(stateAt(base, events).currentValue, 1300);
});

test('portfolio series drops exited capital but keeps realized P/L', () => {
  const rows = [{ ...base, closed: 1, exit_date: '2026-03-01', events: [ev('valuation', '2026-03-01', 1200)], metrics: { usdPrice: 1 } }];
  const s = portfolioSeries(rows);
  assert.deepEqual(s.map((p) => p.date), ['2026-01-01', '2026-03-01']);
  assert.deepEqual(s[0], { date: '2026-01-01', invested: 1000, value: 1000, pnl: 0 });
  assert.deepEqual(s[1], { date: '2026-03-01', invested: 0, value: 0, pnl: 200 });
});

test('capital moved into a position raises its deposit, not its profit', () => {
  // Wallet holding worth $80; a closed pool returns $40 of tokens; prices unchanged.
  const w = { ...base, deposit: 80 };
  const events = [ev('valuation', '2026-06-01', 80), ev('deposit', '2026-06-05', 40), ev('valuation', '2026-06-05', 120)];
  const m = computePosition(w, events, price);
  assert.ok(Math.abs(m.pnl) < 1e-9);
  assert.equal(m.capital, 120);
  assert.equal(m.depositUsd, 120);
  // Capital added after the last valuation also lifts current value (mirror of a withdrawal).
  const m2 = computePosition(w, [ev('valuation', '2026-06-01', 80), ev('deposit', '2026-06-05', 40)], price);
  assert.equal(m2.currentValue, 120);
  assert.ok(Math.abs(m2.pnl) < 1e-9);
});
