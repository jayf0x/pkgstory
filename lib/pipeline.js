import { Cache } from './cache.js';
import { resolve } from './resolve.js';
import { fetchAll } from './fetch.js';
import { analyzeVersions } from './analyze.js';
import { aggregate } from './aggregate.js';
import { render } from './render.js';

/**
 * Run the full pipeline for a package.
 *
 * opts:
 *   noCache        {boolean}  bypass disk cache
 *   skipTarballs   {boolean}  skip tarball download/analysis (faster)
 *   githubToken    {string}   GitHub PAT for higher rate limits
 *   concurrency    {number}   max concurrent HTTP requests (default 5)
 *   onProgress     {function} (stage, message, pct?) => void
 *
 * Returns { timeline, svg }
 * Throws if the package can't be resolved (fail-fast on primary source).
 */
export async function runPipeline(pkgName, opts = {}) {
  const cache = new Cache({ enabled: !opts.noCache });
  const progress = opts.onProgress ?? (() => {});

  progress('resolve', `Resolving ${pkgName}…`);
  const manifest = await resolve(pkgName, cache); // throws if not found

  progress('fetch', 'Fetching downloads and metadata…');
  const fetchResult = await fetchAll(manifest, opts, cache);

  progress('analyze', 'Analyzing tarballs…');
  const analyzeResult = await analyzeVersions(manifest.versions, opts, cache);

  progress('aggregate', 'Building timeline…');
  const timeline = aggregate(manifest, fetchResult, analyzeResult);

  progress('render', 'Rendering SVG…');
  const svg = render(timeline);

  return { timeline, svg };
}
