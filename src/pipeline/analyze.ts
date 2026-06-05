import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { Cache } from '../cache.js';
import { fetchWithRetry, Semaphore } from '../utils.js';
import type { VersionMeta, TarballAnalysis, ModuleFormat, PipelineOptions } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tarModule = require('tar') as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Parser: new () => any;
};

interface TarEntry {
  path: string;
  size: number;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
  resume(): void;
}

function detectModuleFormat(meta: VersionMeta): ModuleFormat {
  const type = meta.packageType;
  const exp = meta.exports;

  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const str = JSON.stringify(exp);
    const hasCjs =
      str.includes('"require"') ||
      str.includes('.cjs') ||
      (str.includes('"main"') && type !== 'module');
    const hasEsm =
      str.includes('"import"') ||
      str.includes('.mjs') ||
      str.includes('"module"');
    if (hasCjs && hasEsm) return 'dual';
    if (hasEsm) return 'esm';
    if (hasCjs) return 'cjs';
  }

  if (type === 'module') return 'esm';
  if (!type || type === 'commonjs') return 'cjs';
  return 'unknown';
}

function countExports(source: string, format: ModuleFormat): number | null {
  try {
    let count = 0;
    if (format === 'esm' || format === 'dual') {
      const esmMatches = source.match(/^\s*export\s+(const|let|var|function|class|default|async\s+function|type|interface|enum)\s/gm);
      count += esmMatches?.length ?? 0;
      const reexports = source.match(/^\s*export\s+\{[^}]+\}/gm);
      if (reexports) {
        for (const m of reexports) {
          count += (m.match(/,/g)?.length ?? 0) + 1;
        }
      }
    } else {
      // CJS: count module.exports.X = or exports.X =
      const cjsMatches = source.match(/^\s*(module\.)?exports\.\w+\s*=/gm);
      count += cjsMatches?.length ?? 0;
    }
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

async function analyzeTarball(
  version: VersionMeta,
  cache: Cache
): Promise<TarballAnalysis> {
  const cacheKey = `tarball-analysis:${version.tarballUrl}`;
  const cached = cache.get<TarballAnalysis>(cacheKey);
  if (cached) return cached;

  const res = await fetchWithRetry(version.tarballUrl, { timeoutMs: 60_000, retries: 2 });
  if (!res.ok) throw new Error(`Failed to fetch tarball: ${res.status}`);

  const tarBuffer = Buffer.from(await res.arrayBuffer());
  const gzippedSize = tarBuffer.length;

  let unpackedSize = 0;
  let fileCount = 0;
  let hasDts = false;
  let exportedSymbolCount: number | null = null;
  const moduleFormat = detectModuleFormat(version);
  let mainFileSource = '';
  let mainFileFound = false;

  await new Promise<void>((resolve, reject) => {
    const parser = new tarModule.Parser();
    let ended = false;

    parser.on('entry', (entry: TarEntry) => {
      const entryPath: string = entry.path;
      const entrySize: number = entry.size ?? 0;

      if (entryPath.endsWith('.d.ts') || entryPath.endsWith('.d.mts') || entryPath.endsWith('.d.cts')) {
        hasDts = true;
      }

      fileCount++;
      unpackedSize += entrySize;

      const chunks: Buffer[] = [];
      const isMainJs = !mainFileFound && (
        entryPath.endsWith('/index.js') ||
        entryPath.endsWith('/index.mjs') ||
        entryPath.endsWith('/index.cjs') ||
        entryPath === 'package/index.js'
      ) && entrySize < 500_000;

      if (isMainJs) {
        mainFileFound = true;
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          mainFileSource = Buffer.concat(chunks).toString('utf8');
        });
      } else {
        entry.resume();
      }
    });

    parser.on('end', () => { if (!ended) { ended = true; resolve(); } });
    parser.on('finish', () => { if (!ended) { ended = true; resolve(); } });

    const gunzip = createGunzip();
    gunzip.on('error', reject);
    parser.on('error', (e: Error) => reject(e));
    gunzip.on('data', (chunk: Buffer) => parser.write(chunk));
    gunzip.on('end', () => parser.end());

    Readable.from(tarBuffer).pipe(gunzip);
  });

  if (mainFileSource) {
    exportedSymbolCount = countExports(mainFileSource, moduleFormat);
  }

  const result: TarballAnalysis = {
    unpackedSize,
    gzippedSize,
    fileCount,
    hasTypes: hasDts || version.hasTypes,
    moduleFormat,
    exportedSymbolCount,
  };

  cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000); // 7 days
  return result;
}

export interface AnalyzeResult {
  tarballs: Map<string, TarballAnalysis>;
  status: 'ok' | 'partial' | 'unavailable';
}

export async function analyzeVersions(
  versions: VersionMeta[],
  opts: PipelineOptions,
  cache: Cache
): Promise<AnalyzeResult> {
  if (opts.skipTarballs) {
    return { tarballs: new Map(), status: 'unavailable' };
  }

  const sem = new Semaphore(opts.concurrency ?? 3);
  const results = new Map<string, TarballAnalysis>();
  let ok = 0;
  let failed = 0;

  const onProgress = opts.onProgress ?? (() => {});
  let done = 0;

  await Promise.all(
    versions.map(v =>
      sem.run(async () => {
        try {
          const analysis = await analyzeTarball(v, cache);
          results.set(v.version, analysis);
          ok++;
        } catch {
          failed++;
        } finally {
          done++;
          const pct = Math.round((done / versions.length) * 100);
          onProgress('analyze', `Analyzing tarballs (${done}/${versions.length})…`, pct);
        }
      })
    )
  );

  const status: 'ok' | 'partial' | 'unavailable' =
    ok === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok';
  return { tarballs: results, status };
}

/** Fast path: derive size + format from registry manifest without tarball download. */
export function analyzeFromManifest(meta: VersionMeta): Partial<TarballAnalysis> {
  return {
    unpackedSize: meta.distUnpackedSize,
    fileCount: meta.distFileCount,
    hasTypes: meta.hasTypes,
    moduleFormat: detectModuleFormat(meta),
    gzippedSize: undefined,
    exportedSymbolCount: null,
  };
}
