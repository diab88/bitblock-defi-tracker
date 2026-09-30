// Net exposure per asset and cross-venue hedge detection.
//
// Every tracked position contributes "legs": signed token quantities it is exposed to — spot, staking and LP
// holdings are long; perp shorts are negative. Legs of the same asset are netted. When an asset is held long
// in one place and shorted in another, those legs form a hedge (e.g. a token staked on one venue + its perp short
// on another), whose combined P/L is what matters, not either leg alone.

// Assets whose price is ~$1 (or that are vault shares) carry no directional exposure.
const NEUTRAL = new Set(['USD', 'USDC', 'USDT', 'USDG', 'DAI', 'USDS', 'USDe', 'sUSDe', 'PYUSD', 'RLUSD', 'FRAX', 'LUSD', 'GHO', 'crvUSD', 'USDC.e', 'XVS']);
// Wrapped / staked forms move with their underlying.
const ALIAS = { WETH: 'ETH', stETH: 'ETH', wstETH: 'ETH', weETH: 'ETH', rETH: 'ETH', cbETH: 'ETH', WBTC: 'BTC', cbBTC: 'BTC', tBTC: 'BTC', WSOL: 'SOL', JitoSOL: 'SOL', mSOL: 'SOL' };
export const underlying = (sym) => ALIAS[sym] || sym;
export const isNeutralAsset = (sym) => NEUTRAL.has(sym);

// legs: [{ positionId, label, venue, symbol, qty (signed, in units), kind: 'hold'|'perp', priceUsd, perp? }]
export function computeExposure(legs) {
  const byAsset = new Map();
  for (const l of legs) {
    const asset = underlying(l.symbol);
    if (isNeutralAsset(asset) || !l.qty) continue;
    if (!byAsset.has(asset)) byAsset.set(asset, { asset, long: 0, short: 0, price: null, legs: [] });
    const a = byAsset.get(asset);
    if (l.qty > 0) a.long += l.qty; else a.short += -l.qty;
    if (l.priceUsd > 0 && (a.price === null || l.kind === 'perp')) a.price = l.priceUsd; // prefer the perp mark
    a.legs.push({ ...l, asset });
  }
  return [...byAsset.values()].map((a) => ({
    ...a,
    net: a.long - a.short,
    longUsd: a.price ? a.long * a.price : null,
    shortUsd: a.price ? a.short * a.price : null,
    netUsd: a.price ? (a.long - a.short) * a.price : null,
  })).sort((x, y) => Math.abs(y.longUsd ?? 0) + Math.abs(y.shortUsd ?? 0) - (Math.abs(x.longUsd ?? 0) + Math.abs(x.shortUsd ?? 0)));
}

// A hedge = an asset with both long holdings and a short perp, where the short covers ≥ 20% of the long.
export function detectHedges(exposure, { minRatio = 0.2, neutralBand = 0.05 } = {}) {
  const out = [];
  for (const a of exposure) {
    const shorts = a.legs.filter((l) => l.qty < 0 && l.kind === 'perp');
    const longs = a.legs.filter((l) => l.qty > 0);
    if (!shorts.length || !longs.length) continue;
    const ratio = a.short / a.long;
    if (ratio < minRatio) continue;
    const drift = a.net / a.long;
    const status = Math.abs(drift) <= neutralBand ? 'neutral' : drift > 0 ? 'under' : 'over';
    const perp = shorts.map((l) => l.perp).filter(Boolean);
    const perpPnl = perp.reduce((s, p) => s + (p.uPnl || 0), 0);
    const perpCarry = perp.reduce((s, p) => s + (p.realisedPnl || 0), 0); // funding received − trading fees so far
    const liq = perp.map((p) => p.liquidationPrice).filter((x) => x > 0);
    out.push({
      asset: a.asset,
      status,
      ratio,
      netQty: a.net,
      netUsd: a.netUsd,
      price: a.price,
      longQty: a.long,
      shortQty: a.short,
      longs: longs.map(({ perp: _p, ...l }) => l),
      shorts: shorts.map(({ perp: p, ...l }) => ({ ...l, entryPrice: p?.entryPrice, markPrice: p?.markPrice, uPnl: p?.uPnl, carry: p?.realisedPnl, funding: p?.funding, liquidationPrice: p?.liquidationPrice })),
      perpPnl,
      perpCarry,
      liquidationPrice: liq.length ? Math.min(...liq) : null,
      liquidationDistance: liq.length && a.price ? Math.min(...liq) / a.price - 1 : null,
    });
  }
  return out;
}
