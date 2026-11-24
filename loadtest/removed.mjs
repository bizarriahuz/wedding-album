// Regression test for "a removed upload stays removed". Local only: node loadtest/removed.mjs http://localhost:8799
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8799';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) { console.error('Refusing: local dev server only'); process.exit(2); }
const KEY = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/CREATE_KEY=(.*)/)[1].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${got})`); if (!ok) failed++; };

async function call(method, path, { body, type, headers = {}, slow } = {}) {
  const h = { ...headers }; let b = body;
  if (Buffer.isBuffer(body)) {
    h['Content-Type'] = type; h['Content-Length'] = String(body.length);
    if (slow) { let off = 0; b = new ReadableStream({ async pull(c) { if (off >= body.length) return c.close(); await sleep(slow); c.enqueue(body.subarray(off, off + 65536)); off += 65536; } }); }
  } else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers: h, body: b, duplex: 'half' });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const made = await call('POST', '/api/events', { body: { couple_names: 'Removal Test', event_date: '2026-12-12', theme: 'ivory' }, headers: { 'X-Create-Key': KEY } });
const SLUG = made.data.slug, ADMIN = made.data.admin_url.split('#')[1], TOKEN = new URL(made.data.guest_url).searchParams.get('t');
const API = `/api/events/${SLUG}`;
const g = { 'X-Guest-Token': TOKEN }, adm = { 'X-Admin-Token': ADMIN };
const guest = (await call('POST', `${API}/guests`, { body: { name: 'Tester', device_id: randomUUID() }, headers: g })).data.guest_id;
const photo = () => { const b = randomBytes(2 * 1024 * 1024); b.set([0xff, 0xd8, 0xff], 0); return b; };
const put = (id, opts = {}) => call('PUT', `${API}/media/${id}?guest=${guest}`, { body: photo(), type: 'image/jpeg', headers: g, ...opts });
const feedIds = async () => ((await call('GET', `${API}/feed`, { headers: { ...g, ...adm } })).data.items || []).map((i) => i.id);

// 1. normal upload still works, and a plain retry is still a duplicate
const a = randomUUID();
const a1 = await put(a), a2 = await put(a);
check('normal upload', a1.status === 201, a1.status);
check('retry of a landed upload is a duplicate', a2.status === 200 && a2.data.duplicate, JSON.stringify(a2.data));

// 2. couple deletes, phone re-sends the same id
const b = randomUUID();
await put(b);
const del = await call('DELETE', `/api/admin/${SLUG}/media/${b}`, { headers: adm });
const b2 = await put(b);
check('re-send after couple removed it is not stored', b2.status === 200 && b2.data.removed, `${del.status} then ${b2.status} ${JSON.stringify(b2.data)}`);
check('removed item absent from feed', !(await feedIds()).includes(b), 'feed');

// 3. couple deletes while the upload is still arriving (admin route)
const c = randomUUID();
const inflight = put(c, { slow: 40 });
await sleep(150);
const delC = await call('DELETE', `/api/admin/${SLUG}/media/${c}`, { headers: adm });
const c2 = await inflight;
check('delete during upload (admin route) wins', !(await feedIds()).includes(c), `delete ${JSON.stringify(delC.data)}, upload ${c2.status} ${JSON.stringify(c2.data)}`);

// 4. same, through the guest-page route with the couple's token
const d = randomUUID();
const inflightD = put(d, { slow: 40 });
await sleep(150);
await call('DELETE', `${API}/media/${d}`, { headers: { ...g, ...adm } });
const d2 = await inflightD;
check('delete during upload (couple on guest page) wins', !(await feedIds()).includes(d), `upload ${d2.status} ${JSON.stringify(d2.data)}`);

// 5. a guest deletes their own photo, then their phone re-sends it
const e = randomUUID();
await put(e);
await call('DELETE', `${API}/media/${e}`, { headers: { ...g, 'X-Guest-Id': guest } });
const e2 = await put(e);
check('guest\'s own removal sticks', e2.data.removed && !(await feedIds()).includes(e), JSON.stringify(e2.data));

// 6. a guest cannot block someone else's not-yet-arrived upload
const f = randomUUID();
await call('DELETE', `${API}/media/${f}`, { headers: { ...g, 'X-Guest-Id': guest } });
const f2 = await put(f);
check('guest delete of an unknown id does not tombstone it', f2.status === 201, f2.status);

// 7. big video: removed between pieces, then completed
const v = randomUUID();
const ty = encodeURIComponent('video/mp4');
const start = await call('POST', `${API}/media/${v}/parts?guest=${guest}&type=${ty}&bytes=${12 * 1024 * 1024}`, { headers: g });
const vid = randomBytes(12 * 1024 * 1024);
const p1 = await call('PUT', `${API}/media/${v}/parts/1?guest=${guest}&type=${ty}&upload=${start.data.upload_id}`, { body: vid.subarray(0, 10 * 1024 * 1024), type: 'video/mp4', headers: g });
const p2 = await call('PUT', `${API}/media/${v}/parts/2?guest=${guest}&type=${ty}&upload=${start.data.upload_id}`, { body: vid.subarray(10 * 1024 * 1024), type: 'video/mp4', headers: g });
await call('DELETE', `/api/admin/${SLUG}/media/${v}`, { headers: adm });
const done = await call('POST', `${API}/media/${v}/parts/complete`, { body: { guest, type: 'video/mp4', upload_id: start.data.upload_id, parts: [p1.data, p2.data], bytes: vid.length }, headers: g });
check('video removed before complete stays removed', done.data.removed && !(await feedIds()).includes(v), `${done.status} ${JSON.stringify(done.data)}`);

// 8. owner reset clears tombstones too
const reset = await call('POST', '/api/owner/reset', { body: { slug: SLUG, confirm: SLUG, clear: true }, headers: { 'X-Create-Key': KEY } });
const again = (await call('POST', `${API}/guests`, { body: { name: 'Tester', device_id: randomUUID() }, headers: g })).data.guest_id; // reset clears guests too
const b3 = await call('PUT', `${API}/media/${b}?guest=${again}`, { body: photo(), type: 'image/jpeg', headers: g });
check('owner reset (clear) forgets removals', reset.status === 200 && b3.status === 201, `${reset.status}, re-upload ${b3.status}`);

console.log(`slug=${SLUG} ids: c=${c} d=${d} v=${v}`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
