import * as multisig from '@sqds/multisig';
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { checkTransaction, type BastionResult, type Decision } from '../bastion/index.js';
import type { Policy } from '../bastion/policy.js';
import { ConfigError, heliusRpcUrl } from '../config.js';
import { currentCluster } from '../lib/cluster.js';
import { fetchJson } from '../lib/http.js';
import { jupQuote } from '../lib/market.js';
import { TRUSTED_MINTS, WSOL } from '../lib/programs.js';
import { botLink } from '../notify/telegram.js';
import { scanToken } from '../scan/index.js';
import { freezeWallet, getFreeze } from './freeze.js';
import type { ScanResult } from '../scan/types.js';

/**
 * Guard: on-chain enforcement on top of a Squads v4 multisig.
 *
 *   owner    — all permissions (can approve, execute, change members)
 *   agent    — Initiate + Execute: can propose and run, cannot approve
 *   sentinel — Vote only: approves what passes Bastion, cannot propose or move funds
 *   threshold 1
 *
 * A proposal needs one vote, and the agent has none. So the agent's funds move only when
 * Sentinel (or the owner) approves. Refusing to vote is the kill-switch.
 */

const { Permission, Permissions } = multisig.types;
const MAX_TX_BYTES = 1232;
const VAULT_INDEX = 0;
/** Jupiter route sizes to try, largest first, until the vault transaction fits into one Solana transaction. */
const VAULT_ROUTE_MAX_ACCOUNTS = [30, 24, 18];

export class GuardError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

class TooLargeError extends GuardError {}

let approverCache: Keypair | undefined;
export function approver(): Keypair {
  if (approverCache) return approverCache;
  const secret = process.env.SENTINEL_APPROVER_SECRET;
  if (!secret) throw new ConfigError('SENTINEL_APPROVER_SECRET is not set');
  approverCache = Keypair.fromSecretKey(bs58.decode(secret));
  return approverCache;
}

const connection = () => new Connection(heliusRpcUrl(), 'confirmed');
const pk = (v: unknown, name: string) => {
  try {
    if (typeof v !== 'string') throw new Error();
    return new PublicKey(v);
  } catch {
    throw new GuardError(`${name} must be a Solana address`);
  }
};
const b64 = (tx: VersionedTransaction) => {
  const bytes = tx.serialize();
  if (bytes.length > MAX_TX_BYTES) throw new TooLargeError(`Transaction is ${bytes.length} bytes, over the ${MAX_TX_BYTES}-byte limit`, 422);
  return Buffer.from(bytes).toString('base64');
};
const vaultOf = (ms: PublicKey) => multisig.getVaultPda({ multisigPda: ms, index: VAULT_INDEX })[0];

async function compile(payer: PublicKey, instructions: TransactionInstruction[], luts: AddressLookupTableAccount[] = []) {
  const { blockhash } = await connection().getLatestBlockhash('confirmed');
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(luts));
}

async function loadMultisig(ms: PublicKey) {
  try {
    return await multisig.accounts.Multisig.fromAccountAddress(connection(), ms);
  } catch {
    throw new GuardError(`No Squads multisig at ${ms.toBase58()} on ${currentCluster()}`, 404);
  }
}

const has = (mask: number, p: number) => (mask & p) === p;

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://www.santinelguard.online';

/** Page where the owner reviews and approves a proposal Sentinel would not approve on its own. */
export const approvalUrl = (ms: string, index: number) =>
  `${PUBLIC_URL}/approve.html?ms=${ms}&i=${index}${currentCluster() === 'devnet' ? '&cluster=devnet' : ''}`;

// ---------------------------------------------------------------- setup

export async function setupGuard(input: { owner?: unknown; agent?: unknown; fundSol?: unknown }) {
  const owner = pk(input.owner, 'owner');
  const agent = pk(input.agent, 'agent');
  if (owner.equals(agent)) throw new GuardError('owner and agent must be different wallets');
  const fundSol = input.fundSol == null ? 0 : Number(input.fundSol);
  if (!Number.isFinite(fundSol) || fundSol < 0) throw new GuardError('fundSol must be a non-negative number');

  const conn = connection();
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const vault = vaultOf(multisigPda);
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);

  const instructions = [
    multisig.instructions.multisigCreateV2({
      createKey: createKey.publicKey,
      creator: owner,
      multisigPda,
      configAuthority: null,
      threshold: 1,
      timeLock: 0,
      rentCollector: null,
      treasury: programConfig.treasury,
      members: [
        { key: owner, permissions: Permissions.all() },
        { key: agent, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Execute]) },
        { key: approver().publicKey, permissions: Permissions.fromPermissions([Permission.Vote]) },
      ],
      memo: 'Sentinel guarded wallet',
    }),
  ];
  if (fundSol > 0) instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: vault, lamports: Math.round(fundSol * 1e9) }));

  const tx = await compile(owner, instructions);
  tx.sign([createKey]);
  return {
    cluster: currentCluster(),
    multisig: multisigPda.toBase58(),
    vault: vault.toBase58(),
    sentinel: approver().publicKey.toBase58(),
    /** Owner opens this to get approval requests and kill-switch alerts in Telegram. */
    telegramLink: await botLink(multisigPda.toBase58()).catch(() => null),
    /** Owner signs and sends. Afterwards the agent trades from `vault`, never from its own wallet. */
    transaction: b64(tx),
  };
}

