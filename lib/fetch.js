import { fetchWithRetry, chunkDateRange, parseGitHubUrl, Semaphore, sleep } from './utils.js';

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range';
const PACKAGEPHOBIA_API = 'https://packagephobia.com/api.json';
const GITHUB_API = 'https://api.github.com';

async function fetchDownloads(pkgName, firstPublish, cache) {
  const start = new Date(firstPublish);
  const end = new Date();
  const chunks = chunkDateRange(start, end);

  if (chunks.length === 0) return { downloads: [], status: 'unavailable' };

  const all = [];
  let anyOk = false;
  let anyFailed = false;

  for (const chunk of chunks) {
    const cacheKey = `downloads:${pkgName}:${chunk.start}:${chunk.end}`;
    const cached = cache.get(cacheKey);
    if (cached) { all.push(...cached); anyOk = true; continue; }

    try {
      const url = `${DOWNLOADS_API}/${chunk.start}:${chunk.end}/${encodeURIComponent(pkgName)}`;
      const res = await fetchWithRetry(url, { timeoutMs: 20_000, retries: 3 });
      if (!res.ok) {
        if (res.status === 404) { anyOk = true; continue; } // not yet published in range
        anyFailed = true;
        continue;
      }
      const data = await res.json();
      const days = (data.downloads ?? []).map(d => ({ day: d.day, downloads: d.downloads }));
      cache.set(cacheKey, days, 2 * 60 * 60 * 1000); // 2h
      all.push(...days);
      anyOk = true;
      await sleep(200); // rate limit courtesy
    } catch {
      anyFailed = true;
    }
  }

  all.sort((a, b) => (a.day < b.day ? -1 : 1));
  const status = anyOk ? (anyFailed ? 'partial' : 'ok') : 'unavailable';
  return { downloads: all, status };
}

async function fetchPackagephobia(pkgName, versions, cache, sem) {
  const results = new Map();
  let ok = 0, failed = 0;

  await Promise.all(versions.map(version => sem.run(async () => {
    const cacheKey = `packagephobia:${pkgName}@${version}`;
    const cached = cache.get(cacheKey);
    if (cached) { results.set(version, cached); ok++; return; }

    try {
      const res = await fetchWithRetry(
        `${PACKAGEPHOBIA_API}?p=${encodeURIComponent(pkgName + '@' + version)}`,
        { timeoutMs: 20_000, retries: 1 }
      );
      if (!res.ok) { failed++; return; }
      const data = await res.json();
      const result = {
        publishSize: data.publish?.bytes ?? 0,
        installSize: data.install?.bytes ?? 0,
      };
      cache.set(cacheKey, result);
      results.set(version, result);
      ok++;
    } catch { failed++; }
  })));

  const status = ok === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok';
  return { results, status };
}

async function fetchGitHub(repoUrl, token, cache) {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return null;

  const cacheKey = `github:${parsed.owner}/${parsed.repo}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = {
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
    const repoData = await repoRes.json();

    const relRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/releases?per_page=100`,
      { headers, timeoutMs: 15_000, retries: 1 }
    );
    const releases = [];
    if (relRes.ok) {
      const relData = await relRes.json();
      for (const r of relData) {
        if (r.tag_name && r.published_at) {
          releases.push({ tagName: r.tag_name, publishedAt: r.published_at, name: r.name ?? r.tag_name });
        }
      }
    }

    const result = {
      stars: repoData.stargazers_count ?? 0,
      forks: repoData.forks_count ?? 0,
      releases,
    };
    cache.set(cacheKey, result, 60 * 60 * 1000); // 1h
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch all external data: downloads, packagephobia, GitHub.
 * Never throws — failed sources return empty/null.
 */
export async function fetchAll(manifest, opts, cache) {
  const sem = new Semaphore(opts.concurrency ?? 5);
  const versions = manifest.versions.map(v => v.version);
  const progress = opts.onProgress ?? (() => {});

  progress('fetch', 'Fetching download history…');
  const { downloads, status: dlStatus } = await fetchDownloads(manifest.name, manifest.firstPublish, cache);

  progress('fetch', 'Fetching packagephobia data…');
  const { results: ppResults, status: ppStatus } = await fetchPackagephobia(manifest.name, versions, cache, sem);

  let github = null;
  let ghStatus = 'unavailable';
  if (manifest.repositoryUrl) {
    progress('fetch', 'Fetching GitHub metadata…');
    github = await fetchGitHub(manifest.repositoryUrl, opts.githubToken, cache);
    ghStatus = github ? 'ok' : 'unavailable';
  }

  return {
    dailyDownloads: downloads,
    packagephobia: ppResults,
    github,
    sourceStatus: {
      downloads: dlStatus,
      packagephobia: ppStatus,
      github: ghStatus,
    },
  };
}
