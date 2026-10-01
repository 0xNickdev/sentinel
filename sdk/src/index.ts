import { VersionedTransaction, type Connection, type Keypair } from '@solana/web3.js';

/**
 * Sentinel SDK. The agent asks Sentinel instead of signing directly; Sentinel answers with a decision
 * and, when allowed, an unsigned transaction. Keys never leave the agent.
 */

export type Cluster = 'mainnet' | 'devnet';
export type Decision = 'allow' | 'confirm' | 'block' | 'freeze';

export interface Policy {
  limits?: { per_tx_sol?: number; per_day_sol?: number };
  programs?: string[];
  min_token_score?: number;
  max_slippage_bps?: number;
  new_recipient?: 'allow' | 'confirm' | 'block';
  mode?: 'enforce' | 'warn';
  max_tx_per_hour?: number;
  recipients?: string[];
}

export type Intent =
  | { type: 'buy'; wallet: string; mint: string; sol: number; slippageBps?: number }
  | { type: 'sell'; wallet: string; mint: string; amount: number; slippageBps?: number }
  | { type: 'swap'; wallet: string; inputMint: string; outputMint: string; amount: number; slippageBps?: number }
  | { type: 'transfer'; wallet: string; to: string; sol: number };

export type GuardIntent =
  | { type: 'buy'; agent: string; mint: string; sol: number; slippageBps?: number }
  | { type: 'sell'; agent: string; mint: string; amount: number; slippageBps?: number }
  | { type: 'transfer'; agent: string; to: string; sol: number };

export interface Reason {
  id: string;
  action: Decision | 'note';
  message: string;
}

export interface ScanResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  score: number;
  verdict: 'allow' | 'warn' | 'block';
  risk: 'low' | 'medium' | 'high';
  criticalFlags: Array<{ id: string; severity: string; message: string }>;
  flags: Array<{ id: string; severity: string; message: string }>;
  blocks: Array<{ id: string; label: string; weight: number; score: number; status: string; details: Record<string, unknown> }>;
  rulesVersion: string;
  durationMs: number;
  cached: boolean;
  disclaimer: string;
}

export interface ExecuteResult {
  decision: Decision;
  enforced: boolean;
  transaction: string | null;
  requiresOwnerConfirmation: boolean;
  reasons: Reason[];
  scan: Pick<ScanResult, 'mint' | 'symbol' | 'score' | 'verdict'> | null;
  bastion: Record<string, unknown> | null;
  journalId: string;
  durationMs: number;
}

export interface GuardExecuteResult {
  decision: Decision;
  enforced: boolean;
  approvedBySentinel: boolean;
  requiresOwnerConfirmation: boolean;
  approvalUrl: string | null;
  multisig: string;
  vault: string;
  transactionIndex: number | null;
  transaction: string | null;
  reasons: Reason[];
  durationMs: number;
}

export interface GuardStatus {
  cluster: Cluster;
  multisig: string;
  vault: string;
  vaultSol: number;
  threshold: number;
  transactionIndex: number;
  frozen: { reason: string; frozenAt: string } | null;
  members: Array<{ key: string; role: string; initiate: boolean; vote: boolean; execute: boolean }>;
  enforced: boolean;
}

export class SentinelError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'SentinelError';
  }
}

export interface SentinelOptions {
  /** Defaults to the hosted gateway. */
  baseUrl?: string;
  /** Default cluster for guarded-wallet calls. */
  cluster?: Cluster;
  /** Default policy applied when a call does not pass one. */
  policy?: Policy;
  fetch?: typeof fetch;
}

const toBase64 = (tx: VersionedTransaction | string) => (typeof tx === 'string' ? tx : Buffer.from(tx.serialize()).toString('base64'));

