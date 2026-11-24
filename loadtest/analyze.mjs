// Summarise harness results and the wrangler tail log.
//   node loadtest/analyze.mjs loadtest/results/stage-10.json [...more] [--tail loadtest/results/tail.jsonl]
import { readFileSync, existsSync } from 'node:fs';

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--tail');
const tailFile = process.argv.includes('--tail') ? process.argv[process.argv.indexOf('--tail') + 1] : null;
const pct = (xs, p) => { if (!xs.length) return '-'; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

for (const f of files) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n=== ${f}: ${r.guests} guests x ${r.files} files, wall ${r.wall_s}s, ${r.log.length} requests`);
  const routes = [...new Set(r.log.map((x) => x.route))];
  console.log('route            n     p50ms  p95ms  max    statuses');
  for (const route of routes) {
    const xs = r.log.filter((x) => x.route === route);
    const ok = xs.filter((x) => typeof x.status === 'number' && x.status < 400).map((x) => x.ms);
    const st = {};
    for (const x of xs) st[x.status] = (st[x.status] || 0) + 1;
    console.log(`${route.padEnd(16)} ${String(xs.length).padEnd(5)} ${String(pct(ok, 0.5)).padEnd(6)} ${String(pct(ok, 0.95)).padEnd(6)} ${String(Math.max(0, ...ok)).padEnd(6)} ${JSON.stringify(st)}`);
  }
  const errs = r.log.filter((x) => typeof x.status !== 'number' || x.status >= 400);
  const groups = {};
  for (const e of errs) { const k = `${e.route} ${e.status} ${e.code || ''} ${e.platform || ''} ${e.error || ''}`.trim(); groups[k] = (groups[k] || 0) + 1; }
  if (errs.length) { console.log('errors:'); for (const [k, n] of Object.entries(groups)) console.log(`  ${n} x ${k}`); }
  const plat = r.log.filter((x) => x.platform);
  if (plat.length) console.log('platform/non-JSON responses:', plat.map((x) => `${x.status}:${x.platform}`).join(', '), '\n  e.g.', plat[0].snippet);
  const media = r.log.filter((x) => x.route === 'media' && x.status === 201);
  const mb = media.reduce((a, x) => a + x.bytes, 0) / 1048576;
  console.log(`media throughput: ${mb.toFixed(0)} MB in ${r.wall_s}s = ${(mb / r.wall_s).toFixed(1)} MB/s; expected=${r.expected.length} abandoned=${r.abandoned.length}`);
}

if (tailFile && existsSync(tailFile)) {
  const raw = readFileSync(tailFile, 'utf8');
  const events = raw.split(/\n(?=\{)/).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  console.log(`\n=== wrangler tail: ${events.length} invocations`);
  const byRoute = {};
  for (const e of events) {
    const u = e.event?.request?.url ? new URL(e.event.request.url) : null;
    const m = e.event?.request?.method || '?';
    const p = u ? u.pathname.replace(/[0-9a-f-]{36}/g, ':id').replace(/\/api\/(events|admin)\/[a-z0-9-]+/, '/api/$1/:slug').replace(/parts\/\d+/, 'parts/:n') : 'cron';
    const k = `${m} ${p}`;
    (byRoute[k] ||= []).push(e);
  }
  console.log('route                                   n     cpu p50/p95/max   wall p50/p95/max   outcomes');
  for (const [k, xs] of Object.entries(byRoute).sort((a, b) => b[1].length - a[1].length)) {
    const cpu = xs.map((x) => x.cpuTime ?? 0), wall = xs.map((x) => x.wallTime ?? 0);
    const oc = {}; for (const x of xs) oc[x.outcome] = (oc[x.outcome] || 0) + 1;
    console.log(`${k.slice(0, 39).padEnd(39)} ${String(xs.length).padEnd(5)} ${pct(cpu, 0.5)}/${pct(cpu, 0.95)}/${Math.max(...cpu)}`.padEnd(66) + `${pct(wall, 0.5)}/${pct(wall, 0.95)}/${Math.max(...wall)}`.padEnd(19) + JSON.stringify(oc));
  }
  const ex = events.filter((e) => e.exceptions?.length || e.logs?.some((l) => l.level === 'error'));
  const exg = {};
  for (const e of ex) {
    const msg = (e.exceptions?.[0]?.message || e.logs.find((l) => l.level === 'error')?.message?.join?.(' ') || JSON.stringify(e.logs.find((l) => l.level === 'error')?.message) || '').slice(0, 200);
    exg[msg] = (exg[msg] || 0) + 1;
  }
  if (ex.length) { console.log('exceptions / console.error:'); for (const [k, n] of Object.entries(exg)) console.log(`  ${n} x ${k}`); }
}
