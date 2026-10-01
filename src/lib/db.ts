import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Persistence for everything that must outlive a serverless instance.
 * Postgres (Neon over HTTP) when DATABASE_URL is set; in-memory otherwise, for local development.
 */

let client: NeonQueryFunction<false, false> | null | undefined;
let schemaReady: Promise<void> | undefined;

function sqlClient() {
  if (client === undefined) client = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
  return client;
}

export const dbEnabled = () => !!sqlClient();

async function db() {
  const sql = sqlClient();
  if (!sql) return null;
  schemaReady ??= migrate(sql).catch((e) => {
    schemaReady = undefined; // retry on the next call
    throw e;
  });
  await schemaReady;
  return sql;
}

async function migrate(sql: NeonQueryFunction<false, false>) {
  await sql`CREATE TABLE IF NOT EXISTS decisions (
    id uuid PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, wallet text NOT NULL,
    summary text NOT NULL, decision text NOT NULL, enforced boolean NOT NULL, reasons jsonb NOT NULL, rules_version text NOT NULL)`;
  await sql`CREATE INDEX IF NOT EXISTS decisions_wallet_at ON decisions (wallet, at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS scan_cache (key text PRIMARY KEY, result jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS rate_limits (ip text PRIMARY KEY, window_start timestamptz NOT NULL, hits int NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS tg_subscriptions (
    multisig text NOT NULL, cluster text NOT NULL, chat_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (multisig, cluster, chat_id))`;
  await sql`CREATE TABLE IF NOT EXISTS freezes (
    multisig text NOT NULL, cluster text NOT NULL, reason text NOT NULL, frozen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (multisig, cluster))`;
}

// ---------------------------------------------------------------- decision journal

export interface JournalRow {
  id: string;
  at: string;
  kind: string;
  wallet: string;
  summary: string;
  decision: string;
  enforced: boolean;
  reasons: Array<{ id: string; action: string; message: string }>;
  rulesVersion: string;
}

const memJournal: JournalRow[] = [];

export async function journalInsert(row: JournalRow) {
  const sql = await db();
  if (!sql) {
    memJournal.unshift(row);
    memJournal.length = Math.min(memJournal.length, 500);
    return;
  }
  await sql`INSERT INTO decisions (id, at, kind, wallet, summary, decision, enforced, reasons, rules_version)
    VALUES (${row.id}, ${row.at}, ${row.kind}, ${row.wallet}, ${row.summary}, ${row.decision}, ${row.enforced}, ${JSON.stringify(row.reasons)}, ${row.rulesVersion})`;
}

