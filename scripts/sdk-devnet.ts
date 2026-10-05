/** SDK round trip on devnet against the hosted gateway: setup a guarded wallet, then guard.run() moves funds. */
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';
import { Sentinel } from '../sdk/dist/index.js';

const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');
const owner = Keypair.fromSecretKey(bs58.decode(process.env.OWNER_SECRET!));
const agent = Keypair.generate();
const sentinel = new Sentinel({ baseUrl: process.env.API ?? 'https://www.santinelguard.online', cluster: 'devnet', policy: { limits: { per_tx_sol: 0.03 }, recipients: [owner.publicKey.toBase58()] } });

await conn.confirmTransaction(await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })), [owner]), 'confirmed');
const setup = await sentinel.guard.setup({ owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58(), fundSol: 0.06 });
const tx = VersionedTransaction.deserialize(Buffer.from(setup.transaction, 'base64')); tx.sign([owner]);
await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed');
console.log('guard.setup →', setup.vault, '| telegram:', setup.telegramLink ? 'link ✅' : 'none');

const ok = await sentinel.guard.run({ multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), sol: 0.02 } }, agent, conn);
console.log(`guard.run(0.02 to owner) → ${ok.decision}, executed=${ok.executed}, ${ok.signatures.length} tx`, ok.executed ? '✅' : '❌');
const no = await sentinel.guard.run({ multisig: setup.multisig, intent: { type: 'transfer', agent: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), sol: 0.035 } }, agent, conn);
console.log(`guard.run(0.035, over limit) → ${no.decision}, executed=${no.executed}`, !no.executed ? '✅ nothing signed' : '❌', '|', no.reasons[0]?.message);
console.log('guard.status →', (await sentinel.guard.status(setup.multisig)).vaultSol, 'SOL left');
const scan = await sentinel.scan('739dnZEG4yaBWFsY8L8ZwrfhGG6dhtCSercW8Umspump');
console.log('scan(CLAW) →', scan.score, scan.verdict);
try { await sentinel.scan('nope'); } catch (e) { console.log('scan(invalid) →', (e as Error).name, (e as any).status, '✅'); }
