/**
 * Pipeline smoke test — @jayf0x/fluidity-js
 * Run: node test.js
 */
import * as fs from 'node:fs';
import { runPipeline } from './lib/pipeline.js';

const PKG = '@jayf0x/fluidity-js';
const OUT_SVG  = 'fluidity-js.svg';
const OUT_JSON = 'fluidity-js.json';

console.log(`\n▶ pkgstory test: ${PKG}\n`);

const start = Date.now();

const result = await runPipeline(PKG, {
  skipTarballs: false,
  onProgress: (stage, msg, pct) => {
    const pctStr = pct != null ? ` ${pct}%` : '';
    process.stderr.write(`  [${stage}]${pctStr} ${msg}\n`);
  },
}).catch(err => {
  console.error(`\n✗ Pipeline failed: ${err?.message ?? err}`);
  process.exit(1);
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);

fs.writeFileSync(OUT_SVG, result.svg, 'utf8');
fs.writeFileSync(OUT_JSON, JSON.stringify(result.timeline, null, 2), 'utf8');

const s = result.timeline.summary;
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
console.log(`  JSON → ${OUT_JSON}`);
console.log('');
