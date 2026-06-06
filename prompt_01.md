# Build prompt: `pkgstory`

Build a tool that turns an npm package's history into a single, embeddable SVG that tells the story of how the package evolved — size, dependencies, module format, and adoption — over its released versions. Output is a downloadable SVG suitable for a README. Ship a web demo page and a CLI.

Stack: TypeScript, Node 20+. No framework requirement for the demo beyond what you justify. Keep dependencies minimal.

---

## Non-negotiable data contract

This is the part most easy to get wrong. Honor these limits exactly; do not invent data to fill gaps.

1. **Per-version download counts over time DO NOT EXIST publicly** as a direct API call. npm only exposes per-version downloads for the trailing 7 days (`GET https://api.npmjs.org/versions/{pkg}/last-week`). However, a **reconstructed trend** is valid and should be built as follows: take the total daily downloads curve (from the range API), and for each version compute `downloads_during_active_window` — the sum of daily downloads between that version's publish date and the next version's publish date. This is real data from two real sources yielding a useful approximation. Caveats to encode in the data model: users who pin old versions inflate this figure for successor versions; and the final version has no end date so its window is open-ended. Label this metric exactly as "downloads during active period" — never as "version downloads" or any phrasing that implies direct attribution. The SVG should visually distinguish it as a trend estimate, not a measurement.

2. **Total downloads over time DO exist** via `GET https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}`, capped at 18 months per request and reaching back no earlier than 2015-01-10. Chunk requests to cover the full lifespan. This API is aggressively rate-limited — caching is mandatory, not optional.

3. **Size is measured per version, not fetched as history.** Compute it yourself from the tarball as the primary source. Use packagephobia as a secondary/cross-check. Treat bundlephobia as optional and unreliable.

4. **Release dates are authoritative from the npm registry `time` field.** GitHub release notes are annotation only, and GitHub tags do not always map 1:1 to npm versions — treat that join as fuzzy and never block on it.

5. When a source is missing or fails, the renderer degrades gracefully and the SVG visibly marks the metric as unavailable rather than guessing.

---

## Data sources (in priority order)

**Primary (must work without these failing the whole run):**
- npm registry manifest: `GET https://registry.npmjs.org/{pkg}` — full version list, publish timestamps (`time`), per-version `dependencies`/`peerDependencies`, `type`, `exports`, `sideEffects`, `types`/`typings`, `dist.tarball`, `repository`.
- npm downloads range: `GET https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}` — total daily downloads, chunked ≤18mo, floor 2015-01-10.
- Tarball analysis: download `dist.tarball` per version, compute: total unpacked size, gzipped tarball size, file count, exported-symbol count (best-effort static parse), module format (CJS / ESM / dual via `exports` + file extensions), presence of `.d.ts`.

**Secondary (cross-check / enrich; never block on these):**
- packagephobia: `GET https://packagephobia.com/api.json?p={pkg}@{version}` — install size and publish size per version. Reliable, well-maintained.
- bundlephobia: `GET https://bundlephobia.com/api/size?package={pkg}@{version}` — minified + gzip bundle size, treeshake flag. Best-effort only; wrap in timeout + retry + cache; tolerate total absence.
- GitHub API: stars, forks, contributors, and release notes for timeline annotations. Optional; requires no auth for low volume but honor rate limits and allow a token via env var.

Do not pull in libraries.io, ecosyste.ms, or paid scrapers for v1. List them as future enrichment only.

---

## Derived metrics

Separate **measured** facts from **invented** ratios in both the data model and the SVG. Measured metrics (size, file count, dep count, format, downloads curve, release cadence) get full visual weight. Composite/vanity scores ("downloads per KB", "efficiency score") are allowed only in a clearly-labeled secondary zone and must never be presented as if they were measurements. If a composite metric can't be defended as meaningful, leave it out.

The honest signature insight to surface: **direction of size/deps over versions, overlaid against the total-downloads trend, with release dates marked.** That is the story. "Release impact" may be shown only as a marker on the total-downloads curve at a release date, explicitly framed as correlation.

---

## Architecture

Pipeline, each stage independently testable and cached:

1. `resolve` — validate package name, fetch registry manifest, produce ordered version list with publish dates.
2. `fetch` — gather downloads range (chunked), packagephobia per version, optional bundlephobia/GitHub. Concurrency-limited, retried, cached to disk keyed by `{pkg}@{version}@{source}`.
3. `analyze` — tarball download + static analysis per version.
4. `aggregate` — merge into a single normalized timeline JSON (the canonical intermediate artifact; the SVG is a pure function of this). Each metric carries a `source` and an `available: boolean`.
5. `render` — timeline JSON → SVG. Pure, deterministic, no network.

The cache layer is load-bearing because of npm rate limiting. Cache aggressively, support `--no-cache` and a TTL.

---

## Output: the SVG

One primary mode for v1, designed to be screenshot-worthy and README-embeddable. Hand-built SVG (no headless browser); deterministic; self-contained (inline fonts/styles, no external refs).

Layout to implement:
- X axis: versions in publish order (time-spaced, not evenly spaced).
- Primary series: bundle/unpacked size per version (area or bar).
- Overlaid series: total downloads trend (line, secondary axis), aligned by date.
- Markers at major releases; annotation chips for detectable transitions: "ESM introduced", "types added", "tree-shaking enabled (sideEffects:false)", "dependencies: N→M".
- A compact header strip: latest size, latest weekly downloads, dependency count, package age.
- Missing data rendered as an explicit muted "n/a" state, never interpolated.

Visual reference points: bundlephobia's version-bar layout, GitHub's contribution-graph density, shields.io's README-friendliness. Aim for "speaks for itself at a glance."

Defer to later versions: radar chart, multi-package compare, "release story" card variant. Build the data model so they're additive, not rewrites.

---

## Interfaces

- **Demo web page:** input a package name → fetch → render → preview → download SVG. Show the pipeline stages and which data sources succeeded/failed (honesty about gaps is a feature).
- **CLI:** `npx pkgstory <name> [--out file.svg] [--no-cache] [--github-token ...]`. Packaged for npm now; structure so a Homebrew formula is a thin wrapper later. The CLI emits the SVG to stdout or `--out` so it drops straight into a README.

---

## Definition of done

- Given a real package (test against a small one and a large one, e.g. one with <2k weekly downloads and one like `react`), produces a correct, self-contained SVG offline from cache.
- Zero fabricated data points; every rendered value traces to a real source or is marked unavailable.
- Bundlephobia being down does not break a run.
- The aggregate timeline JSON is dumpable (`--json`) so the rendering is auditable.

---

## Explicit don'ts

- Don't label `downloads_during_active_window` as "version downloads" or any phrasing implying direct attribution. Trend estimate; say so.
- Don't block the pipeline on any secondary source.
- Don't present composite scores as measurements.
- Don't use a headless browser to render the SVG.
- Don't oversell novelty in copy — the components exist; the synthesis and the embeddable artifact are the contribution.