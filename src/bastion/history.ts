import { heliusApiUrl } from '../config.js';
import { fetchJson } from '../lib/http.js';
import type { EnhancedTx } from '../lib/helius.js';
import { countHelius } from '../lib/usage.js';

export interface WalletActivity {
  /** SOL that left the wallet in the last 24h (native transfers, incl. swap legs). */
  spent24hSol: number;
  txLastHour: number;
  /** Addresses the wallet has already sent SOL or tokens to: not "new" recipients. */
  knownRecipients: Set<string>;
  /** false when the last 100 txs don't reach back 24h: spend is a lower bound. */
  complete: boolean;
}

/**
 * Derived from on-chain history rather than a local ledger, so limits hold
 * across restarts and serverless instances.
 */
export async function walletActivity(wallet: string): Promise<WalletActivity> {
  countHelius();
  const txs = await fetchJson<EnhancedTx[]>(heliusApiUrl(`/v0/addresses/${wallet}/transactions?limit=100`), {
    timeoutMs: 8000,
    label: 'helius address history',
  });
  const now = Date.now() / 1000;
  let spent = 0;
  let lastHour = 0;
  const known = new Set<string>();
  for (const tx of txs) {
    const age = now - tx.timestamp;
    // A guarded vault never pays fees itself (the agent does), so count txs that move its funds too.
    const movesFunds =
      (tx.nativeTransfers ?? []).some((t) => t.fromUserAccount === wallet) || (tx.tokenTransfers ?? []).some((t) => t.fromUserAccount === wallet);
    if (age <= 3600 && (tx.feePayer === wallet || movesFunds)) lastHour++;
    for (const t of tx.nativeTransfers ?? []) {
      if (t.fromUserAccount !== wallet || t.toUserAccount === wallet) continue;
      known.add(t.toUserAccount);
      if (age <= 86_400) spent += t.amount / 1e9;
    }
    for (const t of tx.tokenTransfers ?? []) {
      if (t.fromUserAccount === wallet && t.toUserAccount && t.toUserAccount !== wallet) known.add(t.toUserAccount);
    }
  }
  const oldest = txs[txs.length - 1]?.timestamp ?? now;
  return { spent24hSol: spent, txLastHour: lastHour, knownRecipients: known, complete: txs.length < 100 || now - oldest > 86_400 };
}
