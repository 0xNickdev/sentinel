/**
 * Cold scan latency against the hosted API, as a user sees it.
 *   established: the most-traded pair of well-known Solana tokens (≥ 500 trades/24h)
 *   fresh:       tokens traded on pump.fun in the last few minutes
 * Each token is scanned once, spaced to stay under the rate limit; cached answers are left out.
 * Reports durationMs from the API response (server time, without network).   npm run bench
 */
import '../src/config.js';
import { getSignatures, parseTransactions } from '../src/lib/helius.js';
import { dexSearch, type DexPair } from '../src/lib/market.js';
import { PUMP_PROGRAM, TRUSTED_MINTS } from '../src/lib/programs.js';

const API = process.env.API ?? 'https://www.santinelguard.online';
const PER_SET = 15;
const TICKERS = ['POPCAT', 'MEW', 'BOME', 'PNUT', 'GOAT', 'MOODENG', 'FARTCOIN', 'GIGA', 'MICHI', 'WEN', 'SLERF', 'PENGU', 'AI16Z', 'ZEREBRO', 'GRIFFAIN', 'CHILLGUY', 'PONKE', 'MYRO', 'FWOG', 'USELESS'];

async function established() {
  const out: string[] = [];
  const trades = (p: DexPair) => (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  for (const t of TICKERS) {
    const best = (await dexSearch(t).catch(() => [] as DexPair[])).filter((p) => p.baseToken.symbol.toUpperCase() === t).sort((a, b) => trades(b) - trades(a))[0];
    if (best && trades(best) >= 500 && !TRUSTED_MINTS[best.baseToken.address]) out.push(best.baseToken.address);
    if (out.length >= PER_SET) break;
  }
  return out;
}

async function fresh() {
  const sigs = await getSignatures(PUMP_PROGRAM, { limit: 200 });
  const txs = await parseTransactions(sigs.filter((s) => !s.err).map((s) => s.signature).slice(0, 100));
  return [...new Set(txs.flatMap((t) => (t.tokenTransfers ?? []).map((x) => x.mint)).filter((m) => m.endsWith('pump')))].slice(0, PER_SET);
}

const rows: Array<{ set: string; ms: number; ok: boolean }> = [];
for (const [set, mints] of [['established', await established()], ['fresh', await fresh()]] as const) {
  for (const mint of mints) {
    const res = await fetch(`${API}/api/scan/${mint}`, { headers: { 'user-agent': 'sentinel-bench' } });
    const body = (await res.json().catch(() => ({}))) as { durationMs?: number; cached?: boolean };
    rows.push({ set, ms: body.durationMs ?? -1, ok: res.ok && !body.cached && typeof body.durationMs === 'number' });
    await new Promise((r) => setTimeout(r, 2200));
  }
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
console.log(`${new Date().toISOString().slice(0, 10)}  ${API}`);
for (const set of ['established', 'fresh', 'all']) {
  const ms = rows.filter((r) => r.ok && (set === 'all' || r.set === set)).map((r) => r.ms);
  if (!ms.length) continue;
  console.log(`${set.padEnd(12)} n=${String(ms.length).padStart(2)}  median ${quantile(ms, 0.5)} ms  p90 ${quantile(ms, 0.9)} ms  max ${Math.max(...ms)} ms`);
}
const skipped = rows.filter((r) => !r.ok).length;
if (skipped) console.log(`${skipped} skipped (error or cached)`);
process.exit(0);
