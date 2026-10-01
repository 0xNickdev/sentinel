/**
 * Scan calibration against labeled tokens.
 *   clean: established tokens (most-traded Solana pair, ≥ 500 trades/24h, ≥ $200k liquidity, ≥ 60 days old) must never be blocked
 *   rugs:  recent tokens that died (≤ $1k liquidity, ≥ 90% down) should be blocked
 * Ground truth comes from market outcomes, independent of Sentinel's verdict.   npm run calibrate
 */
import '../src/config.js';
import { getSignatures, parseTransactions } from '../src/lib/helius.js';
import { dexPairsFor, dexSearch, type DexPair } from '../src/lib/market.js';
import { PUMP_PROGRAM, TRUSTED_MINTS } from '../src/lib/programs.js';
import { scanToken } from '../src/scan/index.js';

const CLEAN_TICKERS = ['POPCAT', 'MEW', 'BOME', 'PNUT', 'GOAT', 'MOODENG', 'FARTCOIN', 'GIGA', 'MICHI', 'WEN', 'SLERF', 'PENGU', 'TRUMP', 'AI16Z', 'ZEREBRO', 'GRIFFAIN', 'CHILLGUY', 'RETARDIO', 'PONKE', 'MYRO', 'FWOG', 'SIGMA', 'MOTHER', 'BILLY', 'LOCKIN', 'USELESS', 'PUMP', 'ALCH', 'TROLL', 'SPX', 'HARAMBE', 'ORCA', 'KMNO', 'DRIFT', 'TNSR', 'CLOUD', 'W', 'ZEUS', 'HNT', 'RENDER'];
const DAY = 86_400_000;

async function cleanSet() {
  const out = new Map<string, string>();
  for (const t of CLEAN_TICKERS) {
    // Rank by real trades, not liquidity: scam clones of popular tickers post fake liquidity in the hundreds of millions.
    const trades = (p: DexPair) => (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
    const pairs = (await dexSearch(t).catch(() => [] as DexPair[])).filter((p) => p.baseToken.symbol.toUpperCase() === t);
    const best = pairs.sort((a, b) => trades(b) - trades(a))[0];
    if (!best || trades(best) < 500 || (best.liquidity?.usd ?? 0) < 200_000 || Date.now() - (best.pairCreatedAt ?? Date.now()) < 60 * DAY) continue;
    if (TRUSTED_MINTS[best.baseToken.address]) continue;
    out.set(best.baseToken.address, t);
  }
  return out;
}

/** Recently traded pump.fun tokens that have since died, plus rugs found earlier by hand. */
async function rugSet() {
  const out = new Map<string, string>([
    ['CFgZyepFRMeBoJNvKw8X59RnD6KR3rdZhLKxGyimpump', 'REC'],
    ['GXKehzpt6GzwKkQ9iexxk2ijdZr6etc3mtPBfVuZpump', 'SARKA'],
    ['Hs7WMehNQU6T987UxYRCgMpyBwSKd4BBbvc9hJUZpump', 'Jelly'],
    ['2j54zjWv15hqJGwq3zvv7RBMm3V5JYZaMNFfSNv4pump', 'FLOKI'],
  ]);
  const sigs = await getSignatures(PUMP_PROGRAM, { limit: 300 });
  const txs = await parseTransactions(sigs.filter((s) => !s.err).map((s) => s.signature));
  const mints = [...new Set(txs.flatMap((t) => (t.tokenTransfers ?? []).map((x) => x.mint)).filter((m) => m.endsWith('pump')))];
  const pairs = await dexPairsFor(mints.slice(0, 120));
  for (const p of pairs) {
    const drop = Math.min(p.priceChange?.h1 ?? 0, p.priceChange?.h6 ?? 0, p.priceChange?.h24 ?? 0);
    if ((p.liquidity?.usd ?? 0) <= 1_500 && drop <= -80) out.set(p.baseToken.address, p.baseToken.symbol);
  }
  return new Map([...out].slice(0, 25));
}

type Row = { mint: string; label: string; ticker: string; score: number; verdict: string; reasons: string };
async function scanAll(set: Map<string, string>, label: string): Promise<Row[]> {
  const rows: Row[] = [];
  const queue = [...set];
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [mint, ticker] = next;
        try {
          const r = await scanToken(mint);
          const reasons = [...r.criticalFlags, ...r.flags.filter((f) => f.severity === 'warn')].slice(0, 3).map((f) => f.id).join(',');
          rows.push({ mint, label, ticker, score: r.score, verdict: r.verdict, reasons });
        } catch (e) {
          rows.push({ mint, label, ticker, score: -1, verdict: 'error', reasons: (e as Error).message.slice(0, 60) });
        }
      }
    }),
  );
  return rows;
}

const clean = await scanAll(await cleanSet(), 'clean');
const rugs = await scanAll(await rugSet(), 'rug');
for (const r of [...clean, ...rugs].sort((a, b) => a.label.localeCompare(b.label) || a.score - b.score))
  console.log(`${r.label.padEnd(5)} ${r.ticker.slice(0, 10).padEnd(10)} ${r.mint.slice(0, 6)} ${String(r.score).padStart(3)} ${r.verdict.padEnd(6)} ${r.reasons}`);

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const count = (rows: Row[], v: string) => rows.filter((r) => r.verdict === v).length;
console.log(`\nclean (${clean.length}): allow ${count(clean, 'allow')}, warn ${count(clean, 'warn')}, BLOCK ${count(clean, 'block')} → false-block rate ${pct(count(clean, 'block'), clean.length)}`);
console.log(`rugs  (${rugs.length}): block ${count(rugs, 'block')}, warn ${count(rugs, 'warn')}, allow ${count(rugs, 'allow')} → catch rate ${pct(count(rugs, 'block'), rugs.length)}`);
process.exit(0);
