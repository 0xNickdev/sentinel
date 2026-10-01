import * as multisig from '@sqds/multisig';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createPublicKey, verify } from 'node:crypto';
import { heliusRpcUrl } from '../config.js';
import { currentCluster } from '../lib/cluster.js';
import { freezeClear, freezeGet, freezeSet } from '../lib/db.js';
import { GuardError } from './index.js';

/** Signed proofs older than this are refused, so a leaked signature cannot be replayed later. */
const MAX_PROOF_AGE_MS = 10 * 60_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const unfreezeMessage = (ms: string, cluster: string, timestamp: number) => `Sentinel: unfreeze ${ms} on ${cluster} at ${timestamp}`;

export const getFreeze = (ms: string) => freezeGet(ms, currentCluster());

export const freezeWallet = (ms: string, reason: string) => freezeSet(ms, currentCluster(), reason);

function verifyEd25519(message: string, signature: Uint8Array, signer: PublicKey) {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, signer.toBuffer()]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, signature);
}

/**
 * Lifts a kill-switch freeze. Only a full-permission member (the owner) can do it, proven by signing
 * a short, timestamped message in their wallet. No transaction and no fee.
 */
export async function unfreezeWallet(input: { multisig?: unknown; owner?: unknown; timestamp?: unknown; signature?: unknown }) {
  let ms: PublicKey;
  let owner: PublicKey;
  try {
    ms = new PublicKey(String(input.multisig));
    owner = new PublicKey(String(input.owner));
  } catch {
    throw new GuardError('multisig and owner must be Solana addresses');
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_PROOF_AGE_MS)
    throw new GuardError('Signature expired: sign a fresh unfreeze message', 401);
  let signature: Uint8Array;
  try {
    const raw = String(input.signature);
    signature = /^[0-9a-f]{128}$/i.test(raw) ? Buffer.from(raw, 'hex') : bs58.decode(raw);
  } catch {
    throw new GuardError('signature must be base58 or hex');
  }
  const message = unfreezeMessage(ms.toBase58(), currentCluster(), timestamp);
  if (signature.length !== 64 || !verifyEd25519(message, signature, owner)) throw new GuardError('Invalid signature', 401);

  const account = await multisig.accounts.Multisig.fromAccountAddress(new Connection(heliusRpcUrl(), 'confirmed'), ms).catch(() => null);
  if (!account) throw new GuardError(`No Squads multisig at ${ms.toBase58()}`, 404);
  const member = account.members.find((m) => m.key.equals(owner));
  if (!member || (member.permissions.mask & 7) !== 7) throw new GuardError('Only the owner of this wallet can unfreeze it', 403);

  const was = await getFreeze(ms.toBase58());
  await freezeClear(ms.toBase58(), currentCluster());
  return { multisig: ms.toBase58(), unfrozen: true, wasFrozen: !!was };
}
