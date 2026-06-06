import { formatBytes, formatDownloads, formatDays } from './utils.js';

// ── Dimensions ────────────────────────────────────────────────────────────────
const W = 900;
const H = 500;
const HEADER_H = 72;
const CHIP_H = 36;
const CHART_TOP = HEADER_H + CHIP_H + 8;
const CHART_BOTTOM = H - 90;
const CHART_H = CHART_BOTTOM - CHART_TOP;
const ML = 82;  // left margin (size axis)
const MR = 78;  // right margin (downloads axis)
const CHART_W = W - ML - MR;

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#ffffff',
  border: '#d0d7de',
  grid: '#f3f4f6',
  text: '#1f2328',
  textSec: '#6e7781',
  textMuted: '#9ea7b3',
  size: '#0969da',
  downloads: '#1a7f37',
  downloadsFill: 'rgba(26,127,55,0.08)',
  na: '#d0d7de',
  naText: '#9ea7b3',
  chips: {
    major_release:      { bg: '#fff1e6', border: '#fb8f44', text: '#953800' },
    esm_introduced:     { bg: '#f0eaff', border: '#8957e5', text: '#512a97' },
    types_added:        { bg: '#dff7e2', border: '#2ea043', text: '#116329' },
    treeshaking_enabled:{ bg: '#dff7e2', border: '#2ea043', text: '#116329' },
    deps_changed:       { bg: '#fff8c5', border: '#d4a72c', text: '#7d4e00' },
    peer_deps_added:    { bg: '#fff8c5', border: '#d4a72c', text: '#7d4e00' },
  },
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function niceScale(max, ticks = 5) {
  if (max === 0) return { step: 1, niceMax: 5 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm <= 1.5) step = 1;
  else if (norm <= 3) step = 2;
  else if (norm <= 7) step = 5;
  else step = 10;
  step *= mag;
  return { step, niceMax: Math.ceil(max / step) * step };
}

