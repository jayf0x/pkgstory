import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { runPipeline } from './pipeline/index.js';
import type { PipelineOptions, TimelineJSON } from './types.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

interface Job {
  id: string;
  pkg: string;
  status: 'running' | 'done' | 'error';
  events: Array<{ type: string; stage: string; message: string; pct?: number; ts: number }>;
  svg?: string;
  timeline?: TimelineJSON;
  error?: string;
  subscribers: Set<(data: string) => void>;
}

const jobs = new Map<string, Job>();

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function pushEvent(job: Job, type: string, stage: string, message: string, pct?: number): void {
  const ev = { type, stage, message, pct, ts: Date.now() };
  job.events.push(ev);
  const sseData = `data: ${JSON.stringify(ev)}\n\n`;
  for (const sub of job.subscribers) sub(sseData);
}

function startJob(job: Job, opts: PipelineOptions): void {
  runPipeline(job.pkg, {
    ...opts,
    onProgress: (stage, message, pct) => {
      pushEvent(job, 'progress', stage, message, pct);
    },
  })
    .then(result => {
      job.svg = result.svg;
      job.timeline = result.timeline;
      job.status = 'done';
      pushEvent(job, 'done', 'done', 'Pipeline complete');
      for (const sub of job.subscribers) sub('event: close\ndata: {}\n\n');
    })
    .catch(err => {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = 'error';
      pushEvent(job, 'error', 'error', job.error);
      for (const sub of job.subscribers) sub('event: close\ndata: {}\n\n');
    });
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
  };
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url ?? '/', true);
  const pathname = parsed.pathname ?? '/';
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  // POST /api/analyze — start a new job
  if (pathname === '/api/analyze' && method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await parseBody(req); }
    catch { json(res, { error: 'Invalid request body' }, 400); return; }

    const pkg = typeof body.pkg === 'string' ? body.pkg.trim() : '';
    if (!pkg) { json(res, { error: 'pkg is required' }, 400); return; }

    const id = genId();
    const job: Job = {
      id,
      pkg,
      status: 'running',
      events: [],
      subscribers: new Set(),
    };
    jobs.set(id, job);

    const opts: PipelineOptions = {
      skipTarballs: body.skipTarballs === true,
      skipBundlephobia: body.skipBundlephobia === true,
      maxVersions: typeof body.maxVersions === 'number' ? body.maxVersions : undefined,
      noCache: body.noCache === true,
    };

    startJob(job, opts);
    json(res, { jobId: id });
    return;
  }

  // GET /api/stream/:jobId — SSE stream of job events
  const streamMatch = pathname.match(/^\/api\/stream\/([^/]+)$/);
  if (streamMatch && method === 'GET') {
    const jobId = streamMatch[1];
    const job = jobs.get(jobId);
    if (!job) { json(res, { error: 'Job not found' }, 404); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Replay past events
    for (const ev of job.events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    if (job.status !== 'running') {
      res.write('event: close\ndata: {}\n\n');
      res.end();
      return;
    }

    const send = (data: string) => { res.write(data); };
    job.subscribers.add(send);

    req.on('close', () => {
      job.subscribers.delete(send);
    });

    // Keepalive ping every 15s
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  // GET /api/result/:jobId/svg
  const svgMatch = pathname.match(/^\/api\/result\/([^/]+)\/svg$/);
  if (svgMatch && method === 'GET') {
    const job = jobs.get(svgMatch[1]);
    if (!job) { json(res, { error: 'Job not found' }, 404); return; }
    if (job.status === 'running') { json(res, { error: 'Still running' }, 202); return; }
    if (job.status === 'error') { json(res, { error: job.error }, 500); return; }

    const pkg = job.pkg.replace(/[^a-z0-9-]/gi, '-');
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Disposition': `attachment; filename="${pkg}-observatory.svg"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(job.svg);
    return;
  }

  // GET /api/result/:jobId/json
  const jsonMatch = pathname.match(/^\/api\/result\/([^/]+)\/json$/);
  if (jsonMatch && method === 'GET') {
    const job = jobs.get(jsonMatch[1]);
    if (!job) { json(res, { error: 'Job not found' }, 404); return; }
    if (job.status === 'running') { json(res, { error: 'Still running' }, 202); return; }
    if (job.status === 'error') { json(res, { error: job.error }, 500); return; }
    json(res, job.timeline);
    return;
  }

  // GET /api/status/:jobId
  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/);
  if (statusMatch && method === 'GET') {
    const job = jobs.get(statusMatch[1]);
    if (!job) { json(res, { error: 'Job not found' }, 404); return; }
    json(res, {
      jobId: job.id,
      pkg: job.pkg,
      status: job.status,
      eventCount: job.events.length,
      error: job.error,
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`pkg-observatory demo running at http://localhost:${PORT}`);
});
