import { createHash, timingSafeEqual } from 'node:crypto';
import { currentCluster, withCluster, type Cluster } from '../lib/cluster.js';
import { chatsFor, subscribe, unsubscribeChat, walletsForChat } from '../lib/db.js';
import { fetchJson } from '../lib/http.js';
import { setUsageTool } from '../lib/usage.js';
import { scanToken } from '../scan/index.js';

/**
 * Telegram: owner alerts with action buttons, plus a free token checker for the community.
 * Every button opens a Sentinel page where the owner signs with their own wallet; the bot never holds keys.
 */

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://www.santinelguard.online';
const token = () => process.env.TELEGRAM_BOT_TOKEN;
export const telegramEnabled = () => !!token();

/** Telegram echoes this in X-Telegram-Bot-Api-Secret-Token, proving a webhook call really comes from Telegram. */
export const webhookSecret = () => createHash('sha256').update(`sentinel-webhook:${token()}`).digest('hex').slice(0, 48);

export function webhookAuthorized(header: unknown) {
  if (!token() || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

type Button = { text: string; url: string };

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetchJson<{ ok: boolean; result: T; description?: string }>(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 8000,
    label: `telegram ${method}`,
  });
  if (!res.ok) throw new Error(`telegram ${method}: ${res.description}`);
  return res.result;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export async function send(chatId: number, html: string, buttons: Button[] = []) {
  if (!token()) return;
  await tg('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : {}),
  });
}

let botUsername: string | undefined;
export async function botLink(ms: string) {
  if (!token()) return null;
  botUsername ??= process.env.TELEGRAM_BOT_USERNAME ?? (await tg<{ username: string }>('getMe', {})).username;
  return `https://t.me/${botUsername}?start=${ms}${currentCluster() === 'devnet' ? '_d' : ''}`;
}

const pageUrl = (params: Record<string, string>) => {
  const q = new URLSearchParams({ ...params, ...(currentCluster() === 'devnet' ? { cluster: 'devnet' } : {}) });
  return `${PUBLIC_URL}/approve.html?${q}`;
};

// ---------------------------------------------------------------- owner alerts

export interface GuardEvent {
  multisig: string;
  vault: string;
  agent: string;
  decision: string;
  summary: string;
  reasons: Array<{ action: string; message: string }>;
  approvalUrl: string | null;
}

/** Alerts everyone linked to this wallet. Allowed trades stay quiet; only what needs the owner is sent. */
export async function notifyGuardEvent(e: GuardEvent) {
  if (!token() || e.decision === 'allow') return;
  const chats = await chatsFor(e.multisig, currentCluster());
  if (!chats.length) return;
  const why = e.reasons
    .filter((r) => r.action !== 'note')
    .slice(0, 3)
    .map((r) => `• ${esc(r.message)}`)
    .join('\n');
  const wallet = `<code>${short(e.vault)}</code>${currentCluster() === 'devnet' ? ' (devnet)' : ''}`;
  let text: string;
  let buttons: Button[] = [];
  if (e.decision === 'confirm') {
    text = `⏸ <b>Your agent needs approval</b>\nWallet ${wallet}\n${esc(e.summary)}\n\n${why}`;
    if (e.approvalUrl) buttons = [{ text: 'Review & approve', url: e.approvalUrl }];
  } else if (e.decision === 'freeze') {
    text = `🛑 <b>Kill-switch: wallet frozen</b>\nWallet ${wallet}\n${esc(e.summary)}\n\n${why}\n\nSentinel will not approve anything until you unfreeze it.`;
    buttons = [
      { text: 'Unfreeze', url: pageUrl({ action: 'unfreeze', ms: e.multisig }) },
      { text: 'Revoke agent', url: pageUrl({ action: 'revoke', ms: e.multisig, agent: e.agent }) },
    ];
  } else {
    text = `⛔ <b>Blocked</b>\nWallet ${wallet}\n${esc(e.summary)}\n\n${why}`;
  }
  await Promise.allSettled(chats.map((c) => send(c, text, buttons)));
}

// ---------------------------------------------------------------- bot commands (webhook)

