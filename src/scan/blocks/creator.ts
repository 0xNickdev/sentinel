import { getSignatures, rpc } from '../../lib/helius.js';
import { dexPairsFor } from '../../lib/market.js';
import type { ScanContext } from '../context.js';
import { earlyBuys } from './launch.js';
import { BlockBuilder, pct, round1 } from './util.js';

/** A prior launch below this market cap is counted as dead / rugged. */
const DEAD_MCAP_USD = 10_000;

/** Creator: past launches, dead share, dev dump, wallet age. Weight 20. */
export async function creatorBlock(ctx: ScanContext) {
  const b = new BlockBuilder('creator', 'Creator', 20);
  const creator = await ctx.creator();
  if (!creator) {
    b.status = 'partial';
    b.score = 10;
    b.flag('creator_unknown', 'info', 'Could not identify the creator');
    return b.build();
  }

  const [prior, walletSigs, devNow, early, mint] = await Promise.all([
    priorLaunches(creator, ctx.mint),
    getSignatures(creator),
    creatorBalance(creator, ctx.mint),
    earlyBuys(ctx).catch(() => null),
    ctx.mintInfo(),
  ]);

  // Prior launches (8)
  let priorPts: number;
  if (prior.count >= 20) priorPts = 1;
  else if (prior.count >= 3) priorPts = 8 * (1 - prior.deadRate);
  else priorPts = 6;

  // Dev dump (8): the strongest single creator signal
  const devNowPct = pct(devNow, Number(mint.supply) / 10 ** mint.decimals);
  let devPts = 5;
  let devSoldPct: number | null = null;
  if (early && early.devBoughtPct > 0.05) {
    devSoldPct = Math.max(0, 100 - (devNowPct / early.devBoughtPct) * 100);
    devPts = devSoldPct >= 80 ? 0 : devSoldPct >= 40 ? 4 : 8;
  } else if (early) {
    devPts = 8; // no dev buy at launch
  }

  // Wallet age (4)
  const established = walletSigs.length >= 1000;
  const oldest = walletSigs[walletSigs.length - 1]?.blockTime;
  const ageDays = oldest ? (Date.now() / 1000 - oldest) / 86_400 : 0;
  const agePts = established ? 4 : ageDays < 1 ? 0 : ageDays < 7 ? 2 : 4;

  b.score = priorPts + devPts + agePts;
  b.details = {
    creator,
    priorLaunches: prior.count,
    priorLaunchesChecked: prior.checked,
    priorDeadRatePct: round1(prior.deadRate * 100),
    devBoughtPct: early ? round1(early.devBoughtPct) : null,
    devHoldsNowPct: round1(devNowPct),
    devSoldPct: devSoldPct == null ? null : round1(devSoldPct),
    walletAgeDays: established ? null : round1(ageDays),
    walletTxCount: established ? '1000+' : walletSigs.length,
  };

  if (prior.count >= 20) b.flag('serial_launcher', 'warn', `Creator has launched ${prior.count}+ tokens`);
  else if (prior.count >= 3 && prior.deadRate >= 0.7)
    b.flag('creator_rugs', 'warn', `${round1(prior.deadRate * 100)}% of the creator's past tokens are dead`);
  if (devSoldPct != null && devSoldPct >= 80) b.flag('dev_dump', 'warn', `Creator sold ${round1(devSoldPct)}% of their tokens`);
  if (!established && ageDays < 1) b.flag('fresh_creator', 'warn', 'Creator wallet is less than a day old');
  if (!early) b.status = 'partial';
  return b.build();
}

async function priorLaunches(creator: string, mint: string) {
  const res = await rpc<{ items: Array<{ id: string; interface: string }> }>('getAssetsByCreator', {
    creatorAddress: creator,
    onlyVerified: false,
    page: 1,
    limit: 50,
  });
  const ids = res.items.filter((a) => a.interface === 'FungibleToken' && a.id !== mint).map((a) => a.id);
  if (!ids.length) return { count: 0, checked: 0, deadRate: 0 };
  const sample = ids.slice(0, 30);
  const pairs = await dexPairsFor(sample);
  const bestCap = new Map<string, number>();
  for (const p of pairs) {
    const cap = p.marketCap ?? p.fdv ?? 0;
    bestCap.set(p.baseToken.address, Math.max(bestCap.get(p.baseToken.address) ?? 0, cap));
  }
  const dead = sample.filter((id) => (bestCap.get(id) ?? 0) < DEAD_MCAP_USD).length;
  return { count: ids.length, checked: sample.length, deadRate: dead / sample.length };
}

async function creatorBalance(owner: string, mint: string) {
  const res = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> }>(
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed' }],
  );
  return res.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}
