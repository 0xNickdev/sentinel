/** Usage report from Postgres: calls, errors, latency and Helius cost per channel and tool.  npm run usage [-- days] */
import '../src/config.js';
import { usageReport } from '../src/lib/db.js';

const days = Number(process.argv[2] ?? 7);
const rows = (await usageReport(days)) as Array<{ day: string; channel: string; tool: string; calls: number; errors: number; helius: number; ms_total: number }>;
if (!rows.length) {
  console.log('No usage recorded yet (is DATABASE_URL set?)');
  process.exit(0);
}
const totals = { calls: 0, helius: 0, errors: 0 };
console.log(`Last ${days} day(s)\n`);
console.log('day         channel   tool                               calls  errors  avg ms  helius  helius/call');
for (const r of rows) {
  totals.calls += r.calls; totals.helius += r.helius; totals.errors += r.errors;
  console.log(`${r.day}  ${r.channel.padEnd(8)}  ${r.tool.padEnd(33)}  ${String(r.calls).padStart(5)}  ${String(r.errors).padStart(6)}  ${String(Math.round(r.ms_total / r.calls)).padStart(6)}  ${String(r.helius).padStart(6)}  ${(r.helius / r.calls).toFixed(1).padStart(11)}`);
}
console.log(`\ntotal: ${totals.calls} calls, ${totals.errors} errors, ${totals.helius} Helius requests`);
