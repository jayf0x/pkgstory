/**
 * Pipeline smoke test
 * Run: node test.js [package] [--skip-tarballs]
 * Examples:
 *   node test.js
 *   node test.js react --skip-tarballs
 *   node test.js ms
 */
import * as fs from 'node:fs';
import { runPipeline } from './lib/pipeline.js';

const args = process.argv.slice(2);
const PKG = args.find(a => !a.startsWith('-')) ?? '@jayf0x/fluidity-js';
const skipTarballs = args.includes('--skip-tarballs');
const slug = PKG.replace(/\//g, '-').replace(/^@/, '');
const OUT_SVG  = `${slug}.svg`;
const OUT_JSON = `${slug}.json`;

console.log(`\n▶ pkgstory test: ${PKG}${skipTarballs ? ' (--skip-tarballs)' : ''}\n`);

const start = Date.now();

let result;
try {
  result = await runPipeline(PKG, {
    skipTarballs,
    onProgress: (stage, msg, pct) => {
      const pctStr = pct != null ? ` ${pct}%` : '';
      process.stderr.write(`  [${stage}]${pctStr} ${msg}\n`);
    },
  });
} catch (err) {
  console.error(`\n✗ Pipeline failed: ${err?.message ?? err}`);
  process.exit(1);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);

fs.writeFileSync(OUT_SVG,  result.svg, 'utf8');
fs.writeFileSync(OUT_JSON, JSON.stringify(result.timeline, null, 2), 'utf8');

const s  = result.timeline.summary;
const ds = result.timeline.dataSourceStatus;

console.log(`\n✓ Done in ${elapsed}s`);
console.log(`  package      : ${result.timeline.package}`);
console.log(`  latest       : v${s.latestVersion}`);
console.log(`  versions     : ${s.totalVersions}`);
console.log(`  age          : ${s.packageAgeDays}d`);
console.log(`  unpacked size: ${s.latestUnpackedSize != null ? (s.latestUnpackedSize / 1024).toFixed(1) + ' KB' : 'n/a'}`);
console.log(`  weekly dl    : ${s.latestWeeklyDownloads ?? 'n/a'}`);
console.log(`  deps         : ${s.latestDepCount ?? 'n/a'}`);
console.log(`\n  data sources:`);
for (const [k, v] of Object.entries(ds)) {
  const icon = v === 'ok' ? '✓' : v === 'partial' ? '~' : '✗';
  console.log(`    ${icon} ${k}: ${v}`);
}
console.log(`\n  SVG  → ${OUT_SVG}`);
console.log(`  JSON → ${OUT_JSON}\n`);

process.exit(0); // force-close fetch keepalive connections
