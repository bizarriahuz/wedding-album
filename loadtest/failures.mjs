// Deliberate failure paths against the isolated load-test Worker.
//   node loadtest/failures.mjs --base <loadtest url> --slug <test slug> --token <guest token> --admin <admin token> --key <test CREATE_KEY>
// Prints one line per scenario: what was sent, what came back, PASS/FINDING.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fetch } from 'undici';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith('--') && acc.push([x.slice(2), all[i + 1]]), acc), []));
if (!/loadtest/.test(a.base) || /harris-aqilah/.test(a.slug)) { console.error('Refusing: not the load-test stack'); process.exit(2); }
const BASE = a.base, SLUG = a.slug, ADMIN = a.admin, KEY = a.key;
let TOKEN = a.token;
const API = `${BASE}/api/events/${SLUG}`;
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (scenario, expected, got, verdict, detail = '') => { results.push({ scenario, expected, got, verdict, detail }); console.log(`[${verdict}] ${scenario}\n    expected: ${expected}\n    got:      ${got}${detail ? `\n    ${detail}` : ''}`); };

async function call(method, url, { body, type, headers = {}, slow } = {}) {
  const h = { ...headers };
  let b = body;
  if (Buffer.isBuffer(body)) {
    h['Content-Type'] = type; h['Content-Length'] = String(body.length);
    if (slow) { // trickle the body out so we can act while it is in flight
      let off = 0; const CH = 256 * 1024;
      b = new ReadableStream({ async pull(c) { if (off >= body.length) return c.close(); await sleep(slow); c.enqueue(body.subarray(off, off + CH)); off += CH; } });
    }
  } else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(url, { method, headers: h, body: b, duplex: 'half' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 120) }; }
  return { status: r.status, data };
}
const g = () => ({ 'X-Guest-Token': TOKEN });
const adm = { 'X-Admin-Token': ADMIN };
const jpeg = (n) => { const b = randomBytes(n); b.set([0xff, 0xd8, 0xff, 0xe0], 0); return b; };
const fmt = (r) => `${r.status} ${JSON.stringify(r.data)}`;
const join = async (name) => (await call('POST', `${API}/guests`, { body: { name, device_id: randomUUID() }, headers: g() })).data.guest_id;
const setStatus = (s) => call('PUT', `${BASE}/api/admin/${SLUG}/status`, { body: { status: s }, headers: adm });
const inFeed = async (id) => ((await call('GET', `${API}/feed`, { headers: { ...g(), 'X-Admin-Token': ADMIN } })).data.items || []).some((i) => i.id === id);
async function parts(guest, id, buf, upTo, uploadId) {
  const ty = encodeURIComponent('video/mp4');
  if (!uploadId) {
    const s = await call('POST', `${API}/media/${id}/parts?guest=${guest}&type=${ty}&bytes=${buf.length}`, { headers: g() });
    uploadId = s.data.upload_id;
  }
  const done = [];
  for (let n = 1; n <= upTo; n++) {
    const r = await call('PUT', `${API}/media/${id}/parts/${n}?guest=${guest}&type=${ty}&upload=${uploadId}`, { body: buf.subarray((n - 1) * 10 * MB, n * 10 * MB), type: 'video/mp4', headers: g() });
    if (r.status !== 200) return { uploadId, done, fail: r, n };
    done.push({ part_number: r.data.part_number, etag: r.data.etag });
  }
  return { uploadId, done };
}

const guest = await join('Failure tester');
const video = randomBytes(40 * MB);

