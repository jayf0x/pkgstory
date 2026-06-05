import { Cache } from '../cache.js';
import {
  fetchWithRetry,
  chunkDateRange,
  parseGitHubUrl,
  Semaphore,
  sleep,
} from '../utils.js';
import type {
  ResolvedManifest,
  DailyDownload,
  PackagephobiaResult,
  BundlephobiaResult,
  GitHubRepo,
  PipelineOptions,
} from '../types.js';

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range';
const PACKAGEPHOBIA_API = 'https://packagephobia.com/api.json';
const BUNDLEPHOBIA_API = 'https://bundlephobia.com/api/size';
const GITHUB_API = 'https://api.github.com';

export interface FetchResult {
  dailyDownloads: DailyDownload[];
  packagephobia: Map<string, PackagephobiaResult>;
  bundlephobia: Map<string, BundlephobiaResult>;
  github: GitHubRepo | null;
  sourceStatus: {
    downloads: 'ok' | 'partial' | 'unavailable';
    packagephobia: 'ok' | 'partial' | 'unavailable';
    bundlephobia: 'ok' | 'partial' | 'unavailable';
    github: 'ok' | 'unavailable';
  };
}

async function fetchDownloads(
  pkgName: string,
  firstPublish: string,
  cache: Cache
): Promise<{ downloads: DailyDownload[]; status: 'ok' | 'partial' | 'unavailable' }> {
  const start = new Date(firstPublish);
  const end = new Date();
  const chunks = chunkDateRange(start, end);

  if (chunks.length === 0) {
    return { downloads: [], status: 'unavailable' };
  }

  const all: DailyDownload[] = [];
  let anyOk = false;
  let anyFailed = false;

  for (const chunk of chunks) {
    const cacheKey = `downloads:${pkgName}:${chunk.start}:${chunk.end}`;
    const cached = cache.get<DailyDownload[]>(cacheKey);
    if (cached) {
      all.push(...cached);
      anyOk = true;
      continue;
    }

    try {
      const url = `${DOWNLOADS_API}/${chunk.start}:${chunk.end}/${encodeURIComponent(pkgName)}`;
      const res = await fetchWithRetry(url, { timeoutMs: 20_000, retries: 3 });
      if (!res.ok) {
        if (res.status === 404) {
          // Package didn't exist yet in this range — not an error
          anyOk = true;
          continue;
        }
        anyFailed = true;
        continue;
      }
      const data = (await res.json()) as { downloads: Array<{ day: string; downloads: number }> };
      const days: DailyDownload[] = (data.downloads ?? []).map(d => ({
        day: d.day,
        downloads: d.downloads,
      }));
      cache.set(cacheKey, days, 2 * 60 * 60 * 1000); // 2h
      all.push(...days);
      anyOk = true;
      await sleep(200); // rate limit courtesy
    } catch {
      anyFailed = true;
    }
  }

  all.sort((a, b) => (a.day < b.day ? -1 : 1));
  const status: 'ok' | 'partial' | 'unavailable' = anyOk
    ? anyFailed
      ? 'partial'
      : 'ok'
    : 'unavailable';
  return { downloads: all, status };
}

async function fetchPackagephobia(
  pkgName: string,
  versions: string[],
  cache: Cache,
  sem: Semaphore
): Promise<{ results: Map<string, PackagephobiaResult>; status: 'ok' | 'partial' | 'unavailable' }> {
  const results = new Map<string, PackagephobiaResult>();
  let ok = 0;
  let failed = 0;

  await Promise.all(
    versions.map(version =>
      sem.run(async () => {
        const cacheKey = `packagephobia:${pkgName}@${version}`;
        const cached = cache.get<PackagephobiaResult>(cacheKey);
        if (cached) {
          results.set(version, cached);
          ok++;
          return;
        }
        try {
          const res = await fetchWithRetry(
            `${PACKAGEPHOBIA_API}?p=${encodeURIComponent(pkgName + '@' + version)}`,
            { timeoutMs: 20_000, retries: 1 }
          );
          if (!res.ok) { failed++; return; }
          const data = (await res.json()) as { publish?: { bytes?: number }; install?: { bytes?: number } };
          const result: PackagephobiaResult = {
            publishSize: data.publish?.bytes ?? 0,
            installSize: data.install?.bytes ?? 0,
          };
          cache.set(cacheKey, result);
          results.set(version, result);
          ok++;
        } catch {
          failed++;
        }
      })
    )
  );

  const status: 'ok' | 'partial' | 'unavailable' =
    ok === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok';
  return { results, status };
}

