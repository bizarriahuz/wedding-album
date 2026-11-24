// Load harness for the guest upload path. Runs ONLY against the isolated load-test Worker.
//
//   node loadtest/harness.mjs --base https://madeofmemories-loadtest.<acct>.workers.dev \
//     --slug <test slug> --token <guest token> --admin <admin token> \
//     --guests 60 --files 8 [--video] [--booth] --out loadtest/results/stage-60.json
//
// Each simulated guest behaves like public/guest.js: join, then one upload at a time
// (thumb PUT then media PUT), polling the feed every 20 s. Photos are 2-8 MB, 70% JPEG
// with a thumb, 30% HEIC sent raw with no thumb (the client's fallback when it can't decode).

import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fetch, Agent } from 'undici';

// Each simulated phone gets its own HTTP/1.1 connection pool, like a real device.
// (Sharing one pool multiplexes every guest over a single HTTP/2 connection, which
// Cloudflare resets with ERR_HTTP2_STREAM_ERROR past ~100 streams: a harness artifact.)
const device = new AsyncLocalStorage();
const asDevice = (fn) => device.run(new Agent({ connections: 4, allowH2: false, bodyTimeout: 180000, headersTimeout: 180000 }), fn);

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const BASE = String(args.base || '');
if (!/loadtest/.test(BASE)) { console.error('Refusing: --base must be the load-test Worker'); process.exit(2); }
if (/harris-aqilah/.test(String(args.slug))) { console.error('Refusing: production slug'); process.exit(2); }

const SLUG = args.slug, TOKEN = args.token, ADMIN = args.admin;
const GUESTS = Number(args.guests || 60), FILES = Number(args.files || 8);
const ABORT_P = Number(args.abort ?? 0.05), DUP_P = Number(args.dup ?? 0.10);
const API = `${BASE}/api/events/${SLUG}`;
const MB = 1024 * 1024;
const POOL = randomBytes(10 * MB); // random so nothing compresses; sliced per file

const log = [];
const t0 = performance.now();
const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payload(bytes, type) {
  const buf = Buffer.from(POOL.subarray(0, bytes));
  if (type === 'image/jpeg') buf.set([0xff, 0xd8, 0xff, 0xe1], 0);
  if (type === 'image/heic') buf.set(Buffer.from('\0\0\0\x18ftypheic'), 0);
  return buf;
}

// A body that records when its last byte was handed to the socket, and can abort partway.
function bodyStream(buf, abortAt, ac, mark) {
  let off = 0;
  const CH = 256 * 1024;
  return new ReadableStream({
    pull(c) {
      if (abortAt != null && off >= abortAt) { ac.abort(); return; }
      if (off >= buf.length) { mark.sent = now(); c.close(); return; }
      c.enqueue(buf.subarray(off, Math.min(buf.length, off + CH)));
      off += CH;
    },
  });
}

async function req(route, method, url, { body, type, headers = {}, abortFrac } = {}) {
  const ac = new AbortController();
  const mark = { sent: null };
  const start = now();
  const h = { ...headers };
  let b;
  if (Buffer.isBuffer(body)) {
    h['Content-Type'] = type; h['Content-Length'] = String(body.length);
    b = bodyStream(body, abortFrac != null ? Math.floor(body.length * abortFrac) : null, ac, mark);
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json'; b = JSON.stringify(body);
  }
  const rec = { route, method, t: Math.round(start - t0), bytes: Buffer.isBuffer(body) ? body.length : 0 };
  const timer = setTimeout(() => ac.abort(), 180000);
  try {
    const res = await fetch(url, { method, headers: h, body: b, duplex: 'half', signal: ac.signal, dispatcher: device.getStore() });
    const hdr = now();
    const text = await res.text();
    rec.status = res.status;
    rec.ms = Math.round(now() - start);
    rec.server_ms = mark.sent ? Math.round(hdr - mark.sent) : rec.ms;
    rec.ray = res.headers.get('cf-ray');
    let data = {};
    try { data = JSON.parse(text); } catch {
      const code = text.match(/error code:?\s*(\d{4,5})/i) || text.match(/Error (\d{4,5})/);
      rec.platform = code ? code[1] : 'non-json';
      rec.snippet = text.slice(0, 160);
    }
    rec.code = data.code;
    if (res.status >= 400) rec.error = data.error;
    log.push(rec);
    return { status: res.status, data };
  } catch (e) {
    rec.status = abortFrac != null ? 'aborted' : 'network';
    rec.ms = Math.round(now() - start);
    rec.error = String(e.cause?.code || e.name || e);
    log.push(rec);
    return { status: rec.status, data: {} };
  } finally { clearTimeout(timer); }
}

