export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private concurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

export async function fetchWithRetry(
  url: string,
  opts: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30_000, retries = 2, ...fetchOpts } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDownloads(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatDays(days: number): string {
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const y = Math.floor(days / 365);
  const m = Math.round((days % 365) / 30);
  return m > 0 ? `${y}y ${m}mo` : `${y}y`;
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Split a date range into ≤18-month chunks (npm downloads API limit). */
export function chunkDateRange(
  start: Date,
  end: Date
): Array<{ start: string; end: string }> {
  const FLOOR = new Date('2015-01-10');
  const effectiveStart = start < FLOOR ? FLOOR : start;
  if (effectiveStart >= end) return [];

  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(effectiveStart);

  while (cursor < end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setMonth(chunkEnd.getMonth() + 18);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({ start: toDateString(cursor), end: toDateString(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return chunks;
}

/** Sum daily downloads between two dates (inclusive start, exclusive end). */
export function sumDownloadsInWindow(
  downloads: Array<{ day: string; downloads: number }>,
  windowStart: string,
  windowEnd: string | null
): number {
  return downloads.reduce((sum, d) => {
    if (d.day >= windowStart && (windowEnd === null || d.day < windowEnd)) {
      return sum + d.downloads;
    }
    return sum;
  }, 0);
}

/** Parse GitHub repo URL into {owner, repo} or null. */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

export function semverMajor(v: string): number {
  return parseInt(v.split('.')[0] ?? '0', 10);
}

export function semverMinor(v: string): number {
  return parseInt(v.split('.')[1] ?? '0', 10);
}

/** Sample versions intelligently when there are too many. */
export function sampleVersions(versions: string[], maxVersions: number): string[] {
  if (versions.length <= maxVersions) return versions;

  const keep = new Set<string>();

  // Always keep first and last
  keep.add(versions[0]);
  keep.add(versions[versions.length - 1]);

  // Keep all x.0.0 major releases
  for (const v of versions) {
    if (v.match(/^\d+\.0\.0$/)) keep.add(v);
  }

  // Keep last 20 versions
  for (const v of versions.slice(-20)) keep.add(v);

  if (keep.size >= maxVersions) {
    const sorted = versions.filter(v => keep.has(v));
    return sorted.slice(0, maxVersions);
  }

  // Fill remaining slots evenly
  const remaining = versions.filter(v => !keep.has(v));
  const slots = maxVersions - keep.size;
  const step = Math.ceil(remaining.length / slots);
  for (let i = 0; i < remaining.length && keep.size < maxVersions; i += step) {
    keep.add(remaining[i]);
  }

  return versions.filter(v => keep.has(v));
}
