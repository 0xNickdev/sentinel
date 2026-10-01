import { PublicKey } from '@solana/web3.js';
import { getSignatures, parseTransactions, rpc } from '../../lib/helius.js';
import { BURN_OWNERS, POOL_AUTHORITIES, POOL_PROGRAMS } from '../../lib/programs.js';
import type { ScanContext } from '../context.js';
import { BlockBuilder, lin, pct, round1 } from './util.js';

const FUNDING_CHECK_TOP = 6;

interface Holder {
  owner: string;
  pct: number;
}

/** Holders: top-10 share, clusters funded from one SOL source. Weight 20. */
export async function holdersBlock(ctx: ScanContext) {
  const b = new BlockBuilder('holders', 'Holders', 20);
  const creatorP = ctx.creator().catch(() => null);
  const [mint, largest] = await Promise.all([
    ctx.mintInfo(),
    rpc<{ value: Array<{ address: string; amount: string }> }>('getTokenLargestAccounts', [ctx.mint]),
  ]);
  const supply = Number(mint.supply);
  const tokenAccounts = largest.value.filter((a) => a.amount !== '0');

  const accInfo = await rpc<{ value: any[] }>('getMultipleAccounts', [
    tokenAccounts.map((a) => a.address),
    { encoding: 'jsonParsed' },
  ]);
  const owners: string[] = accInfo.value.map((v) => v?.data?.parsed?.info?.owner ?? '');
  const shares = tokenAccounts.map((acc) => pct(Number(acc.amount), supply));
  const onCurve = owners.map((o) => !!o && PublicKey.isOnCurve(new PublicKey(o).toBytes()));

  // Pools and vaults are off-curve PDAs, so on-curve owners outside the static lists are wallets already.
  // The funding lookup is the slow part, so it starts now instead of after the owner-program lookup.
  const walletShares = new Map<string, number>();
  owners.forEach((o, i) => {
    if (onCurve[i] && !POOL_AUTHORITIES.has(o) && !BURN_OWNERS.has(o)) walletShares.set(o, (walletShares.get(o) ?? 0) + shares[i]);
  });
  const candidates = [...walletShares]
    .map(([owner, p]) => ({ owner, pct: p }))
    .sort((x, y) => y.pct - x.pct)
    .filter((h) => h.pct >= 0.5)
    .slice(0, FUNDING_CHECK_TOP);
  // Settled up front: a rejection while the owner lookup is still in flight must not go unhandled.
  const fundingP = fundingClusters(candidates, creatorP).then(
    (found) => ({ ok: true as const, found }),
    () => ({ ok: false as const }),
  );

  const ownerAccs = await rpc<{ value: Array<{ owner: string } | null> }>('getMultipleAccounts', [
    owners,
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ]);

  let poolPct = 0;
  let burnPct = 0;
  const vaults = new Map<string, number>();
  const byOwner = new Map<string, number>();
  tokenAccounts.forEach((_, i) => {
    const owner = owners[i];
    if (!owner) return;
    const share = shares[i];
    const ownerProgram = ownerAccs.value[i]?.owner;
    if (POOL_AUTHORITIES.has(owner) || (ownerProgram && POOL_PROGRAMS.has(ownerProgram))) poolPct += share;
    else if (BURN_OWNERS.has(owner)) burnPct += share;
    // Off-curve owners are PDAs: program vaults (lockers, multisigs, pump.fun Mayhem agent), not people.
    else if (!onCurve[i]) vaults.set(owner, (vaults.get(owner) ?? 0) + share);
    else byOwner.set(owner, (byOwner.get(owner) ?? 0) + share);
  });
  const vaultPct = [...vaults.values()].reduce((s, v) => s + v, 0);

  const holders: Holder[] = [...byOwner].map(([owner, p]) => ({ owner, pct: p })).sort((x, y) => y.pct - x.pct);
  const top10 = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const maxSingle = holders[0]?.pct ?? 0;

  let clusterPct = 0;
  let clusters: Array<{ funder: string; wallets: string[]; pct: number }> = [];
  let fundingStatus: 'ok' | 'error' = 'ok';
  const [funding, creator] = await Promise.all([fundingP, creatorP]);
  if (funding.ok) {
    // An on-curve account owned by a pool program would be reclassified above; keep clusters to real wallets.
    clusters = funding.found
      .map((c) => ({ ...c, wallets: c.wallets.filter((w) => byOwner.has(w)) }))
      .filter((c) => c.wallets.length >= 2 || (c.wallets.length === 1 && c.funder === creator))
      .map((c) => ({ ...c, pct: c.wallets.reduce((s, w) => s + (byOwner.get(w) ?? 0), 0) }));
    clusterPct = clusters.reduce((s, c) => s + c.pct, 0);
  } else {
    fundingStatus = 'error';
    b.status = 'partial';
  }

  const concentration = 12 * lin(top10, 15, 50);
  const single = 3 * lin(maxSingle, 5, 20);
  const cluster = fundingStatus === 'ok' ? 5 * lin(clusterPct, 2, 15) : 2.5;
  b.score = concentration + single + cluster;

  b.details = {
    top10Pct: round1(top10),
    maxSinglePct: round1(maxSingle),
    poolPct: round1(poolPct),
    burnedPct: round1(burnPct),
    programVaultPct: round1(vaultPct),
    programVaults: [...vaults].map(([owner, p]) => ({ owner, pct: round1(p) })),
    topHolders: holders.slice(0, 10).map((h) => ({ owner: h.owner, pct: round1(h.pct), isCreator: h.owner === creator })),
    fundingClusters: clusters.map((c) => ({ ...c, pct: round1(c.pct) })),
    clusterPct: round1(clusterPct),
  };

  if (top10 > 50) b.flag('top10_concentrated', 'warn', `Top 10 hold ${round1(top10)}% of supply`);
  if (maxSingle > 15) b.flag('whale', 'warn', `One wallet holds ${round1(maxSingle)}%`);
  if (clusterPct >= 5)
    b.flag('funding_cluster', 'warn', `Wallets funded from one SOL source hold ${round1(clusterPct)}%`);
  if (vaultPct > 20)
    b.flag('program_vault', 'info', `${round1(vaultPct)}% in program vaults (PDAs): a locker, multisig or platform agent`);
  if (clusters.some((c) => c.funder === creator))
    b.flag('creator_funded_holders', 'warn', 'The token creator funded top holders');

  return b.build();
}

