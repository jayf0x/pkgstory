import { Cache } from '../cache.js';
import { fetchWithRetry, parseGitHubUrl } from '../utils.js';
import type { ResolvedManifest, VersionMeta } from '../types.js';

interface NpmDistTag {
  latest?: string;
  [key: string]: string | undefined;
}

interface NpmVersionDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
  unpackedSize?: number;
  fileCount?: number;
}

interface NpmVersionEntry {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  type?: string;
  exports?: unknown;
  sideEffects?: boolean | string[];
  types?: string;
  typings?: string;
  dist: NpmVersionDist;
  deprecated?: string;
  repository?: { type?: string; url?: string } | string;
}

interface NpmManifest {
  name: string;
  'dist-tags': NpmDistTag;
  versions: Record<string, NpmVersionEntry>;
  time: Record<string, string>;
  repository?: { type?: string; url?: string } | string;
}

const REGISTRY_URL = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min for registry manifests

function extractRepoUrl(
  repo: NpmVersionEntry['repository'] | NpmManifest['repository'] | undefined
): string | undefined {
  if (!repo) return undefined;
  const url = typeof repo === 'string' ? repo : repo.url ?? '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '') || undefined;
}

export async function resolve(
  pkgName: string,
  cache: Cache
): Promise<ResolvedManifest> {
  if (!pkgName || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) {
    throw new Error(`Invalid package name: ${pkgName}`);
  }

  const cacheKey = `registry:${pkgName}`;
  const cached = cache.get<ResolvedManifest>(cacheKey);
  if (cached) return cached;

  const encodedName = pkgName.startsWith('@')
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : pkgName;

  const res = await fetchWithRetry(`${REGISTRY_URL}/${encodedName}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 60_000,
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Package not found: ${pkgName}`);
    }
    throw new Error(`Registry error ${res.status} for ${pkgName}`);
  }

  const manifest = (await res.json()) as NpmManifest;
  const latestVersion = manifest['dist-tags']?.latest ?? '';
  const timeMap = manifest.time ?? {};

  const versions: VersionMeta[] = [];

  for (const [version, entry] of Object.entries(manifest.versions)) {
    // Skip dist-tags or non-semver entries recorded in time
    const publishDate = timeMap[version];
    if (!publishDate || !version.match(/^\d+\.\d+\.\d+/)) continue;

    const repoUrl =
      extractRepoUrl(entry.repository) ?? extractRepoUrl(manifest.repository);

    versions.push({
      version,
      publishDate,
      tarballUrl: entry.dist.tarball,
      dependencies: entry.dependencies ?? {},
      peerDependencies: entry.peerDependencies ?? {},
      packageType:
        entry.type === 'module'
          ? 'module'
          : entry.type === 'commonjs'
          ? 'commonjs'
          : undefined,
      exports: entry.exports,
      sideEffects: entry.sideEffects,
      hasTypes: !!(entry.types || entry.typings),
      distUnpackedSize: entry.dist.unpackedSize,
      distFileCount: entry.dist.fileCount,
      distIntegrity: entry.dist.integrity,
      deprecated: entry.deprecated,
    });
  }

  // Sort by publish date ascending
  versions.sort((a, b) => (a.publishDate < b.publishDate ? -1 : 1));

  const topLevelRepoUrl = extractRepoUrl(manifest.repository);
  const ghInfo = topLevelRepoUrl ? parseGitHubUrl(topLevelRepoUrl) : null;

  const result: ResolvedManifest = {
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
