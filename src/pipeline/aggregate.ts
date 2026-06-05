import { sumDownloadsInWindow, semverMajor } from '../utils.js';
import type {
  ResolvedManifest,
  VersionMeta,
  TimelineJSON,
  VersionPoint,
  MetricValue,
  AnnotationChip,
  ModuleFormat,
  DailyDownload,
} from '../types.js';
import type { FetchResult } from './fetch.js';
import type { AnalyzeResult } from './analyze.js';
import { analyzeFromManifest } from './analyze.js';

function mv<T>(
  value: T | null | undefined,
  source: string
): MetricValue<T> {
  return {
    value: value ?? null,
    source,
    available: value != null,
  };
}

function detectAnnotations(
  versions: VersionMeta[]
): Map<string, AnnotationChip[]> {
  const map = new Map<string, AnnotationChip[]>();
  const add = (v: string, chip: AnnotationChip) => {
    if (!map.has(v)) map.set(v, []);
    map.get(v)!.push(chip);
  };

  let prevHasTypes = false;
  let prevSideEffects: boolean | string[] | undefined = undefined;
  let prevModuleFormat: ModuleFormat | null = null;
  let prevDepCount: number | null = null;
  let prevPeerDepCount: number | null = null;

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const ver = v.version;
    const depCount = Object.keys(v.dependencies ?? {}).length;
    const peerDepCount = Object.keys(v.peerDependencies ?? {}).length;

    // Major release
    if (i > 0) {
      const prevMajor = semverMajor(versions[i - 1].version);
      const curMajor = semverMajor(ver);
      if (curMajor > prevMajor) {
        add(ver, {
          version: ver,
          type: 'major_release',
          label: `v${curMajor} major`,
        });
      }
    }

    // Types added
    if (!prevHasTypes && v.hasTypes) {
      add(ver, {
        version: ver,
        type: 'types_added',
        label: 'Types added',
      });
    }
    prevHasTypes = v.hasTypes;

    // ESM introduced
    const fmt = detectFormat(v);
    if (
      prevModuleFormat !== null &&
      prevModuleFormat === 'cjs' &&
      (fmt === 'esm' || fmt === 'dual')
    ) {
      add(ver, {
        version: ver,
        type: 'esm_introduced',
        label: fmt === 'dual' ? 'Dual ESM/CJS' : 'ESM introduced',
      });
    }
    prevModuleFormat = fmt;

    // Tree-shaking (sideEffects: false)
    const se = v.sideEffects;
    if (se === false && prevSideEffects !== false) {
      add(ver, {
        version: ver,
        type: 'treeshaking_enabled',
        label: 'Tree-shakeable',
      });
    }
    prevSideEffects = se;

    // Dependencies changed significantly
    if (prevDepCount !== null && Math.abs(depCount - prevDepCount) >= 2) {
      const delta = depCount - prevDepCount;
      add(ver, {
        version: ver,
        type: 'deps_changed',
        label: `deps ${delta > 0 ? '+' : ''}${delta}`,
      });
    }
    prevDepCount = depCount;

    // Peer deps added
    if (prevPeerDepCount === 0 && peerDepCount > 0) {
      add(ver, {
        version: ver,
        type: 'peer_deps_added',
        label: `peer deps +${peerDepCount}`,
      });
    }
    prevPeerDepCount = peerDepCount;
  }

  return map;
}

function detectFormat(v: VersionMeta): ModuleFormat {
  const exp = v.exports;
  const type = v.packageType;

  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const str = JSON.stringify(exp);
    const hasCjs = str.includes('"require"') || str.includes('.cjs');
    const hasEsm = str.includes('"import"') || str.includes('.mjs');
    if (hasCjs && hasEsm) return 'dual';
    if (hasEsm) return 'esm';
    if (hasCjs) return 'cjs';
  }

  if (type === 'module') return 'esm';
  return 'cjs';
}

