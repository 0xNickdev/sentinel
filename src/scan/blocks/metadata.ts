import { dexSearch } from '../../lib/market.js';
import type { ScanContext } from '../context.js';
import { mainPair } from './liquidity.js';
import { BlockBuilder } from './util.js';

/** Metadata: broken links, missing socials, duplicates / impersonation. Weight 5. */
export async function metadataBlock(ctx: ScanContext) {
  const b = new BlockBuilder('metadata', 'Metadata', 5);
  const [asset, pairs] = await Promise.all([ctx.asset(), ctx.dexPairs()]);
  const name = asset?.content?.metadata?.name?.trim() ?? '';
  const symbol = asset?.content?.metadata?.symbol?.trim() ?? '';
  const uri = asset?.content?.json_uri ?? '';

  const json = uri ? await fetchMetadataJson(uri) : null;

  const image = asset?.content?.links?.image || (typeof json?.image === 'string' ? json.image : '');
  const socials = ['twitter', 'telegram', 'website'].filter((k) => typeof json?.[k] === 'string' && (json[k] as string).length > 4);

  let pts = 0;
  if (json) pts += 2;
  else b.flag('metadata_unreachable', 'warn', uri ? 'Metadata JSON is unreachable' : 'Token has no metadata link');
  if (image) pts += 1;
  if (socials.length) pts += 1;
  else b.flag('no_socials', 'info', 'No website or social links');

  // Duplicates: other Solana tokens with the same ticker; impersonation when one of them is far bigger.
  let duplicates = 0;
  let impersonates: string | null = null;
  try {
    if (symbol) {
      const ourLiq = pairs.length ? (mainPair(pairs).liquidity?.usd ?? 0) : 0;
      const ourListed = Math.min(...pairs.map((p) => p.pairCreatedAt ?? Infinity));
      const same = (await dexSearch(symbol)).filter(
        (p) => p.baseToken.address !== ctx.mint && p.baseToken.symbol.toLowerCase() === symbol.toLowerCase(),
      );
      const byToken = new Map<string, { liq: number; listed: number }>();
      for (const p of same) {
        const cur = byToken.get(p.baseToken.address);
        byToken.set(p.baseToken.address, {
          liq: Math.max(cur?.liq ?? 0, p.liquidity?.usd ?? 0),
          listed: Math.min(cur?.listed ?? Infinity, p.pairCreatedAt ?? Infinity),
        });
      }
      duplicates = byToken.size;
      // The copycat is the younger token living off an older, much bigger one.
      const original = [...byToken].find(([, v]) => v.liq >= 50_000 && v.liq >= ourLiq * 10 && v.listed < ourListed);
      if (original) impersonates = original[0];
    }
  } catch {
    b.status = 'partial';
  }

  if (impersonates) b.flag('impersonation', 'warn', `Ticker ${symbol} copies a larger token ${impersonates}`);
  else pts += 1;
  if (duplicates > 0 && !impersonates) b.flag('duplicate_ticker', 'info', `${duplicates} other token(s) use the ticker ${symbol}`);

  b.score = pts;
  b.details = { name, symbol, uri, metadataReachable: !!json, image: !!image, socials, duplicateTickers: duplicates, impersonates };
  return b.build();
}

/** Public ipfs.io rate-limits hard (429), so IPFS links are tried via a faster gateway first. */
const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/'];

async function fetchMetadataJson(uri: string): Promise<Record<string, unknown> | null> {
  const cid = uri.match(/\/ipfs\/(.+)$/)?.[1] ?? (uri.startsWith('ipfs://') ? uri.slice(7) : null);
  const candidates = cid ? [...IPFS_GATEWAYS.map((g) => g + cid), uri] : [uri];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      /* try next gateway */
    }
  }
  return null;
}
