import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { rpc } from '../lib/helius.js';
import { WSOL } from '../lib/programs.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './policy.js';

export class TxInputError extends Error {}

interface RawAccount {
  lamports: number;
  owner: string;
  data: [string, string];
}

/** What an instruction does, independent of whether RPC gave it to us raw or pre-parsed. */
type IxEvent =
  | { type: 'sol_transfer'; from: string; to: string; lamports: bigint }
  | { type: 'token_transfer'; src: string; dst: string; mint: string | null; authority: string; amount: bigint }
  | { type: 'approve'; owner: string; delegate: string }
  | { type: 'set_authority'; account: string; authority: string; newAuthority: string | null }
  | { type: 'assign'; account: string }
  | { type: 'ata_create'; ata: string; owner: string }
  | { type: 'cu_limit'; units: number }
  | { type: 'cu_price'; microLamports: bigint };

interface Ix {
  programId: string;
  topLevel: boolean;
  events: IxEvent[];
}

/** Decodes the instructions Bastion cares about from raw program data. */
function rawEvents(programId: string, a: string[], data: Uint8Array): IxEvent[] {
  const d = Buffer.from(data);
  if (programId === SYSTEM_PROGRAM && d.length >= 4) {
    const kind = d.readUInt32LE(0);
    if (kind === 2 && d.length >= 12) return [{ type: 'sol_transfer', from: a[0], to: a[1], lamports: d.readBigUInt64LE(4) }];
    if (kind === 1) return [{ type: 'assign', account: a[0] }];
  } else if (TOKEN_PROGRAMS.has(programId) && d.length >= 1) {
    const op = d[0];
    if (op === 3 && d.length >= 9) return [{ type: 'token_transfer', src: a[0], dst: a[1], mint: null, authority: a[2], amount: d.readBigUInt64LE(1) }];
    if (op === 12 && d.length >= 9) return [{ type: 'token_transfer', src: a[0], dst: a[2], mint: a[1], authority: a[3], amount: d.readBigUInt64LE(1) }];
    if (op === 4) return [{ type: 'approve', owner: a[2], delegate: a[1] }];
    if (op === 13) return [{ type: 'approve', owner: a[3], delegate: a[2] }];
    if (op === 6 && d.length >= 3) {
      const newAuthority = d[2] === 1 && d.length >= 35 ? new PublicKey(d.subarray(3, 35)).toBase58() : null;
      return [{ type: 'set_authority', account: a[0], authority: a[1], newAuthority }];
    }
  } else if (programId === ATA_PROGRAM && a.length >= 3) {
    return [{ type: 'ata_create', ata: a[1], owner: a[2] }];
  } else if (programId === COMPUTE_BUDGET) {
    if (d[0] === 2 && d.length >= 5) return [{ type: 'cu_limit', units: d.readUInt32LE(1) }];
    if (d[0] === 3 && d.length >= 9) return [{ type: 'cu_price', microLamports: d.readBigUInt64LE(1) }];
  }
  return [];
}

/** Inner instructions from simulateTransaction come either jsonParsed or as {programId, accounts, data(base58)}. */
function innerEvents(ix: any): IxEvent[] {
  if (!ix.parsed) return rawEvents(ix.programId, ix.accounts ?? [], ix.data ? bs58.decode(ix.data) : new Uint8Array());
  const { type, info } = ix.parsed as { type: string; info: any };
  if (!info) return [];
  const big = (v: unknown) => BigInt(String(v ?? 0));
  if (ix.programId === SYSTEM_PROGRAM) {
    if (type === 'transfer') return [{ type: 'sol_transfer', from: info.source, to: info.destination, lamports: big(info.lamports) }];
    if (type === 'assign') return [{ type: 'assign', account: info.account }];
  } else if (TOKEN_PROGRAMS.has(ix.programId)) {
    const authority = info.authority ?? info.multisigAuthority ?? info.owner;
    if (type === 'transfer') return [{ type: 'token_transfer', src: info.source, dst: info.destination, mint: null, authority, amount: big(info.amount) }];
    if (type === 'transferChecked')
      return [{ type: 'token_transfer', src: info.source, dst: info.destination, mint: info.mint, authority, amount: big(info.tokenAmount?.amount) }];
    if (type === 'approve' || type === 'approveChecked') return [{ type: 'approve', owner: info.owner, delegate: info.delegate }];
    if (type === 'setAuthority') return [{ type: 'set_authority', account: info.account, authority: info.authority, newAuthority: info.newAuthority ?? null }];
  } else if (ix.programId === ATA_PROGRAM && info.account && info.wallet) {
    return [{ type: 'ata_create', ata: info.account, owner: info.wallet }];
  }
  return [];
}

