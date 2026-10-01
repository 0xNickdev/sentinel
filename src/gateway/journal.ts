import { randomUUID } from 'node:crypto';
import { journalInsert, journalList, type JournalRow } from '../lib/db.js';

export type JournalEntry = JournalRow & { kind: 'execute' | 'check' | 'freeze' | 'unfreeze' };

/**
 * Decision log: every verdict with its reason and rules version, so the owner can see why the wallet said no.
 * Stored in Postgres when configured. A failing write must never block a decision, so errors are only logged.
 */
export async function record(entry: Omit<JournalEntry, 'id' | 'at'>): Promise<JournalEntry> {
  const full = { id: randomUUID(), at: new Date().toISOString(), ...entry };
  await journalInsert(full).catch((e) => console.error('journal write failed', e));
  return full;
}

export const list = (wallet?: string, limit = 50) => journalList(wallet, limit);