// ---------------------------------------------------------------- status

export async function guardStatus(msInput: unknown) {
  const ms = pk(msInput, 'multisig');
  const account = await loadMultisig(ms);
  const vault = vaultOf(ms);
  const sentinel = approver().publicKey;
  const members = account.members.map((m) => {
    const mask = m.permissions.mask;
    return {
      key: m.key.toBase58(),
      role: m.key.equals(sentinel) ? 'sentinel' : has(mask, 7) ? 'owner' : has(mask, 1) && !has(mask, 2) ? 'agent' : 'member',
      initiate: has(mask, 1),
      vote: has(mask, 2),
      execute: has(mask, 4),
    };
  });
  const voters = members.filter((m) => m.vote);
  return {
    cluster: currentCluster(),
    multisig: ms.toBase58(),
    vault: vault.toBase58(),
    vaultSol: (await connection().getBalance(vault)) / 1e9,
    threshold: account.threshold,
    transactionIndex: Number(account.transactionIndex),
    frozen: await getFreeze(ms.toBase58()).catch(() => null),
    members,
    /** Enforced when every voter other than the owner is Sentinel and the threshold is one vote. */
    enforced: account.threshold === 1 && voters.some((v) => v.key === sentinel.toBase58()) && !members.some((m) => m.role === 'agent' && m.vote),
  };
}

// ---------------------------------------------------------------- guarded execute

export type GuardIntent =
  | { type: 'buy'; agent: string; mint: string; sol: number; slippageBps?: number }
  | { type: 'sell'; agent: string; mint: string; amount: number; slippageBps?: number }
  | { type: 'transfer'; agent: string; to: string; sol: number };

export interface GuardExecuteResult {
  decision: Decision;
  enforced: boolean;
  approvedBySentinel: boolean;
  requiresOwnerConfirmation: boolean;
  /** Set when the owner must approve: open it, review what the transaction does, sign with the owner wallet. */
  approvalUrl: string | null;
  multisig: string;
  vault: string;
  transactionIndex: number | null;
  /** Agent signs and sends: creates the vault transaction + proposal (+ Sentinel's vote when approved). */
  transaction: string | null;
  reasons: BastionResult['reasons'];
  scan: Pick<ScanResult, 'mint' | 'symbol' | 'score' | 'verdict'> | null;
  bastion: BastionResult | null;
  durationMs: number;
}

