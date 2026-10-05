import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { currentCluster } from '../lib/cluster.js';
import { cacheGet, cacheSet } from '../lib/db.js';
import { TRUSTED_MINTS } from '../lib/programs.js';
import { creatorBlock } from './blocks/creator.js';
import { holdersBlock } from './blocks/holders.js';
import { launchBlock } from './blocks/launch.js';
import { liquidityBlock } from './blocks/liquidity.js';
import { marketBlock } from './blocks/market.js';
import { metadataBlock } from './blocks/metadata.js';
import { rightsBlock } from './blocks/rights.js';
import { ScanContext } from './context.js';
import { ScanInputError, type BlockId, type BlockResult, type ScanResult } from './types.js';

export const RULES_VERSION = 'scan-v1.1';
/** Below this score Scan recommends a block (policy default `min_token_score`). */
export const MIN_TOKEN_SCORE = 60;
const BLOCK_TIMEOUT_MS = 12_000;
/** With this much weight missing the score says more about the outage than the token, so there is no verdict. */
const MAX_MISSING_WEIGHT = 30;
const DISCLAIMER = 'The score is a risk indicator, not financial advice.';

const BLOCKS: Array<[BlockId, string, number, (ctx: ScanContext) => Promise<BlockResult>]> = [
  ['creator', 'Creator', 20, creatorBlock],
  ['holders', 'Holders', 20, holdersBlock],
  ['launch', 'Bundles & snipers', 15, launchBlock],
  ['rights', 'Authorities', 15, rightsBlock],
  ['liquidity', 'Liquidity', 15, liquidityBlock],
  ['market', 'Trading anomalies', 10, marketBlock],
  ['metadata', 'Metadata', 5, metadataBlock],
];

const cache = new Map<string, { at: number; result: ScanResult }>();
const inflight = new Map<string, Promise<ScanResult>>();

export function assertMint(mint: string) {
  try {
    if (mint.length < 32 || mint.length > 44) throw new Error();
    new PublicKey(mint);
  } catch {
    throw new ScanInputError('Invalid token address (CA)');
  }
}

export async function scanToken(mint: string): Promise<ScanResult> {
  assertMint(mint);
  const key = `${currentCluster()}:${mint}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.scanCacheTtlMs) return { ...hit.result, cached: true };
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      // Shared cache: a cold serverless instance reuses a scan another instance just did.
      const shared = await cacheGet<ScanResult>(`scan:${key}`, config.scanCacheTtlMs).catch(() => null);
      if (shared) return { ...shared, cached: true };
      const fresh = await runScan(mint);
      await cacheSet(`scan:${key}`, fresh).catch(() => {});
      return fresh;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const result = await p;
  cache.set(key, { at: Date.now(), result: { ...result, cached: false } });
  return result;
}

async function runScan(mint: string): Promise<ScanResult> {
  const started = Date.now();
  if (TRUSTED_MINTS[mint]) return trustedResult(mint, started);

  const ctx = new ScanContext(mint);
  await ctx.mintInfo(); // fail fast on non-mints (404 / 422)

  const blocks = await Promise.all(BLOCKS.map(([id, label, weight, fn]) => guarded(fn(ctx), id, label, weight)));
  const asset = await ctx.asset();
  const flags = blocks.flatMap((b) => b.flags);
  const criticalFlags = flags.filter((f) => f.severity === 'critical');
  const score = Math.round(blocks.reduce((s, b) => s + b.score, 0));
  const missing = blocks.filter((b) => b.status === 'error').reduce((s, b) => s + b.weight, 0);
  // A proven critical flag is enough to block; anything softer needs the data. Not cached, so the next call retries.
  if (!criticalFlags.length && missing >= MAX_MISSING_WEIGHT)
    throw new ScanInputError('Not enough data to score this token right now, try again shortly', 503);
  const verdict = criticalFlags.length || score < MIN_TOKEN_SCORE ? 'block' : score < 75 ? 'warn' : 'allow';

  return {
    mint,
    name: asset?.content?.metadata?.name ?? null,
    symbol: asset?.content?.metadata?.symbol ?? null,
    score,
    verdict,
    risk: criticalFlags.length || score < MIN_TOKEN_SCORE ? 'high' : score < 75 ? 'medium' : 'low',
    criticalFlags,
    flags,
    blocks,
    rulesVersion: RULES_VERSION,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    cached: false,
    disclaimer: DISCLAIMER,
  };
}

/** A failing data source must not sink the whole scan: the block gets half weight and says why. */
async function guarded(p: Promise<BlockResult>, id: BlockId, label: string, weight: number): Promise<BlockResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), BLOCK_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (e instanceof ScanInputError) throw e;
    return {
      id,
      label,
      weight,
      score: weight / 2,
      status: 'error',
      details: { error: e instanceof Error ? e.message : String(e) },
      flags: [{ id: 'insufficient_data', severity: 'info', message: `${label}: data temporarily unavailable` }],
    };
  } finally {
    clearTimeout(timer);
  }
}

function trustedResult(mint: string, started: number): ScanResult {
  return {
    mint,
    name: TRUSTED_MINTS[mint],
    symbol: TRUSTED_MINTS[mint],
    score: 100,
    verdict: 'allow',
    risk: 'low',
    criticalFlags: [],
    flags: [{ id: 'trusted_allowlist', severity: 'info', message: 'Token is on the trusted list' }],
    blocks: [],
    rulesVersion: RULES_VERSION,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    cached: false,
    disclaimer: DISCLAIMER,
  };
}
