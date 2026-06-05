import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.pkg-observatory-cache');

interface CacheEntry<T> {
  key: string;
  timestamp: number;
  ttlMs: number;
  data: T;
}

export class Cache {
  private dir: string;
  private ttlMs: number;
  private enabled: boolean;

  constructor(opts: { dir?: string; ttlMs?: number; enabled?: boolean } = {}) {
    this.dir = opts.dir ?? DEFAULT_CACHE_DIR;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.enabled = opts.enabled ?? true;

    if (this.enabled) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private keyToPath(key: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.dir, `${hash}.json`);
  }

  get<T>(key: string): T | null {
    if (!this.enabled) return null;
    const p = this.keyToPath(key);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      const age = Date.now() - entry.timestamp;
      if (age > entry.ttlMs) {
        fs.unlinkSync(p);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    if (!this.enabled) return;
    const entry: CacheEntry<T> = {
      key,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.ttlMs,
      data,
    };
    const p = this.keyToPath(key);
    fs.writeFileSync(p, JSON.stringify(entry), 'utf8');
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    if (!fs.existsSync(this.dir)) return;
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.json')) {
        fs.unlinkSync(path.join(this.dir, f));
      }
    }
  }
}
