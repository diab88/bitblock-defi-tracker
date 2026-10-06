// DEX connectors: value, capital (net deposits) and P/L parts that add up, from API-shaped payloads (fictional numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hyperliquidItems, hyperliquidFlows, gmxItems, bulkItem, grvtItem } from '../server/dexes.js';
import { accountSince } from '../server/integrations.js';

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const VAULT = '0x3333333333333333333333333333333333333333';
const t = (d) => Date.parse(`${d}T12:00:00Z`);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('Hyperliquid: deposits, withdrawals and transfers are capital; vault deposits move to the vault item', () => {
  const ledger = [
    { time: t('2026-03-01'), delta: { type: 'deposit', usdc: '1000.0' } },
    { time: t('2026-03-02'), delta: { type: 'internalTransfer', usdc: '200.0', user: OTHER, destination: ME, fee: '0' } },
    { time: t('2026-03-03'), delta: { type: 'vaultDeposit', vault: VAULT, usdc: '300.0' } },
    { time: t('2026-03-04'), delta: { type: 'accountClassTransfer', usdc: '50.0', toPerp: true } },
    { time: t('2026-04-01'), delta: { type: 'withdraw', usdc: '100.0', nonce: 1, fee: '1.0' } },
  ];
  const { flows, vaults } = hyperliquidFlows(ledger, ME);
  near(flows.reduce((a, f) => a + f.usd, 0), 1000 + 200 - 300 - 100);
  near(vaults[VAULT].reduce((a, m) => a + m.usd, 0), 300);

  const items = hyperliquidItems({
    address: ME, ledger,
    state: { marginSummary: { accountValue: '880.0' }, assetPositions: [{ position: { coin: 'ETH', szi: '-0.5', entryPx: '3000', positionValue: '1450', unrealizedPnl: '50', liquidationPx: null, leverage: { value: 5 } } }] },
    spot: { balances: [{ coin: 'USDC', total: '20.0', entryNtl: '0' }, { coin: 'HYPE', total: '2', entryNtl: '60' }] },
    mids: { ETH: '2900', HYPE: '40' },
    fills: [
      { coin: 'ETH', time: t('2026-03-05'), startPosition: '0.0', closedPnl: '0', fee: '1.5', feeToken: 'USDC' },
      { coin: 'BTC', time: t('2026-03-10'), startPosition: '0.01', closedPnl: '40', fee: '0.5', feeToken: 'USDC' },
    ],
    funding: [{ time: t('2026-03-20'), delta: { type: 'funding', coin: 'ETH', usdc: '3.0' } }],
    vaultEquities: [{ vaultAddress: VAULT, equity: '330.0' }], vaultNames: { [VAULT]: 'Hyperliquidity Provider (HLP)' },
  });
  const acc = items.find((i) => i.key === 'hyperliquid|account');
  near(acc.netUsd, 880 + 20 + 2 * 40);                    // perps account + USDC + HYPE at its mid
  near(acc.depositUsd, 800);
  assert.equal(acc.entryDate, '2026-03-01');
  assert.deepEqual(acc.positions.map((p) => [p.market, p.side, p.size, p.markPrice, p.openedAt]), [['ETH-USD', 'SHORT', 0.5, 2900, '2026-03-05']]);
  assert.ok(acc.reconcile.ok);                            // parts add up to value − capital
  near(acc.breakdown.reduce((a, b) => a + b.usd, 0), acc.netUsd - 800);
  const vault = items.find((i) => i.key === `hyperliquid|vault|${VAULT}`);
  assert.equal(vault.name, 'Hyperliquidity Provider (HLP)');
  near(vault.netUsd, 330); near(vault.depositUsd, 300);

  // A later start date drops trades and funding before it, and the parts still add up.
  const since = accountSince(acc, '2026-03-15', { ETH: 2950 });
  assert.ok(since.reconcile.ok);
  assert.ok(since.excludedTrades.some((x) => x.market === 'BTC-USD'));
});

