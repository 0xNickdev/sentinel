import { BASTION_RULES_VERSION } from '../bastion/index.js';
import type { Policy } from '../bastion/policy.js';
import { record } from '../gateway/journal.js';
import { notifyGuardEvent } from '../notify/telegram.js';
import { guardedExecute } from './index.js';

/** Guarded execute plus its side effects: the decision log and owner alerts. Shared by the REST API and MCP. */
export async function guardExecuteAndReport(multisig: unknown, rawIntent: unknown, policy: Policy) {
  const result = await guardedExecute(multisig, rawIntent, policy);
  const intent = (rawIntent ?? {}) as { type?: string; agent?: string; to?: string; mint?: string; sol?: number; amount?: number };
  const summary =
    intent.type === 'transfer' ? `Transfer ${intent.sol} SOL to ${intent.to}` :
    intent.type === 'buy' ? `Buy ${result.scan?.symbol ?? intent.mint} for ${intent.sol} SOL` :
    intent.type === 'sell' ? `Sell ${intent.amount} ${result.scan?.symbol ?? intent.mint}` : 'Agent transaction';
  // Awaited: a serverless function may be frozen right after the response, dropping a pending alert.
  await Promise.allSettled([
    notifyGuardEvent({ multisig: result.multisig, vault: result.vault, agent: String(intent.agent ?? ''), decision: result.decision, summary, reasons: result.reasons, approvalUrl: result.approvalUrl }),
    record({ kind: 'execute', wallet: result.vault, summary: `guarded: ${summary}`, decision: result.decision, enforced: result.enforced, reasons: result.reasons, rulesVersion: result.bastion?.rulesVersion ?? BASTION_RULES_VERSION }),
  ]);
  return result;
}
