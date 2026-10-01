/**
 * End-to-end test of on-chain enforcement on devnet with real transactions.
 *   npm run guard:devnet            (local server must be running: npm start)
 * Proves: allowed transfer executes; injection gets no approval; the agent cannot bypass
 * Sentinel by proposing on its own; the owner can revoke the agent.
 */
import * as multisig from '@sqds/multisig';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import 'dotenv/config';

const API = process.env.API ?? 'http://127.0.0.1:8787';
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');
// OWNER_SECRET (base58) reuses a pre-funded devnet wallet when the faucets are rate-limited.
const owner = process.env.OWNER_SECRET ? Keypair.fromSecretKey(bs58.decode(process.env.OWNER_SECRET)) : Keypair.generate();
const faucet = new Connection('https://api.devnet.solana.com', 'confirmed');
const agent = Keypair.generate();
const stranger = Keypair.generate().publicKey;

const post = async (path: string, body: unknown) => {
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cluster: 'devnet', ...(body as object) }) });
  const json = (await res.json()) as any;
  if (!res.ok) throw Object.assign(new Error(`${path} → HTTP ${res.status}: ${json.error}`), { status: res.status });
  return json;
};
const send = async (b64: string, signer: Keypair) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  tx.sign([signer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
};
const sol = async (k: PublicKey) => (await conn.getBalance(k)) / LAMPORTS_PER_SOL;
const step = (s: string) => console.log(`\n■ ${s}`);

async function fund() {
  if ((await sol(owner.publicKey)) >= 0.3) return;
  for (const [name, c] of [['helius', conn], ['solana', faucet]] as const) {
    for (const amount of [1, 0.5]) {
      try {
        const sig = await c.requestAirdrop(owner.publicKey, amount * LAMPORTS_PER_SOL);
        await c.confirmTransaction(sig, 'confirmed');
        if ((await sol(owner.publicKey)) >= 0.3) return;
      } catch (e) {
        console.log(`  ${name} airdrop ${amount} SOL failed: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }
  throw new Error(`Devnet faucet is rate-limited. Fund ${owner.publicKey.toBase58()} at https://faucet.solana.com and re-run with OWNER_SECRET.`);
}

const policy = { limits: { per_tx_sol: 0.1, per_day_sol: 1 }, recipients: [] as string[] };

step('1. Fund owner (devnet airdrop) and give the agent gas money');
await fund();
await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })), [owner]).then((s) => conn.confirmTransaction(s, 'confirmed'));
console.log(`  owner ${await sol(owner.publicKey)} SOL, agent ${await sol(agent.publicKey)} SOL`);

step('2. Owner creates the guarded wallet (Squads multisig) and funds the vault with 0.2 SOL');
const setup = await post('/api/guard/setup', { owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58(), fundSol: 0.2 });
console.log(`  multisig ${setup.multisig}\n  vault    ${setup.vault}\n  sentinel ${setup.sentinel}`);
console.log(`  tx ${await send(setup.transaction, owner)}`);
const status = await post('/api/guard/status', { multisig: setup.multisig });
console.log(`  enforced=${status.enforced} threshold=${status.threshold} vault=${status.vaultSol} SOL`);
console.log(`  members: ${status.members.map((m: any) => `${m.role}(${['initiate', 'vote', 'execute'].filter((p) => m[p]).join('+')})`).join(', ')}`);
policy.recipients.push(owner.publicKey.toBase58());

step('3. Allowed: agent sends 0.02 SOL back to the owner (pre-approved recipient)');
const ok = await post('/api/guard/execute', { multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), sol: 0.02 }, policy });
console.log(`  decision=${ok.decision} approvedBySentinel=${ok.approvedBySentinel} #${ok.transactionIndex}`);
console.log(`  propose+approve tx ${await send(ok.transaction, agent)}`);
const fin = await post('/api/guard/finalize', { multisig: setup.multisig, agent: agent.publicKey.toBase58(), transactionIndex: ok.transactionIndex });
const before = await sol(new PublicKey(setup.vault));
console.log(`  execute tx ${await send(fin.transaction, agent)}`);
console.log(`  vault ${before} → ${await sol(new PublicKey(setup.vault))} SOL  ✅ executed on-chain`);

step('4. Injection: agent tries to send 0.17 SOL (almost everything) to a stranger');
const bad = await post('/api/guard/execute', { multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: stranger.toBase58(), sol: 0.17 }, policy });
console.log(`  decision=${bad.decision} approvedBySentinel=${bad.approvedBySentinel} transaction=${bad.transaction ? 'returned' : 'none'}`);
for (const r of bad.reasons) console.log(`  - [${r.action}] ${r.message}`);