test('GMX: each open position is an item; USD values are scaled by 1e30', () => {
  const e30 = (x) => (BigInt(Math.round(x * 1e6)) * 10n ** 24n).toString();
  const [i] = gmxItems('arbitrum', [{
    key: '0xabc', indexName: 'ETH/USD', poolName: 'WETH-USDC', isLong: true, sizeInUsd: e30(3000), markPrice: e30(3000), entryPrice: e30(2800),
    netValue: e30(1180), collateralUsd: e30(1000), pnlAfterFees: e30(180), liquidationPrice: e30(1900), leverage: '25000', increasedAtTime: String(t('2026-05-01') / 1000),
  }]);
  assert.equal(i.key, 'gmx|arbitrum|0xabc');
  near(i.netUsd, 1180); near(i.depositUsd, 1000);
  assert.equal(i.entryDate, '2026-05-01');
  const [p] = i.positions;
  assert.deepEqual([p.market, p.side, p.leverage], ['ETH-USD', 'LONG', 2.5]);
  near(p.size, 3000 / 2800); near(p.entryPrice, 2800); near(p.uPnl, 180);
});

test('Bulk: deposits and transfers in are capital; closed trades include their fees and funding', () => {
  const ns = (d) => String(BigInt(t(d)) * 1000000n);
  const item = bulkItem({
    address: 'SoLMe111', account: [{ fullAccount: { margin: { totalMargin: 1150, unrealizedPnl: 25 }, positions: [{ symbol: 'SOL-USD', size: 3, price: 150, fairPrice: 158, notional: 474, unrealizedPnl: 25, leverage: 2, averageEntryTime: ns('2026-06-02') }] } }],
    activity: [
      { activityType: 'deposit', status: 'completed', symbol: 'USD', amount: 1000, timestamp: ns('2026-06-01') },
      { activityType: 'transferInternal', status: 'completed', symbol: 'USD', amount: 100, from: 'Other', to: 'SoLMe111', timestamp: ns('2026-06-02') },
      { activityType: 'withdrawal', status: 'pending', symbol: 'USD', amount: 500, timestamp: ns('2026-06-03') },
    ],
    closed: [{ symbol: 'BTC-USD', realizedPnl: 60, fees: -8, funding: -2, closeTime: ns('2026-06-05') }],
  });
  near(item.netUsd, 1175); near(item.depositUsd, 1100);
  near(item.closedTrades[0].realisedPnl, 50);
  assert.ok(item.reconcile.ok);
  assert.equal(item.positions[0].openedAt, '2026-06-02');
});

test('GRVT: capital is what was transferred into the trading sub-account', () => {
  const ns = (d) => String(BigInt(t(d)) * 1000000n);
  const item = grvtItem({
    subAccountId: '42',
    summary: { total_equity: '1530.5', positions: [{ instrument: 'BTC_USDT_Perp', size: '-0.01', notional: '900', entry_price: '91000', mark_price: '90000', unrealized_pnl: '10', est_liquidation_price: '120000', leverage: '3' }] },
    transfers: [
      { from_sub_account_id: '0', to_sub_account_id: '42', currency: 'USDT', num_tokens: '2000', event_time: ns('2026-07-01') },
      { from_sub_account_id: '42', to_sub_account_id: '0', currency: 'USDT', num_tokens: '500', event_time: ns('2026-07-10') },
      { from_sub_account_id: '0', to_sub_account_id: '77', currency: 'USDT', num_tokens: '999', event_time: ns('2026-07-11') },
    ],
    fills: [{ instrument: 'BTC_USDT_Perp', realized_pnl: '25', fee: '1', event_time: ns('2026-07-05') }],
  });
  near(item.depositUsd, 1500); near(item.netUsd, 1530.5);
  assert.deepEqual(item.positions.map((p) => [p.market, p.side]), [['BTC-USD', 'SHORT']]);
  assert.ok(item.reconcile.ok);
});
