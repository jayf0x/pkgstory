import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fetchWithRetry, Semaphore } from './utils.js';

const require = createRequire(import.meta.url);
const tar = require('tar');

function detectModuleFormat(meta) {
  const { packageType: type, exports: exp } = meta;

  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const str = JSON.stringify(exp);
    const hasCjs = str.includes('"require"') || str.includes('.cjs') || (str.includes('"main"') && type !== 'module');
    const hasEsm = str.includes('"import"') || str.includes('.mjs') || str.includes('"module"');
    if (hasCjs && hasEsm) return 'dual';
    if (hasEsm) return 'esm';
    if (hasCjs) return 'cjs';
  }

  if (type === 'module') return 'esm';
  return 'cjs';
}

function countExports(source, format) {
  try {
    let count = 0;
    if (format === 'esm' || format === 'dual') {
      const esmMatches = source.match(/^\s*export\s+(const|let|var|function|class|default|async\s+function|type|interface|enum)\s/gm);
      count += esmMatches?.length ?? 0;
      const reexports = source.match(/^\s*export\s+\{[^}]+\}/gm);
      if (reexports) {
        for (const m of reexports) count += (m.match(/,/g)?.length ?? 0) + 1;
      }
    } else {
      const cjsMatches = source.match(/^\s*(module\.)?exports\.\w+\s*=/gm);
      count += cjsMatches?.length ?? 0;
    }
    return count > 0 ? count : null;
  } catch { return null; }
}

async function analyzeTarball(meta, cache) {
  const cacheKey = `tarball-analysis:${meta.tarballUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetchWithRetry(meta.tarballUrl, { timeoutMs: 60_000, retries: 2 });
  if (!res.ok) throw new Error(`Failed to fetch tarball: ${res.status}`);

  const tarBuffer = Buffer.from(await res.arrayBuffer());
  const gzippedSize = tarBuffer.length;

  let unpackedSize = 0;
  let fileCount = 0;
  let hasDts = false;
  let exportedSymbolCount = null;
  const moduleFormat = detectModuleFormat(meta);
  let mainFileSource = '';
  let mainFileFound = false;

  await new Promise((resolve, reject) => {
    const parser = new tar.Parser();
    let ended = false;

    parser.on('entry', entry => {
      const entryPath = entry.path;
      const entrySize = entry.size ?? 0;

      if (entryPath.endsWith('.d.ts') || entryPath.endsWith('.d.mts') || entryPath.endsWith('.d.cts')) {
        hasDts = true;
      }

      fileCount++;
      unpackedSize += entrySize;

      const chunks = [];
      const isMainJs = !mainFileFound && (
        entryPath.endsWith('/index.js') ||
        entryPath.endsWith('/index.mjs') ||
        entryPath.endsWith('/index.cjs') ||
        entryPath === 'package/index.js'
      ) && entrySize < 500_000;

      if (isMainJs) {
        mainFileFound = true;
        entry.on('data', chunk => chunks.push(chunk));
        entry.on('end', () => { mainFileSource = Buffer.concat(chunks).toString('utf8'); });
      } else {
        entry.resume();
      }
    });

    const done = () => { if (!ended) { ended = true; resolve(); } };
    parser.on('end', done);
    parser.on('finish', done);
    parser.on('error', reject);

    const gunzip = createGunzip();
    gunzip.on('error', reject);
    gunzip.on('data', chunk => parser.write(chunk));
    gunzip.on('end', () => parser.end());

    Readable.from(tarBuffer).pipe(gunzip);
  });

  if (mainFileSource) {
    exportedSymbolCount = countExports(mainFileSource, moduleFormat);
  }

  const result = {
    unpackedSize,
    gzippedSize,
    fileCount,
    hasTypes: hasDts || meta.hasTypes,
    moduleFormat,
    exportedSymbolCount,
  };

  cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000); // 7 days
  return result;
}

/** Fast path: derive size + format from registry manifest fields. */
export function analyzeFromManifest(meta) {
  return {
    unpackedSize: meta.distUnpackedSize,
    fileCount: meta.distFileCount,
    hasTypes: meta.hasTypes,
    moduleFormat: detectModuleFormat(meta),
    gzippedSize: undefined,
    exportedSymbolCount: null,
  };
}

/**
 * Analyze tarballs for all versions.
 * Returns a Map<version, analysis> and overall status.
 */
export async function analyzeVersions(versions, opts, cache) {
  if (opts.skipTarballs) return { tarballs: new Map(), status: 'unavailable' };

  const sem = new Semaphore(opts.concurrency ?? 3);
  const results = new Map();
  let ok = 0, failed = 0;
  let done = 0;

  const progress = opts.onProgress ?? (() => {});

  await Promise.all(versions.map(v => sem.run(async () => {
    try {
      const analysis = await analyzeTarball(v, cache);
      results.set(v.version, analysis);
      ok++;
    } catch {
      failed++;
    } finally {
      done++;
      progress('analyze', `Analyzing tarballs (${done}/${versions.length})…`, Math.round((done / versions.length) * 100));
    }
  })));

  const status = ok === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok';
  return { tarballs: results, status };
}
