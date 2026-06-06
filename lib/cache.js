import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.pkgstory-cache');

export class Cache {
  constructor({ dir = DEFAULT_CACHE_DIR, ttlMs = DEFAULT_TTL_MS, enabled = true } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.enabled = enabled;
    if (this.enabled) fs.mkdirSync(this.dir, { recursive: true });
  }

  _path(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.dir, `${hash}.json`);
  }

  get(key) {
    if (!this.enabled) return null;
    try {
      const raw = fs.readFileSync(this._path(key), 'utf8');
      const entry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > entry.ttlMs) {
        try { fs.unlinkSync(this._path(key)); } catch {}
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  set(key, data, ttlMs) {
    if (!this.enabled) return;
    try {
      fs.writeFileSync(this._path(key), JSON.stringify({
        key, timestamp: Date.now(), ttlMs: ttlMs ?? this.ttlMs, data,
      }), 'utf8');
    } catch {}
  }
}
