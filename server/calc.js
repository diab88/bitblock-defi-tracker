// Position math, ported from the Excel tracker (Strategies sheet, columns I–V).
//
// Instead of the sheet's Inputs D/E + Strategies W juggling, every change is an
// event: valuation | withdrawal | reward | fee. The sheet's rules then fall out:
//   Current Value  = last valuation − withdrawals + capital added, recorded after it  (J = D − W + E)
//   Profit / Loss  = Current Value + withdrawals + rewards − fees − Deposit − capital added   (N)
// "deposit" events are capital moved in after the start (e.g. tokens returned to a wallet from a closed
// pool): they raise the amount invested, never the profit — the mirror image of a withdrawal.
//   Total Return   = P/L ÷ Deposit                                           (O)
//   Annualized     = Total Return × 365 ÷ Duration                           (P)
//   Duration       = (Exit Date or Valuation Date) − Entry Date              (Q)

const DAY = 86400000;

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

// Events sorted chronologically; same-day events keep insertion order.
export function sortEvents(events) {
  return [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}

function sumType(events, type) {
  return events.reduce((s, e) => (e.type === type ? s + e.amount : s), 0);
}

// Position state using only events up to and including `upTo` (ISO date) — or all events.
export function stateAt(position, events, upTo = null) {
  const evs = sortEvents(events).filter((e) => !upTo || e.date <= upTo);
  let lastVal = -1;
  evs.forEach((e, i) => { if (e.type === 'valuation') lastVal = i; });

  const withdrawals = sumType(evs, 'withdrawal');
  const rewards = sumType(evs, 'reward');
  const fees = sumType(evs, 'fee');
  const added = sumType(evs, 'deposit');
  let currentValue = null;
  let valuationDate = null;
  if (lastVal >= 0) {
    const after = evs.slice(lastVal + 1);
    currentValue = evs[lastVal].amount - sumType(after, 'withdrawal') + sumType(after, 'deposit');
    valuationDate = evs[lastVal].date;
  }
  const deposit = (position.deposit || 0) + added; // capital invested so far
  const valid = deposit > 0 && currentValue !== null && currentValue >= 0;
  const pnl = valid ? currentValue + withdrawals + rewards - fees - deposit : null;
  return { currentValue, valuationDate, withdrawals, rewards, fees, added, capital: deposit, pnl };
}

export function computePosition(position, events, price) {
  const s = stateAt(position, events);
  const closed = !!position.closed;
  const endDate = closed ? position.exit_date : s.valuationDate;
  let duration = null;
  if (position.entry_date && endDate) {
    const d = daysBetween(position.entry_date, endDate);
    duration = d >= 0 ? d : null;
  }
  const totalReturn = s.pnl !== null ? s.pnl / s.capital : null;
  const annualized = totalReturn !== null && duration ? (totalReturn * 365) / duration : null;

  // Status / Validation (column R), same precedence as the sheet.
  let status;
  if (!position.strategy || !position.chain || !position.currency || !position.entry_date || !(position.deposit > 0)) status = 'Complete inputs';
  else if (s.currentValue === null) status = 'Enter position value';
  else if (s.currentValue < 0) status = 'Check withdrawals';
  else if (closed && !position.exit_date) status = 'Check dates';
  else if (endDate && duration === null) status = 'Check dates';
  else status = closed ? 'Closed' : 'Open';

  const usd = price && price.usd_price > 0 ? price.usd_price : null;
  const toUsd = (v) => (usd !== null && v !== null ? v * usd : null);
  const counted = status === 'Open' || status === 'Closed';
  return {
    ...s,
    status,
    duration,
    totalReturn,
    annualized,
    expectedReturn: position.expected_return ?? null,
    usdPrice: usd,
    usdPriceDate: price?.price_date ?? null,
    depositUsd: toUsd(s.capital),
    valueUsd: status === 'Open' ? toUsd(s.currentValue) : status === 'Closed' ? 0 : null,
    pnlUsd: counted ? toUsd(s.pnl) : null, // column U
  };
}

// Per-currency rollup, same as the Overview sheet (native units, no conversion).
export function summarizeByCurrency(rows) {
  const out = {};
  for (const r of rows) {
    const c = r.currency || '(none)';
    const o = (out[c] ??= { currency: c, total: 0, open: 0, closed: 0, incomplete: 0, deposit: 0, openValue: 0, openPnl: 0, closedPnl: 0, withdrawals: 0, usdPrice: r.metrics.usdPrice, noWallet: 0 });
    const m = r.metrics;
    o.total++;
    o.deposit += m.capital ?? r.deposit ?? 0;
    o.withdrawals += m.withdrawals;
    if (!r.wallet_id) o.noWallet++;
    if (m.status === 'Open') { o.open++; o.openValue += m.currentValue; o.openPnl += m.pnl; }
    else if (m.status === 'Closed') { o.closed++; o.closedPnl += m.pnl; }
    else o.incomplete++;
  }
  return Object.values(out).map((o) => ({
    ...o,
    totalPnl: o.openPnl + o.closedPnl,
    totalPnlUsd: o.usdPrice ? (o.openPnl + o.closedPnl) * o.usdPrice : null,
  }));
}

// Portfolio time series in USD at *current* prices (historical prices are not stored).
export function portfolioSeries(rows) {
  const dates = new Set();
  for (const r of rows) {
    if (r.entry_date) dates.add(r.entry_date);
    for (const e of r.events) dates.add(e.date);
    if (r.closed && r.exit_date) dates.add(r.exit_date);
  }
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...dates].filter((d) => d <= today).sort();
  return sorted.map((date) => {
    let invested = 0, value = 0, pnl = 0;
    for (const r of rows) {
      const px = r.metrics.usdPrice;
      if (!px || !r.entry_date || r.entry_date > date || !(r.deposit > 0)) continue;
      const exited = r.closed && r.exit_date && r.exit_date <= date;
      let s = stateAt(r, r.events, date);
      // Before the first valuation the position is assumed to be worth its deposit.
      if (s.currentValue === null) s = { ...s, currentValue: r.deposit, pnl: s.withdrawals + s.rewards - s.fees };
      if (s.pnl === null) continue;
      pnl += s.pnl * px;
      if (!exited) { invested += ((r.deposit || 0) + (s.added || 0)) * px; value += s.currentValue * px; }
    }
    return { date, invested, value, pnl };
  });
}

export function positionSeries(position, events) {
  const dates = [...new Set([position.entry_date, ...events.map((e) => e.date)].filter(Boolean))].sort();
  return dates.map((date) => {
    let s = stateAt(position, events, date);
    if (s.currentValue === null) s = { ...s, currentValue: position.deposit, pnl: s.withdrawals + s.rewards - s.fees };
    return { date, value: s.currentValue, withdrawals: s.withdrawals, pnl: s.pnl };
  });
}
