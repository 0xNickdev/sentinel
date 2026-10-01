import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { checkTransaction, type BastionResult, type Decision } from '../bastion/index.js';
import type { Policy } from '../bastion/policy.js';
import { rpc } from '../lib/helius.js';
import { fetchJson } from '../lib/http.js';
import { jupQuote } from '../lib/market.js';
import { TRUSTED_MINTS, WSOL } from '../lib/programs.js';
import { scanToken } from '../scan/index.js';
import type { ScanResult } from '../scan/types.js';
import { record } from './journal.js';

export type Intent =
  | { type: 'buy'; wallet: string; mint: string; sol: number; slippageBps?: number }
  | { type: 'sell'; wallet: string; mint: string; amount: number; slippageBps?: number }
  | { type: 'swap'; wallet: string; inputMint: string; outputMint: string; amount: number; slippageBps?: number }
  | { type: 'transfer'; wallet: string; to: string; sol: number };

export class IntentError extends Error {}

export interface ExecuteResult {
  decision: Decision;
  enforced: boolean;
  /** Unsigned base64 tx for the agent's session key. Omitted when the gateway blocks or freezes. */
  transaction: string | null;
  requiresOwnerConfirmation: boolean;
  reasons: BastionResult['reasons'];
  intent: Intent;
  scan: Pick<ScanResult, 'mint' | 'symbol' | 'score' | 'verdict' | 'criticalFlags'> | null;
  bastion: BastionResult | null;
  journalId: string;
  durationMs: number;
}

const DEFAULT_SLIPPAGE_BPS = 100;

/** sentinel.execute(intent): Scan → build → simulate → policies → decision. Never signs. */
export async function execute(raw: unknown, policy: Policy): Promise<ExecuteResult> {
  const started = Date.now();
  const intent = parseIntent(raw);

  // 1. Scan the token being bought while the route is built in parallel; a bad token short-circuits.
  const target = intent.type === 'buy' ? intent.mint : intent.type === 'swap' ? intent.outputMint : null;
  const built = buildTransaction(intent);
  built.catch(() => {}); // may be abandoned if Scan blocks first
  let scan: ScanResult | null = null;
  if (target && !TRUSTED_MINTS[target]) {
    scan = await scanToken(target);
    const critical = scan.criticalFlags[0];
    if (critical || scan.score < policy.min_token_score) {
      const reason = critical
        ? { id: 'scan_critical', action: 'block' as const, message: `Scan: ${critical.message}` }
        : { id: 'scan_low_score', action: 'block' as const, message: `Scan: score ${scan.score} < ${policy.min_token_score}` };
      return finish('block', [reason], null, null);
    }
  }

  // 2. Let Bastion judge what the built transaction actually does.
  const tx = await built;
  const bastion = await checkTransaction(tx, policy, intent.wallet);
  const sendable = bastion.decision === 'allow' || bastion.decision === 'confirm' || policy.mode === 'warn';
  return finish(bastion.decision, bastion.reasons, bastion, sendable ? Buffer.from(tx.serialize()).toString('base64') : null);

  async function finish(decision: Decision, reasons: BastionResult['reasons'], bastion: BastionResult | null, transaction: string | null): Promise<ExecuteResult> {
    const entry = await record({
      kind: 'execute',
      wallet: intent.wallet,
      summary: describe(intent, scan?.symbol),
      decision,
      enforced: policy.mode === 'enforce',
      reasons,
      rulesVersion: [scan?.rulesVersion, bastion?.rulesVersion].filter(Boolean).join(' + ') || 'n/a',
    });
    return {
      decision,
      enforced: policy.mode === 'enforce',
      transaction,
      requiresOwnerConfirmation: decision === 'confirm',
      reasons,
      intent,
      scan: scan && { mint: scan.mint, symbol: scan.symbol, score: scan.score, verdict: scan.verdict, criticalFlags: scan.criticalFlags },
      bastion,
      journalId: entry.id,
      durationMs: Date.now() - started,
    };
  }
}

function describe(i: Intent, symbol?: string | null) {
  switch (i.type) {
    case 'buy':
      return `buy ${symbol ?? i.mint} for ${i.sol} SOL`;
    case 'sell':
      return `sell ${i.amount} ${symbol ?? i.mint}`;
    case 'swap':
      return `swap ${i.amount} ${i.inputMint} → ${i.outputMint}`;
    case 'transfer':
      return `transfer ${i.sol} SOL to ${i.to}`;
  }
}

const isPubkey = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return false;
  try {
    new PublicKey(v);
    return true;
  } catch {
    return false;
  }
};
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function parseIntent(raw: unknown): Intent {
  if (!raw || typeof raw !== 'object') throw new IntentError('intent must be an object');
  const i = raw as Record<string, unknown>;
  if (!isPubkey(i.wallet)) throw new IntentError('intent.wallet must be the agent wallet address');
  const slip = i.slippageBps;
  if (slip !== undefined && (typeof slip !== 'number' || slip < 1 || slip > 5000)) throw new IntentError('slippageBps: 1–5000');
  switch (i.type) {
    case 'buy':
      if (!isPubkey(i.mint) || !isAmount(i.sol)) throw new IntentError('buy: { mint, sol }');
      break;
    case 'sell':
      if (!isPubkey(i.mint) || !isAmount(i.amount)) throw new IntentError('sell: { mint, amount }');
      break;
    case 'swap':
      if (!isPubkey(i.inputMint) || !isPubkey(i.outputMint) || !isAmount(i.amount)) throw new IntentError('swap: { inputMint, outputMint, amount }');
      break;
    case 'transfer':
      if (!isPubkey(i.to) || !isAmount(i.sol)) throw new IntentError('transfer: { to, sol }');
      break;
    default:
      throw new IntentError('intent.type: buy | sell | swap | transfer');
  }
  return i as unknown as Intent;
}

async function buildTransaction(intent: Intent): Promise<VersionedTransaction> {
  if (intent.type === 'transfer') {
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const from = new PublicKey(intent.wallet);
    const message = new TransactionMessage({
      payerKey: from,
      recentBlockhash: value.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(intent.to), lamports: Math.round(intent.sol * 1e9) })],
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  const [inputMint, outputMint, amountUi] =
    intent.type === 'buy'
      ? [WSOL, intent.mint, intent.sol]
      : intent.type === 'sell'
        ? [intent.mint, WSOL, intent.amount]
        : [intent.inputMint, intent.outputMint, intent.amount];
  const decimals = inputMint === WSOL ? 9 : await mintDecimals(inputMint);
  const quote = await jupQuote(inputMint, outputMint, BigInt(Math.round(amountUi * 10 ** decimals)), intent.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  if (!quote) throw new IntentError('Jupiter found no route for this trade');
  const swap = await fetchJson<{ swapTransaction: string }>('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: intent.wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    timeoutMs: 10_000,
  });
  return VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
}

async function mintDecimals(mint: string): Promise<number> {
  const res = await rpc<{ value: any }>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const decimals = res.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new IntentError(`${mint} is not a token`);
  return decimals;
}
