export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Caps parallel requests so a single scan cannot blow through provider rate limits. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => {
      this.active--;
      this.queue.shift()?.();
    };
  }
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  gate?: Semaphore;
  /** Label used in error messages instead of the URL, so API keys never leak into logs. */
  label?: string;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 8000, retries = 2, gate, label = new URL(url).host, ...init } = opts;
  for (let attempt = 0; ; attempt++) {
    const release = gate ? await gate.acquire() : undefined;
    let retryable: HttpError | undefined;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return (await res.json()) as T;
      const body = (await res.text().catch(() => '')).slice(0, 400);
      const err = new HttpError(res.status, `${label}: HTTP ${res.status}`, body);
      if (res.status === 429 || res.status >= 500) retryable = err;
      else throw err;
    } finally {
      release?.();
    }
    if (attempt >= retries) throw retryable;
    await sleep(350 * 2 ** attempt);
  }
}