function svgPath(points) {
  if (points.length === 0) return '';
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function makeTimeMapper(versions) {
  if (versions.length === 0) return () => ML;
  const first = new Date(versions[0].publishDate).getTime();
  const last = new Date(versions[versions.length - 1].publishDate).getTime();
  const span = last - first || 1;
  return isoDate => ML + ((new Date(isoDate).getTime() - first) / span) * CHART_W;
}

// ── Sub-renderers ─────────────────────────────────────────────────────────────

function renderHeader(timeline) {
  const s = timeline.summary;
  const sizeStr = s.latestUnpackedSize != null ? formatBytes(s.latestUnpackedSize) : 'n/a';
  const dlStr = s.latestWeeklyDownloads != null ? formatDownloads(s.latestWeeklyDownloads) + '/wk' : 'n/a';
  const depsStr = s.latestDepCount != null ? String(s.latestDepCount) : 'n/a';
  const ageStr = formatDays(s.packageAgeDays);

  const badges = [
    { label: 'size',     value: sizeStr, color: C.size },
    { label: 'weekly dl',value: dlStr,   color: C.downloads },
    { label: 'deps',     value: depsStr, color: '#6e7781' },
    { label: 'age',      value: ageStr,  color: '#6e7781' },
  ];

  let badgeX = 180;
  let out = '';
  for (const b of badges) {
    const lw = b.label.length * 6.5 + 10;
    const vw = b.value.length * 7.5 + 10;
    out += `
    <rect x="${badgeX}" y="24" width="${lw}" height="22" rx="3" fill="${b.color}"/>
    <text x="${badgeX + lw / 2}" y="39" text-anchor="middle" font-size="11" fill="#fff" font-weight="600" font-family="system-ui,sans-serif">${esc(b.label)}</text>
    <rect x="${badgeX + lw}" y="24" width="${vw}" height="22" fill="#f3f4f6" stroke="${C.border}" stroke-width="1"/>
    <text x="${badgeX + lw + vw / 2}" y="39" text-anchor="middle" font-size="11" fill="${C.text}" font-family="system-ui,sans-serif">${esc(b.value)}</text>`;
    badgeX += lw + vw + 6;
  }

  return `
  <text x="14" y="32" font-size="18" font-weight="700" fill="${C.text}" font-family="system-ui,sans-serif">${esc(timeline.package)}</text>
  <text x="14" y="52" font-size="11" fill="${C.textSec}" font-family="system-ui,sans-serif">v${esc(s.latestVersion)} · ${s.totalVersions} versions</text>
  ${out}`;
}

function renderAnnotationChips(allAnnotations, toX, versions) {
  if (allAnnotations.length === 0) return '';
  const versionDateMap = new Map(versions.map(v => [v.version, v.publishDate]));
  const chipY = HEADER_H + 4;
  const chipH = 20;
  const FONT_W = 6.5, PAD = 10;

  const placed = [];
  for (const chip of allAnnotations) {
    const date = versionDateMap.get(chip.version);
    if (!date) continue;
    const lineX = toX(date);
    const w = chip.label.length * FONT_W + PAD * 2;
    let cx = Math.max(ML, Math.min(ML + CHART_W - w, lineX - w / 2));
    for (const p of placed) {
      if (cx < p.x + p.w + 4 && cx + w > p.x - 4) cx = p.x + p.w + 6;
    }
    placed.push({ x: cx, w, label: chip.label, type: chip.type, lineX });
  }

  let out = '';
  for (const p of placed) {
    const palette = C.chips[p.type] ?? C.chips.deps_changed;
    out += `
    <line x1="${p.lineX.toFixed(1)}" y1="${chipY + chipH}" x2="${p.lineX.toFixed(1)}" y2="${CHART_BOTTOM}" stroke="${palette.border}" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
    <rect x="${p.x.toFixed(1)}" y="${chipY}" width="${p.w}" height="${chipH}" rx="3" fill="${palette.bg}" stroke="${palette.border}" stroke-width="1"/>
    <text x="${(p.x + p.w / 2).toFixed(1)}" y="${chipY + 13}" text-anchor="middle" font-size="10" fill="${palette.text}" font-weight="600" font-family="system-ui,sans-serif">${esc(p.label)}</text>`;
  }
  return out;
}

function renderGrid(sizeMax, dlMax) {
  const TICKS = 5;
  let out = '';
  for (let i = 0; i <= TICKS; i++) {
    const val = (sizeMax / TICKS) * i;
    const y = CHART_BOTTOM - (val / sizeMax) * CHART_H;
    if (y < CHART_TOP - 2 || y > CHART_BOTTOM + 2) continue;
    out += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${ML + CHART_W}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    out += `<text x="${ML - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.textSec}" font-family="system-ui,sans-serif">${esc(formatBytes(val))}</text>`;
    if (dlMax > 0) {
      const dlVal = (dlMax / TICKS) * i;
      out += `<text x="${ML + CHART_W + 6}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="10" fill="${C.downloads}" font-family="system-ui,sans-serif">${esc(formatDownloads(dlVal))}</text>`;
    }
  }
  return out;
}

function renderSizeBars(versions, toX, maxSize) {
  if (maxSize === 0) return '';
  let out = '';
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const x = toX(v.publishDate);
    const nextX = i + 1 < versions.length ? toX(versions[i + 1].publishDate) : ML + CHART_W;
    const barW = Math.max(2, (nextX - x) * 0.65);

    if (!v.unpackedSize.available || v.unpackedSize.value == null) {
      out += `
      <rect x="${(x - barW / 2).toFixed(1)}" y="${CHART_BOTTOM - 12}" width="${barW.toFixed(1)}" height="12" rx="1" fill="${C.na}" opacity="0.5"/>
      <text x="${x.toFixed(1)}" y="${CHART_BOTTOM - 3}" text-anchor="middle" font-size="7" fill="${C.naText}" font-family="system-ui,sans-serif">n/a</text>`;
    } else {
      const h = Math.max(2, (v.unpackedSize.value / maxSize) * CHART_H);
      const y = CHART_BOTTOM - h;
      out += `
      <rect x="${(x - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${C.size}" opacity="0.85">
        <title>${esc(v.version)}: ${formatBytes(v.unpackedSize.value)} unpacked</title>
      </rect>`;
    }
  }
  return out;
}