async function fetchBundlephobia(
  pkgName: string,
  versions: string[],
  cache: Cache,
  sem: Semaphore
): Promise<{ results: Map<string, BundlephobiaResult>; status: 'ok' | 'partial' | 'unavailable' }> {
  const results = new Map<string, BundlephobiaResult>();
  let ok = 0;

  await Promise.all(
    versions.map(version =>
      sem.run(async () => {
        const cacheKey = `bundlephobia:${pkgName}@${version}`;
        const cached = cache.get<BundlephobiaResult>(cacheKey);
        if (cached) {
          results.set(version, cached);
          ok++;
          return;
        }
        try {
          const res = await fetchWithRetry(
            `${BUNDLEPHOBIA_API}?package=${encodeURIComponent(pkgName + '@' + version)}`,
            { timeoutMs: 15_000, retries: 1 }
          );
          if (!res.ok) return;
          const data = (await res.json()) as {
            size?: number;
            gzip?: number;
            hasJsSideEffects?: boolean;
          };
          if (typeof data.size !== 'number') return;
          const result: BundlephobiaResult = {
            size: data.size,
            gzip: data.gzip ?? 0,
            hasSideEffects: data.hasJsSideEffects ?? true,
          };
          cache.set(cacheKey, result);
          results.set(version, result);
          ok++;
        } catch {
          // Bundlephobia is optional; silence all failures
        }
      })
    )
  );

  const status: 'ok' | 'partial' | 'unavailable' = ok === 0 ? 'unavailable' : ok < versions.length ? 'partial' : 'ok';
  return { results, status };
}

async function fetchGitHub(
  repoUrl: string,
  token: string | undefined,
  cache: Cache
): Promise<GitHubRepo | null> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return null;

  const cacheKey = `github:${parsed.owner}/${parsed.repo}`;
  const cached = cache.get<GitHubRepo>(cacheKey);
  if (cached) return cached;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const repoRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}`,
      { headers, timeoutMs: 15_000, retries: 1 }
    );
    if (!repoRes.ok) return null;
    const repoData = (await repoRes.json()) as { stargazers_count?: number; forks_count?: number };

    const relRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/releases?per_page=100`,
      { headers, timeoutMs: 15_000, retries: 1 }
    );
    const releases: GitHubRepo['releases'] = [];
    if (relRes.ok) {
      const relData = (await relRes.json()) as Array<{
        tag_name?: string;
        published_at?: string;
        name?: string;
      }>;
      for (const r of relData) {
        if (r.tag_name && r.published_at) {
          releases.push({
            tagName: r.tag_name,
            publishedAt: r.published_at,
            name: r.name ?? r.tag_name,
          });
        }
      }
    }

    const result: GitHubRepo = {
      stars: repoData.stargazers_count ?? 0,
      forks: repoData.forks_count ?? 0,
      contributors: null, // skip contributors API to avoid rate limits
      releases,
    };

    cache.set(cacheKey, result, 60 * 60 * 1000); // 1h
    return result;
  } catch {
    return null;
  }
}

export async function fetchAll(
  manifest: ResolvedManifest,
  opts: PipelineOptions,
  cache: Cache
): Promise<FetchResult> {
  const sem = new Semaphore(opts.concurrency ?? 5);
  const versions = manifest.versions.map(v => v.version);

  const onProgress = opts.onProgress ?? (() => {});

  onProgress('fetch', 'Fetching download history…');
  const { downloads, status: dlStatus } = await fetchDownloads(
    manifest.name,
    manifest.firstPublish,
    cache
  );

  onProgress('fetch', 'Fetching packagephobia data…');
  const { results: ppResults, status: ppStatus } = await fetchPackagephobia(
    manifest.name,
    versions,
    cache,
    sem
  );

  let bpResults = new Map<string, BundlephobiaResult>();
  let bpStatus: 'ok' | 'partial' | 'unavailable' = 'unavailable';
  if (!opts.skipBundlephobia) {
    onProgress('fetch', 'Fetching bundlephobia data (best-effort)…');
    const bp = await fetchBundlephobia(manifest.name, versions, cache, sem);
    bpResults = bp.results;
    bpStatus = bp.status;
  }

  let github: GitHubRepo | null = null;
  let ghStatus: 'ok' | 'unavailable' = 'unavailable';
  if (manifest.repositoryUrl) {
    onProgress('fetch', 'Fetching GitHub metadata…');
    github = await fetchGitHub(manifest.repositoryUrl, opts.githubToken, cache);
    ghStatus = github ? 'ok' : 'unavailable';
  }

  return {
    dailyDownloads: downloads,
    packagephobia: ppResults,
    bundlephobia: bpResults,
    github,
    sourceStatus: {
      downloads: dlStatus,
      packagephobia: ppStatus,
      bundlephobia: bpStatus,
      github: ghStatus,
    },
  };
}