interface Update {
  message?: { chat: { id: number }; text?: string };
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERDICT: Record<string, string> = { allow: '✅ Allowed', warn: '⚠️ Caution', block: '⛔ Blocked' };

export async function handleUpdate(update: Update, linkWallet: (ms: string, cluster: Cluster) => Promise<{ ok: boolean; error?: string }>) {
  const msg = update.message;
  if (!msg?.text) return;
  const chat = msg.chat.id;
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const arg = args[0] ?? '';
  setUsageTool(`telegram:${cmd.startsWith('/') ? cmd.slice(1) : 'check'}`);

  if (cmd === '/start' && arg) {
    const [ms, flag] = arg.split('_');
    const cluster: Cluster = flag === 'd' ? 'devnet' : 'mainnet';
    if (!ADDRESS.test(ms)) return send(chat, 'That link is broken. Open it again from the Sentinel setup screen.');
    const res = await linkWallet(ms, cluster);
    if (!res.ok) return send(chat, `Could not link this wallet: ${esc(res.error ?? 'unknown error')}`);
    await subscribe(ms, cluster, chat);
    return send(chat, `🛡 <b>Linked</b>\nYou'll get alerts for guarded wallet <code>${short(ms)}</code>${cluster === 'devnet' ? ' (devnet)' : ''}: approvals, blocks and kill-switch freezes.\n\n/status to check it, /stop to unlink.`);
  }
  if (cmd === '/start' || cmd === '/help') {
    return send(
      chat,
      [
        '🛡 <b>Welcome to Sentinel</b>',
        'Risk checks for Solana tokens, built for AI agents and the people who run them.',
        '',
        '<b>Check a token</b>',
        'Paste a token address or send /check &lt;CA&gt;. In a few seconds you get a 0-100 score, a verdict and the main red flags.',
        '',
        '<b>Owner alerts</b>',
        'If your agent trades from a guarded wallet, open the Telegram link from the wallet setup. Approvals, blocks and kill-switch freezes will arrive in this chat.',
        '',
        '/status linked wallets · /stop unlink this chat',
      ].join('\n'),
      [{ text: 'Open Sentinel', url: PUBLIC_URL }],
    );
  }
  if (cmd === '/stop') {
    await unsubscribeChat(chat);
    return send(chat, 'Unlinked. You will no longer get alerts here.');
  }
  if (cmd === '/status') {
    const wallets = await walletsForChat(chat);
    if (!wallets.length) return send(chat, 'No wallets linked to this chat yet.');
    return send(chat, `Linked wallets:\n${wallets.map((w) => `• <code>${short(w.multisig)}</code>${w.cluster === 'devnet' ? ' (devnet)' : ''}`).join('\n')}`);
  }
  // /check <CA>, or just a pasted address
  const ca = cmd === '/check' ? arg : ADDRESS.test(cmd) ? cmd : '';
  if (cmd === '/check' && !ca) return send(chat, 'Send /check followed by a token address.');
  if (!ca) return send(chat, 'Send a token address to check it, or /help.');
  try {
    const r = await withCluster('mainnet', () => scanToken(ca));
    const flags = [...r.flags]
      .sort((a, b) => ['critical', 'warn', 'info'].indexOf(a.severity) - ['critical', 'warn', 'info'].indexOf(b.severity))
      .slice(0, 4)
      .map((f) => `${f.severity === 'critical' ? '🔴' : f.severity === 'warn' ? '🟠' : '⚪️'} ${esc(f.message)}`)
      .join('\n');
    return send(
      chat,
      `${VERDICT[r.verdict]} · <b>${r.score}/100</b>\n${esc(r.name ?? 'Unknown')}${r.symbol ? ` · ${esc(r.symbol)}` : ''}\n<code>${r.mint}</code>\n\n${flags || 'No flags found.'}\n\n<i>${esc(r.disclaimer)}</i>`,
      [{ text: 'Full report', url: `${PUBLIC_URL}/scan/${r.mint}` }],
    );
  } catch (e) {
    return send(chat, `Could not check that token: ${esc((e as Error).message)}`);
  }
}

export const registerWebhook = (url: string) =>
  tg('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: true });