function renderDownloadsLine(dailyDownloads, toX, maxDownloads) {
  if (maxDownloads === 0 || dailyDownloads.length === 0) return '';

  const WINDOW = 7;
  const smoothed = [];
  for (let i = 0; i < dailyDownloads.length; i++) {
    const slice = dailyDownloads.slice(
      Math.max(0, i - Math.floor(WINDOW / 2)),
      Math.min(dailyDownloads.length, i + Math.ceil(WINDOW / 2))
    );
    const avg = slice.reduce((s, d) => s + d.downloads, 0) / slice.length;
    const x = toX(dailyDownloads[i].day);
    const y = CHART_BOTTOM - (avg / maxDownloads) * CHART_H;
    if (x >= ML && x <= ML + CHART_W) smoothed.push([x, y]);
  }

  if (smoothed.length < 2) return '';

  const areaPath = svgPath(smoothed) +
    ` L${smoothed[smoothed.length - 1][0].toFixed(1)},${CHART_BOTTOM} L${smoothed[0][0].toFixed(1)},${CHART_BOTTOM} Z`;

  return `
  <path d="${areaPath}" fill="${C.downloadsFill}"/>
  <polyline points="${smoothed.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"
    fill="none" stroke="${C.downloads}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
}

function renderVersionAxis(versions, toX) {
  if (versions.length === 0) return '';
  const MIN_SPACING = 40;
  const majors = new Set();
  let prevMajor = -1;
  for (const v of versions) {
    const maj = parseInt(v.version.split('.')[0], 10);
    if (maj !== prevMajor) { majors.add(v.version); prevMajor = maj; }
  }

  const labeled = [];
  let lastLabelX = -999;
  for (const v of versions) {
    const x = toX(v.publishDate);
    const isMajor = majors.has(v.version);
    const isEdge = v === versions[0] || v === versions[versions.length - 1];
    if ((isMajor || isEdge) && x - lastLabelX >= MIN_SPACING) {
      labeled.push(v);
      lastLabelX = x;
    }
  }

  let out = '';
  for (const v of versions) {
    const x = toX(v.publishDate);
    out += `<line x1="${x.toFixed(1)}" y1="${CHART_BOTTOM}" x2="${x.toFixed(1)}" y2="${CHART_BOTTOM + 4}" stroke="${C.border}" stroke-width="1"/>`;
  }
  for (const v of labeled) {
    const x = toX(v.publishDate);
    out += `<text transform="translate(${x.toFixed(1)},${CHART_BOTTOM + 8}) rotate(45)" font-size="9" fill="${C.textSec}" font-family="system-ui,sans-serif">v${esc(v.version)}</text>`;
  }
  out += `<line x1="${ML}" y1="${CHART_BOTTOM}" x2="${ML + CHART_W}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`;
  return out;
}

function renderAxisLabels() {
  const midY = CHART_TOP + CHART_H / 2;
  return `
  <text transform="translate(${ML - 58},${midY}) rotate(-90)" text-anchor="middle" font-size="10" fill="${C.textSec}" font-family="system-ui,sans-serif">Size (unpacked)</text>
  <text transform="translate(${ML + CHART_W + 62},${midY}) rotate(90)" text-anchor="middle" font-size="10" fill="${C.downloads}" font-family="system-ui,sans-serif">Downloads (trend)</text>`;
}

function renderLegend() {
  const lx = ML + CHART_W - 180;
  const ly = CHART_TOP + 8;
  return `
  <rect x="${lx}" y="${ly}" width="172" height="38" rx="4" fill="${C.bg}" stroke="${C.border}" stroke-width="1"/>
  <rect x="${lx + 8}" y="${ly + 8}" width="10" height="10" rx="1" fill="${C.size}" opacity="0.85"/>
  <text x="${lx + 22}" y="${ly + 17}" font-size="10" fill="${C.text}" font-family="system-ui,sans-serif">Unpacked size</text>
  <line x1="${lx + 8}" y1="${ly + 26}" x2="${lx + 18}" y2="${ly + 26}" stroke="${C.downloads}" stroke-width="2"/>
  <text x="${lx + 22}" y="${ly + 30}" font-size="10" fill="${C.text}" font-family="system-ui,sans-serif">Downloads (estimate)</text>`;
}

