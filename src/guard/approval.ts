import * as multisig from '@sqds/multisig';
import { AddressLookupTableAccount, Connection, MessageV0, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { checkTransaction, type BastionResult } from '../bastion/index.js';
import { DEFAULT_POLICY } from '../bastion/policy.js';
import { heliusRpcUrl } from '../config.js';
import { currentCluster } from '../lib/cluster.js';
import { GuardError } from './index.js';

const MAX_TX_BYTES = 1232;
const connection = () => new Connection(heliusRpcUrl(), 'confirmed');

function parse(msInput: unknown, indexInput: unknown) {
  let ms: PublicKey;
  try {
    ms = new PublicKey(String(msInput));
  } catch {
    throw new GuardError('multisig must be a Solana address');
  }
  const index = Number(indexInput);
  if (!Number.isInteger(index) || index < 1) throw new GuardError('transactionIndex must be a positive integer');
  return { ms, index: BigInt(index) };
}

async function loadProposal(ms: PublicKey, index: bigint) {
  const conn = connection();
  const [proposalPda] = multisig.getProposalPda({ multisigPda: ms, transactionIndex: index });
  const [txPda] = multisig.getTransactionPda({ multisigPda: ms, index });
  const [proposal, vaultTx] = await Promise.all([
    multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda).catch(() => null),
    multisig.accounts.VaultTransaction.fromAccountAddress(conn, txPda).catch(() => null),
  ]);
  if (!proposal || !vaultTx) throw new GuardError(`Proposal #${index} not found on ${currentCluster()}`, 404);
  return { proposal, vaultTx };
}

/** Rebuilds the stored vault message as a transaction the vault itself would send, so Bastion can judge it again. */
async function storedTransaction(vaultTx: multisig.accounts.VaultTransaction) {
  // Lookup tables stay as references: Bastion's simulation resolves them itself.
  const m = vaultTx.message;
  const message = new MessageV0({
    header: {
      numRequiredSignatures: m.numSigners,
      numReadonlySignedAccounts: m.numSigners - m.numWritableSigners,
      numReadonlyUnsignedAccounts: m.accountKeys.length - m.numSigners - m.numWritableNonSigners,
    },
    staticAccountKeys: m.accountKeys,
    recentBlockhash: (await connection().getLatestBlockhash('confirmed')).blockhash,
    compiledInstructions: m.instructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountKeyIndexes: [...ix.accountIndexes],
      data: Uint8Array.from(ix.data),
    })),
    addressTableLookups: m.addressTableLookups.map((l) => ({
      accountKey: l.accountKey,
      writableIndexes: [...l.writableIndexes],
      readonlyIndexes: [...l.readonlyIndexes],
    })),
  });
  return new VersionedTransaction(message);
}

export interface ProposalView {
  cluster: string;
  multisig: string;
  vault: string;
  transactionIndex: number;
  status: string;
  creator: string;
  approvedBy: string[];
  rejectedBy: string[];
  analysis: Pick<BastionResult, 'decision' | 'reasons' | 'changes' | 'recipients' | 'programs' | 'simulation'> | null;
}

export async function describeProposal(msInput: unknown, indexInput: unknown): Promise<ProposalView> {
  const { ms, index } = parse(msInput, indexInput);
  const { proposal, vaultTx } = await loadProposal(ms, index);
  const [vault] = multisig.getVaultPda({ multisigPda: ms, index: vaultTx.vaultIndex });
  let analysis: ProposalView['analysis'] = null;
  // Squads invalidates proposals created before a config change (e.g. the agent was revoked).
  const status = proposal.status.__kind === 'Active' && (await isStale(ms, index)) ? 'Stale' : proposal.status.__kind;
  // Re-simulate only what can still run; executed/cancelled proposals would just fail simulation.
  if (status === 'Active' || status === 'Approved') {
    try {
      const r = await checkTransaction(await storedTransaction(vaultTx), DEFAULT_POLICY, vault.toBase58());
      analysis = { decision: r.decision, reasons: r.reasons, changes: r.changes, recipients: r.recipients, programs: r.programs, simulation: r.simulation };
    } catch {
      analysis = null;
    }
  }
  return {
    cluster: currentCluster(),
    multisig: ms.toBase58(),
    vault: vault.toBase58(),
    transactionIndex: Number(index),
    status,
    creator: vaultTx.creator.toBase58(),
    approvedBy: proposal.approved.map((k) => k.toBase58()),
    rejectedBy: proposal.rejected.map((k) => k.toBase58()),
    analysis,
  };
}