export async function guardedExecute(msInput: unknown, rawIntent: unknown, policy: Policy): Promise<GuardExecuteResult> {
  const started = Date.now();
  const ms = pk(msInput, 'multisig');
  const intent = parseGuardIntent(rawIntent);
  const agent = new PublicKey(intent.agent);
  const account = await loadMultisig(ms);
  const agentMember = account.members.find((m) => m.key.equals(agent));
  if (!agentMember || !has(agentMember.permissions.mask, 1)) throw new GuardError('agent is not a member with Initiate permission', 403);
  if (!account.members.some((m) => m.key.equals(approver().publicKey) && has(m.permissions.mask, 2)))
    throw new GuardError('Sentinel is not a voting member of this multisig', 403);
  const vault = vaultOf(ms);

  const base = { multisig: ms.toBase58(), vault: vault.toBase58(), enforced: policy.mode === 'enforce' };

  // A tripped kill-switch persists: nothing gets Sentinel's vote until the owner unfreezes the wallet.
  const frozen = await getFreeze(ms.toBase58());
  if (frozen) {
    return {
      ...base, decision: 'freeze', approvedBySentinel: false, requiresOwnerConfirmation: false, approvalUrl: null, transactionIndex: null, transaction: null,
      reasons: [{ id: 'wallet_frozen', action: 'freeze', message: `Wallet frozen by the kill-switch since ${frozen.frozenAt}: ${frozen.reason}. The owner must unfreeze it.` }],
      scan: null, bastion: null, durationMs: Date.now() - started,
    };
  }

  // Scan the token being bought first; mainnet-only data, so skipped on devnet.
  let scan: ScanResult | null = null;
  if (intent.type === 'buy' && !TRUSTED_MINTS[intent.mint] && currentCluster() === 'mainnet') {
    scan = await scanToken(intent.mint);
    const critical = scan.criticalFlags[0];
    if (critical || scan.score < policy.min_token_score) {
      const message = critical ? `Scan: ${critical.message}` : `Scan: score ${scan.score} < ${policy.min_token_score}`;
      return {
        ...base, decision: 'block', approvedBySentinel: false, requiresOwnerConfirmation: false, approvalUrl: null, transactionIndex: null, transaction: null,
        reasons: [{ id: critical ? 'scan_critical' : 'scan_low_score', action: 'block', message }],
        scan: pickScan(scan), bastion: null, durationMs: Date.now() - started,
      };
    }
  }

  for (const maxAccounts of VAULT_ROUTE_MAX_ACCOUNTS) {
    try {
      return await judgeAndWrap(maxAccounts);
    } catch (e) {
      if (!(e instanceof TooLargeError) || intent.type === 'transfer' || maxAccounts === VAULT_ROUTE_MAX_ACCOUNTS.at(-1)) throw e;
    }
  }
  throw new GuardError('No route small enough for a guarded transaction', 422);

  async function judgeAndWrap(maxAccounts: number): Promise<GuardExecuteResult> {
    // What the vault itself would execute, judged by Bastion as if the vault were signing directly.
    const { instructions, luts } = await vaultInstructions(intent, vault, maxAccounts);
    const inner = await compile(vault, instructions, luts);
    const bastion = await checkTransaction(inner, policy, vault.toBase58());

    if (bastion.decision === 'freeze' && policy.mode === 'enforce') {
      const trigger = bastion.reasons.find((r) => r.action === 'freeze');
      await freezeWallet(ms.toBase58(), trigger?.message ?? 'kill-switch');
    }

    const approve = bastion.decision === 'allow' || policy.mode === 'warn';
    const needsOwner = !approve && bastion.decision === 'confirm';
    let transaction: string | null = null;
    let transactionIndex: number | null = null;

    if (approve || needsOwner) {
      const index = BigInt(account.transactionIndex.toString()) + 1n;
      const { blockhash } = await connection().getLatestBlockhash('confirmed');
      const ixs = [
        multisig.instructions.vaultTransactionCreate({
          multisigPda: ms,
          transactionIndex: index,
          creator: agent,
          vaultIndex: VAULT_INDEX,
          ephemeralSigners: 0,
          transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions }),
          addressLookupTableAccounts: luts,
          memo: `sentinel ${bastion.rulesVersion}`,
        }),
        multisig.instructions.proposalCreate({ multisigPda: ms, transactionIndex: index, creator: agent }),
      ];
      if (approve) ixs.push(multisig.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member: approver().publicKey }));
      const tx = await compile(agent, ixs);
      if (approve) tx.sign([approver()]);
      transaction = b64(tx);
      transactionIndex = Number(index);
    }

    return {
      ...base,
      decision: bastion.decision,
      approvedBySentinel: approve,
      requiresOwnerConfirmation: needsOwner,
      approvalUrl: needsOwner && transactionIndex ? approvalUrl(ms.toBase58(), transactionIndex) : null,
      transactionIndex,
      transaction,
      reasons: bastion.reasons,
      scan: scan && pickScan(scan),
      bastion,
      durationMs: Date.now() - started,
    };
  }
}

/** Second step: once the proposal is approved, the agent executes the vault transaction. */
export async function guardFinalize(msInput: unknown, agentInput: unknown, indexInput: unknown) {
  const ms = pk(msInput, 'multisig');
  const agent = pk(agentInput, 'agent');
  const index = Number(indexInput);
  if (!Number.isInteger(index) || index < 1) throw new GuardError('transactionIndex must be a positive integer');
  const conn = connection();
  const [proposalPda] = multisig.getProposalPda({ multisigPda: ms, transactionIndex: BigInt(index) });
  let status: string;
  try {
    status = (await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda)).status.__kind;
  } catch {
    throw new GuardError(`Proposal #${index} not found. Send the execute transaction first.`, 404);
  }
  if (status !== 'Approved') throw new GuardError(`Proposal #${index} is ${status}, not Approved`, 409);
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
    connection: conn,
    multisigPda: ms,
    transactionIndex: BigInt(index),
    member: agent,
  });
  return { transactionIndex: index, transaction: b64(await compile(agent, [instruction], lookupTableAccounts)) };
}

