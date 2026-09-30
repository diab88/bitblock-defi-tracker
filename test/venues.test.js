// Lighter pool shares and Extended accounts report deposits, which Zerion/DeBank can't.
// All figures below are fictional; they're chosen so the accounting identities are easy to check by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lighterPoolItem, extendedItem, normalizeZerion, accountSince, applyTrackFrom } from '../server/integrations.js';

const day = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;

// A fictional Extended sub-account, funded by transfers from a main account:
//   round 1: 520 XVS vault shares in (3 Mar) → ETH + SOL shorts close +$25 (1 Apr) → $25 withdrawn (2 Apr)
//            → the 520 XVS are redeemed with the proceeds paid to the main account (15 Apr)
//   round 2: 250 XVS in at $1.20 (10 May) + $300 USDC in (20 May); LIT short 200 @ $2.00, mark $2.50
//   now: cash $304 (300 + $4 funding − fees), XVS worth $302.50, short uPnL −$100
const OPS = [
  { type: 'TRANSFER', status: 'COMPLETED', amount: '300', asset: 1, time: Date.parse('2026-05-20'), counterpartyAccountId: 2 },
  { type: 'TRANSFER', status: 'COMPLETED', amount: '250', asset: 94, time: Date.parse('2026-05-10'), counterpartyAccountId: 2 },
  { type: 'VAULT_WITHDRAWAL', status: 'COMPLETED', amount: '572', asset: 1, amount2: '-520', asset2: 94, time: Date.parse('2026-04-15'), counterpartyAccountId: 2 },
  { type: 'WITHDRAWAL', status: 'COMPLETED', amount: '-25', asset: 1, time: Date.parse('2026-04-02') },
  { type: 'TRANSFER', status: 'COMPLETED', amount: '520', asset: 94, time: Date.parse('2026-03-03'), counterpartyAccountId: 2 },
  { type: 'DEPOSIT', status: 'REJECTED', amount: '999', asset: 1, time: Date.parse('2026-02-01') },
];
const SPOT = [
  { asset: 'USD', balance: '304', notionalValue: '304' },
  { asset: 'XVS', balance: '250', notionalValue: '302.5', averageEntryPrice: '1.2' },
];
const SHORT = { id: 7, market: 'LIT-USD', side: 'SHORT', size: '200', value: '500', openPrice: '2', markPrice: '2.5', liquidationPrice: '3.4',
  leverage: '10', unrealisedPnl: '-100', realisedPnl: '4', createdAt: Date.parse('2026-05-10') };
const HIST = [
  { id: 7, market: 'LIT-USD', realisedPnl: '4' },
  { id: 1, market: 'ETH-USD', side: 'SHORT', realisedPnl: '30', createdTime: Date.parse('2026-03-03'), closedTime: Date.parse('2026-04-01'), exitPrice: '2400' },
  { id: 2, market: 'SOL-USD', side: 'SHORT', realisedPnl: '-5', createdTime: Date.parse('2026-03-03'), closedTime: Date.parse('2026-04-01'), exitPrice: '150' },
];
const account = () => extendedItem({ equity: '476.25', unrealisedPnl: '-100', balance: '304' }, [SHORT], OPS, SPOT, HIST);

test('Lighter pool: value = shares × latest share price; deposit, entry date and history from entry', () => {
  const pool = { name: 'Lighter Liquidity Provider (LLP)', pool_info: { annual_percentage_yield: 12, share_prices: [
    { timestamp: day('2026-05-09'), share_price: 0.0029 },
    { timestamp: day('2026-05-10'), share_price: 0.003 },
    { timestamp: day('2026-05-11'), share_price: 0.00305 },
  ] } };
  const share = { public_pool_index: 5001, shares_amount: 100000, principal_amount: '300', entry_timestamp: Date.parse('2026-05-10T09:00:00Z') };
  const i = lighterPoolItem({ index: 700001 }, share, pool);
  assert.equal(i.strategy, 'LLP');
  assert.equal(i.name, 'Lighter Liquidity Provider (LLP)');
  assert.ok(Math.abs(i.netUsd - 305) < 1e-9);
  assert.equal(i.depositUsd, 300);
  assert.equal(i.entryDate, '2026-05-10');
  assert.deepEqual(i.history.map((h) => h.date), ['2026-05-10', '2026-05-11']); // nothing before entry
  assert.equal(i.key, 'lighter|pool|5001|700001');
});

