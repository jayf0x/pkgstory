import { Cache } from '../cache.js';
import { sampleVersions } from '../utils.js';
import { resolve } from './resolve.js';
import { fetchAll } from './fetch.js';
import { analyzeVersions } from './analyze.js';
import { aggregate } from './aggregate.js';
import { render } from './render.js';
import type { PipelineOptions, PipelineResult, TimelineJSON } from '../types.js';

export async function runPipeline(
  pkgName: string,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const cache = new Cache({
    dir: opts.cacheDir,
    ttlMs: opts.cacheTTLMs,
    enabled: !opts.noCache,
  });

  const onProgress = opts.onProgress ?? (() => {});

  // 1. Resolve
  onProgress('resolve', `Resolving ${pkgName}…`);
  const manifest = await resolve(pkgName, cache);

  onProgress('resolve', `Found ${manifest.versions.length} versions (latest: ${manifest.latestVersion})`);

  // 2. Version sampling
  let selectedVersions = manifest.versions;
  if (opts.maxVersions && manifest.versions.length > opts.maxVersions) {
    const sampled = sampleVersions(
      manifest.versions.map(v => v.version),
      opts.maxVersions
    );
    const sampledSet = new Set(sampled);
    selectedVersions = manifest.versions.filter(v => sampledSet.has(v.version));
    onProgress('resolve', `Sampled ${selectedVersions.length} versions from ${manifest.versions.length} total`);
  }

  const sampledManifest = { ...manifest, versions: selectedVersions };

  // 3. Fetch
  onProgress('fetch', 'Fetching data from external sources…');
  const fetchResult = await fetchAll(sampledManifest, opts, cache);

  // 4. Analyze tarballs
  onProgress('analyze', 'Analyzing package tarballs…');
  const analyzeResult = await analyzeVersions(selectedVersions, opts, cache);

  // 5. Aggregate
  onProgress('aggregate', 'Aggregating data…');
  const timeline = aggregate(sampledManifest, fetchResult, analyzeResult);

  // 6. Render
  onProgress('render', 'Rendering SVG…');
  const svg = render(timeline);

  onProgress('done', 'Complete.');
  return { timeline, svg };
}

export { render } from './render.js';
export { resolve } from './resolve.js';
export { aggregate } from './aggregate.js';

export function renderFromTimeline(timeline: TimelineJSON): string {
  return render(timeline);
}
