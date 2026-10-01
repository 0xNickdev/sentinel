import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';

/**
 * Local check of a transaction built by the Sentinel server, run before the agent signs it.
 * The transaction is simulated on the caller's own RPC connection and the resulting balance
 * changes are compared with the intent, so a compromised server cannot slip in a different trade.
 */

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = 'So11111111111111111111111111111111111111112';

/** Room for network fees, priority fees and rent of accounts the transaction opens. */
export const FEE_ALLOWANCE_LAMPORTS = 5_000_000n; // 0.005 SOL

export interface Expectation {
  /** The account whose funds the transaction moves: the agent wallet, or the vault of a guarded wallet. */
  owner: string;
  /** Upper bound on SOL leaving `owner`, in lamports, fees included. */
  maxSolOut: bigint;
  /** The one token allowed to leave `owner`, and how much of it at most (UI units). */
  spend?: { mint: string; amount: number };
  /** A token whose balance must go up (the token being bought). */
  receive?: string;
  /** A SOL transfer that must land at this address. */
  pay?: { to: string; lamports: bigint };
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(`Local check failed: ${message}. The transaction was not signed.`);
    this.name = 'VerificationError';
  }
}

interface TokenState {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
}

function parseTokenAccount(data: Buffer): TokenState | null {
  if (data.length < 165) return null;
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    delegate: data.readUInt32LE(72) === 1 ? new PublicKey(data.subarray(76, 108)).toBase58() : null,
  };
}

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

const toRaw = (ui: number, decimals: number) => BigInt(Math.round(ui * 10 ** decimals));

export async function verifyTransaction(connection: Connection, b64: string, expect: Expectation): Promise<void> {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const owner = new PublicKey(expect.owner);

  // Every token account the owner has now, plus the accounts the trade may open for the bought token.
  const held = (
    await Promise.all(
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) => connection.getTokenAccountsByOwner(owner, { programId }, 'confirmed')),
    )
  ).flatMap((r) => r.value.map((v) => v.pubkey.toBase58()));
  const extra: string[] = [];
  if (expect.receive && expect.receive !== WSOL) {
    const mint = new PublicKey(expect.receive);
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) extra.push(ata(owner, mint, program).toBase58());
  }
  const addresses = [...new Set([owner.toBase58(), ...held, ...extra, ...(expect.pay ? [expect.pay.to] : [])])];

  // Only writable accounts of the transaction can change, and the RPC only reports accounts the transaction uses.
  const writable = await writableKeys(connection, tx);
  const watched = addresses.filter((a) => writable.has(a));
  const [rawBefore, sim] = await Promise.all([
    connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)), 'confirmed'),
    connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }),
  ]);
  if (sim.value.err) throw new VerificationError(`simulation failed (${JSON.stringify(sim.value.err)})`);
  const simulated = sim.value.accounts ?? [];
  if (simulated.length !== watched.length) throw new VerificationError('the RPC did not return the simulated accounts');

  type State = { lamports: bigint; owner: string; data: Buffer } | null;
  const before: State[] = rawBefore.map((a) => (a ? { lamports: BigInt(a.lamports), owner: a.owner.toBase58(), data: a.data } : null));
  const after: State[] = addresses.map((a, i) => {
    const j = watched.indexOf(a);
    if (j < 0) return before[i];
    const s = simulated[j];
    return s ? { lamports: BigInt(s.lamports), owner: s.owner, data: Buffer.from(s.data[0], 'base64') } : null;
  });

  const lamportsBefore = (i: number) => before[i]?.lamports ?? 0n;
  const lamportsAfter = (i: number) => after[i]?.lamports ?? 0n;
  const dataAfter = (i: number) => after[i]?.data ?? null;

  // The wallet itself must keep its program owner: no reassignment.
  if (before[0] && after[0] && after[0].owner !== before[0].owner)
    throw new VerificationError('the wallet would be reassigned to another program');

  // SOL leaving the wallet, counting rent locked into token accounts it owns.
  let solOut = lamportsBefore(0) - lamportsAfter(0);
  const tokenDelta = new Map<string, bigint>();
  addresses.forEach((_, i) => {
    if (i === 0 || addresses[i] === expect.pay?.to) return;
    const pre = before[i] ? parseTokenAccount(before[i]!.data) : null;
    const postData = dataAfter(i);
    const post = postData ? parseTokenAccount(postData) : null;
    if (!pre && !post) return;
    if (pre && pre.owner !== owner.toBase58()) return;
    if (!pre && post && post.owner !== owner.toBase58()) return; // opened for someone else: not the wallet's money
    if (post && post.owner !== owner.toBase58() && pre)
      throw new VerificationError(`token account ${addresses[i]} would change owner`);
    if (post && post.delegate && post.delegate !== pre?.delegate)
      throw new VerificationError(`token account ${addresses[i]} would get a delegate (${post.delegate})`);
    const mint = (post ?? pre)!.mint;
    tokenDelta.set(mint, (tokenDelta.get(mint) ?? 0n) + (post?.amount ?? 0n) - (pre?.amount ?? 0n));
    // Rent moving between the wallet and its own token accounts is not money leaving.
    solOut -= lamportsAfter(i) - lamportsBefore(i);
  });

  if (solOut > expect.maxSolOut)
    throw new VerificationError(`${Number(solOut) / 1e9} SOL would leave the wallet, the intent allows ${Number(expect.maxSolOut) / 1e9}`);

  const spendRaw = expect.spend ? await spendLimit(connection, expect.spend) : null;
  for (const [mint, delta] of tokenDelta) {
    if (delta >= 0n || mint === WSOL) continue;
    if (expect.spend && mint === expect.spend.mint && -delta <= spendRaw!) continue;
    throw new VerificationError(`token ${mint} balance would drop by ${-delta} (raw units)`);
  }
  if (expect.receive && expect.receive !== WSOL && !((tokenDelta.get(expect.receive) ?? 0n) > 0n))
    throw new VerificationError(`token ${expect.receive} would not arrive`);
  if (expect.pay) {
    const i = addresses.indexOf(expect.pay.to);
    if (lamportsAfter(i) - lamportsBefore(i) < expect.pay.lamports) throw new VerificationError(`${expect.pay.to} would not receive the transfer`);
  }
}