/**
 * Finds who first sent SOL to each top holder. Wallets whose history exceeds one page
 * are treated as established and skipped; funders with 1000+ txs look like exchanges and are ignored.
 */
async function fundingClusters(holders: Holder[], creatorP: Promise<string | null>) {
  const firstSigs = await Promise.all(
    holders.map(async (h) => {
      const sigs = await getSignatures(h.owner);
      return sigs.length && sigs.length < 1000 ? sigs[sigs.length - 1].signature : null;
    }),
  );
  const toParse = firstSigs.filter((s): s is string => !!s);
  const [parsed, creator] = await Promise.all([
    toParse.length ? parseTransactions(toParse) : Promise.resolve([]),
    creatorP,
  ]);
  const bySig = new Map(parsed.map((t) => [t.signature, t]));

  const groups = new Map<string, Holder[]>();
  holders.forEach((h, i) => {
    const sig = firstSigs[i];
    const tx = sig ? bySig.get(sig) : undefined;
    if (!tx) return;
    const funder =
      tx.nativeTransfers?.find((t) => t.toUserAccount === h.owner && t.amount > 0)?.fromUserAccount ??
      (tx.feePayer !== h.owner ? tx.feePayer : undefined);
    if (!funder) return;
    groups.set(funder, [...(groups.get(funder) ?? []), h]);
  });
  // The creator funding even one top holder is already a signal.
  const found = [...groups].filter(([funder, members]) => members.length >= 2 || funder === creator);
  const kept = await Promise.all(
    found.map(async ([funder, members]) => {
      if (funder !== creator && (await getSignatures(funder)).length >= 1000) return null; // exchange / hot wallet
      return { funder, wallets: members.map((m) => m.owner), pct: members.reduce((s, m) => s + m.pct, 0) };
    }),
  );
  return kept.filter((c): c is NonNullable<typeof c> => !!c);
}
