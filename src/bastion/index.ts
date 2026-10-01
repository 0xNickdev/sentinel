import type { VersionedTransaction } from '@solana/web3.js';
import { rpc } from '../lib/helius.js';
import { jupQuote, solPriceUsd } from '../lib/market.js';
import { TRUSTED_MINTS, WSOL } from '../lib/programs.js';
import { scanToken } from '../scan/index.js';
import { walletActivity } from './history.js';
import { allowedPrograms, programName, type Policy } from './policy.js';
import { simulate, type SimulationReport } from './simulate.js';

export const BASTION_RULES_VERSION = 'bastion-v1.0';

/** Ordered by severity: the strictest reason wins. */
export type Decision = 'allow' | 'confirm' | 'block' | 'freeze';
const RANK: Record<Decision, number> = { allow: 0, confirm: 1, block: 2, freeze: 3 };

export interface Reason {
  id: string;
  action: Exclude<Decision, 'allow'> | 'note';
  message: string;
}

export interface TokenChange {
  mint: string;
  symbol: string | null;
  amount: number;
  valueSol: number | null;
}

export interface BastionResult {
  decision: Decision;
  /** false in `warn` mode: the decision is a recommendation, the agent may still sign. */
  enforced: boolean;
  reasons: Reason[];
  wallet: string;
  simulation: { success: boolean; error: string | null; logsTail: string[]; unitsConsumed: number | null };
  changes: { sol: number; tokens: TokenChange[] };
  spend: { txSol: number; perTxLimitSol: number; day24hSol: number; perDayLimitSol: number; txLastHour: number };
  programs: Array<{ id: string; name: string | null; allowed: boolean }>;
  recipients: Array<{ address: string; amount: number; asset: string; isNew: boolean }>;
  tokenScans: Array<{ mint: string; score: number; verdict: string; critical: string[] }>;
  slippageBps: number | null;
  rulesVersion: string;
  durationMs: number;
}

/** A single tx moving this share of the wallet's SOL, above the per-tx limit, trips the kill-switch. */
const DRAIN_SHARE = 0.9;
const KILL_MULTIPLIER = 5;

export async function checkTransaction(tx: VersionedTransaction, policy: Policy, walletOverride?: string): Promise<BastionResult> {
  const started = Date.now();
  const sim = await simulate(tx, walletOverride);
  const reasons: Reason[] = [];
  const add = (id: string, action: Reason['action'], message: string) => reasons.push({ id, action, message });

  const [activity, balance, mints] = await Promise.all([
    walletActivity(sim.wallet).catch(() => null),
    rpc<{ value: number }>('getBalance', [sim.wallet]).then((r) => r.value / 1e9),
    describeMints([...sim.tokenDeltas.keys(), ...sim.outgoing.filter((t) => t.kind === 'token').map((t) => t.mint)]),
  ]);

  // 1. Simulation
  if (!sim.success) add('simulation_failed', 'block', `Transaction would fail on-chain: ${sim.error}`);

  // 2. Drainer patterns: always blocked, whatever the policy says
  for (const d of sim.dangerous) add(d.id, 'block', d.message);

  // 3. Programs the wallet calls directly
  const allowed = allowedPrograms(policy);
  const programs = sim.topLevelPrograms.map((id) => ({ id, name: programName(id), allowed: allowed.has(id) }));
  for (const p of programs.filter((x) => !x.allowed)) add('program_not_allowed', 'block', `Program ${p.name ?? p.id} is not in the allowlist`);

  // 4. Value moved
  const tokens: TokenChange[] = [...sim.tokenDeltas].map(([mint, raw]) => {
    const m = mints.get(mint);
    const amount = m ? Number(raw) / 10 ** m.decimals : Number(raw);
    return { mint, symbol: m?.symbol ?? null, amount, valueSol: m?.priceSol != null ? amount * m.priceSol : null };
  });
  const tokenOutSol = tokens.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.valueSol ?? 0), 0);
  const txSol = Math.max(0, -sim.solDelta) + tokenOutSol;
  const day24h = (activity?.spent24hSol ?? 0) + txSol;

  if (txSol > policy.limits.per_tx_sol) add('per_tx_limit', 'block', `Trade of ${fmt(txSol)} SOL exceeds the ${policy.limits.per_tx_sol} SOL limit`);
  if (day24h > policy.limits.per_day_sol)
    add('per_day_limit', 'block', `${fmt(day24h)} SOL out in 24h exceeds the ${policy.limits.per_day_sol} SOL daily limit`);
  if (!activity) add('history_unavailable', 'note', 'Wallet history unavailable, so the daily limit only counts this trade');
  else if (!activity.complete) add('history_partial', 'note', 'Over 100 transactions in 24h, so daily spend may be higher');

  // 5. Recipients: only transfers the wallet makes itself (top-level); swap legs inside DEX calls are covered by the program allowlist
  const recipients = sim.outgoing
    .filter((t) => t.topLevel)
    .map((t) => {
      const m = mints.get(t.mint);
      const amount = t.kind === 'sol' ? Number(t.rawAmount) / 1e9 : Number(t.rawAmount) / 10 ** (m?.decimals ?? 0);
      const isNew = !policy.recipients.includes(t.to) && !(activity?.knownRecipients.has(t.to) ?? false);
      return { address: t.to, amount, asset: t.kind === 'sol' ? 'SOL' : (m?.symbol ?? t.mint), isNew };
    });
  for (const r of recipients.filter((x) => x.isNew)) {
    if (policy.new_recipient !== 'allow')
      add('new_recipient', policy.new_recipient, `Transfer of ${fmt(r.amount)} ${r.asset} to a new address ${r.address}`);
  }

  // 6. Tokens the wallet receives go through Scan
  const received = tokens.filter((t) => t.amount > 0 && !TRUSTED_MINTS[t.mint]);
  const tokenScans = await Promise.all(
    received.map(async (t) => {
      try {
        const s = await scanToken(t.mint);
        return { mint: t.mint, score: s.score, verdict: s.verdict, critical: s.criticalFlags.map((f) => f.message) };
      } catch {
        return { mint: t.mint, score: -1, verdict: 'unknown', critical: [] as string[] };
      }
    }),
  );
  for (const s of tokenScans) {
    const label = received.find((t) => t.mint === s.mint)?.symbol ?? s.mint;
    if (s.score < 0) add('scan_unavailable', 'confirm', `Could not check token ${label}`);
    else if (s.critical.length) add('scan_critical', 'block', `Token ${label}: ${s.critical[0]}`);
    else if (s.score < policy.min_token_score) add('scan_low_score', 'block', `Token ${label} scores ${s.score} < ${policy.min_token_score}`);
  }

  // 7. Effective slippage for a simple swap (one asset out, one in) vs a fresh Jupiter quote
  const slippageBps = await effectiveSlippage(sim, tokens, mints).catch(() => null);
  if (slippageBps != null && slippageBps > policy.max_slippage_bps)
    add('slippage', 'block', `Actual slippage ${(slippageBps / 100).toFixed(2)}% > ${policy.max_slippage_bps / 100}%`);

  // 8. Kill-switch: anomalies that look like a compromised agent, not a bad trade
  if (txSol > policy.limits.per_tx_sol * KILL_MULTIPLIER)
    add('kill_amount_spike', 'freeze', `Amount is ${Math.round(txSol / Math.max(policy.limits.per_tx_sol, 1e-9))}× the limit. Wallet frozen`);
  if (balance > 0 && txSol >= balance * DRAIN_SHARE && txSol > policy.limits.per_tx_sol)
    add('kill_drain', 'freeze', 'Transaction drains almost the entire balance, likely a prompt injection');
  if (activity && activity.txLastHour >= policy.max_tx_per_hour)
    add('kill_frequency', 'freeze', `${activity.txLastHour} transactions in the last hour ≥ the ${policy.max_tx_per_hour} limit`);

  const decision = reasons.reduce<Decision>((d, r) => (r.action !== 'note' && RANK[r.action] > RANK[d] ? r.action : d), 'allow');
  return {
    decision,
    enforced: policy.mode === 'enforce',
    reasons: reasons.sort((a, b) => rankOf(b) - rankOf(a)),
    wallet: sim.wallet,
    simulation: { success: sim.success, error: sim.error, logsTail: sim.logsTail, unitsConsumed: sim.unitsConsumed },
    changes: { sol: round(sim.solDelta), tokens },
    spend: {
      txSol: round(txSol),
      perTxLimitSol: policy.limits.per_tx_sol,
      day24hSol: round(day24h),
      perDayLimitSol: policy.limits.per_day_sol,
      txLastHour: activity?.txLastHour ?? 0,
    },
    programs,
    recipients,
    tokenScans,
    slippageBps,
    rulesVersion: BASTION_RULES_VERSION,
    durationMs: Date.now() - started,
  };
}

