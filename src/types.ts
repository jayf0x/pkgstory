export interface MetricValue<T> {
  value: T | null;
  source: string;
  available: boolean;
}

export type ModuleFormat = 'cjs' | 'esm' | 'dual' | 'unknown';

export interface VersionMeta {
  version: string;
  publishDate: string; // ISO 8601
  tarballUrl: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  packageType?: 'module' | 'commonjs';
  exports?: unknown;
  sideEffects?: boolean | string[];
  hasTypes: boolean;
  distUnpackedSize?: number;
  distFileCount?: number;
  distIntegrity?: string;
  deprecated?: string;
}

export interface ResolvedManifest {
  name: string;
  versions: VersionMeta[];
  latestVersion: string;
  repositoryUrl?: string;
  firstPublish: string;
}

export interface DailyDownload {
  day: string; // YYYY-MM-DD
  downloads: number;
}

export interface TarballAnalysis {
  unpackedSize: number;
  gzippedSize: number;
  fileCount: number;
  hasTypes: boolean;
  moduleFormat: ModuleFormat;
  exportedSymbolCount: number | null;
}

export interface PackagephobiaResult {
  publishSize: number;
  installSize: number;
}

export interface BundlephobiaResult {
  size: number;
  gzip: number;
  hasSideEffects: boolean;
}

export interface GitHubRepo {
  stars: number;
  forks: number;
  contributors: number | null;
  releases: Array<{
    tagName: string;
    publishedAt: string;
    name: string;
  }>;
}

export type AnnotationType =
  | 'esm_introduced'
  | 'types_added'
  | 'treeshaking_enabled'
  | 'deps_changed'
  | 'major_release'
  | 'peer_deps_added';

export interface AnnotationChip {
  version: string;
  type: AnnotationType;
  label: string;
}

export interface VersionPoint {
  version: string;
  publishDate: string;

  unpackedSize: MetricValue<number>;
  gzippedSize: MetricValue<number>;
  fileCount: MetricValue<number>;
  moduleFormat: MetricValue<ModuleFormat>;
  hasTypes: MetricValue<boolean>;

  depCount: MetricValue<number>;
  peerDepCount: MetricValue<number>;

  installSize: MetricValue<number>;
  publishSize: MetricValue<number>;

  bundleSize: MetricValue<number>;
  bundleGzip: MetricValue<number>;

  /** Downloads summed between this version's publish date and the next version's publish date.
   *  This is a trend estimate derived from two real sources — NOT a direct per-version measurement. */
  downloadsActiveWindow: MetricValue<number>;
  downloadsActiveWindowIsOpenEnded: boolean; // true for the final version (no successor)

  annotations: AnnotationChip[];
}

export interface TimelineJSON {
  package: string;
  generatedAt: string;
  versions: VersionPoint[];
  dailyDownloads: DailyDownload[];
  github: MetricValue<GitHubRepo>;
  summary: {
    latestVersion: string;
    latestWeeklyDownloads: number | null;
    latestUnpackedSize: number | null;
    latestDepCount: number | null;
    packageAgeDays: number;
    totalVersions: number;
  };
  dataSourceStatus: {
    registry: 'ok' | 'error';
    downloads: 'ok' | 'partial' | 'unavailable';
    tarballs: 'ok' | 'partial' | 'unavailable';
    packagephobia: 'ok' | 'partial' | 'unavailable';
    bundlephobia: 'ok' | 'partial' | 'unavailable';
    github: 'ok' | 'unavailable';
  };
  caveats: string[];
}

export interface PipelineOptions {
  noCache?: boolean;
  cacheTTLMs?: number;
  cacheDir?: string;
  maxVersions?: number;
  githubToken?: string;
  concurrency?: number;
  skipTarballs?: boolean;
  skipBundlephobia?: boolean;
  onProgress?: (stage: string, message: string, pct?: number) => void;
}

export interface PipelineResult {
  timeline: TimelineJSON;
  svg: string;
}