export function aggregate(
  manifest: ResolvedManifest,
  fetchResult: FetchResult,
  analyzeResult: AnalyzeResult
): TimelineJSON {
  const { dailyDownloads, packagephobia, bundlephobia, github, sourceStatus } = fetchResult;
  const { tarballs } = analyzeResult;

  const annotationMap = detectAnnotations(manifest.versions);
  const caveats: string[] = [
    '"Downloads during active period" is a trend estimate computed by summing total daily downloads between consecutive release dates — it is NOT a direct per-version measurement. Users who pin older versions inflate successor counts.',
  ];

  const versions: VersionPoint[] = manifest.versions.map((meta, i) => {
    const tarball = tarballs.get(meta.version);
    const manifest_analysis = analyzeFromManifest(meta);
    const pp = packagephobia.get(meta.version);
    const bp = bundlephobia.get(meta.version);

    // Size: prefer tarball (we computed it), fall back to dist fields from manifest, then packagephobia
    const unpackedSize =
      tarball?.unpackedSize != null
        ? mv(tarball.unpackedSize, 'tarball')
        : manifest_analysis.unpackedSize != null
        ? mv(manifest_analysis.unpackedSize, 'npm-registry-dist')
        : pp?.publishSize != null
        ? mv(pp.publishSize, 'packagephobia-publish')
        : mv<number>(null, 'unavailable');

    const gzippedSize =
      tarball?.gzippedSize != null
        ? mv(tarball.gzippedSize, 'tarball')
        : pp?.publishSize != null
        ? mv(pp.publishSize, 'packagephobia-publish')
        : mv<number>(null, 'unavailable');

    const fileCount =
      tarball?.fileCount != null
        ? mv(tarball.fileCount, 'tarball')
        : manifest_analysis.fileCount != null
        ? mv(manifest_analysis.fileCount, 'npm-registry-dist')
        : mv<number>(null, 'unavailable');

    const fmt = tarball?.moduleFormat ?? manifest_analysis.moduleFormat ?? 'unknown';
    const hasTypesVal = tarball?.hasTypes ?? meta.hasTypes;

    // Downloads during active window
    const nextMeta = manifest.versions[i + 1];
    const windowStart = meta.publishDate.slice(0, 10);
    const windowEnd = nextMeta ? nextMeta.publishDate.slice(0, 10) : null;
    const windowDownloads = dailyDownloads.length > 0
      ? sumDownloadsInWindow(dailyDownloads, windowStart, windowEnd)
      : null;

    return {
      version: meta.version,
      publishDate: meta.publishDate,

      unpackedSize,
      gzippedSize,
      fileCount,
      moduleFormat: mv<ModuleFormat>(fmt as ModuleFormat, tarball ? 'tarball' : 'npm-registry-manifest'),
      hasTypes: mv(hasTypesVal, tarball ? 'tarball' : 'npm-registry-manifest'),

      depCount: mv(Object.keys(meta.dependencies).length, 'npm-registry-manifest'),
      peerDepCount: mv(Object.keys(meta.peerDependencies).length, 'npm-registry-manifest'),

      installSize: pp ? mv(pp.installSize, 'packagephobia') : mv<number>(null, 'unavailable'),
      publishSize: pp ? mv(pp.publishSize, 'packagephobia') : mv<number>(null, 'unavailable'),

      bundleSize: bp ? mv(bp.size, 'bundlephobia') : mv<number>(null, 'unavailable'),
      bundleGzip: bp ? mv(bp.gzip, 'bundlephobia') : mv<number>(null, 'unavailable'),

      downloadsActiveWindow: mv(windowDownloads, 'npm-downloads-range-derived'),
      downloadsActiveWindowIsOpenEnded: !nextMeta,

      annotations: annotationMap.get(meta.version) ?? [],
    };
  });

  const latest = manifest.versions.find(v => v.version === manifest.latestVersion) ?? manifest.versions[manifest.versions.length - 1];
  const latestPoint = versions.find(v => v.version === manifest.latestVersion) ?? versions[versions.length - 1];

  // Latest weekly downloads from last 7 days of daily data
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const weekAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
  const latestWeeklyDownloads = dailyDownloads.length > 0
    ? dailyDownloads
        .filter(d => d.day >= weekAgoStr)
        .reduce((s, d) => s + d.downloads, 0)
    : null;

  const firstPublishDate = new Date(manifest.firstPublish || manifest.versions[0]?.publishDate || '');
  const packageAgeDays = Math.floor((Date.now() - firstPublishDate.getTime()) / 86_400_000);

  if (!nextMeta_caveats_check(versions)) {
    caveats.push('The latest version\'s "downloads during active period" window is open-ended (no successor released yet) — this figure will continue growing.');
  }

  return {
    package: manifest.name,
    generatedAt: new Date().toISOString(),
    versions,
    dailyDownloads,
    github: github
      ? { value: github, source: 'github-api', available: true }
      : { value: null, source: 'github-api', available: false },
    summary: {
      latestVersion: manifest.latestVersion,
      latestWeeklyDownloads,
      latestUnpackedSize: latestPoint?.unpackedSize.value ?? null,
      latestDepCount: latestPoint?.depCount.value ?? null,
      packageAgeDays,
      totalVersions: manifest.versions.length,
    },
    dataSourceStatus: {
      registry: 'ok',
      downloads: sourceStatus.downloads,
      tarballs: analyzeResult.status,
      packagephobia: sourceStatus.packagephobia,
      bundlephobia: sourceStatus.bundlephobia,
      github: sourceStatus.github,
    },
    caveats,
  };
}

function nextMeta_caveats_check(versions: VersionPoint[]): boolean {
  const last = versions[versions.length - 1];
  return !last || !last.downloadsActiveWindowIsOpenEnded;
}