const gh = () => ({ 'X-Guest-Token': TOKEN });

async function sendPhoto(guestId, id, buf, type, abortFrac) {
  if (type === 'image/jpeg') {
    const t = await req('thumb', 'PUT', `${API}/thumbs/${id}`, { body: payload(60 * 1024, 'image/jpeg'), type: 'image/jpeg', headers: gh() });
    if (typeof t.status !== 'number' || t.status >= 500) return t;
  }
  return req('media', 'PUT', `${API}/media/${id}?guest=${guestId}&w=2000&h=1500`, { body: buf, type, headers: gh(), abortFrac });
}

async function sendLarge(guestId, id, buf, type) {
  const g = encodeURIComponent(guestId), ty = encodeURIComponent(type);
  const s = await req('parts-start', 'POST', `${API}/media/${id}/parts?guest=${g}&type=${ty}&bytes=${buf.length}`, { headers: gh() });
  if (s.status !== 201) return s;
  const size = s.data.part_bytes, parts = [];
  for (let n = 1; (n - 1) * size < buf.length; n++) {
    let r;
    for (let tries = 0; tries < 4; tries++) {
      r = await req('parts-put', 'PUT', `${API}/media/${id}/parts/${n}?guest=${g}&type=${ty}&upload=${encodeURIComponent(s.data.upload_id)}`,
        { body: buf.subarray((n - 1) * size, Math.min(buf.length, n * size)), type, headers: gh() });
      if (r.status === 200) break;
      await sleep(2000 * 2 ** tries);
    }
    if (r.status !== 200) return r;
    parts.push({ part_number: r.data.part_number, etag: r.data.etag });
  }
  return req('parts-complete', 'POST', `${API}/media/${id}/parts/complete`,
    { body: { guest: guestId, type, upload_id: s.data.upload_id, parts, bytes: buf.length }, headers: gh() });
}

const expected = new Set();   // media ids the harness believes landed
const abandoned = [];         // ids whose upload was aborted and never retried (guest walked off)

