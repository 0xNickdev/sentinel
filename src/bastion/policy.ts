import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../lib/programs.js';

export type RecipientRule = 'allow' | 'confirm' | 'block';

export interface Policy {
  limits: { per_tx_sol: number; per_day_sol: number };
  /** Named venues (see PROGRAM_GROUPS) or raw program ids the wallet may call directly. */
  programs: string[];
  min_token_score: number;
  max_slippage_bps: number;
  new_recipient: RecipientRule;
  /** enforce: decisions are binding; warn: same analysis, returned as recommendations only. */
  mode: 'enforce' | 'warn';
  max_tx_per_hour: number;
  /** Addresses the owner has pre-approved as transfer recipients. */
  recipients: string[];
}

/** Policy from the Sentinel plan, plus the frequency limit the kill-switch watches. */
export const DEFAULT_POLICY: Policy = {
  limits: { per_tx_sol: 2, per_day_sol: 10 },
  programs: ['pump.fun', 'jupiter'],
  min_token_score: 60,
  max_slippage_bps: 300,
  new_recipient: 'confirm',
  mode: 'enforce',
  max_tx_per_hour: 20,
  recipients: [],
};

export const PROGRAM_GROUPS: Record<string, string[]> = {
  'pump.fun': [PUMP_PROGRAM, PUMP_AMM_PROGRAM, 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'],
  jupiter: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  raydium: [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ],
  orca: ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'],
  meteora: ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
};

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Plumbing every wallet needs; never subject to the venue allowlist. */
export const INFRA_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: 'System',
  [TOKEN_PROGRAM]: 'SPL Token',
  [TOKEN_2022_PROGRAM]: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: 'Memo v1',
};

export const programName = (id: string) =>
  INFRA_PROGRAMS[id] ?? Object.entries(PROGRAM_GROUPS).find(([, ids]) => ids.includes(id))?.[0] ?? null;

export function allowedPrograms(policy: Policy): Set<string> {
  return new Set([...Object.keys(INFRA_PROGRAMS), ...policy.programs.flatMap((p) => PROGRAM_GROUPS[p] ?? [p])]);
}

export class PolicyError extends Error {}

/** Merges a caller-supplied (partial) policy onto the default and validates it. */
export function resolvePolicy(input: unknown): Policy {
  if (input == null) return DEFAULT_POLICY;
  if (typeof input !== 'object') throw new PolicyError('policy must be an object');
  const p = input as Partial<Policy>;
  const policy: Policy = {
    ...DEFAULT_POLICY,
    ...p,
    limits: { ...DEFAULT_POLICY.limits, ...(p.limits ?? {}) },
    programs: p.programs ?? DEFAULT_POLICY.programs,
    recipients: p.recipients ?? DEFAULT_POLICY.recipients,
  };
  const num = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PolicyError(`${name} must be a non-negative number`);
  };
  num(policy.limits.per_tx_sol, 'limits.per_tx_sol');
  num(policy.limits.per_day_sol, 'limits.per_day_sol');
  num(policy.min_token_score, 'min_token_score');
  num(policy.max_slippage_bps, 'max_slippage_bps');
  num(policy.max_tx_per_hour, 'max_tx_per_hour');
  if (!['allow', 'confirm', 'block'].includes(policy.new_recipient)) throw new PolicyError('new_recipient: allow | confirm | block');
  if (!['enforce', 'warn'].includes(policy.mode)) throw new PolicyError('mode: enforce | warn');
  if (!Array.isArray(policy.programs) || !Array.isArray(policy.recipients)) throw new PolicyError('programs and recipients must be arrays');
  const unknown = policy.programs.filter((x) => !PROGRAM_GROUPS[x] && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x));
  if (unknown.length) throw new PolicyError(`Unknown programs: ${unknown.join(', ')}. Available: ${Object.keys(PROGRAM_GROUPS).join(', ')} or a program id`);
  return policy;
}