test('Lighter pool without entry time: no history, principal still used', () => {
  const i = lighterPoolItem({ index: 1 }, { public_pool_index: 9, shares_amount: 10, principal_amount: '150', entry_timestamp: 0 },
    { pool_info: { share_prices: [{ timestamp: day('2026-06-01'), share_price: 2 }] } });
  assert.equal(i.netUsd, 20);
  assert.equal(i.depositUsd, 150);
  assert.equal(i.entryDate, null);
  assert.deepEqual(i.history, []);
});

test('Extended account reconciles: value = cash + full spot value + uPnL; capital = USDC flows + spot cost', () => {
  const i = account();
  assert.ok(Math.abs(i.netUsd - 506.5) < 1e-9);         // 304 + 302.50 − 100, not the haircut equity 476.25
  assert.ok(Math.abs(i.depositUsd - 575) < 1e-9);       // 300 − 25 + 250 × 1.20 (the vault payout went to the main account)
  assert.equal(i.entryDate, '2026-03-03');
  assert.deepEqual(i.spot.map((x) => x.symbol), ['XVS']);
  assert.deepEqual(i.tokens, ['LIT-USD short']);
});

test('Extended account P/L breaks down into parts that add up exactly', () => {
  const i = account();
  const by = Object.fromEntries(i.breakdown.map((b) => [b.kind, +b.usd.toFixed(2)]));
  assert.deepEqual(by, { upnl: -100, carry: 4, closed: 25, spot: 2.5 });
  assert.ok(i.reconcile.ok, `diff ${i.reconcile.diff}`);
  assert.ok(Math.abs(i.reconcile.pnl - -68.5) < 1e-9);
});

test('Zerion EVM: plain wallet tokens are grouped into one balance row per chain', () => {
  const row = (id, chain, symbol, value) => ({ id, attributes: { position_type: 'wallet', value, fungible_info: { symbol }, flags: {} }, relationships: { chain: { data: { id: chain } } } });
  const items = normalizeZerion([row('a', 'base', 'USDC', 60), row('b', 'base', 'ETH', 30), row('c', 'base', 'AERO', 2), row('d', 'arbitrum', 'ETH', 8)], { walletByChain: true });
  assert.equal(items.length, 2);
  assert.equal(items[0].chain, 'Base');
  assert.ok(Math.abs(items[0].netUsd - 92) < 1e-9);
  assert.deepEqual(items[0].tokens, ['USDC', 'ETH', 'AERO']);
  assert.equal(items[0].strategy, 'Exposure');
});

test('Lighter staking pool is tracked in the staked token, deposit in that token', () => {
  // 1,000,000 LIT over 100,000,000 shares = 0.01 LIT/share; USD share price 0.025 → LIT at $2.50.
  const pool = { account_type: 4, assets: [{ symbol: 'LIT', balance: '1000000' }],
    pool_info: { total_shares: 100000000, share_prices: [{ timestamp: day('2026-06-01'), share_price: 0.025 }] } };
  const i = lighterPoolItem({ index: 700001 }, { public_pool_index: 5002, shares_amount: 20150, principal_amount: '200', entry_timestamp: 0 }, pool);
  assert.equal(i.currency, 'LIT');
  assert.equal(i.strategy, 'Staking');
  assert.ok(Math.abs(i.amount - 201.5) < 1e-9);
  assert.equal(i.depositAmount, 200);
  assert.equal(i.depositUsd, null);
  assert.ok(Math.abs(i.netUsd - 503.75) < 1e-9);
  assert.ok(Math.abs(i.impliedPrice - 2.5) < 1e-9);
});

test('counting an Extended account from a later entry date drops the earlier round entirely', () => {
  const full = account();
  const v = accountSince(full, '2026-05-10');
  assert.ok(Math.abs(v.depositUsd - 600) < 0.01);                 // everything in the account on 10 May: 275 USDC net + 25 earned + 300 XVS
  assert.ok(Math.abs(v.reconcile.pnl - -93.5) < 1e-9);           // −100 uPnL + 4 carry + 2.50 XVS
  assert.ok(v.reconcile.ok);
  assert.equal(v.breakdown.some((b) => b.kind === 'closed'), false);
  assert.deepEqual(v.excludedTrades.map((t) => t.market).sort(), ['ETH-USD', 'SOL-USD']);
  assert.ok(Math.abs(accountSince(full, '2026-03-01').reconcile.pnl - full.reconcile.pnl) < 1e-9); // earlier date → unchanged
});

