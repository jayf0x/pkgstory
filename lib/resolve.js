import { fetchWithRetry, parseGitHubUrl } from './utils.js';

const REGISTRY_URL = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

function extractRepoUrl(repo) {
  if (!repo) return undefined;
  const url = typeof repo === 'string' ? repo : (repo.url ?? '');
  return url.replace(/^git\+/, '').replace(/\.git$/, '') || undefined;
}

/**
 * Fetches npm registry manifest and returns a normalized list of versions.
 * Throws if package not found or registry error.
 */
export async function resolve(pkgName, cache) {
  if (!pkgName || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) {
    throw new Error(`Invalid package name: ${pkgName}`);
  }

  const cacheKey = `registry:${pkgName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const encodedName = pkgName.startsWith('@')
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : pkgName;

  const res = await fetchWithRetry(`${REGISTRY_URL}/${encodedName}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 60_000,
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error(`Package not found: ${pkgName}`);
    throw new Error(`Registry error ${res.status} for ${pkgName}`);
  }

  const manifest = await res.json();
  const latestVersion = manifest['dist-tags']?.latest ?? '';
  const timeMap = manifest.time ?? {};

  const versions = [];

  for (const [version, entry] of Object.entries(manifest.versions ?? {})) {
    const publishDate = timeMap[version];
    if (!publishDate || !/^\d+\.\d+\.\d+/.test(version)) continue;

    const repoUrl = extractRepoUrl(entry.repository) ?? extractRepoUrl(manifest.repository);

    versions.push({
      version,
      publishDate,
      tarballUrl: entry.dist?.tarball,
      dependencies: entry.dependencies ?? {},
      peerDependencies: entry.peerDependencies ?? {},
      packageType: entry.type === 'module' ? 'module' : entry.type === 'commonjs' ? 'commonjs' : undefined,
      exports: entry.exports,
      sideEffects: entry.sideEffects,
      hasTypes: !!(entry.types || entry.typings),
      distUnpackedSize: entry.dist?.unpackedSize,
      distFileCount: entry.dist?.fileCount,
      deprecated: entry.deprecated,
      _repoUrl: repoUrl,
    });
  }

  if (versions.length === 0) {
    throw new Error(`No valid versions found for ${pkgName}`);
  }

  versions.sort((a, b) => (a.publishDate < b.publishDate ? -1 : 1));

  const topLevelRepoUrl = extractRepoUrl(manifest.repository);
  const ghInfo = topLevelRepoUrl ? parseGitHubUrl(topLevelRepoUrl) : null;

  const result = {
    name: manifest.name,
    versions,
    latestVersion,
    repositoryUrl: ghInfo
      ? `https://github.com/${ghInfo.owner}/${ghInfo.repo}`
      : topLevelRepoUrl,
    firstPublish: timeMap.created ?? versions[0]?.publishDate ?? '',
  };

  cache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}
