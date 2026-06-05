#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipeline } from './pipeline/index.js';
import { renderFromTimeline } from './pipeline/index.js';
import type { PipelineOptions } from './types.js';

function parseArgs(argv: string[]): {
  pkg: string | null;
  opts: PipelineOptions & { json?: boolean; jsonOut?: string; outFile?: string };
} {
  const args = argv.slice(2);
  let pkg: string | null = null;
  const opts: PipelineOptions & { json?: boolean; jsonOut?: string; outFile?: string } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      pkg = arg;
    } else if (arg === '--no-cache') {
      opts.noCache = true;
    } else if (arg === '--skip-tarballs') {
      opts.skipTarballs = true;
    } else if (arg === '--skip-bundlephobia') {
      opts.skipBundlephobia = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--out' || arg === '-o') {
      opts.outFile = args[++i];
    } else if (arg === '--json-out') {
      opts.jsonOut = args[++i];
    } else if (arg === '--github-token') {
      opts.githubToken = args[++i];
    } else if (arg === '--max-versions') {
      opts.maxVersions = parseInt(args[++i], 10);
    } else if (arg === '--concurrency') {
      opts.concurrency = parseInt(args[++i], 10);
    } else if (arg === '--cache-dir') {
      opts.cacheDir = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }

  return { pkg, opts };
}

function printHelp(): void {
  console.log(`
pkg-observatory — turn an npm package's history into an embeddable SVG

Usage:
  pkg-observatory <package-name> [options]

Options:
  --out, -o <file>        Write SVG to file instead of stdout
  --json                  Print timeline JSON to stdout instead of SVG
  --json-out <file>       Also write timeline JSON to this file
  --no-cache              Bypass disk cache
  --cache-dir <dir>       Cache directory (default: ~/.pkg-observatory-cache)
  --skip-tarballs         Skip tarball download/analysis (faster, less size data)
  --skip-bundlephobia     Skip bundlephobia lookups
  --github-token <token>  GitHub personal access token for higher rate limits
  --max-versions <n>      Analyze at most N versions (sampled intelligently)
  --concurrency <n>       Max concurrent HTTP requests (default: 5)
  --help, -h              Show this help

Examples:
  pkg-observatory ms > ms.svg
  pkg-observatory react --out react-history.svg --skip-tarballs
  pkg-observatory lodash --json | jq '.summary'
  pkg-observatory axios --out axios.svg --json-out axios-timeline.json
`.trim());
}

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

async function main(): Promise<void> {
  const { pkg, opts } = parseArgs(process.argv);

  if (!pkg) {
    printHelp();
    process.exit(1);
  }

  // When writing SVG to stdout and stdout is a TTY, warn the user
  const toStdout = !opts.outFile && !opts.json;
  if (toStdout && isTTY()) {
    console.error('hint: pipe to a file or use --out to write the SVG, e.g.:');
    console.error(`  pkg-observatory ${pkg} --out ${pkg.replace('/', '-')}.svg`);
  }

  const progressLines: string[] = [];

  const result = await runPipeline(pkg, {
    ...opts,
    onProgress: (stage, message) => {
      if (isTTY() || opts.outFile || opts.json) {
        process.stderr.write(`[${stage}] ${message}\n`);
      }
    },
  });

  if (opts.jsonOut) {
    fs.writeFileSync(opts.jsonOut, JSON.stringify(result.timeline, null, 2), 'utf8');
    process.stderr.write(`timeline JSON written to ${opts.jsonOut}\n`);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.timeline, null, 2) + '\n');
  } else if (opts.outFile) {
    fs.writeFileSync(opts.outFile, result.svg, 'utf8');
    process.stderr.write(`SVG written to ${opts.outFile}\n`);
  } else {
    process.stdout.write(result.svg);
  }
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