test('track-from date: earlier deposits restart at the value on that date; later ones are kept', () => {
  const llp = { key: 'k', depositUsd: 300, entryDate: '2026-05-10', netUsd: 303, history: [
    { date: '2026-05-10', value: 299.9 }, { date: '2026-05-20', value: 301.2 }, { date: '2026-06-01', value: 303 } ] };
  const r = applyTrackFrom(llp, '2026-05-20');
  assert.equal(r.depositUsd, 301.2);
  assert.equal(r.entryDate, '2026-05-20');
  assert.deepEqual(r.history.map((h) => h.date), ['2026-05-20', '2026-06-01']);
  assert.equal(applyTrackFrom(llp, '2026-05-01').depositUsd, 300); // deposit after the date → unchanged
  assert.equal(applyTrackFrom(llp, null), llp);                   // all history
});

test('track-from date: a deposit with no history before the date starts from today\'s value', () => {
  const stake = { key: 's', currency: 'LIT', amount: 201.5, depositAmount: 200, entryDate: null, netUsd: 503.75, history: [] };
  const r = applyTrackFrom(stake, '2026-06-01');
  assert.equal(r.depositAmount, null);
  assert.equal(r.depositUsd, null);
  assert.equal(r.rebased, 'today');
  const plain = { key: 'p', netUsd: 100 }; // Zerion item: never reports a deposit → unaffected
  assert.equal(applyTrackFrom(plain, '2026-06-01').depositUsd, undefined);
});

test('track-from date on an exchange account drops earlier trades and flows', () => {
  const r = applyTrackFrom(account(), '2026-05-10');
  assert.ok(Math.abs(r.depositUsd - 600) < 0.01);
  assert.equal(r.entryDate, '2026-05-10');
  assert.ok(r.reconcile.ok);
});

test('a later start date never turns money already in the account into profit', () => {
  const it = extendedItem({ unrealisedPnl: '-100' }, [{ ...SHORT, createdAt: undefined }], OPS, SPOT, HIST);
  for (const since of ['2026-05-10', '2026-05-25', '2026-06-01']) {
    const v = accountSince(it, since);
    assert.ok(Math.abs(v.depositUsd - 600) < 0.02, `${since}: capital ${v.depositUsd}`); // the $300 of 20 May is capital, not profit
    assert.ok(Math.abs(v.reconcile.pnl - -93.5) < 0.02);
    assert.ok(v.reconcile.ok);
  }
});

test('start date after a hedge was opened: both legs restart at that day\'s price and still cancel', () => {
  const since = '2026-05-25', px = 2.2; // LIT on 25 May
  const a = applyTrackFrom(account(), since, { LIT: px });
  const leg = a.breakdown.filter((b) => b.market === 'LIT-USD' && b.kind === 'upnl')[0].usd;
  assert.ok(Math.abs(leg - -200 * (2.5 - px)) < 1e-9);            // only the move since 25 May (−$60)
  assert.equal(a.positions[0].entryPrice, px);
  assert.ok(a.reconcile.ok);
  const again = accountSince(a, since, { LIT: px });              // re-applying changes nothing
  assert.ok(Math.abs(again.reconcile.pnl - a.reconcile.pnl) < 1e-9);
  assert.ok(Math.abs(again.depositUsd - a.depositUsd) < 1e-9);

  const stake = { key: 's', currency: 'LIT', amount: 201.5, depositAmount: 200, entryDate: null, netUsd: 201.5 * 2.5, history: [] };
  const b = applyTrackFrom(stake, since, { LIT: px });
  assert.equal(b.trackUsd, true);
  assert.ok(Math.abs(b.depositUsd - 201.5 * px) < 0.01);
  const longPnl = b.netUsd - b.depositUsd;                        // +$60.45
  assert.ok(Math.abs(longPnl + leg) < 1);                         // legs cancel (up to the 1.5 LIT size gap)
});
