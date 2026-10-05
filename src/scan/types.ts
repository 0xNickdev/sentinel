export type Severity = 'critical' | 'warn' | 'info';

export interface Flag {
  id: string;
  severity: Severity;
  message: string;
}

export type BlockId = 'creator' | 'holders' | 'launch' | 'rights' | 'liquidity' | 'market' | 'metadata';

export interface BlockResult {
  id: BlockId;
  label: string;
  weight: number;
  score: number;
  /** partial = some inputs missing, error = collector failed and got a neutral score */
  status: 'ok' | 'partial' | 'error';
  details: Record<string, unknown>;
  flags: Flag[];
}

export type Verdict = 'allow' | 'warn' | 'block';

export interface ScanResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  /** Token image from its metadata, when it has one. Untrusted URL. */
  image: string | null;
  score: number;
  verdict: Verdict;
  risk: 'low' | 'medium' | 'high';
  criticalFlags: Flag[];
  flags: Flag[];
  blocks: BlockResult[];
  rulesVersion: string;
  scannedAt: string;
  durationMs: number;
  cached: boolean;
  disclaimer: string;
}

export class ScanInputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
