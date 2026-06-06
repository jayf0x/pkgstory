#!/usr/bin/env node
import * as fs from 'node:fs';
import { runPipeline } from './lib/pipeline.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  let pkg = null;
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { pkg = a; }
    else if (a === '--no-cache')      { opts.noCache = true; }
    else if (a === '--skip-tarballs') { opts.skipTarballs = true; }
    else if (a === '--json')          { opts.json = true; }
    else if (a === '--out' || a === '-o') { opts.outFile = args[++i]; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown flag: ${a}`); process.exit(1); }
  }

  return { pkg, opts };
}

function printHelp() {
  console.error(`
pkgstory — npm package history as an embeddable SVG

Usage:
  node pkgstory.js <package> [options]

Options:
  --out, -o <file>   Write SVG to file (default: stdout)
  --json             Print timeline JSON instead of SVG
  --no-cache         Bypass disk cache (~/.pkgstory-cache)
  --skip-tarballs    Skip tarball analysis (faster, less size data)
  --help, -h         Show this help

Examples:
  node pkgstory.js ms --out ms.svg
  node pkgstory.js @jayf0x/fluidity-js --out fluidity-js.svg
  node pkgstory.js react --json | head -40
`.trim());
}

async function main() {
  const { pkg, opts } = parseArgs(process.argv);

  if (!pkg) { printHelp(); process.exit(1); }

  const isTTY = process.stdout.isTTY === true;
  if (!opts.outFile && !opts.json && isTTY) {
    console.error(`hint: pipe output or use --out, e.g.:  node pkgstory.js ${pkg} --out out.svg`);
  }

  const result = await runPipeline(pkg, {
    ...opts,
    onProgress: (stage, msg) => process.stderr.write(`[${stage}] ${msg}\n`),
  });

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
  console.error('Error:', err?.message ?? String(err));
  process.exit(1);
});