const rankOf = (r: Reason) => (r.action === 'note' ? -1 : RANK[r.action]);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const fmt = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3)).replace(/\.?0+$/, '');

interface MintMeta {
  decimals: number;
  symbol: string | null;
  priceSol: number | null;
}

async function describeMints(mints: string[]): Promise<Map<string, MintMeta>> {
  // A temporary WSOL account opened and closed inside the transaction has no readable mint ('').
  const ids = [...new Set(mints)].filter((m) => m && m !== WSOL);
  const out = new Map<string, MintMeta>();
  if (!ids.length) return out;
  const [accs, assets, prices, solUsd] = await Promise.all([
    rpc<{ value: any[] }>('getMultipleAccounts', [ids, { encoding: 'jsonParsed' }]),
    rpc<any[]>('getAssetBatch', { ids }).catch(() => []),
    fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.join(',')}`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json() as Promise<Record<string, { usdPrice: number }>>)
      .catch(() => ({}) as Record<string, { usdPrice: number }>),
    solPriceUsd().catch(() => null),
  ]);
  ids.forEach((id, i) => {
    const usd = prices[id]?.usdPrice;
    out.set(id, {
      decimals: accs.value[i]?.data?.parsed?.info?.decimals ?? 0,
      symbol: assets.find((a) => a?.id === id)?.content?.metadata?.symbol ?? null,
      priceSol: usd != null && solUsd ? usd / solUsd : null,
    });
  });
  return out;
}

async function effectiveSlippage(sim: SimulationReport, tokens: TokenChange[], mints: Map<string, MintMeta>): Promise<number | null> {
  // Fees and rent are not part of the trade: strip them from the SOL leg before comparing to a quote.
  const tradeSol = sim.solDelta + sim.costsSol;
  const legs = [
    ...(Math.abs(tradeSol) > 1e-6 ? [{ mint: WSOL, amount: tradeSol, decimals: 9 }] : []),
    ...tokens.map((t) => ({ mint: t.mint, amount: t.amount, decimals: mints.get(t.mint)?.decimals ?? 0 })),
  ];
  const out = legs.filter((l) => l.amount < 0);
  const inn = legs.filter((l) => l.amount > 0);
  if (out.length !== 1 || inn.length !== 1) return null;
  const quote = await jupQuote(out[0].mint, inn[0].mint, BigInt(Math.round(-out[0].amount * 10 ** out[0].decimals)), 50);
  if (!quote) return null;
  const expected = Number(quote.outAmount) / 10 ** inn[0].decimals;
  return Math.max(0, Math.round(((expected - inn[0].amount) / expected) * 10_000));
}
