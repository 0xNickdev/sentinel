import { solPriceUsd, type DexPair } from '../../lib/market.js';
import type { ScanContext } from '../context.js';
import { BlockBuilder, lin, round1 } from './util.js';

/** Venues where LP cannot be pulled: pump.fun curve is program-held, PumpSwap migration burns LP. */
/**
 * A curve this young with no SOL in it has simply not been bought yet: the curve itself still quotes both ways.
 * Older than this and still empty, nobody is buying, which is how dead launches look.
 */
const FRESH_CURVE_SECONDS = 3600;
const LOCKED_VENUES = new Set(['pumpfun', 'pumpswap']);

export const mainPair = (pairs: DexPair[]) =>
  [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

/** Liquidity: depth and locked share. Weight 15. */
export async function liquidityBlock(ctx: ScanContext) {
  const b = new BlockBuilder('liquidity', 'Liquidity', 15);
  const [curve, pairs] = await Promise.all([ctx.bondingCurve(), ctx.dexPairs()]);
  let curveAgeSec: number | null = null;

  let liqUsd: number;
  let venue: string;
  let locked: boolean | null;

  if (curve.exists && !curve.complete) {
    liqUsd = curve.realSolReserves * (await solPriceUsd());
    venue = 'pump.fun bonding curve';
    locked = true;
    b.details.bondingCurveSol = round1(curve.realSolReserves);
    const launch = await ctx.launch().catch(() => null);
    if (launch?.creationTime) curveAgeSec = Date.now() / 1000 - launch.creationTime;
  } else if (pairs.length) {
    const main = mainPair(pairs);
    liqUsd = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    venue = main.dexId;
    locked = LOCKED_VENUES.has(main.dexId) ? true : null;
    b.details.pairs = pairs.length;
    b.details.mainPair = main.pairAddress;
  } else {
    b.score = 0;
    b.details = { liquidityUsd: 0 };
    b.flag('no_liquidity', 'warn', 'No pool and no bonding curve, so there is nowhere to buy or sell');
    return b.build();
  }

  // 10 pts: log scale, $5k → 0, $100k → full
  const depth = 10 * lin(Math.log10(Math.max(liqUsd, 1)), Math.log10(100_000), Math.log10(5_000));
  const lockPts = locked ? 5 : 2;
  b.score = depth + lockPts;
  Object.assign(b.details, { liquidityUsd: Math.round(liqUsd), venue, lpLocked: locked });

  if (locked === null) {
    b.status = 'partial';
    b.flag('lp_lock_unknown', 'info', `LP lock on ${venue} is not checked in v1`);
  }
  const liqLabel = `~$${Math.round(liqUsd).toLocaleString('en-US')}`;
  const freshCurve = curveAgeSec !== null && curveAgeSec < FRESH_CURVE_SECONDS;
  if (liqUsd < 500 && freshCurve) {
    b.score = 0;
    b.flag('fresh_launch', 'warn', `Launched ${Math.max(1, Math.round(curveAgeSec! / 60))} min ago on the pump.fun curve: too early to judge, treat as high risk`);
  } else if (liqUsd < 500) {
    b.score = 0;
    b.flag('no_real_liquidity', 'critical', `Almost no liquidity (${liqLabel}), no trade possible without heavy losses`);
  } else if (liqUsd < 5_000) b.flag('low_liquidity', 'warn', `Liquidity is only ${liqLabel}`);
  return b.build();
}