export interface Transfer {
  kind: 'sol' | 'token';
  mint: string;
  /** Wallet that receives: for token transfers, the owner of the destination token account. */
  to: string;
  rawAmount: bigint;
  topLevel: boolean;
}

export interface DangerousIx {
  id: 'token_approve' | 'token_set_authority' | 'system_assign';
  message: string;
}

export interface SimulationReport {
  wallet: string;
  success: boolean;
  error: string | null;
  logsTail: string[];
  unitsConsumed: number | null;
  solDelta: number;
  /** Network fee + net rent (opened minus closed accounts): SOL that moves but is not trade value. */
  costsSol: number;
  /** Per mint, raw base units (positive = received). WSOL is folded into solDelta. */
  tokenDeltas: Map<string, bigint>;
  topLevelPrograms: string[];
  innerPrograms: string[];
  outgoing: Transfer[];
  dangerous: DangerousIx[];
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

export function decodeTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  } catch {
    throw new TxInputError('Could not decode the transaction: expected base64 of a serialized Solana transaction');
  }
}

async function resolveAccountKeys(tx: VersionedTransaction): Promise<string[]> {
  const msg = tx.message;
  const lookups = msg.addressTableLookups ?? [];
  if (!lookups.length) return msg.staticAccountKeys.map((k) => k.toBase58());
  const res = await rpc<{ value: Array<RawAccount | null> }>('getMultipleAccounts', [
    lookups.map((l) => l.accountKey.toBase58()),
    { encoding: 'base64' },
  ]);
  const tables = res.value.map((acc, i) => {
    if (!acc) throw new TxInputError(`Lookup table ${lookups[i].accountKey.toBase58()} not found`);
    return new AddressLookupTableAccount({
      key: lookups[i].accountKey,
      state: AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], 'base64')),
    });
  });
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
  return [...keys.staticAccountKeys, ...(keys.accountKeysFromLookups?.writable ?? []), ...(keys.accountKeysFromLookups?.readonly ?? [])].map(
    (k) => k.toBase58(),
  );
}

/** SPL token account layout: mint 0..32 | owner 32..64 | amount 64..72 (same base layout in Token-2022). */
function parseTokenAccount(acc: RawAccount | null | undefined) {
  if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) return null;
  const buf = Buffer.from(acc.data[0], 'base64');
  if (buf.length < 72) return null;
  return {
    mint: new PublicKey(buf.subarray(0, 32)).toBase58(),
    owner: new PublicKey(buf.subarray(32, 64)).toBase58(),
    amount: buf.readBigUInt64LE(64),
  };
}