async function writableKeys(connection: Connection, tx: VersionedTransaction): Promise<Set<string>> {
  const msg = tx.message;
  const out = new Set<string>();
  msg.staticAccountKeys.forEach((k, i) => {
    if (msg.isAccountWritable(i)) out.add(k.toBase58());
  });
  for (const lookup of msg.addressTableLookups) {
    const table = (await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'confirmed' })).value;
    if (!table) throw new VerificationError(`lookup table ${lookup.accountKey.toBase58()} not found`);
    for (const i of lookup.writableIndexes) out.add(table.state.addresses[i].toBase58());
  }
  return out;
}

async function spendLimit(connection: Connection, spend: { mint: string; amount: number }) {
  const info = await connection.getParsedAccountInfo(new PublicKey(spend.mint), 'confirmed');
  const decimals = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new VerificationError(`${spend.mint} is not a token mint`);
  return toRaw(spend.amount, decimals) + 1n;
}

type AnyIntent =
  | { type: 'buy'; mint: string; sol: number }
  | { type: 'sell'; mint: string; amount: number }
  | { type: 'swap'; inputMint: string; outputMint: string; amount: number }
  | { type: 'transfer'; to: string; sol: number };

/** What a transaction for this intent may do to `owner`'s funds. */
export function expectationFor(intent: AnyIntent, owner: string): Expectation {
  const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
  switch (intent.type) {
    case 'buy':
      return { owner, maxSolOut: lamports(intent.sol) + FEE_ALLOWANCE_LAMPORTS, receive: intent.mint };
    case 'sell':
      return { owner, maxSolOut: FEE_ALLOWANCE_LAMPORTS, spend: { mint: intent.mint, amount: intent.amount } };
    case 'swap':
      return intent.inputMint === WSOL
        ? { owner, maxSolOut: lamports(intent.amount) + FEE_ALLOWANCE_LAMPORTS, receive: intent.outputMint }
        : { owner, maxSolOut: FEE_ALLOWANCE_LAMPORTS, spend: { mint: intent.inputMint, amount: intent.amount }, receive: intent.outputMint };
    case 'transfer':
      return { owner, maxSolOut: lamports(intent.sol) + FEE_ALLOWANCE_LAMPORTS, pay: { to: intent.to, lamports: lamports(intent.sol) } };
  }
}
