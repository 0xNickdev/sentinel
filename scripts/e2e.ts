import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const API = process.env.API ?? 'http://127.0.0.1:8787';
const WALLET = 'GSiqvKLVGmTJ9UzautG4vE8vT3uSEoKZp3cGzSrb6ak6'; // public wallet, simulation only
const CLAW = '739dnZEG4yaBWFsY8L8ZwrfhGG6dhtCSercW8Umspump';
const RUG = 'CFgZyepFRMeBoJNvKw8X59RnD6KR3rdZhLKxGyimpump';
const stranger = Keypair.generate().publicKey.toBase58();

const post = async (path: string, body: unknown) => {
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const show = (title: string, r: { status: number; body: any }) => {
  const b = r.body;
  console.log(`\n■ ${title}  [HTTP ${r.status}]`);
  if (r.status !== 200) return console.log('  error:', b.error);
  const bs = b.bastion ?? b;
  console.log(`  decision: ${b.decision.toUpperCase()}  enforced=${b.enforced}  tx=${b.transaction === undefined ? '-' : b.transaction ? 'returned' : 'withheld'}  ${b.durationMs}ms`);
  if (bs?.changes) console.log(`  changes: ${bs.changes.sol} SOL, tokens ${JSON.stringify(bs.changes.tokens.map((t: any) => `${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} ${t.symbol}`))}  slippage=${bs.slippageBps}bps  spend=${bs.spend.txSol} SOL (24h ${bs.spend.day24hSol})`);
  if (bs?.programs) console.log(`  programs: ${bs.programs.map((p: any) => `${p.name ?? p.id}${p.allowed ? '' : ' ✗'}`).join(', ')}`);
  for (const r of b.reasons) console.log(`  - [${r.action}] ${r.message}`);
};

show('1. Swap into a clean token: buy $CLAW for 0.01 SOL', await post('/api/execute', { intent: { type: 'buy', wallet: WALLET, mint: CLAW, sol: 0.01 } }));
show('2. Buy a rugged token', await post('/api/execute', { intent: { type: 'buy', wallet: WALLET, mint: RUG, sol: 0.01 } }));
show('3. Transfer 0.1 SOL to a new address', await post('/api/execute', { intent: { type: 'transfer', wallet: WALLET, to: stranger, sol: 0.1 } }));
show('4. Injection: drain almost everything to a new address (0.5 SOL limit)', await post('/api/execute', { intent: { type: 'transfer', wallet: WALLET, to: stranger, sol: 0.75 }, policy: { limits: { per_tx_sol: 0.5 } } }));
show('5. Same in warn mode', await post('/api/execute', { intent: { type: 'transfer', wallet: WALLET, to: stranger, sol: 0.75 }, policy: { limits: { per_tx_sol: 0.5 }, mode: 'warn' } }));
show('6. Buy through a venue outside the allowlist (pump.fun only)', await post('/api/execute', { intent: { type: 'buy', wallet: WALLET, mint: CLAW, sol: 0.01 }, policy: { programs: ['pump.fun'] } }));

// 7. Drainer: raw tx approving a stranger to spend the wallet's CLAW, sent to /bastion/check
const ata = PublicKey.findProgramAddressSync(
  [new PublicKey(WALLET).toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), new PublicKey(CLAW).toBuffer()],
  new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
)[0];
const data = Buffer.alloc(9); data[0] = 4; data.writeBigUInt64LE(10n ** 15n, 1);
const approve = new TransactionInstruction({
  programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  keys: [{ pubkey: ata, isSigner: false, isWritable: true }, { pubkey: new PublicKey(stranger), isSigner: false, isWritable: false }, { pubkey: new PublicKey(WALLET), isSigner: true, isWritable: false }],
  data,
});
const msg = new TransactionMessage({ payerKey: new PublicKey(WALLET), recentBlockhash: '11111111111111111111111111111111', instructions: [approve] }).compileToV0Message();
show('7. Drainer: approve a stranger (raw transaction to /bastion/check)', await post('/api/bastion/check', { transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64') }));
show('8. Garbage instead of a transaction', await post('/api/bastion/check', { transaction: 'bm90IGEgdHg=' }));
show('9. Invalid intent', await post('/api/execute', { intent: { type: 'buy', wallet: WALLET } }));
const journal = await (await fetch(`${API}/api/journal?wallet=${WALLET}&limit=3`)).json();
console.log('\n■ Decision log (last 3):'); for (const e of journal as any[]) console.log(`  ${e.at.slice(11, 19)} ${e.decision.padEnd(7)} ${e.summary}  [${e.rulesVersion}]`);