// ---------- 1. Expired guest token ----------
{
  // 1a: a single upload already in flight when the link is renewed
  const id = randomUUID();
  const inflight = call('PUT', `${API}/media/${id}?guest=${guest}`, { body: jpeg(6 * MB), type: 'image/jpeg', headers: g(), slow: 150 });
  // 1b: a big video halfway through its pieces
  const vid = randomUUID();
  const before = await parts(guest, vid, video, 2);
  await sleep(1500);
  const reset = await call('POST', `${BASE}/api/owner/reset`, { body: { slug: SLUG, confirm: SLUG, renew_guest: true }, headers: { 'X-Create-Key': KEY } });
  const oldToken = TOKEN;
  TOKEN = new URL(reset.data.guest_url).searchParams.get('t');
  const r1 = await inflight;
  note('1a token renewed while a single photo PUT is in flight', 'either outcome, but consistent', fmt(r1), r1.status === 201 ? 'OBSERVED' : 'FINDING',
    'Token is checked once at request start, so an in-flight upload still lands after the link is renewed.');
  TOKEN = oldToken;
  const r2 = await call('PUT', `${API}/media/${randomUUID()}?guest=${guest}`, { body: jpeg(2 * MB), type: 'image/jpeg', headers: g() });
  note('1b new upload with the old (expired) token', "401 code 'bad_token'", fmt(r2), r2.status === 401 && r2.data.code === 'bad_token' ? 'PASS' : 'FINDING');
  const p3 = await parts(guest, vid, video, 3, before.uploadId).catch((e) => ({ fail: { status: 'err', data: String(e) } }));
  note('1c video: pieces 1-2 sent, token renewed, piece 3 with old token', "401 'bad_token'", fmt(p3.fail || { status: 200, data: 'all ok' }),
    p3.fail?.status === 401 ? 'OBSERVED' : 'FINDING',
    "guest.js answers bad_token with queue = [] (drops every queued file in memory, IndexedDB copies stay until reload) and the R2 multipart upload is left incomplete (no abort call).");
  TOKEN = new URL(reset.data.guest_url).searchParams.get('t');
  const r3 = await call('PUT', `${API}/media/${randomUUID()}?guest=${guest}`, { body: jpeg(2 * MB), type: 'image/jpeg', headers: g() });
  note('1d same guest id with the new token', '201 (guest record survives a link renewal)', fmt(r3), r3.status === 201 ? 'PASS' : 'FINDING');
}

// ---------- 2. Event closed mid-upload ----------
{
  const id = randomUUID();
  const inflight = call('PUT', `${API}/media/${id}?guest=${guest}`, { body: jpeg(6 * MB), type: 'image/jpeg', headers: g(), slow: 150 });
  const vid = randomUUID();
  const v = await parts(guest, vid, video, 2);
  await sleep(1000);
  const c = await setStatus('closed');
  const r1 = await inflight;
  note('2a event closed while a single photo PUT is in flight', 'either, but consistent', `${fmt(r1)} (close: ${c.status})`, 'OBSERVED',
    r1.status === 201 ? 'Status is checked at request start: the photo lands in a closed album.' : '');
  const r2 = await call('PUT', `${API}/media/${randomUUID()}?guest=${guest}`, { body: jpeg(2 * MB), type: 'image/jpeg', headers: g() });
  note('2b new upload while closed', "403 'closed'", fmt(r2), r2.status === 403 && r2.data.code === 'closed' ? 'PASS' : 'FINDING');
  const p = await parts(guest, vid, video, 3, v.uploadId);
  note('2c video piece 3 while closed', "403 'closed'", fmt(p.fail || { status: 200, data: 'ok' }), p.fail?.status === 403 ? 'PASS' : 'FINDING');
  await setStatus('live');
  const ty = encodeURIComponent('video/mp4');
  const p3 = await call('PUT', `${API}/media/${vid}/parts/3?guest=${guest}&type=${ty}&upload=${v.uploadId}`, { body: video.subarray(20 * MB, 30 * MB), type: 'video/mp4', headers: g() });
  const p4 = await call('PUT', `${API}/media/${vid}/parts/4?guest=${guest}&type=${ty}&upload=${v.uploadId}`, { body: video.subarray(30 * MB), type: 'video/mp4', headers: g() });
  await setStatus('closed');
  const doneClosed = await call('POST', `${API}/media/${vid}/parts/complete`, { body: { guest, type: 'video/mp4', upload_id: v.uploadId, parts: [...v.done, p3.data, p4.data], bytes: video.length }, headers: g() });
  await setStatus('live');
  const done = await call('POST', `${API}/media/${vid}/parts/complete`, { body: { guest, type: 'video/mp4', upload_id: v.uploadId, parts: [...v.done, p3.data, p4.data], bytes: video.length }, headers: g() });
  note('2d reopen, resume video from piece 3; close again before complete; reopen and complete', "complete 403 while closed, then 201",
    `complete-while-closed ${doneClosed.status} ${doneClosed.data.code || ''}; after reopen ${fmt(done)}`, doneClosed.status === 403 && done.status === 201 ? 'PASS' : 'FINDING',
    'Resume works because pieces already in R2 are kept for the upload id.');
}

