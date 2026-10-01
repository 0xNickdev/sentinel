import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkTransaction } from '../bastion/index.js';
import { resolvePolicy } from '../bastion/policy.js';
import { decodeTransaction } from '../bastion/simulate.js';
import { execute } from '../gateway/execute.js';
import { list } from '../gateway/journal.js';
import { guardFinalize, guardStatus, setupGuard } from '../guard/index.js';
import { guardExecuteAndReport } from '../guard/service.js';
import { parseCluster, withCluster } from '../lib/cluster.js';
import { scanToken } from '../scan/index.js';

/**
 * Sentinel as an MCP server. Agents call these tools instead of signing directly.
 * Nothing here signs: transactions come back unsigned for the agent's own key.
 */

const address = z.string().describe('Solana address (base58)');
const cluster = z.enum(['mainnet', 'devnet']).optional().describe('Defaults to mainnet. Use devnet only for testing guarded wallets.');
const policy = z
  .record(z.any())
  .optional()
  .describe(
    'Owner policy. Any subset of: {"limits":{"per_tx_sol":2,"per_day_sol":10},"programs":["pump.fun","jupiter"],"min_token_score":60,"max_slippage_bps":300,"new_recipient":"confirm","mode":"enforce"}. Omit for the default.',
  );

const ok = (summary: string, data: unknown) => ({
  content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] });

async function run<T>(fn: () => Promise<T>, summarize: (r: T) => string, clusterArg?: string) {
  try {
    const r = await withCluster(parseCluster(clusterArg), fn);
    return ok(summarize(r), r);
  } catch (e) {
    return fail(e);
  }
}

const NEXT_STEP: Record<string, string> = {
  allow: 'Sign `transaction` with the agent key and send it.',
  confirm: 'Do not proceed on your own: the owner must approve first.',
  block: 'Do not retry this trade. Tell the user why it was blocked.',
  freeze: 'Stop all activity and alert the owner: the kill-switch fired.',
};

