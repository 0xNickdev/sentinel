import { config, heliusApiUrl, heliusRpcUrl } from '../config.js';
import { fetchJson, Semaphore } from './http.js';

const gate = new Semaphore(config.rpcConcurrency);

export async function rpc<T>(method: string, params: unknown, timeoutMs = 8000): Promise<T> {
  const body = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(heliusRpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    timeoutMs,
    gate,
    label: `helius ${method}`,
  });
  if (body.error) throw new Error(`helius ${method}: ${body.error.message}`);
  return body.result as T;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export const getSignatures = (address: string, opts: { limit?: number; before?: string } = {}) =>
  rpc<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: 1000, ...opts }]);

/**
 * Walks an address history back to its first transaction.
 * `complete` is false when the history is longer than maxPages×1000.
 */
export async function getOldestSignatures(address: string, maxPages: number) {
  let before: string | undefined;
  let page: SignatureInfo[] = [];
  let total = 0;
  for (let i = 0; i < maxPages; i++) {
    const batch = await getSignatures(address, { before });
    total += batch.length;
    if (batch.length) page = batch;
    if (batch.length < 1000) return { oldestFirst: [...page].reverse(), total, complete: true };
    before = batch[batch.length - 1].signature;
  }
  return { oldestFirst: [...page].reverse(), total, complete: false };
}

export interface EnhancedTx {
  signature: string;
  slot: number;
  timestamp: number;
  feePayer: string;
  type: string;
  source: string;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
}

/** Helius Enhanced Transactions: decoded transfers for up to 100 signatures per call. */
export async function parseTransactions(signatures: string[]): Promise<EnhancedTx[]> {
  const out: EnhancedTx[] = [];
  for (let i = 0; i < signatures.length; i += 100) {
    const chunk = signatures.slice(i, i + 100);
    const res = await fetchJson<EnhancedTx[]>(heliusApiUrl('/v0/transactions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: chunk }),
      timeoutMs: 10_000,
      gate,
      label: 'helius parseTransactions',
    });
    out.push(...res);
  }
  return out;
}