async function signAndSend(b64: string, signer: Keypair, connection: Connection) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  tx.sign([signer]);
  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  const latest = await connection.getLatestBlockhash('confirmed');
  const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new SentinelError(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`, 422);
  return signature;
}

export class Sentinel {
  private baseUrl: string;
  private cluster: Cluster;
  private policy?: Policy;
  private fetchImpl: typeof fetch;

  constructor(opts: SentinelOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://sentinel-clawpump.vercel.app').replace(/\/$/, '');
    this.cluster = opts.cluster ?? 'mainnet';
    this.policy = opts.policy;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new SentinelError(data.error ?? `HTTP ${res.status}`, res.status);
    return data as T;
  }

  /** Risk score 0-100 for a token. */
  scan(mint: string) {
    return this.call<ScanResult>('GET', `/api/scan/${mint}`);
  }

  /** Scan + build + simulate + policy. Returns the decision and, when allowed, an unsigned transaction. */
  execute(intent: Intent, opts: { policy?: Policy } = {}) {
    return this.call<ExecuteResult>('POST', '/api/execute', { intent, policy: opts.policy ?? this.policy });
  }

  /** Judge a transaction you built yourself, before signing it. */
  check(transaction: VersionedTransaction | string, opts: { wallet?: string; policy?: Policy } = {}) {
    return this.call<ExecuteResult & Record<string, unknown>>('POST', '/api/bastion/check', {
      transaction: toBase64(transaction),
      wallet: opts.wallet,
      policy: opts.policy ?? this.policy,
    });
  }

  journal(opts: { wallet?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.wallet) q.set('wallet', opts.wallet);
    if (opts.limit) q.set('limit', String(opts.limit));
    return this.call<Array<Record<string, unknown>>>('GET', `/api/journal?${q}`);
  }

  /**
   * One line for the agent: ask Sentinel, and sign + send only when the answer is `allow`.
   * Anything else comes back unsigned with the reasons, so the agent can tell its user why.
   */
  async executeAndSend(intent: Intent, signer: Keypair, connection: Connection, opts: { policy?: Policy } = {}) {
    if (signer.publicKey.toBase58() !== intent.wallet) throw new SentinelError('signer does not match intent.wallet', 400);
    const result = await this.execute(intent, opts);
    if (result.decision !== 'allow' || !result.transaction) return { ...result, signature: null as string | null };
    return { ...result, signature: await signAndSend(result.transaction, signer, connection) };
  }

  /** Guarded wallets: Squads multisig where only Sentinel's vote lets the agent's transactions through. */
  guard = {
    setup: (p: { owner: string; agent: string; fundSol?: number; cluster?: Cluster }) =>
      this.call<{ multisig: string; vault: string; sentinel: string; telegramLink: string | null; transaction: string }>('POST', '/api/guard/setup', {
        cluster: p.cluster ?? this.cluster,
        ...p,
      }),
    status: (multisig: string, cluster?: Cluster) => this.call<GuardStatus>('POST', '/api/guard/status', { multisig, cluster: cluster ?? this.cluster }),
    execute: (p: { multisig: string; intent: GuardIntent; policy?: Policy; cluster?: Cluster }) =>
      this.call<GuardExecuteResult>('POST', '/api/guard/execute', { ...p, policy: p.policy ?? this.policy, cluster: p.cluster ?? this.cluster }),
    finalize: (p: { multisig: string; agent: string; transactionIndex: number; cluster?: Cluster }) =>
      this.call<{ transactionIndex: number; transaction: string }>('POST', '/api/guard/finalize', { ...p, cluster: p.cluster ?? this.cluster }),

    /**
     * Full guarded round trip with the agent key: propose (carrying Sentinel's vote) and execute.
     * On `confirm` the proposal is still created so the owner can approve it at `approvalUrl`.
     */
    run: async (p: { multisig: string; intent: GuardIntent; policy?: Policy; cluster?: Cluster }, agent: Keypair, connection: Connection) => {
      if (agent.publicKey.toBase58() !== p.intent.agent) throw new SentinelError('agent key does not match intent.agent', 400);
      const result = await this.guard.execute(p);
      const signatures: string[] = [];
      if (result.transaction) signatures.push(await signAndSend(result.transaction, agent, connection));
      if (result.approvedBySentinel && result.transactionIndex) {
        const fin = await this.guard.finalize({ multisig: p.multisig, agent: p.intent.agent, transactionIndex: result.transactionIndex, cluster: p.cluster });
        signatures.push(await signAndSend(fin.transaction, agent, connection));
      }
      return { ...result, executed: result.approvedBySentinel && signatures.length === 2, signatures };
    },
  };
}

export default Sentinel;
