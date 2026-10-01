import { scanToken } from './scan/index.js';

const mints = process.argv.slice(2);
if (!mints.length) {
  console.error('usage: npm run scan -- <mint> [mint...]');
  process.exit(1);
}

for (const mint of mints) {
  try {
    const r = await scanToken(mint);
    console.log(`\n${r.name ?? '?'} (${r.symbol ?? '?'})  ${r.mint}`);
    console.log(`score ${r.score}/100 · verdict ${r.verdict.toUpperCase()} · ${r.durationMs} ms · ${r.rulesVersion}`);
    for (const b of r.blocks) {
      console.log(`  ${b.label.padEnd(20)} ${String(b.score).padStart(5)} / ${b.weight}  ${b.status !== 'ok' ? `[${b.status}]` : ''}`);
    }
    for (const f of r.flags) console.log(`  ${f.severity === 'critical' ? '⛔' : f.severity === 'warn' ? '⚠️ ' : 'ℹ️ '} ${f.message}`);
    if (process.env.VERBOSE) console.dir(r.blocks.map((b) => ({ [b.id]: b.details })), { depth: 4 });
  } catch (e) {
    console.error(`${mint}: ${e instanceof Error ? e.message : e}`);
  }
}