/** Owner-side kill-switch that needs no one's cooperation: removes the agent from the multisig. */
export async function revokeAgent(msInput: unknown, ownerInput: unknown, agentInput: unknown) {
  const ms = pk(msInput, 'multisig');
  const owner = pk(ownerInput, 'owner');
  const agent = pk(agentInput, 'agent');
  const account = await loadMultisig(ms);
  const ownerMember = account.members.find((m) => m.key.equals(owner));
  if (!ownerMember || !has(ownerMember.permissions.mask, 7)) throw new GuardError('owner must be a member with all permissions', 403);
  if (!account.members.some((m) => m.key.equals(agent))) throw new GuardError('agent is not a member', 404);
  const index = BigInt(account.transactionIndex.toString()) + 1n;
  const tx = await compile(owner, [
    multisig.instructions.configTransactionCreate({ multisigPda: ms, transactionIndex: index, creator: owner, actions: [{ __kind: 'RemoveMember', oldMember: agent }] }),
    multisig.instructions.proposalCreate({ multisigPda: ms, transactionIndex: index, creator: owner }),
    multisig.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member: owner }),
    multisig.instructions.configTransactionExecute({ multisigPda: ms, transactionIndex: index, member: owner, rentPayer: owner }),
  ]);
  return { transactionIndex: Number(index), transaction: b64(tx) };
}

// ---------------------------------------------------------------- helpers

const pickScan = (s: ScanResult) => ({ mint: s.mint, symbol: s.symbol, score: s.score, verdict: s.verdict });

function parseGuardIntent(raw: unknown): GuardIntent {
  if (!raw || typeof raw !== 'object') throw new GuardError('intent must be an object');
  const i = raw as Record<string, unknown>;
  pk(i.agent, 'intent.agent');
  const amount = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new GuardError(`${name} must be a positive number`);
  };
  switch (i.type) {
    case 'buy':
      pk(i.mint, 'intent.mint');
      amount(i.sol, 'intent.sol');
      break;
    case 'sell':
      pk(i.mint, 'intent.mint');
      amount(i.amount, 'intent.amount');
      break;
    case 'transfer':
      pk(i.to, 'intent.to');
      amount(i.sol, 'intent.sol');
      break;
    default:
      throw new GuardError('intent.type: buy | sell | transfer');
  }
  return i as unknown as GuardIntent;
}

interface JupIx {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}
const toIx = (ix: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });

/** Instructions the vault executes. Compute-budget instructions are excluded: they only work top-level. */
async function vaultInstructions(intent: GuardIntent, vault: PublicKey, maxAccounts: number): Promise<{ instructions: TransactionInstruction[]; luts: AddressLookupTableAccount[] }> {
  if (intent.type === 'transfer') {
    return { instructions: [SystemProgram.transfer({ fromPubkey: vault, toPubkey: new PublicKey(intent.to), lamports: Math.round(intent.sol * 1e9) })], luts: [] };
  }
  if (currentCluster() !== 'mainnet') throw new GuardError('Swaps route through Jupiter and are mainnet-only', 422);
  const [inputMint, outputMint, amountUi] = intent.type === 'buy' ? [WSOL, intent.mint, intent.sol] : [intent.mint, WSOL, intent.amount];
  const decimals = inputMint === WSOL ? 9 : (await connection().getParsedAccountInfo(new PublicKey(inputMint))).value?.data;
  const dec = typeof decimals === 'number' ? decimals : ((decimals as any)?.parsed?.info?.decimals as number | undefined);
  if (dec == null) throw new GuardError(`${inputMint} is not a token`);
  const quote = await jupQuote(inputMint, outputMint, BigInt(Math.round(amountUi * 10 ** dec)), intent.slippageBps ?? 100, maxAccounts);
  if (!quote) throw new GuardError('Jupiter found no route for this trade', 422);
  const res = await fetchJson<{
    setupInstructions?: JupIx[];
    swapInstruction: JupIx;
    cleanupInstruction?: JupIx | null;
    addressLookupTableAddresses?: string[];
  }>('https://lite-api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: vault.toBase58(), wrapAndUnwrapSol: true }),
    timeoutMs: 10_000,
  });
  const instructions = [...(res.setupInstructions ?? []), res.swapInstruction, ...(res.cleanupInstruction ? [res.cleanupInstruction] : [])].map(toIx);
  const lutAddrs = (res.addressLookupTableAddresses ?? []).map((a) => new PublicKey(a));
  const infos = lutAddrs.length ? await connection().getMultipleAccountsInfo(lutAddrs) : [];
  const luts = infos.flatMap((info, i) =>
    info ? [new AddressLookupTableAccount({ key: lutAddrs[i], state: AddressLookupTableAccount.deserialize(info.data) })] : [],
  );
  return { instructions, luts };
}
