export class Semaphore {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.running = 0;
  }

  async run(fn) {
    await this._acquire();
    try { return await fn(); } finally { this._release(); }
  }

  _acquire() {
    if (this.running < this.concurrency) { this.running++; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(resolve));
  }

  _release() {
    this.running--;
    const next = this.queue.shift();
    if (next) { this.running++; next(); }
  }
}

export async function fetchWithRetry(url, opts = {}) {
  const { timeoutMs = 30_000, retries = 2, ...fetchOpts } = opts;
  let lastErr;
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
      if (attempt < retries) await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDownloads(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatDays(days) {
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const y = Math.floor(days / 365);
  const m = Math.round((days % 365) / 30);
  return m > 0 ? `${y}y ${m}mo` : `${y}y`;
}

export function toDateString(d) {
  return d.toISOString().slice(0, 10);
}

/** Split date range into ≤18-month chunks (npm downloads API limit). */
export function chunkDateRange(start, end) {
  const FLOOR = new Date('2015-01-10');
  const effectiveStart = start < FLOOR ? FLOOR : start;
  if (effectiveStart >= end) return [];

  const chunks = [];
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

/** Sum daily downloads in window [windowStart, windowEnd). */
export function sumDownloadsInWindow(downloads, windowStart, windowEnd) {
  return downloads.reduce((sum, d) => {
    if (d.day >= windowStart && (windowEnd === null || d.day < windowEnd)) {
      return sum + d.downloads;
    }
    return sum;
  }, 0);
}

export function parseGitHubUrl(url) {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

export function semverMajor(v) {
  return parseInt(v.split('.')[0] ?? '0', 10);
}
