import { sumDownloadsInWindow, semverMajor } from './utils.js';
import { analyzeFromManifest } from './analyze.js';

function mv(value, source) {
  return { value: value ?? null, source, available: value != null };
}

function detectFormat(v) {
  const { exports: exp, packageType: type } = v;
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

function detectAnnotations(versions) {
  const map = new Map();
  const add = (ver, chip) => {
    if (!map.has(ver)) map.set(ver, []);
    map.get(ver).push(chip);
  };

  let prevHasTypes = false;
  let prevSideEffects = undefined;
  let prevModuleFormat = null;
  let prevDepCount = null;
  let prevPeerDepCount = null;

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const depCount = Object.keys(v.dependencies ?? {}).length;
    const peerDepCount = Object.keys(v.peerDependencies ?? {}).length;

    if (i > 0 && semverMajor(v.version) > semverMajor(versions[i - 1].version)) {
      add(v.version, { version: v.version, type: 'major_release', label: `v${semverMajor(v.version)} major` });
    }

    if (!prevHasTypes && v.hasTypes) {
      add(v.version, { version: v.version, type: 'types_added', label: 'Types added' });
    }
    prevHasTypes = v.hasTypes;

    const fmt = detectFormat(v);
    if (prevModuleFormat === 'cjs' && (fmt === 'esm' || fmt === 'dual')) {
      add(v.version, {
        version: v.version, type: 'esm_introduced',
        label: fmt === 'dual' ? 'Dual ESM/CJS' : 'ESM introduced',
      });
    }
    prevModuleFormat = fmt;

    if (v.sideEffects === false && prevSideEffects !== false) {
      add(v.version, { version: v.version, type: 'treeshaking_enabled', label: 'Tree-shakeable' });
    }
    prevSideEffects = v.sideEffects;

    if (prevDepCount !== null && Math.abs(depCount - prevDepCount) >= 2) {
      const delta = depCount - prevDepCount;
      add(v.version, { version: v.version, type: 'deps_changed', label: `deps ${delta > 0 ? '+' : ''}${delta}` });
    }
    prevDepCount = depCount;

    if (prevPeerDepCount === 0 && peerDepCount > 0) {
      add(v.version, { version: v.version, type: 'peer_deps_added', label: `peer deps +${peerDepCount}` });
    }
    prevPeerDepCount = peerDepCount;
  }

  return map;
}

/**
 * Merge all data sources into a single TimelineJSON.
 */
export function aggregate(manifest, fetchResult, analyzeResult) {
  const { dailyDownloads, packagephobia, github, sourceStatus } = fetchResult;
  const { tarballs } = analyzeResult;

  const annotationMap = detectAnnotations(manifest.versions);

  const caveats = [
    '"Downloads during active period" is a trend estimate (daily downloads summed between release dates) — NOT a per-version measurement.',
  ];

  const versionPoints = manifest.versions.map((meta, i) => {
    const tarball = tarballs.get(meta.version);
    const fromManifest = analyzeFromManifest(meta);
    const pp = packagephobia.get(meta.version);

    // Size: tarball first, then registry dist fields, then packagephobia
    const unpackedSize =
      tarball?.unpackedSize != null ? mv(tarball.unpackedSize, 'tarball') :
      fromManifest.unpackedSize != null ? mv(fromManifest.unpackedSize, 'npm-registry-dist') :
      pp?.publishSize != null ? mv(pp.publishSize, 'packagephobia') :
      mv(null, 'unavailable');

    const gzippedSize =
      tarball?.gzippedSize != null ? mv(tarball.gzippedSize, 'tarball') :
      pp?.publishSize != null ? mv(pp.publishSize, 'packagephobia') :
      mv(null, 'unavailable');

    const fileCount =
      tarball?.fileCount != null ? mv(tarball.fileCount, 'tarball') :
      fromManifest.fileCount != null ? mv(fromManifest.fileCount, 'npm-registry-dist') :
      mv(null, 'unavailable');

    const fmt = tarball?.moduleFormat ?? fromManifest.moduleFormat ?? 'unknown';
    const hasTypesVal = tarball?.hasTypes ?? meta.hasTypes;

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
      moduleFormat: mv(fmt, tarball ? 'tarball' : 'npm-registry-manifest'),
      hasTypes: mv(hasTypesVal, tarball ? 'tarball' : 'npm-registry-manifest'),
      depCount: mv(Object.keys(meta.dependencies).length, 'npm-registry-manifest'),
      peerDepCount: mv(Object.keys(meta.peerDependencies).length, 'npm-registry-manifest'),
      installSize: pp ? mv(pp.installSize, 'packagephobia') : mv(null, 'unavailable'),
      publishSize: pp ? mv(pp.publishSize, 'packagephobia') : mv(null, 'unavailable'),
      downloadsActiveWindow: mv(windowDownloads, 'npm-downloads-range-derived'),
      downloadsActiveWindowIsOpenEnded: !nextMeta,
      annotations: annotationMap.get(meta.version) ?? [],
    };
  });

  const latestPoint = versionPoints.find(v => v.version === manifest.latestVersion)
    ?? versionPoints[versionPoints.length - 1];

  const today = new Date();
  const weekAgoStr = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const latestWeeklyDownloads = dailyDownloads.length > 0
    ? dailyDownloads.filter(d => d.day >= weekAgoStr).reduce((s, d) => s + d.downloads, 0)
    : null;

  const firstPublishDate = new Date(manifest.firstPublish || manifest.versions[0]?.publishDate || '');
  const packageAgeDays = Math.floor((Date.now() - firstPublishDate.getTime()) / 86_400_000);

  const lastPoint = versionPoints[versionPoints.length - 1];
  if (lastPoint?.downloadsActiveWindowIsOpenEnded) {
    caveats.push('Latest version download window is open-ended (no successor) — figure will keep growing.');
  }

  return {
    package: manifest.name,
    generatedAt: new Date().toISOString(),
    versions: versionPoints,
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
      github: sourceStatus.github,
    },
    caveats,
  };
}