step('4a. The freeze persists: even an allowed transfer is refused until the owner unfreezes');
const blocked = await post('/api/guard/execute', { multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), sol: 0.01 }, policy });
console.log(`  decision=${blocked.decision} ${blocked.reasons[0]?.id === 'wallet_frozen' ? '✅ still frozen' : '❌ freeze did not persist'}`);
const { message, timestamp } = await post('/api/guard/unfreeze-message', { multisig: setup.multisig });
const seed = owner.secretKey.slice(0, 32);
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const signature = cryptoSign(null, Buffer.from(message), key).toString('hex');
try {
  await post('/api/guard/unfreeze', { multisig: setup.multisig, owner: agent.publicKey.toBase58(), timestamp, signature });
  console.log('  ❌ a non-owner signature was accepted');
} catch (e) {
  console.log(`  ✅ wrong signer refused: ${(e as Error).message}`);
}
await post('/api/guard/unfreeze', { multisig: setup.multisig, owner: owner.publicKey.toBase58(), timestamp, signature });
const after4a = await post('/api/guard/status', { multisig: setup.multisig });
console.log(`  owner signed the unfreeze message → frozen=${after4a.frozen ? 'yes ❌' : 'no ✅'}`);

step('4b. Owner confirmation: a transfer to a new address waits for the owner');
const fresh = Keypair.generate().publicKey;
const pending = await post('/api/guard/execute', { multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: fresh.toBase58(), sol: 0.01 }, policy });
console.log(`  decision=${pending.decision} approvedBySentinel=${pending.approvedBySentinel} requiresOwnerConfirmation=${pending.requiresOwnerConfirmation}`);
console.log(`  approvalUrl ${pending.approvalUrl}`);
console.log(`  agent proposes tx ${await send(pending.transaction, agent)}`);
const view = await post('/api/guard/proposal', { multisig: setup.multisig, transactionIndex: pending.transactionIndex });
console.log(`  owner sees: status=${view.status}, ${view.analysis?.changes.sol} SOL, reasons: ${view.analysis?.reasons.map((r: any) => r.message).join('; ')}`);
const approval = await post('/api/guard/approve', { multisig: setup.multisig, transactionIndex: pending.transactionIndex, owner: owner.publicKey.toBase58() });
const signed = VersionedTransaction.deserialize(Buffer.from(approval.transaction, 'base64'));
signed.sign([owner]);
const relayed = await post('/api/guard/send', { transaction: Buffer.from(signed.serialize()).toString('base64') });
console.log(`  owner approves${approval.executes ? ' + executes' : ''} via relay ${relayed.signature}`);
console.log(`  recipient got ${await sol(fresh)} SOL  ${(await sol(fresh)) > 0 ? '✅ executed after owner approval' : '❌ not executed'}`);

step('5. Bypass attempt: the agent skips Sentinel and proposes the drain directly in Squads');
const ms = new PublicKey(setup.multisig);
const vault = new PublicKey(setup.vault);
const account = await multisig.accounts.Multisig.fromAccountAddress(conn, ms);
const index = BigInt(account.transactionIndex.toString()) + 1n;
const { blockhash } = await conn.getLatestBlockhash();
const rogue = new VersionedTransaction(new TransactionMessage({ payerKey: agent.publicKey, recentBlockhash: blockhash, instructions: [
  multisig.instructions.vaultTransactionCreate({ multisigPda: ms, transactionIndex: index, creator: agent.publicKey, vaultIndex: 0, ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: vault, toPubkey: stranger, lamports: 0.17 * LAMPORTS_PER_SOL })] }) }),
  multisig.instructions.proposalCreate({ multisigPda: ms, transactionIndex: index, creator: agent.publicKey }),
] }).compileToV0Message());
rogue.sign([agent]);
await conn.confirmTransaction(await conn.sendTransaction(rogue), 'confirmed');
console.log(`  agent created proposal #${index} on its own (allowed: it can Initiate)`);
try {
  await conn.confirmTransaction(await conn.sendTransaction(rogue.constructor === VersionedTransaction ? await (async () => {
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection: conn, multisigPda: ms, transactionIndex: index, member: agent.publicKey });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: agent.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [instruction] }).compileToV0Message(lookupTableAccounts));
    tx.sign([agent]);
    return tx;
  })() : rogue), 'confirmed');
  console.log('  ❌ EXECUTED — enforcement failed');
  process.exitCode = 1;
} catch (e) {
  const msg = (e as { logs?: string[] }).logs?.find((l) => l.includes('Error')) ?? (e as Error).message;
  console.log(`  ✅ execution rejected on-chain: ${msg.slice(0, 160)}`);
}
try {
  await post('/api/guard/finalize', { multisig: setup.multisig, agent: agent.publicKey.toBase58(), transactionIndex: Number(index) });
} catch (e) {
  console.log(`  ✅ Sentinel also refuses to finalize: ${(e as Error).message}`);
}
console.log(`  vault still holds ${await sol(vault)} SOL`);

step('6. Owner revokes the agent (owner-side kill-switch)');
const revoke = await post('/api/guard/revoke', { multisig: setup.multisig, owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58() });
console.log(`  tx ${await send(revoke.transaction, owner)}`);
try {
  await post('/api/guard/execute', { multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), sol: 0.01 }, policy });
  console.log('  ❌ revoked agent could still propose');
  process.exitCode = 1;
} catch (e) {
  console.log(`  ✅ revoked agent is locked out: ${(e as Error).message}`);
}
const after = await post('/api/guard/status', { multisig: setup.multisig });
console.log(`  members now: ${after.members.map((m: any) => m.role).join(', ')}`);