async function isStale(ms: PublicKey, index: bigint) {
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection(), ms);
  return BigInt(account.staleTransactionIndex.toString()) >= index;
}

async function ownerTx(ms: PublicKey, ownerInput: unknown) {
  let owner: PublicKey;
  try {
    owner = new PublicKey(String(ownerInput));
  } catch {
    throw new GuardError('owner must be a Solana address');
  }
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection(), ms).catch(() => null);
  if (!account) throw new GuardError(`No Squads multisig at ${ms.toBase58()}`, 404);
  const member = account.members.find((m) => m.key.equals(owner));
  if (!member || (member.permissions.mask & 2) !== 2) throw new GuardError('This wallet cannot vote on this multisig', 403);
  return { owner, canExecute: (member.permissions.mask & 4) === 4 };
}

const build = async (payer: PublicKey, ixs: TransactionInstruction[], luts: AddressLookupTableAccount[] = []) => {
  const { blockhash } = await connection().getLatestBlockhash('confirmed');
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts));
};

/**
 * Owner approval. When the owner may also execute and it fits, approve + execute go in one transaction,
 * so the owner's single signature both confirms and runs it.
 */
export async function approveProposal(msInput: unknown, indexInput: unknown, ownerInput: unknown) {
  const { ms, index } = parse(msInput, indexInput);
  const { owner, canExecute } = await ownerTx(ms, ownerInput);
  const { proposal } = await loadProposal(ms, index);
  if (proposal.status.__kind !== 'Active') throw new GuardError(`Proposal #${index} is ${proposal.status.__kind}`, 409);
  if (await isStale(ms, index)) throw new GuardError(`Proposal #${index} is stale: the wallet's members changed after it was created`, 409);

  const approve = multisig.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member: owner });
  if (canExecute) {
    try {
      const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
        connection: connection(),
        multisigPda: ms,
        transactionIndex: index,
        member: owner,
      });
      const tx = await build(owner, [approve, instruction], lookupTableAccounts);
      const bytes = tx.serialize();
      if (bytes.length <= MAX_TX_BYTES) return { executes: true, transaction: Buffer.from(bytes).toString('base64') };
    } catch {
      /* too large or not executable yet: fall back to approve only */
    }
  }
  return { executes: false, transaction: Buffer.from((await build(owner, [approve])).serialize()).toString('base64') };
}

/** Relays a transaction the owner already signed in their wallet, so the browser never needs an RPC key. */
export async function relaySigned(txInput: unknown) {
  if (typeof txInput !== 'string') throw new GuardError('transaction: base64 of a signed transaction');
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(txInput, 'base64'));
  } catch {
    throw new GuardError('Could not decode the signed transaction');
  }
  if (!tx.signatures.length || tx.signatures.every((s) => s.every((b) => b === 0))) throw new GuardError('Transaction is not signed', 400);
  const conn = connection();
  try {
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const { blockhash, lastValidBlockHeight } = { blockhash: tx.message.recentBlockhash, lastValidBlockHeight: (await conn.getBlockHeight()) + 150 };
    const result = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new GuardError(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`, 422);
    return { signature, cluster: currentCluster() };
  } catch (e) {
    if (e instanceof GuardError) throw e;
    const logs = (e as { logs?: string[] }).logs;
    throw new GuardError(`Transaction rejected: ${logs?.find((l) => l.includes('Error')) ?? (e as Error).message}`.slice(0, 300), 422);
  }
}

export async function rejectProposal(msInput: unknown, indexInput: unknown, ownerInput: unknown) {
  const { ms, index } = parse(msInput, indexInput);
  const { owner } = await ownerTx(ms, ownerInput);
  const { proposal } = await loadProposal(ms, index);
  if (proposal.status.__kind !== 'Active') throw new GuardError(`Proposal #${index} is ${proposal.status.__kind}`, 409);
  const tx = await build(owner, [multisig.instructions.proposalReject({ multisigPda: ms, transactionIndex: index, member: owner })]);
  return { transaction: Buffer.from(tx.serialize()).toString('base64') };
}
