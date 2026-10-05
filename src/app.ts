import cors from '@fastify/cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASTION_RULES_VERSION, checkTransaction } from './bastion/index.js';
import { DEFAULT_POLICY, PolicyError, resolvePolicy } from './bastion/policy.js';
import { decodeTransaction, TxInputError } from './bastion/simulate.js';
import { config, ConfigError } from './config.js';
import { execute, IntentError } from './gateway/execute.js';
import { list, record } from './gateway/journal.js';
import { approveProposal, describeProposal, rejectProposal, relaySigned } from './guard/approval.js';
import { approver, GuardError, guardFinalize, guardStatus, revokeAgent, setupGuard } from './guard/index.js';
import { unfreezeMessage, unfreezeWallet } from './guard/freeze.js';
import { guardExecuteAndReport } from './guard/service.js';
import { currentCluster, parseCluster, withCluster } from './lib/cluster.js';
import { handleUpdate, send, telegramEnabled, webhookAuthorized } from './notify/telegram.js';
import { chatsFor, dbEnabled, rateLimitHit, usageRecord } from './lib/db.js';
import { enterUsage, setUsageTool, type UsageContext } from './lib/usage.js';
import { createMcpServer } from './mcp/server.js';
import { RULES_VERSION, scanToken } from './scan/index.js';
import { ScanInputError, type ScanResult } from './scan/types.js';

/** Per-IP budget for endpoints that spend Helius credits. Shared across instances via Postgres. */
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

async function rateLimited(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const ip = String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim();
  // Fail open: an unreachable store must not take the API down with it.
  const wait = await rateLimitHit(ip, RATE_LIMIT.max, RATE_LIMIT.windowMs).catch(() => 0);
  if (!wait) return false;
  reply.code(429).header('retry-after', wait).send({ error: 'Too many requests, try again in a minute' });
  return true;
}

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://www.santinelguard.online';
/** Shipped next to the function (vercel.json includeFiles); read once per container. */
let reportPage: Promise<string> | undefined;
const loadReportPage = () => (reportPage ??= readFile(join(process.cwd(), 'public', 'scan.html'), 'utf8'));
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** JSON inside a <script>: no way to close the tag or break the line from the data. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function reportMeta(mint: string, scan: ScanResult | null) {
  const url = `${PUBLIC_URL}/scan/${mint}`;
  const verdict = scan ? { allow: 'Allow', warn: 'Caution', block: 'Block' }[scan.verdict] : null;
  const name = scan ? `${scan.name ?? 'Unknown token'}${scan.symbol ? ` ($${scan.symbol})` : ''}` : 'Token report';
  const title = scan ? `${name} · Sentinel score ${scan.score}/100 · ${verdict}` : 'Token report · Sentinel';
  const lead = scan ? (scan.criticalFlags[0]?.message ?? scan.flags.find((f) => f.severity === 'warn')?.message ?? 'No serious risk flags.') : '';
  const description = scan
    ? `${lead.replace(/[.!]?$/, '.')} Holders, launch, liquidity, market and authorities, scored by Sentinel.`
    : 'Deep risk analysis of a Solana token: creator, holders, launch, liquidity, market and authorities.';
  const t = escapeHtml(title), d = escapeHtml(description);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Sentinel" />',
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${PUBLIC_URL}/og.png" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:site" content="@Sent1nelAgency" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${PUBLIC_URL}/og.png" />`,
  ].join('\n');
}

