import { formatBytes, formatDownloads, formatDays } from '../utils.js';
import type { TimelineJSON, VersionPoint, DailyDownload, AnnotationChip } from '../types.js';

// ── Dimensions ──────────────────────────────────────────────────────────────
const W = 900;
const H = 500;

const HEADER_H = 72;
const CHIP_H = 36;
const CHART_TOP = HEADER_H + CHIP_H + 8;
const CHART_BOTTOM = H - 90;
const CHART_H = CHART_BOTTOM - CHART_TOP;

const ML = 82; // left margin (size axis)
const MR = 78; // right margin (downloads axis)
const CHART_W = W - ML - MR;

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: '#ffffff',
  border: '#d0d7de',
  grid: '#f3f4f6',
  text: '#1f2328',
  textSec: '#6e7781',
  textMuted: '#9ea7b3',
  size: '#0969da',
  sizeFill: '#dbeafe',
  downloads: '#1a7f37',
  downloadsFill: 'rgba(26,127,55,0.08)',
  na: '#d0d7de',
  naText: '#9ea7b3',
  chips: {
    major_release: { bg: '#fff1e6', border: '#fb8f44', text: '#953800' },
    esm_introduced: { bg: '#f0eaff', border: '#8957e5', text: '#512a97' },
    types_added: { bg: '#dff7e2', border: '#2ea043', text: '#116329' },
    treeshaking_enabled: { bg: '#dff7e2', border: '#2ea043', text: '#116329' },
    deps_changed: { bg: '#fff8c5', border: '#d4a72c', text: '#7d4e00' },
    peer_deps_added: { bg: '#fff8c5', border: '#d4a72c', text: '#7d4e00' },
  } as Record<string, { bg: string; border: string; text: string }>,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function niceScale(max: number, ticks = 5): { step: number; niceMax: number } {
  if (max === 0) return { step: 1, niceMax: 5 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm <= 1.5) step = 1;
  else if (norm <= 3) step = 2;
  else if (norm <= 7) step = 5;
  else step = 10;
  step *= mag;
  return { step, niceMax: Math.ceil(max / step) * step };
}

function svgPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
}

// ── Coordinate mappers ───────────────────────────────────────────────────────
function makeTimeMapper(versions: VersionPoint[]): (isoDate: string) => number {
  if (versions.length === 0) return () => ML;
  const first = new Date(versions[0].publishDate).getTime();
  const last = new Date(versions[versions.length - 1].publishDate).getTime();
  const span = last - first || 1;
  return (isoDate: string) => {
    const t = new Date(isoDate).getTime();
    return ML + ((t - first) / span) * CHART_W;
  };
}

// ── Sub-renderers ─────────────────────────────────────────────────────────────
function renderHeader(timeline: TimelineJSON): string {
  const s = timeline.summary;
  const sizeStr = s.latestUnpackedSize != null ? formatBytes(s.latestUnpackedSize) : 'n/a';
  const dlStr = s.latestWeeklyDownloads != null ? formatDownloads(s.latestWeeklyDownloads) + '/wk' : 'n/a';
  const depsStr = s.latestDepCount != null ? String(s.latestDepCount) : 'n/a';
  const ageStr = formatDays(s.packageAgeDays);

  const badges = [
    { label: 'size', value: sizeStr, color: C.size },
    { label: 'weekly dl', value: dlStr, color: C.downloads },
    { label: 'deps', value: depsStr, color: '#6e7781' },
    { label: 'age', value: ageStr, color: '#6e7781' },
  ];

  let badgeX = 180;
  let out = '';
  for (const b of badges) {
    const lw = b.label.length * 6.5 + 10;
    const vw = b.value.length * 7.5 + 10;
    out += `
    <rect x="${badgeX}" y="24" width="${lw}" height="22" rx="3" fill="${b.color}" />
    <text x="${badgeX + lw / 2}" y="39" text-anchor="middle" font-size="11" fill="#fff" font-weight="600" font-family="system-ui,sans-serif">${esc(b.label)}</text>
    <rect x="${badgeX + lw}" y="24" width="${vw}" height="22" rx="0" fill="#f3f4f6" stroke="${C.border}" stroke-width="1" />
    <rect x="${badgeX + lw + vw - 3}" y="24" width="3" height="22" rx="0 3 3 0" fill="#f3f4f6" />
    <text x="${badgeX + lw + vw / 2}" y="39" text-anchor="middle" font-size="11" fill="${C.text}" font-family="system-ui,sans-serif">${esc(b.value)}</text>`;
    badgeX += lw + vw + 6;
  }

  return `
  <text x="14" y="32" font-size="18" font-weight="700" fill="${C.text}" font-family="system-ui,sans-serif">${esc(timeline.package)}</text>
  <text x="14" y="52" font-size="11" fill="${C.textSec}" font-family="system-ui,sans-serif">v${esc(s.latestVersion)} · ${s.totalVersions} versions</text>
  ${out}`;
}

