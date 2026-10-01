import { POOL_AUTHORITIES } from '../../lib/programs.js';
import type { ScanContext } from '../context.js';
import { BlockBuilder, lin, pct, round1 } from './util.js';

/** Slots after creation that count as "sniped" (~1.2 s). */
const SNIPE_WINDOW_SLOTS = 3;

export interface EarlyBuys {
  creationSlot: number;
  devBoughtPct: number;
  sniperPct: number;
  sameSlotBuyers: string[];
  snipers: Array<{ wallet: string; pct: number; slotOffset: number }>;
}

/** Token flows out of the curve/pool to wallets in the first slots after creation. */
export async function earlyBuys(ctx: ScanContext): Promise<EarlyBuys | null> {
  const [launch, mint, creator, curve] = await Promise.all([ctx.launch(), ctx.mintInfo(), ctx.creator(), ctx.bondingCurve()]);
  if (!launch.complete || launch.creationSlot == null) return null;
  const supplyUi = Number(mint.supply) / 10 ** mint.decimals;
  const start = launch.creationSlot;

  const bought = new Map<string, { amount: number; slotOffset: number }>();
  for (const tx of launch.early) {
    const offset = tx.slot - start;
    if (offset > SNIPE_WINDOW_SLOTS) break;
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== ctx.mint || !t.fromUserAccount || !t.toUserAccount) continue;
      if (t.toUserAccount === curve.address || POOL_AUTHORITIES.has(t.toUserAccount) || t.toUserAccount === t.fromUserAccount) continue;
      const prev = bought.get(t.toUserAccount);
      bought.set(t.toUserAccount, { amount: (prev?.amount ?? 0) + t.tokenAmount, slotOffset: Math.min(prev?.slotOffset ?? offset, offset) });
    }
  }

  const devBoughtPct = pct(bought.get(creator ?? '')?.amount ?? 0, supplyUi);
  const snipers = [...bought]
    .filter(([w]) => w !== creator)
    .map(([wallet, v]) => ({ wallet, pct: pct(v.amount, supplyUi), slotOffset: v.slotOffset }))
    .sort((a, b) => b.pct - a.pct);
  return {
    creationSlot: start,
    devBoughtPct,
    sniperPct: snipers.reduce((s, x) => s + x.pct, 0),
    sameSlotBuyers: snipers.filter((s) => s.slotOffset === 0).map((s) => s.wallet),
    snipers,
  };
}

/** Bundles & snipers: buys in the first blocks. Weight 15. */
export async function launchBlock(ctx: ScanContext) {
  const b = new BlockBuilder('launch', 'Bundles & snipers', 15);
  const launch = await ctx.launch();
  const early = await earlyBuys(ctx);

  if (!early) {
    // History too long to reach the creation block within budget: the launch is old/very active,
    // so early-block manipulation matters less. Score neutral and say so.
    b.status = 'partial';
    b.score = 10;
    b.details = { analyzed: false, reason: `history longer than ${launch.totalSignatures} transactions, launch not analyzed` };
    b.flag('launch_not_analyzed', 'info', 'Old or very active launch, first blocks were not checked');
    return b.build();
  }

  const bundled = early.sameSlotBuyers.length;
  const bundlePts = bundled === 0 ? 5 : bundled <= 2 ? 3 : bundled <= 4 ? 1 : 0;
  b.score = 10 * lin(early.sniperPct, 3, 25) + bundlePts;
  b.details = {
    analyzed: true,
    creationSlot: early.creationSlot,
    createdAt: launch.creationTime ? new Date(launch.creationTime * 1000).toISOString() : null,
    devBoughtPct: round1(early.devBoughtPct),
    sniperPct: round1(early.sniperPct),
    sameSlotBuyers: bundled,
    topSnipers: early.snipers.slice(0, 5).map((s) => ({ ...s, pct: round1(s.pct) })),
  };

  if (bundled >= 3) b.flag('bundle_launch', 'warn', `${bundled} wallets bought in the creation block (likely a bundle)`);
  if (early.sniperPct > 15) b.flag('snipers_heavy', 'warn', `Snipers took ${round1(early.sniperPct)}% in the first blocks`);
  return b.build();
}