function sendError(req: FastifyRequest, reply: FastifyReply, e: unknown) {
  if (e instanceof ScanInputError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof IntentError || e instanceof PolicyError || e instanceof TxInputError) return reply.code(400).send({ error: e.message });
  if (e instanceof GuardError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof ConfigError) return reply.code(503).send({ error: `Service not configured: ${e.message}` });
  req.log.error(e, 'request failed');
  return reply.code(502).send({ error: 'Data source unavailable, please try again' });
}

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 256 * 1024, trustProxy: true });
  await app.register(cors, { origin: true });

  // Usage metrics: one counter row per request (channel, tool, errors, latency, Helius calls).
  const UNTRACKED = new Set(['/api/health', '/api/policy/default']);
  app.addHook('onRequest', (req, _reply, done) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || UNTRACKED.has(path)) return done();
    const channel = path.startsWith('/api/mcp') ? 'mcp' : path.startsWith('/api/telegram') ? 'telegram' : /Mozilla/.test(String(req.headers['user-agent'])) ? 'web' : 'api';
    const ctx: UsageContext = { channel, tool: req.routeOptions.url ?? path, helius: 0, started: Date.now() };
    (req as FastifyRequest & { usage?: UsageContext }).usage = ctx;
    enterUsage(ctx);
    done();
  });
  const flushUsage = (req: FastifyRequest, status: number) => {
    const ctx = (req as FastifyRequest & { usage?: UsageContext }).usage;
    if (!ctx) return Promise.resolve();
    return usageRecord({ channel: ctx.channel, tool: ctx.tool, error: status >= 500, helius: ctx.helius, ms: Date.now() - ctx.started }).catch(() => {});
  };
  app.addHook('onResponse', async (req, reply) => {
    if (!reply.sent || req.url.startsWith('/api/mcp')) return; // MCP replies are hijacked and flushed by the route
    await flushUsage(req, reply.statusCode);
  });

  app.get('/api/health', async () => ({
    ok: config.heliusConfigured,
    heliusConfigured: config.heliusConfigured,
    database: dbEnabled(),
    telegram: telegramEnabled(),
    rules: { scan: RULES_VERSION, bastion: BASTION_RULES_VERSION },
  }));
  app.get('/api/policy/default', async () => DEFAULT_POLICY);

  // Report page: the scan is embedded so the page renders at once and link previews show the score.
  app.get<{ Params: { mint: string } }>('/scan/:mint', async (req, reply) => {
    const mint = req.params.mint.trim();
    let html: string;
    try {
      html = await loadReportPage();
    } catch {
      return reply.redirect(`/scan.html?mint=${encodeURIComponent(mint)}`);
    }
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim();
    const limited = await rateLimitHit(ip, RATE_LIMIT.max, RATE_LIMIT.windowMs).catch(() => 0);
    const scan = limited ? null : await withCluster('mainnet', () => scanToken(mint)).catch(() => null);
    const head = html.slice(0, html.indexOf('<!--META-->')) + reportMeta(mint, scan) + html.slice(html.indexOf('<!--/META-->') + '<!--/META-->'.length);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=0, s-maxage=60')
      .send(head.replace('/*__SCAN__*/null', scriptJson(scan)));
  });

  app.get<{ Params: { mint: string } }>('/api/scan/:mint', async (req, reply) => {
    if (await rateLimited(req, reply)) return;
    try {
      const result = await scanToken(req.params.mint.trim());
      req.log.info({ mint: result.mint, score: result.score, verdict: result.verdict, ms: result.durationMs, cached: result.cached }, 'scan');
      return result;
    } catch (e) {
      return sendError(req, reply, e);
    }
  });

  app.post<{ Body: { transaction?: string; wallet?: string; policy?: unknown } }>('/api/bastion/check', async (req, reply) => {
    if (await rateLimited(req, reply)) return;
    try {
      const { transaction, wallet, policy } = req.body ?? {};
      if (typeof transaction !== 'string') throw new TxInputError('transaction: base64 of a serialized transaction');
      const resolved = resolvePolicy(policy);
      const result = await checkTransaction(decodeTransaction(transaction), resolved, wallet);
      const entry = await record({
        kind: 'check',
        wallet: result.wallet,
        summary: `transaction check: ${result.changes.sol} SOL, ${result.changes.tokens.length} token(s)`,
        decision: result.decision,
        enforced: result.enforced,
        reasons: result.reasons,
        rulesVersion: result.rulesVersion,
      });
      return { ...result, journalId: entry.id };
    } catch (e) {
      return sendError(req, reply, e);
    }
  });

  app.post<{ Body: { intent?: unknown; policy?: unknown } }>('/api/execute', async (req, reply) => {
    if (await rateLimited(req, reply)) return;
    try {
      const result = await execute(req.body?.intent, resolvePolicy(req.body?.policy));
      req.log.info({ intent: result.intent.type, decision: result.decision, ms: result.durationMs }, 'execute');
      return result;
    } catch (e) {
      return sendError(req, reply, e);
    }
  });

  app.get<{ Querystring: { wallet?: string; limit?: string } }>('/api/journal', async (req, reply) => {
    try {
      return await list(req.query.wallet, Math.min(200, Number(req.query.limit ?? 50) || 50));
    } catch (e) {
      return sendError(req, reply, e);
    }
  });

  // ---- Guard: on-chain enforcement through a Squads multisig where Sentinel holds the only non-owner vote.
  type GuardBody = Record<string, unknown> & { cluster?: unknown };
  const guardRoute = (path: string, handler: (body: GuardBody) => Promise<unknown>) =>
    app.post<{ Body: GuardBody }>(path, async (req, reply) => {
      if (await rateLimited(req, reply)) return;
      try {
        const body = req.body ?? {};
        return await withCluster(parseCluster(body.cluster), () => handler(body));
      } catch (e) {
        return sendError(req, reply, e);
      }
    });

  app.get('/api/guard/sentinel', async (_req, reply) => {
    try {
      return { sentinel: approver().publicKey.toBase58(), permissions: ['vote'] };
    } catch (e) {
      return sendError(_req, reply, e);
    }
  });
  guardRoute('/api/guard/setup', (b) => setupGuard({ owner: b.owner, agent: b.agent, fundSol: b.fundSol }));
  guardRoute('/api/guard/status', (b) => guardStatus(b.multisig));
  guardRoute('/api/guard/execute', (b) => guardExecuteAndReport(b.multisig, b.intent, resolvePolicy(b.policy)));
  guardRoute('/api/guard/finalize', (b) => guardFinalize(b.multisig, b.agent, b.transactionIndex));
  guardRoute('/api/guard/revoke', (b) => revokeAgent(b.multisig, b.owner, b.agent));
  guardRoute('/api/guard/proposal', (b) => describeProposal(b.multisig, b.transactionIndex));
  guardRoute('/api/guard/approve', (b) => approveProposal(b.multisig, b.transactionIndex, b.owner));
  guardRoute('/api/guard/reject', (b) => rejectProposal(b.multisig, b.transactionIndex, b.owner));
  guardRoute('/api/guard/send', (b) => relaySigned(b.transaction));
  guardRoute('/api/guard/unfreeze-message', async (b) => {
    const timestamp = Date.now();
    return { timestamp, message: unfreezeMessage(String(b.multisig), currentCluster(), timestamp) };
  });
  guardRoute('/api/guard/unfreeze', async (b) => {
    const result = await unfreezeWallet({ multisig: b.multisig, owner: b.owner, timestamp: b.timestamp, signature: b.signature });
    await record({ kind: 'unfreeze', wallet: result.multisig, summary: 'owner lifted the kill-switch freeze', decision: 'allow', enforced: true, reasons: [], rulesVersion: BASTION_RULES_VERSION });
    for (const chat of await chatsFor(result.multisig, currentCluster()).catch(() => [] as number[]))
      await send(chat, `✅ <b>Wallet unfrozen</b> by the owner. Sentinel will review new transactions again.`).catch(() => {});
    return result;
  });

  // MCP (Streamable HTTP, stateless): a fresh server + transport per request, which suits serverless.
  app.post('/api/mcp', async (req, reply) => {
    if (await rateLimited(req, reply)) return;
    const rpc = req.body as { method?: string; params?: { name?: string } } | undefined;
    setUsageTool(rpc?.method === 'tools/call' ? `mcp:${rpc.params?.name}` : `mcp:${rpc?.method ?? 'unknown'}`);
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void flushUsage(req, reply.raw.statusCode);
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      req.log.error(e, 'mcp request failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  });
  // Stateless server: no SSE stream to resume and no session to delete.
  app.get('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  app.delete('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  // Telegram webhook: authenticated by the secret token Telegram echoes back on every call.
  app.post<{ Body: Record<string, unknown> }>('/api/telegram/webhook', async (req, reply) => {
    if (!webhookAuthorized(req.headers['x-telegram-bot-api-secret-token'])) return reply.code(401).send({ error: 'unauthorized' });
    try {
      await handleUpdate(req.body as never, (ms, cluster) =>
        withCluster(cluster, async () => {
          try {
            const status = await guardStatus(ms);
            return status.members.some((m) => m.role === 'sentinel') ? { ok: true } : { ok: false, error: 'Sentinel is not part of this wallet' };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        }),
      );
    } catch (e) {
      req.log.error(e, 'telegram update failed');
    }
    return { ok: true }; // always 200, or Telegram retries the same update forever
  });

  return app;
}