// ---------- 3. Couple removes ("rejects") a photo while it is uploading ----------
{
  const id = randomUUID();
  const inflight = call('PUT', `${API}/media/${id}?guest=${guest}`, { body: jpeg(6 * MB), type: 'image/jpeg', headers: g(), slow: 150 });
  await sleep(1500);
  const del = await call('DELETE', `${BASE}/api/admin/${SLUG}/media/${id}`, { headers: adm });
  const up = await inflight;
  const visible = await inFeed(id);
  note('3a couple deletes an item while its upload is still in flight', 'item stays removed', `delete ${fmt(del)}; upload ${up.status}; in feed afterwards: ${visible}`,
    visible ? 'FINDING' : 'PASS', 'DELETE finds no row yet, answers gone:true, then the upload inserts it: the removal is silently lost.');

  const id2 = randomUUID();
  await call('PUT', `${API}/media/${id2}?guest=${guest}`, { body: jpeg(2 * MB), type: 'image/jpeg', headers: g() });
  const del2 = await call('DELETE', `${BASE}/api/admin/${SLUG}/media/${id2}`, { headers: adm });
  const retry = await call('PUT', `${API}/media/${id2}?guest=${guest}`, { body: jpeg(2 * MB), type: 'image/jpeg', headers: g() });
  const back = await inFeed(id2);
  note('3b couple deletes an item, then the guest phone retries the same id (lost response / resumed queue)', 'stays removed', `delete ${del2.status}; retry ${fmt(retry)}; in feed: ${back}`,
    back ? 'FINDING' : 'PASS', 'The duplicate check looks only at live rows, so a removed item is re-created by a retry.');
  const rows = await call('GET', `${BASE}/api/admin/${SLUG}`, { headers: adm });
  note('3c moderation queue', "a way to hold uploads for approval ('approve' privacy, approved=0)", `privacy options accepted: public|private; media.approved is never written as 0`, 'FINDING',
    'schema.sql documents privacy "approve" but PRIVACY = [public, private] and no endpoint sets approved = 0: there is no reject-before-publish.');
  void rows;
}

// ---------- 4. EXIF rotation / undecodable photo ----------
{
  // 4a: what guest.js sends when createImageBitmap() fails (HEIC on Chrome/Android/Windows, corrupt file): raw original, no preview, no w/h
  const id = randomUUID();
  const heic = randomBytes(3 * MB); heic.set(Buffer.from('\0\0\0\x18ftypheic'), 0);
  const up = await call('PUT', `${API}/media/${id}?guest=${guest}`, { body: heic, type: 'image/heic', headers: g() });
  const item = ((await call('GET', `${API}/feed`, { headers: { ...g(), 'X-Admin-Token': ADMIN } })).data.items || []).find((i) => i.id === id);
  const thumb = item ? await fetch(BASE + item.thumb_url) : null;
  const orig = item ? await fetch(BASE + item.url) : null;
  note('4a photo the phone could not decode/rotate (raw HEIC, no preview)', 'accepted, with something every viewer can display',
    `upload ${up.status}; feed w/h=${item?.width}/${item?.height}; thumb ${thumb?.status}; original ${orig?.status} ${orig?.headers.get('content-type')}`,
    'FINDING', 'Gallery falls back to the full original (2-8 MB per tile); image/heic renders only in Safari, so Chrome/Android guests and the couple on Windows see a blank tile.');
  await orig?.arrayBuffer(); await thumb?.arrayBuffer();

  // 4b: JPEG with EXIF Orientation=6 sent as-is (the raw-fallback path): server must not alter it
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const base = readFileSync(new URL('../public/site/demo-cover.jpg', import.meta.url));
  const rotated = Buffer.concat([base.subarray(0, 2), exif, base.subarray(2)]);
  const id2 = randomUUID();
  const up2 = await call('PUT', `${API}/media/${id2}?guest=${guest}`, { body: rotated, type: 'image/jpeg', headers: g() });
  const it2 = ((await call('GET', `${API}/feed`, { headers: { ...g(), 'X-Admin-Token': ADMIN } })).data.items || []).find((i) => i.id === id2);
  const served = Buffer.from(await (await fetch(BASE + it2.url)).arrayBuffer());
  note('4b JPEG with EXIF Orientation=6 and no client-side redraw', 'stored byte-for-byte so browsers can apply the orientation',
    `upload ${up2.status}; served identical: ${served.equals(rotated)}; orientation tag kept: ${served.includes(exif.subarray(20, 30))}`, served.equals(rotated) ? 'PASS' : 'FINDING',
    'The Worker never decodes images; orientation is handled by createImageBitmap on the phone (normal path) or by the viewing browser (fallback path).');
}

writeFileSync(new URL('./results/failures.json', import.meta.url), JSON.stringify(results, null, 2));
// Leave the event live with the newest guest token for later steps
writeFileSync(new URL('./results/.token', import.meta.url), TOKEN);
