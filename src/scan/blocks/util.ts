import type { BlockId, BlockResult, Flag, Severity } from '../types.js';

/** 1 at `good`, 0 at `bad`, linear in between (works for either direction). */
export const lin = (x: number, good: number, bad: number) => {
  const t = (x - bad) / (good - bad);
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

export const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
export const round1 = (n: number) => Math.round(n * 10) / 10;

export class BlockBuilder {
  score = 0;
  status: BlockResult['status'] = 'ok';
  details: Record<string, unknown> = {};
  flags: Flag[] = [];
  constructor(public id: BlockId, public label: string, public weight: number) {}

  flag(id: string, severity: Severity, message: string) {
    this.flags.push({ id, severity, message });
    return this;
  }

  build(): BlockResult {
    const score = Math.max(0, Math.min(this.weight, Math.round(this.score * 10) / 10));
    return { id: this.id, label: this.label, weight: this.weight, score, status: this.status, details: this.details, flags: this.flags };
  }
}
