import { jupQuote } from '../../lib/market.js';
import { WSOL } from '../../lib/programs.js';
import type { ScanContext } from '../context.js';
import { mainPair } from './liquidity.js';
import { BlockBuilder, round1 } from './util.js';

/** Trading anomalies: wash trading, spikes, one-way flow + a sell test (honeypot). Weight 10. */
export async function marketBlock(ctx: ScanContext) {
  const b = new BlockBuilder('market', 'Trading anomalies', 10);
  const [pairs, mint, curve] = await Promise.all([ctx.dexPairs(), ctx.mintInfo(), ctx.bondingCurve()]);
  const hasMarket = pairs.length > 0 || (curve.exists && !curve.complete);
  let pts = 10;

  // Honeypot test: can ~0.05% of supply be sold for SOL?
  const sellAmount = mint.supply / 2000n > 0n ? mint.supply / 2000n : 1n;
  let sellable: boolean | null = null;
  let priceImpactPct: number | null = null;
  try {
    const q = await jupQuote(ctx.mint, WSOL, sellAmount);
    sellable = !!q && BigInt(q.outAmount) > 0n;
    priceImpactPct = q ? Number(q.priceImpactPct) * 100 : null;
  } catch {
    b.status = 'partial';
  }
  if (hasMarket && sellable === false) {
    pts = 0;
    b.flag('no_sell_route', 'critical', 'The token cannot be sold: no sell route (honeypot)');
  }
  if (priceImpactPct != null && priceImpactPct > 15) {
    pts -= 2;
    b.flag('high_price_impact', 'warn', `Selling 0.05% of supply moves the price by ${round1(priceImpactPct)}%`);
  }

  const main = pairs.length ? mainPair(pairs) : undefined;
  if (main) {
    const liq = main.liquidity?.usd ?? 0;
    const vol24 = main.volume?.h24 ?? 0;
    const buys = main.txns?.h24?.buys ?? 0;
    const sells = main.txns?.h24?.sells ?? 0;
    const m5 = main.priceChange?.m5 ?? 0;
    const h1 = main.priceChange?.h1 ?? 0;
    const turnover = liq > 0 ? vol24 / liq : 0;

    if (turnover > 30) {
      pts -= 4;
      b.flag('wash_trading_suspected', 'warn', `24h volume is ${Math.round(turnover)}× liquidity, possible wash trading`);
    }
    if (buys >= 30 && sells === 0) {
      pts -= 5;
      b.flag('no_sells', 'warn', `${buys} buys and not a single sell in 24h`);
    }
    if (m5 <= -80 || h1 <= -80) {
      pts -= 6;
      b.flag('price_crash', 'warn', `Price crashed ${Math.round(Math.min(m5, h1))}% (likely a rug)`);
    } else if (Math.abs(m5) > 40 || h1 > 300) {
      pts -= 3;
      b.flag('price_spike', 'warn', `Sharp price spike: ${m5}% in 5 min, ${h1}% in 1 h`);
    }
    Object.assign(b.details, { volume24hUsd: Math.round(vol24), buys24h: buys, sells24h: sells, priceChange5m: m5, priceChange1h: h1, turnover: round1(turnover) });
  } else {
    b.status = 'partial';
  }

  Object.assign(b.details, { sellable, sellTestPriceImpactPct: priceImpactPct == null ? null : round1(priceImpactPct) });
  b.score = pts;
  return b.build();
}