function renderFooter(timeline) {
  const y0 = H - 58;
  let out = `<text x="${ML}" y="${y0}" font-size="9" fill="${C.textMuted}" font-family="system-ui,sans-serif">⚠ Downloads during active period = trend estimate — not direct per-version data.</text>`;

  let sx = ML;
  const sy = y0 + 16;
  for (const [src, status] of Object.entries(timeline.dataSourceStatus)) {
    const color = status === 'ok' ? '#2ea043' : status === 'partial' ? '#d4a72c' : C.na;
    out += `<circle cx="${sx + 5}" cy="${sy - 4}" r="4" fill="${color}"/>`;
    out += `<text x="${sx + 12}" y="${sy}" font-size="9" fill="${C.textSec}" font-family="system-ui,sans-serif">${esc(src)}</text>`;
    sx += src.length * 6.5 + 22;
  }

  out += `<text x="${ML + CHART_W}" y="${sy}" text-anchor="end" font-size="9" fill="${C.textMuted}" font-family="system-ui,sans-serif">pkgstory · ${new Date(timeline.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</text>`;
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function render(timeline) {
  const { versions, dailyDownloads } = timeline;

  const allAnnotations = versions.flatMap(v => v.annotations);
  const toX = makeTimeMapper(versions);

  const sizes = versions.map(v => v.unpackedSize.value).filter(s => s != null);
  const maxSizeRaw = sizes.length > 0 ? Math.max(...sizes) : 0;
  const { niceMax: maxSize } = niceScale(maxSizeRaw);

  const maxDlRaw = dailyDownloads.length > 0 ? Math.max(...dailyDownloads.map(d => d.downloads)) : 0;
  const { niceMax: maxDownloads } = niceScale(maxDlRaw);

  const hasData = sizes.length > 0 || dailyDownloads.length > 0;
  const noDataMsg = `<text x="${W / 2}" y="${CHART_TOP + CHART_H / 2}" text-anchor="middle" font-size="14" fill="${C.textMuted}" font-family="system-ui,sans-serif">No data available</text>`;

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Package history: ${esc(timeline.package)}">`,
    `<title>pkgstory: ${esc(timeline.package)}</title>`,
    `<desc>Historical size and download trend for ${esc(timeline.package)}, ${timeline.summary.totalVersions} versions</desc>`,

    `<rect width="${W}" height="${H}" fill="${C.bg}" rx="6" stroke="${C.border}" stroke-width="1"/>`,
    `<line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="${C.border}" stroke-width="1"/>`,

    `<g id="header">${renderHeader(timeline)}</g>`,
    `<g id="annotations">${renderAnnotationChips(allAnnotations, toX, versions)}</g>`,

    `<rect x="${ML}" y="${CHART_TOP}" width="${CHART_W}" height="${CHART_H}" fill="none" stroke="${C.border}" stroke-width="1"/>`,

    `<g id="grid">`,
    maxSize > 0 ? renderGrid(maxSize, maxDownloads) : '',
    renderAxisLabels(),
    `</g>`,

    `<g id="chart">`,
    hasData
      ? renderDownloadsLine(dailyDownloads, toX, maxDownloads) + renderSizeBars(versions, toX, maxSize)
      : noDataMsg,
    `</g>`,

    `<g id="x-axis">${renderVersionAxis(versions, toX)}</g>`,

    `<line x1="${ML}" y1="${CHART_TOP}" x2="${ML}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`,
    `<line x1="${ML + CHART_W}" y1="${CHART_TOP}" x2="${ML + CHART_W}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`,

    `<g id="legend">${renderLegend()}</g>`,
    `<g id="footer">${renderFooter(timeline)}</g>`,

    `</svg>`,
  ].join('\n');
}
