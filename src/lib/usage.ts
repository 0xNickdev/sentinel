import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request usage: which channel and tool was called and how many Helius requests it cost. */
export interface UsageContext {
  channel: 'mcp' | 'web' | 'api' | 'telegram';
  tool: string;
  helius: number;
  started: number;
}

const store = new AsyncLocalStorage<UsageContext>();

export const enterUsage = (ctx: UsageContext) => store.enterWith(ctx);
export const currentUsage = () => store.getStore();

/** Called by the RPC client for every Helius request made while serving the current request. */
export function countHelius(n = 1) {
  const ctx = store.getStore();
  if (ctx) ctx.helius += n;
}

/** Lets a handler name the tool more precisely than the route (MCP tool, Telegram command). */
export function setUsageTool(tool: string) {
  const ctx = store.getStore();
  if (ctx) ctx.tool = tool;
}