export async function simulate(tx: VersionedTransaction, walletOverride?: string): Promise<SimulationReport> {
  const keys = await resolveAccountKeys(tx);
  const wallet = walletOverride ?? keys[0];
  const watch = [...new Set([wallet, ...keys])].slice(0, 100);

  const encoded = Buffer.from(tx.serialize()).toString('base64');
  const [pre, sim] = await Promise.all([
    rpc<{ value: Array<RawAccount | null> }>('getMultipleAccounts', [watch, { encoding: 'base64' }]),
    rpc<{ value: any }>('simulateTransaction', [
      encoded,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        innerInstructions: true,
        accounts: { encoding: 'base64', addresses: watch },
      },
    ]),
  ]);
  const v = sim.value;
  const preBy = new Map(watch.map((k, i) => [k, pre.value[i]]));
  const postBy = new Map<string, RawAccount | null>(watch.map((k, i) => [k, v.accounts?.[i] ?? null]));

  // --- instructions: top-level from the message, inner (CPI) from the simulation ---
  const msg = tx.message;
  const ixs: Ix[] = msg.compiledInstructions.map((ix) => {
    const programId = keys[ix.programIdIndex];
    return { programId, topLevel: true, events: rawEvents(programId, ix.accountKeyIndexes.map((i) => keys[i]), ix.data) };
  });
  for (const group of v.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) ixs.push({ programId: ix.programId, topLevel: false, events: innerEvents(ix) });
  }
  const events = ixs.flatMap((ix) => ix.events.map((e) => ({ ...e, topLevel: ix.topLevel })));

  // --- balance changes (only meaningful when the simulation succeeded) ---
  let solDelta = 0;
  const tokenDeltas = new Map<string, bigint>();
  if (!v.err) {
    solDelta = ((postBy.get(wallet)?.lamports ?? 0) - (preBy.get(wallet)?.lamports ?? 0)) / 1e9;
    for (const key of watch) {
      const before = parseTokenAccount(preBy.get(key));
      const after = parseTokenAccount(postBy.get(key));
      const owner = after?.owner ?? before?.owner;
      if (owner !== wallet) continue;
      const mint = (after ?? before)!.mint;
      const delta = (after?.amount ?? 0n) - (before?.amount ?? 0n);
      if (delta === 0n) continue;
      if (mint === WSOL) solDelta += Number(delta) / 1e9;
      else tokenDeltas.set(mint, (tokenDeltas.get(mint) ?? 0n) + delta);
    }
  }

  // --- accounts that belong to the wallet (incl. temp wSOL / ATAs created and closed inside the tx) ---
  const own = new Set([wallet]);
  for (const key of watch) {
    const owner = parseTokenAccount(postBy.get(key))?.owner ?? parseTokenAccount(preBy.get(key))?.owner;
    if (owner === wallet) own.add(key);
  }
  for (const e of events) if (e.type === 'ata_create' && e.owner === wallet) own.add(e.ata);

  // --- costs: base + priority fee, and rent for accounts created by this tx ---
  let cuLimit = 200_000;
  let cuPriceMicro = 0n;
  for (const e of events) {
    if (e.type === 'cu_limit' && e.topLevel) cuLimit = e.units;
    if (e.type === 'cu_price' && e.topLevel) cuPriceMicro = e.microLamports;
  }
  const feeLamports = 5000 * msg.header.numRequiredSignatures + Number((cuPriceMicro * BigInt(cuLimit) + 999_999n) / 1_000_000n);
  // Rent paid for accounts the tx opens, minus rent refunded by accounts it closes (e.g. a temp wSOL account).
  let rentLamports = 0;
  for (const key of watch) {
    if (key === wallet || !own.has(key)) continue;
    const before = preBy.get(key)?.lamports ?? 0;
    const after = postBy.get(key)?.lamports ?? 0;
    if (!before && after > 0) rentLamports += after;
    if (before > 0 && !after) {
      const acc = parseTokenAccount(preBy.get(key));
      rentLamports -= before - (acc?.mint === WSOL ? Number(acc.amount) : 0);
    }
  }
  const costsSol = v.err ? 0 : (feeLamports + rentLamports) / 1e9;

  // --- outgoing transfers signed by the wallet, and drainer patterns ---
  const outgoing: Transfer[] = [];
  const dangerous: DangerousIx[] = [];
  const tokenOwner = (acc: string) => parseTokenAccount(postBy.get(acc))?.owner ?? parseTokenAccount(preBy.get(acc))?.owner ?? acc;
  const tokenMint = (acc: string) => parseTokenAccount(postBy.get(acc))?.mint ?? parseTokenAccount(preBy.get(acc))?.mint ?? '';
  for (const e of events) {
    switch (e.type) {
      case 'sol_transfer':
        if (e.from === wallet && !own.has(e.to)) outgoing.push({ kind: 'sol', mint: WSOL, to: e.to, rawAmount: e.lamports, topLevel: e.topLevel });
        break;
      case 'token_transfer': {
        const to = tokenOwner(e.dst);
        if (e.authority === wallet && to !== wallet && !own.has(e.dst))
          outgoing.push({ kind: 'token', mint: e.mint ?? tokenMint(e.src), to, rawAmount: e.amount, topLevel: e.topLevel });
        break;
      }
      case 'approve':
        if (e.owner === wallet && e.delegate !== wallet)
          dangerous.push({ id: 'token_approve', message: `Grants ${e.delegate} the right to spend your tokens (a classic drainer)` });
        break;
      case 'set_authority':
        if (e.authority === wallet && own.has(e.account) && e.newAuthority !== wallet)
          dangerous.push({ id: 'token_set_authority', message: 'Changes the owner of your token account and hands your tokens to someone else' });
        break;
      case 'assign':
        if (e.account === wallet)
          dangerous.push({ id: 'system_assign', message: 'Reassigns your wallet to another program (account takeover)' });
        break;
    }
  }

  return {
    wallet,
    success: !v.err,
    error: v.err ? JSON.stringify(v.err) : null,
    logsTail: (v.logs ?? []).slice(-4),
    unitsConsumed: v.unitsConsumed ?? null,
    solDelta,
    costsSol,
    tokenDeltas,
    topLevelPrograms: [...new Set(ixs.filter((i) => i.topLevel).map((i) => i.programId))],
    innerPrograms: [...new Set(ixs.filter((i) => !i.topLevel).map((i) => i.programId))],
    outgoing,
    dangerous,
  };
}