async function guest(i, stopAt) {
  const j = await req('join', 'POST', `${API}/guests`, { body: { name: `Load guest ${i}`, device_id: randomUUID() }, headers: gh() });
  if (!j.data.guest_id) return;
  const guestId = j.data.guest_id;
  let newest = '';
  let polling = true;
  const poll = (async () => {
    await sleep(rand(0, 20000));
    while (polling) {
      const f = await req('feed', 'GET', `${API}/feed${newest ? `?since=${encodeURIComponent(newest)}` : ''}`, { headers: { ...gh(), 'X-Guest-Id': guestId } });
      if (f.data.items?.[0]) newest = f.data.items[0].created_at;
      await sleep(20000);
    }
  })();

  for (let k = 0; k < FILES && now() < stopAt; k++) {
    const type = Math.random() < 0.7 ? 'image/jpeg' : 'image/heic';
    const buf = payload(Math.floor(rand(2, 8) * MB), type);
    const id = randomUUID();
    const abort = Math.random() < ABORT_P;
    let r = await sendPhoto(guestId, id, buf, type, abort ? rand(0.2, 0.8) : undefined);
    // Client behaviour: network failure or 5xx -> back off and retry the same id (max 5 here)
    for (let tries = 1; (r.status === 'aborted' || r.status === 'network' || r.status >= 500) && tries <= 5; tries++) {
      if (abort && tries === 1 && Math.random() < 0.3) { abandoned.push(id); break; } // some never come back
      await sleep(Math.min(30000, 2000 * 2 ** (tries - 1)));
      r = await sendPhoto(guestId, id, buf, type);
    }
    if (r.status === 201 || r.status === 200) expected.add(id);
    if (Math.random() < DUP_P) {
      // Same file submitted again: half straight after (double tap), half as two parallel sends of a fresh id
      if (Math.random() < 0.5) await req('media-dup', 'PUT', `${API}/media/${id}?guest=${guestId}`, { body: buf, type, headers: gh() });
      else {
        const id2 = randomUUID();
        const rs = await Promise.all([1, 2].map(() => req('media-dup-race', 'PUT', `${API}/media/${id2}?guest=${guestId}`, { body: buf, type, headers: gh() })));
        if (rs.some((x) => x.status === 201 || x.status === 200)) expected.add(id2);
      }
    }
    await sleep(rand(500, 4000)); // guest picks the next photo
  }
  polling = false;
  await poll;
}

async function booth(stopAt) {
  const j = await req('join', 'POST', `${API}/guests`, { body: { name: 'Photobooth', device_id: randomUUID() }, headers: gh() });
  const guestId = j.data.guest_id;
  let n = 0;
  while (now() < stopAt) {
    const id = randomUUID();
    const r = await sendPhoto(guestId, id, payload(3 * MB, 'image/jpeg'), 'image/jpeg');
    if (r.status === 201) expected.add(id);
    if (n++ % 3 === 0 && ADMIN) {
      await req('strip', 'PUT', `${BASE}/api/admin/${SLUG}/strip/${n % 3}`, { body: payload(2 * MB, 'image/jpeg'), type: 'image/jpeg', headers: { 'X-Admin-Token': ADMIN } });
    }
    await sleep(20000);
  }
}

async function video() {
  const j = await req('join', 'POST', `${API}/guests`, { body: { name: 'Video guest', device_id: randomUUID() }, headers: gh() });
  const id = randomUUID();
  const big = Buffer.alloc(120 * MB);
  for (let o = 0; o < big.length; o += POOL.length) POOL.copy(big, o, 0, Math.min(POOL.length, big.length - o));
  const r = await sendLarge(j.data.guest_id, id, big, 'video/mp4');
  if (r.status === 201 || r.status === 200) expected.add(id);
  return r;
}

const stopAt = now() + Number(args.minutes || 20) * 60000;
console.log(`stage: ${GUESTS} guests x ${FILES} files against ${BASE}`);
const jobs = [];
for (let i = 0; i < GUESTS; i++) jobs.push(asDevice(async () => { await sleep(rand(0, 15000)); await guest(i, stopAt); }));
let boothDone = Promise.resolve();
if (args.booth) { const boothStop = now() + 5 * 60000; boothDone = asDevice(() => booth(boothStop)); }
if (args.video) jobs.push(asDevice(video).then((r) => console.log('video:', r.status, JSON.stringify(r.data))));
const tick = setInterval(() => {
  const m = log.filter((r) => r.route === 'media');
  console.log(`${Math.round((now() - t0) / 1000)}s  requests=${log.length} media=${m.length} ok=${m.filter((r) => r.status === 201).length} err=${log.filter((r) => typeof r.status !== 'number' || r.status >= 400).length}`);
}, 15000);
await Promise.all(jobs);
await boothDone;
clearInterval(tick);

const out = { base: BASE, slug: SLUG, guests: GUESTS, files: FILES, wall_s: Math.round((now() - t0) / 1000), expected: [...expected], abandoned, log };
const file = String(args.out || `loadtest/results/stage-${GUESTS}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${log.length} requests, ${expected.size} uploads expected`);
