import { config as loadEnv } from 'dotenv';
import { currentCluster } from './lib/cluster.js';

// .env for local secrets, .env.vercel for values pulled from Vercel (database). Neither overrides real env vars.
loadEnv();
loadEnv({ path: '.env.vercel' });

export class ConfigError extends Error {}

export const config = {
  /** Read lazily so the app still boots (and /api/health can report it) when the key is missing. */
  get heliusApiKey(): string {
    const key = process.env.HELIUS_API_KEY;
    if (!key) throw new ConfigError('HELIUS_API_KEY is not set. Add it to .env or to the Vercel environment variables');
    return key;
  },
  get heliusConfigured() {
    return !!process.env.HELIUS_API_KEY;
  },
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  scanCacheTtlMs: Number(process.env.SCAN_CACHE_TTL_MS ?? 60_000),
  rpcConcurrency: Number(process.env.RPC_CONCURRENCY ?? 6),
};

export const heliusRpcUrl = () => `https://${currentCluster()}.helius-rpc.com/?api-key=${config.heliusApiKey}`;
export const heliusApiUrl = (path: string) =>
  `https://api${currentCluster() === 'devnet' ? '-devnet' : ''}.helius.xyz${path}${path.includes('?') ? '&' : '?'}api-key=${config.heliusApiKey}`;