function renderAnnotationChips(
  allAnnotations: AnnotationChip[],
  toX: (date: string) => number,
  versions: VersionPoint[]
): string {
  if (allAnnotations.length === 0) return '';

  const versionDateMap = new Map<string, string>(versions.map(v => [v.version, v.publishDate]));
  const chipY = HEADER_H + 4;
  const chipH = 20;

  // Layout: cluster chips and stagger to avoid overlap
  const placed: Array<{ x: number; w: number; label: string; type: string; lineX: number }> = [];
  const FONT_W = 6.5;
  const PAD = 10;

  for (const chip of allAnnotations) {
    const date = versionDateMap.get(chip.version);
    if (!date) continue;
    const lineX = toX(date);
    const label = chip.label;
    const w = label.length * FONT_W + PAD * 2;

    // Find non-overlapping x
    let cx = Math.max(ML, Math.min(ML + CHART_W - w, lineX - w / 2));
    // Nudge right if overlapping previous
    for (const p of placed) {
      if (cx < p.x + p.w + 4 && cx + w > p.x - 4) {
        cx = p.x + p.w + 6;
      }
    }
    placed.push({ x: cx, w, label, type: chip.type, lineX });
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

function renderGrid(sizeStep: number, sizeMax: number, dlStep: number, dlMax: number): string {
  let out = '';
  const TICKS = 5;

  // Horizontal grid lines (size axis)
  for (let i = 0; i <= TICKS; i++) {
    const val = (sizeMax / TICKS) * i;
    const y = CHART_BOTTOM - (val / sizeMax) * CHART_H;
    if (y < CHART_TOP - 2 || y > CHART_BOTTOM + 2) continue;
    out += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${ML + CHART_W}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    // Left axis label
    const label = formatBytes(val);
    out += `<text x="${ML - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.textSec}" font-family="system-ui,sans-serif">${esc(label)}</text>`;
    // Right axis label (downloads)
    if (dlMax > 0) {
      const dlVal = (dlMax / TICKS) * i;
      out += `<text x="${ML + CHART_W + 6}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="10" fill="${C.downloads}" font-family="system-ui,sans-serif">${esc(formatDownloads(dlVal))}</text>`;
    }
  }

  return out;
}

function renderSizeBars(
  versions: VersionPoint[],
  toX: (date: string) => number,
  maxSize: number
): string {
  if (maxSize === 0) return '';
  let out = '';

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const x = toX(v.publishDate);
    const nextX = i + 1 < versions.length ? toX(versions[i + 1].publishDate) : ML + CHART_W;
    const barW = Math.max(2, (nextX - x) * 0.65);
    const cx = x;

    if (!v.unpackedSize.available || v.unpackedSize.value == null) {
      // n/a marker
      out += `
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${CHART_BOTTOM - 12}" width="${barW.toFixed(1)}" height="12" rx="1" fill="${C.na}" opacity="0.5"/>
      <text x="${cx.toFixed(1)}" y="${CHART_BOTTOM - 3}" text-anchor="middle" font-size="7" fill="${C.naText}" font-family="system-ui,sans-serif">n/a</text>`;
    } else {
      const h = Math.max(2, (v.unpackedSize.value / maxSize) * CHART_H);
      const y = CHART_BOTTOM - h;
      out += `
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${C.size}" opacity="0.85">
        <title>${esc(v.version)}: ${formatBytes(v.unpackedSize.value)} unpacked</title>
      </rect>`;
    }
  }

  return out;
}

function renderDownloadsLine(
  dailyDownloads: DailyDownload[],
  toX: (date: string) => number,
  maxDownloads: number
): string {
  if (maxDownloads === 0 || dailyDownloads.length === 0) return '';

  // Smooth the line: use 7-day rolling average to reduce noise
  const smoothed: Array<[number, number]> = [];
  const WINDOW = 7;
  for (let i = 0; i < dailyDownloads.length; i++) {
    const slice = dailyDownloads.slice(
      Math.max(0, i - Math.floor(WINDOW / 2)),
      Math.min(dailyDownloads.length, i + Math.ceil(WINDOW / 2))
    );
    const avg = slice.reduce((s, d) => s + d.downloads, 0) / slice.length;
    const x = toX(dailyDownloads[i].day);
    const y = CHART_BOTTOM - (avg / maxDownloads) * CHART_H;
    if (x >= ML && x <= ML + CHART_W) {
      smoothed.push([x, y]);
    }
  }

  if (smoothed.length < 2) return '';

  // Area fill
  const areaPath =
    svgPath(smoothed) +
    ` L${smoothed[smoothed.length - 1][0].toFixed(1)},${CHART_BOTTOM} L${smoothed[0][0].toFixed(1)},${CHART_BOTTOM} Z`;

  return `
  <path d="${areaPath}" fill="${C.downloadsFill}" />
  <polyline points="${smoothed.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"
    fill="none" stroke="${C.downloads}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
}

function renderVersionAxis(
  versions: VersionPoint[],
  toX: (date: string) => number
): string {
  if (versions.length === 0) return '';

  // Decide which versions to label (avoid crowding)
  const MIN_SPACING = 40;
  const labeledVersions: VersionPoint[] = [];
  let lastLabelX = -999;

  // Always try to label: first, last, and majors
  const majors = new Set<string>();
  let prevMajor = -1;
  for (const v of versions) {
    const maj = parseInt(v.version.split('.')[0], 10);
    if (maj !== prevMajor) { majors.add(v.version); prevMajor = maj; }
  }

  for (const v of versions) {
    const x = toX(v.publishDate);
    const isMajor = majors.has(v.version);
    const isFirstOrLast = v === versions[0] || v === versions[versions.length - 1];
    if ((isMajor || isFirstOrLast) && x - lastLabelX >= MIN_SPACING) {
      labeledVersions.push(v);
      lastLabelX = x;
    }
  }

  let out = '';
  for (const v of versions) {
    const x = toX(v.publishDate);
    out += `<line x1="${x.toFixed(1)}" y1="${CHART_BOTTOM}" x2="${x.toFixed(1)}" y2="${CHART_BOTTOM + 4}" stroke="${C.border}" stroke-width="1"/>`;
  }

  for (const v of labeledVersions) {
    const x = toX(v.publishDate);
    const label = `v${v.version}`;
    out += `
    <text transform="translate(${x.toFixed(1)},${CHART_BOTTOM + 8}) rotate(45)"
      font-size="9" fill="${C.textSec}" font-family="system-ui,sans-serif">${esc(label)}</text>`;
  }

  // Axis line
  out += `<line x1="${ML}" y1="${CHART_BOTTOM}" x2="${ML + CHART_W}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`;

  return out;
}

function renderAxisLabels(): string {
  const sizeY = CHART_TOP + CHART_H / 2;
  const dlY = CHART_TOP + CHART_H / 2;

  return `
  <text transform="translate(${ML - 58},${sizeY}) rotate(-90)"
    text-anchor="middle" font-size="10" fill="${C.textSec}" font-family="system-ui,sans-serif">Size (unpacked)</text>
  <text transform="translate(${ML + CHART_W + 62},${dlY}) rotate(90)"
    text-anchor="middle" font-size="10" fill="${C.downloads}" font-family="system-ui,sans-serif">Downloads (trend)</text>`;
}

function renderFooter(timeline: TimelineJSON): string {
  const y0 = H - 58;
  const statusItems = Object.entries(timeline.dataSourceStatus).map(([src, status]) => ({
    src,
    status,
  }));

  let out = `<text x="${ML}" y="${y0}" font-size="9" fill="${C.textMuted}" font-family="system-ui,sans-serif">`;
  out += `&#x26A0; Downloads during active period = trend estimate (sum of daily downloads between release dates) — not direct per-version data.`;
  out += `</text>`;

  let sx = ML;
  const sy = y0 + 16;
  for (const item of statusItems) {
    const color =
      item.status === 'ok'
        ? '#2ea043'
        : item.status === 'partial'
        ? '#d4a72c'
        : item.status === 'unavailable'
        ? C.na
        : C.na;
    const label = item.src;
    out += `<circle cx="${sx + 5}" cy="${sy - 4}" r="4" fill="${color}"/>`;
    out += `<text x="${sx + 12}" y="${sy}" font-size="9" fill="${C.textSec}" font-family="system-ui,sans-serif">${esc(label)}</text>`;
    sx += label.length * 6.5 + 22;
  }

  // Generated timestamp
  out += `<text x="${ML + CHART_W}" y="${sy}" text-anchor="end" font-size="9" fill="${C.textMuted}" font-family="system-ui,sans-serif">pkg-observatory · ${new Date(timeline.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</text>`;

  return out;
}

function renderNoData(): string {
  return `<text x="${W / 2}" y="${CHART_TOP + CHART_H / 2}" text-anchor="middle" font-size="14" fill="${C.textMuted}" font-family="system-ui,sans-serif">No data available</text>`;
}

// ── Main render ───────────────────────────────────────────────────────────────
export function render(timeline: TimelineJSON): string {
  const { versions, dailyDownloads } = timeline;

  // Collect all annotations for chip row
  const allAnnotations = versions.flatMap(v => v.annotations);

  const toX = makeTimeMapper(versions);

  // Size scale
  const sizes = versions.map(v => v.unpackedSize.value).filter((s): s is number => s != null);
  const maxSizeRaw = sizes.length > 0 ? Math.max(...sizes) : 0;
  const { niceMax: maxSize } = niceScale(maxSizeRaw);

  // Downloads scale
  const maxDlRaw = dailyDownloads.length > 0 ? Math.max(...dailyDownloads.map(d => d.downloads)) : 0;
  const { niceMax: maxDownloads, step: dlStep } = niceScale(maxDlRaw);
  const { step: sizeStep } = niceScale(maxSizeRaw);

  const hasAnyData = sizes.length > 0 || dailyDownloads.length > 0;

  const svgParts = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Package history: ${esc(timeline.package)}">`,
    `<title>Package observatory: ${esc(timeline.package)}</title>`,
    `<desc>Historical size and download trend for ${esc(timeline.package)}, ${timeline.summary.totalVersions} versions, generated ${timeline.generatedAt}</desc>`,

    // Background
    `<rect width="${W}" height="${H}" fill="${C.bg}" rx="6" stroke="${C.border}" stroke-width="1"/>`,

    // Divider under header
    `<line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="${C.border}" stroke-width="1"/>`,

    // Header
    `<g id="header">`,
    renderHeader(timeline),
    `</g>`,

    // Annotation chips
    `<g id="annotations">`,
    renderAnnotationChips(allAnnotations, toX, versions),
    `</g>`,

    // Chart frame
    `<rect x="${ML}" y="${CHART_TOP}" width="${CHART_W}" height="${CHART_H}" fill="none" stroke="${C.border}" stroke-width="1"/>`,

    // Grid + axis labels
    `<g id="grid">`,
    maxSize > 0 ? renderGrid(sizeStep, maxSize, dlStep, maxDownloads) : '',
    renderAxisLabels(),
    `</g>`,

    // Data series
    `<g id="chart">`,
    hasAnyData
      ? [
          renderDownloadsLine(dailyDownloads, toX, maxDownloads),
          renderSizeBars(versions, toX, maxSize),
        ].join('\n')
      : renderNoData(),
    `</g>`,

    // X axis
    `<g id="x-axis">`,
    renderVersionAxis(versions, toX),
    `</g>`,

    // Left + right axis lines
    `<line x1="${ML}" y1="${CHART_TOP}" x2="${ML}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`,
    `<line x1="${ML + CHART_W}" y1="${CHART_TOP}" x2="${ML + CHART_W}" y2="${CHART_BOTTOM}" stroke="${C.border}" stroke-width="1.5"/>`,

    // Legend
    `<g id="legend">`,
    `<rect x="${ML + CHART_W - 180}" y="${CHART_TOP + 8}" width="172" height="38" rx="4" fill="${C.bg}" stroke="${C.border}" stroke-width="1"/>`,
    `<rect x="${ML + CHART_W - 172}" y="${CHART_TOP + 16}" width="10" height="10" rx="1" fill="${C.size}" opacity="0.85"/>`,
    `<text x="${ML + CHART_W - 158}" y="${CHART_TOP + 25}" font-size="10" fill="${C.text}" font-family="system-ui,sans-serif">Unpacked size</text>`,
    `<line x1="${ML + CHART_W - 172}" y1="${CHART_TOP + 34}" x2="${ML + CHART_W - 162}" y2="${CHART_TOP + 34}" stroke="${C.downloads}" stroke-width="2"/>`,
    `<text x="${ML + CHART_W - 158}" y="${CHART_TOP + 38}" font-size="10" fill="${C.text}" font-family="system-ui,sans-serif">Downloads (estimate)</text>`,
    `</g>`,

    // Footer
    `<g id="footer">`,
    renderFooter(timeline),
    `</g>`,

    `</svg>`,
  ];

  return svgParts.join('\n');
}