export function createMcpServer() {
  const server = new McpServer(
    { name: 'sentinel', version: '1.0.0' },
    {
      instructions:
        'Sentinel is a security gateway between an AI agent and its Solana wallet. Before buying a token call scan_token. ' +
        'Instead of signing transactions directly call execute_intent (or guard_execute for a guarded wallet) and follow the returned decision: ' +
        'allow = sign and send the returned transaction; confirm = wait for the owner; block = do not proceed; freeze = stop and alert the owner. ' +
        'Scores and decisions are risk indicators, not financial advice.',
    },
  );

  server.registerTool(
    'scan_token',
    {
      title: 'Scan a Solana token',
      description:
        'Risk score 0-100 for a Solana token by its mint address (CA): creator history, holder concentration, bundles and snipers, mint/freeze authority, liquidity, honeypot sell test, metadata. Call before buying any token.',
      inputSchema: { mint: address.describe('Token mint address (CA)') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mint }) =>
      run(() => scanToken(mint), (r) => `${r.symbol ?? r.mint}: ${r.score}/100, verdict ${r.verdict.toUpperCase()}${r.criticalFlags.length ? ` (critical: ${r.criticalFlags.map((f) => f.message).join('; ')})` : ''}`),
  );

  server.registerTool(
    'execute_intent',
    {
      title: 'Execute a trade or transfer through Sentinel',
      description:
        'Use instead of building and signing a transaction yourself. Sentinel scans the token, builds the transaction (Jupiter for swaps), simulates it and applies the owner policy. ' +
        'Returns a decision and, when allowed, an UNSIGNED base64 transaction for the agent wallet to sign. ' +
        'Intent shapes: {type:"buy",wallet,mint,sol} | {type:"sell",wallet,mint,amount} | {type:"swap",wallet,inputMint,outputMint,amount} | {type:"transfer",wallet,to,sol}.',
      inputSchema: {
        intent: z
          .object({
            type: z.enum(['buy', 'sell', 'swap', 'transfer']),
            wallet: address.describe('The agent wallet that will sign'),
            mint: address.optional(),
            inputMint: address.optional(),
            outputMint: address.optional(),
            to: address.optional(),
            sol: z.number().positive().optional(),
            amount: z.number().positive().optional(),
            slippageBps: z.number().int().min(1).max(5000).optional(),
          })
          .describe('What the agent wants to do'),
        policy,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ intent, policy: p }) =>
      run(() => execute(intent, resolvePolicy(p)), (r) => `Decision: ${r.decision.toUpperCase()}. ${NEXT_STEP[r.decision]}${r.reasons.length ? ` Reasons: ${r.reasons.map((x) => x.message).join('; ')}` : ''}`),
  );

  server.registerTool(
    'check_transaction',
    {
      title: 'Check a transaction before signing',
      description:
        'For agents that build their own transactions: send the serialized transaction (base64) and get Sentinel’s verdict before signing. Simulates it, decodes SOL/token changes, detects drainer patterns and applies the owner policy.',
      inputSchema: {
        transaction: z.string().describe('base64 of a serialized Solana transaction'),
        wallet: address.optional().describe('Wallet whose funds are at risk. Defaults to the fee payer.'),
        policy,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ transaction, wallet, policy: p }) =>
      run(() => checkTransaction(decodeTransaction(transaction), resolvePolicy(p), wallet), (r) => `Decision: ${r.decision.toUpperCase()}. ${NEXT_STEP[r.decision]} SOL change ${r.changes.sol}.`),
  );

  server.registerTool(
    'guard_setup',
    {
      title: 'Create a guarded wallet',
      description:
        'Creates a Squads multisig wallet where the agent can only propose, Sentinel can only approve, and the owner keeps full control. Returns an unsigned transaction for the OWNER to sign, plus a Telegram link for owner alerts.',
      inputSchema: { owner: address, agent: address, fundSol: z.number().min(0).optional(), cluster },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ owner, agent, fundSol, cluster: c }) => run(() => setupGuard({ owner, agent, fundSol }), (r) => `Guarded wallet ${r.vault}. The owner must sign and send the transaction.`, c),
  );

  server.registerTool(
    'guard_execute',
    {
      title: 'Trade from a guarded wallet',
      description:
        'Like execute_intent, but for a guarded (Squads) wallet: the transaction runs from the vault and only goes through if Sentinel votes for it. ' +
        'On allow: sign and send `transaction` (creates the proposal with Sentinel’s vote), then call guard_finalize. ' +
        'Intent shapes: {type:"buy",agent,mint,sol} | {type:"sell",agent,mint,amount} | {type:"transfer",agent,to,sol}.',
      inputSchema: {
        multisig: address.describe('Squads multisig address of the guarded wallet'),
        intent: z.object({
          type: z.enum(['buy', 'sell', 'transfer']),
          agent: address.describe('The agent key (member with Initiate + Execute)'),
          mint: address.optional(),
          to: address.optional(),
          sol: z.number().positive().optional(),
          amount: z.number().positive().optional(),
          slippageBps: z.number().int().min(1).max(5000).optional(),
        }),
        policy,
        cluster,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ multisig, intent, policy: p, cluster: c }) =>
      run(
        () => guardExecuteAndReport(multisig, intent, resolvePolicy(p)),
        (r) => `Decision: ${r.decision.toUpperCase()}. ${r.approvedBySentinel ? 'Sentinel voted for it: sign and send `transaction`, then call guard_finalize.' : NEXT_STEP[r.decision]}`,
        c,
      ),
  );

  server.registerTool(
    'guard_finalize',
    {
      title: 'Execute an approved guarded transaction',
      description: 'Second step after guard_execute: returns the unsigned execute transaction once the proposal is approved. Sign and send it with the agent key.',
      inputSchema: { multisig: address, agent: address, transactionIndex: z.number().int().positive(), cluster },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ multisig, agent, transactionIndex, cluster: c }) => run(() => guardFinalize(multisig, agent, transactionIndex), () => 'Sign and send `transaction` with the agent key.', c),
  );

  server.registerTool(
    'guard_status',
    {
      title: 'Guarded wallet status',
      description: 'Members and roles, vault balance, whether Sentinel enforcement is active, and whether the kill-switch froze the wallet.',
      inputSchema: { multisig: address, cluster },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ multisig, cluster: c }) =>
      run(() => guardStatus(multisig), (r) => `Vault ${r.vault}: ${r.vaultSol} SOL, enforced=${r.enforced}${r.frozen ? `, FROZEN (${r.frozen.reason})` : ''}.`, c),
  );

  server.registerTool(
    'decision_log',
    {
      title: 'Decision log',
      description: 'Recent Sentinel decisions with their reasons and rules version, optionally for one wallet.',
      inputSchema: { wallet: address.optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ wallet, limit }) => run(() => list(wallet, limit ?? 20), (r) => `${r.length} decision(s).`),
  );

  return server;
}
