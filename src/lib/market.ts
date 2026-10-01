import { fetchJson, HttpError } from './http.js';
import { WSOL } from './programs.js';

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>;
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

/** Pairs for up to 30 Solana mints in one request. */
export async function dexPairsFor(mints: string[]): Promise<DexPair[]> {
  if (!mints.length) return [];
  const out: DexPair[] = [];
  for (let i = 0; i < mints.length; i += 30) {
    const ids = mints.slice(i, i + 30).join(',');
    out.push(...(await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${ids}`, { timeoutMs: 6000 })));
  }
  return out;
}

export async function dexSearch(query: string): Promise<DexPair[]> {
  const res = await fetchJson<{ pairs: DexPair[] | null }>(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
    { timeoutMs: 6000 },
  );
  return (res.pairs ?? []).filter((p) => p.chainId === 'solana');
}

export interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label?: string; ammKey: string } }>;
}

/** Returns null when Jupiter cannot route the swap (no market / not tradable). */
export async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps = 1000, maxAccounts?: number) {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}` +
    (maxAccounts ? `&maxAccounts=${maxAccounts}` : '');
  try {
    return await fetchJson<JupQuote>(url, { timeoutMs: 6000, retries: 1 });
  } catch (e) {
    // Only an explicit "no route" means unsellable; other 400s (bad amount, rate limits) are inconclusive.
    if (e instanceof HttpError && e.status === 400 && /NO_ROUTE|COULD_NOT_FIND_ANY_ROUTE|TOKEN_NOT_TRADABLE|NOT_TRADABLE/i.test(e.body ?? '')) return null;
    throw e;
  }
}

let solPriceCache: { at: number; usd: number } | undefined;
export async function solPriceUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.usd;
  const res = await fetchJson<Record<string, { usdPrice: number }>>(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, {
    timeoutMs: 5000,
  });
  const usd = res[WSOL]?.usdPrice;
  if (!usd) throw new Error('jupiter price: no SOL price');
  solPriceCache = { at: Date.now(), usd };
  return usd;
}