export async function journalList(wallet: string | undefined, limit: number): Promise<JournalRow[]> {
  const sql = await db();
  if (!sql) return (wallet ? memJournal.filter((e) => e.wallet === wallet) : memJournal).slice(0, limit);
  const rows = wallet
    ? await sql`SELECT * FROM decisions WHERE wallet = ${wallet} ORDER BY at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM decisions ORDER BY at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.at).toISOString(),
    kind: r.kind,
    wallet: r.wallet,
    summary: r.summary,
    decision: r.decision,
    enforced: r.enforced,
    reasons: r.reasons,
    rulesVersion: r.rules_version,
  }));
}

// ---------------------------------------------------------------- scan cache (shared across instances)

export async function cacheGet<T>(key: string, ttlMs: number): Promise<T | null> {
  const sql = await db();
  if (!sql) return null;
  const rows = await sql`SELECT result FROM scan_cache WHERE key = ${key} AND at > now() - make_interval(secs => ${ttlMs / 1000})`;
  return (rows[0]?.result as T) ?? null;
}

export async function cacheSet(key: string, value: unknown) {
  const sql = await db();
  if (!sql) return;
  await sql`INSERT INTO scan_cache (key, result, at) VALUES (${key}, ${JSON.stringify(value)}, now())
    ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, at = now()`;
}

// ---------------------------------------------------------------- rate limit (fixed window per IP)

const memHits = new Map<string, { start: number; count: number }>();

/** Returns seconds to wait when over the limit, or 0 when the request may proceed. */
export async function rateLimitHit(ip: string, max: number, windowMs: number): Promise<number> {
  const sql = await db();
  if (!sql) {
    const now = Date.now();
    const h = memHits.get(ip);
    if (!h || now - h.start > windowMs) {
      memHits.set(ip, { start: now, count: 1 });
      if (memHits.size > 10_000) memHits.clear();
      return 0;
    }
    return ++h.count <= max ? 0 : Math.ceil((h.start + windowMs - now) / 1000);
  }
  const rows = await sql`INSERT INTO rate_limits (ip, window_start, hits) VALUES (${ip}, now(), 1)
    ON CONFLICT (ip) DO UPDATE SET
      hits = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowMs / 1000}) THEN 1 ELSE rate_limits.hits + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowMs / 1000}) THEN now() ELSE rate_limits.window_start END
    RETURNING hits, extract(epoch FROM (window_start + make_interval(secs => ${windowMs / 1000}) - now())) AS wait`;
  return rows[0].hits <= max ? 0 : Math.max(1, Math.ceil(Number(rows[0].wait)));
}

// ---------------------------------------------------------------- telegram subscriptions

const memSubs = new Set<string>();

export async function subscribe(multisig: string, cluster: string, chatId: number) {
  const sql = await db();
  if (!sql) return void memSubs.add(`${multisig}|${cluster}|${chatId}`);
  await sql`INSERT INTO tg_subscriptions (multisig, cluster, chat_id) VALUES (${multisig}, ${cluster}, ${chatId}) ON CONFLICT DO NOTHING`;
}

export async function unsubscribeChat(chatId: number) {
  const sql = await db();
  if (!sql) {
    for (const k of memSubs) if (k.endsWith(`|${chatId}`)) memSubs.delete(k);
    return;
  }
  await sql`DELETE FROM tg_subscriptions WHERE chat_id = ${chatId}`;
}

export async function chatsFor(multisig: string, cluster: string): Promise<number[]> {
  const sql = await db();
  if (!sql) return [...memSubs].filter((k) => k.startsWith(`${multisig}|${cluster}|`)).map((k) => Number(k.split('|')[2]));
  const rows = await sql`SELECT chat_id FROM tg_subscriptions WHERE multisig = ${multisig} AND cluster = ${cluster}`;
  return rows.map((r) => Number(r.chat_id));
}

export async function walletsForChat(chatId: number): Promise<Array<{ multisig: string; cluster: string }>> {
  const sql = await db();
  if (!sql)
    return [...memSubs].filter((k) => k.endsWith(`|${chatId}`)).map((k) => ({ multisig: k.split('|')[0], cluster: k.split('|')[1] }));
  const rows = await sql`SELECT multisig, cluster FROM tg_subscriptions WHERE chat_id = ${chatId} ORDER BY created_at`;
  return rows.map((r) => ({ multisig: r.multisig, cluster: r.cluster }));
}

// ---------------------------------------------------------------- kill-switch freezes

const memFreezes = new Map<string, { reason: string; frozenAt: string }>();

export async function freezeGet(multisig: string, cluster: string): Promise<{ reason: string; frozenAt: string } | null> {
  const sql = await db();
  if (!sql) return memFreezes.get(`${multisig}|${cluster}`) ?? null;
  const rows = await sql`SELECT reason, frozen_at FROM freezes WHERE multisig = ${multisig} AND cluster = ${cluster}`;
  return rows[0] ? { reason: rows[0].reason, frozenAt: new Date(rows[0].frozen_at).toISOString() } : null;
}

export async function freezeSet(multisig: string, cluster: string, reason: string) {
  const sql = await db();
  if (!sql) return void memFreezes.set(`${multisig}|${cluster}`, { reason, frozenAt: new Date().toISOString() });
  await sql`INSERT INTO freezes (multisig, cluster, reason) VALUES (${multisig}, ${cluster}, ${reason}) ON CONFLICT DO NOTHING`;
}

export async function freezeClear(multisig: string, cluster: string) {
  const sql = await db();
  if (!sql) return void memFreezes.delete(`${multisig}|${cluster}`);
  await sql`DELETE FROM freezes WHERE multisig = ${multisig} AND cluster = ${cluster}`;
}
