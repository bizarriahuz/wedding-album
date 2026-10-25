// Wedding Guest Album: Worker API (phase 1)
//
// Routes
//   POST /api/events                 create an event (needs X-Create-Key = CREATE_KEY secret)
//   GET  /api/events/:slug           public event info for the guest page
//   GET  /api/admin/:slug            full event info (needs X-Admin-Token)
//   PATCH /api/admin/:slug           edit names, date, venue, type (needs X-Admin-Token)
//   PUT  /api/admin/:slug/cover      upload cover photo, raw image body (needs X-Admin-Token)
//   POST /api/events/:slug/guests    guest joins with a name (needs X-Guest-Token)
//   PUT  /api/events/:slug/thumbs/:id  small preview image, sent before its media (needs X-Guest-Token)
//   PUT  /api/events/:slug/media/:id   a photo or video, raw body; safe to retry (needs X-Guest-Token)
//   GET  /api/events/:slug/feed      gallery items, ?since= newer or ?before= older (needs X-Guest-Token)
//   GET  /media/<key>                serve a file from R2
//   GET  /e/:slug                    guest page (static e.html)
//   GET  /admin/:slug                couple's admin page (static admin.html)
//   GET  /print/:slug                printable QR cards and poster (static print.html, needs admin token in #)

const EVENT_TYPES = ['nikah', 'sanding', 'tandang', 'other'];
const THEMES = ['sapphire', 'ha-florals'];
const PRIVACY = ['public', 'private']; // private: each guest sees only their own uploads; the couple sees all

// Schema changes the live database needs, applied by the Worker itself on first use.
// Each must be safe to run again: a "duplicate column" error means it's already done.
const MIGRATIONS = [
  "ALTER TABLE events ADD COLUMN theme TEXT NOT NULL DEFAULT 'sapphire'",
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of MIGRATIONS) {
    try { await env.DB.prepare(sql).run(); }
    catch (err) { if (!/duplicate column/i.test(String(err?.message || err))) throw err; }
  }
  schemaReady = true;
}
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_MEDIA_BYTES = 95 * 1024 * 1024; // free Workers plan accepts up to 100 MB per request
const MAX_THUMB_BYTES = 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FEED_PAGE = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Pretty page URLs -> static HTML
      if (path.startsWith('/e/')) return env.ASSETS.fetch(new URL('/e', url));
      if (path.startsWith('/admin/')) return env.ASSETS.fetch(new URL('/admin', url));
      if (path.startsWith('/print/')) return env.ASSETS.fetch(new URL('/print', url));

      if (path.startsWith('/media/')) return serveMedia(path.slice(7), env);

      if (path.startsWith('/api/')) await ensureSchema(env);

      if (path === '/api/events' && request.method === 'POST') return createEvent(request, env, url);

      let m = path.match(/^\/api\/events\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') return publicEvent(m[1], env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') return adminEvent(m[1], request, env, url);
      if (m && request.method === 'PATCH') return updateEvent(m[1], request, env, url);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/cover$/);
      if (m && request.method === 'PUT') return uploadCover(m[1], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/guests$/);
      if (m && request.method === 'POST') return joinGuest(m[1], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/thumbs\/([0-9a-f-]{36})$/);
      if (m && request.method === 'PUT') return uploadThumb(m[1], m[2], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})$/);
      if (m && request.method === 'PUT') return uploadMedia(m[1], m[2], request, env, url);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/feed$/);
      if (m && request.method === 'GET') return feed(m[1], request, env, url);

      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on our side' }, 500);
    }
  },
};

// ---------- handlers ----------

async function createEvent(request, env, url) {
  const key = request.headers.get('X-Create-Key') || '';
  if (!env.CREATE_KEY || !(await safeEqual(key, env.CREATE_KEY))) {
    return json({ error: 'Wrong creator key' }, 401);
  }

  const body = await readJson(request);
  const fields = validateEventFields(body, true);
  if (fields.error) return json({ error: fields.error }, 400);

  const id = crypto.randomUUID();
  const slug = `${slugify(fields.couple_names)}-${randomString(4)}`;
  const guestToken = randomString(16);
  const adminToken = randomString(32);

  // Album stays up 30 days after the event, per the plan
  const expires = new Date(`${fields.event_date}T00:00:00Z`);
  expires.setUTCDate(expires.getUTCDate() + 30);

  await env.DB.prepare(
    `INSERT INTO events (id, slug, couple_names, event_type, event_date, venue,
                         guest_token, admin_token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, slug, fields.couple_names, fields.event_type, fields.event_date,
          fields.venue, guestToken, await sha256(adminToken), expires.toISOString())
    .run();

  return json({
    slug,
    // Token sits after # so it never reaches server logs
    admin_url: `${url.origin}/admin/${slug}#${adminToken}`,
    guest_url: `${url.origin}/e/${slug}?t=${guestToken}`,
  }, 201);
}

async function publicEvent(slug, env) {
  const ev = await env.DB.prepare(
    `SELECT slug, couple_names, event_type, event_date, venue, cover_key, status, theme, privacy
       FROM events WHERE slug = ?`
  ).bind(slug).first();
  if (!ev) return json({ error: 'Album not found' }, 404);
  return json(withCoverUrl(ev));
}

async function adminEvent(slug, request, env, url) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;

  const counts = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').bind(ev.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE event_id = ?').bind(ev.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM wishes WHERE event_id = ?').bind(ev.id),
  ]);

  const { admin_token_hash, id, ...rest } = ev;
  return json({
    ...withCoverUrl(rest),
    guest_url: `${url.origin}/e/${ev.slug}?t=${ev.guest_token}`,
    counts: {
      guests: counts[0].results[0].n,
      media: counts[1].results[0].n,
      wishes: counts[2].results[0].n,
    },
  });
}

async function updateEvent(slug, request, env, url) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;

  const body = await readJson(request);
  const fields = validateEventFields({ ...ev, ...body }, false);
  if (fields.error) return json({ error: fields.error }, 400);

  await env.DB.prepare(
    `UPDATE events SET couple_names = ?, event_type = ?, event_date = ?, venue = ?, theme = ?, privacy = ? WHERE id = ?`
  ).bind(fields.couple_names, fields.event_type, fields.event_date, fields.venue, fields.theme, fields.privacy, ev.id).run();

  return adminEvent(slug, request, env, url);
}

async function uploadCover(slug, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;

  const type = (request.headers.get('Content-Type') || '').split(';')[0];
  if (!IMAGE_TYPES.includes(type)) return json({ error: 'Cover must be a JPEG, PNG or WebP image' }, 400);

  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > MAX_COVER_BYTES) return json({ error: 'Cover photo is over 10 MB' }, 413);

  const ext = type.split('/')[1].replace('jpeg', 'jpg');
  const key = `events/${ev.id}/cover-${Date.now()}.${ext}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });

  if (ev.cover_key) await env.MEDIA.delete(ev.cover_key);
  await env.DB.prepare('UPDATE events SET cover_key = ? WHERE id = ?').bind(key, ev.id).run();

  return json({ cover_url: `/media/${key}` });
}

// ---------- guest handlers ----------

async function joinGuest(slug, request, env) {
  const ev = await authorizeGuest(slug, request, env);
  if (ev instanceof Response) return ev;

  const body = await readJson(request);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const deviceId = String(body.device_id ?? '');
  if (name.length < 1 || name.length > 40) return json({ error: 'Enter your name (up to 40 characters)' }, 400);
  if (!UUID.test(deviceId)) return json({ error: 'Bad device id' }, 400);

  // One guest per device per event; a new name just updates it
  const existing = await env.DB.prepare('SELECT id FROM guests WHERE event_id = ? AND device_id = ?')
    .bind(ev.id, deviceId).first();
  if (existing) {
    await env.DB.prepare('UPDATE guests SET display_name = ? WHERE id = ?').bind(name, existing.id).run();
    return json({ guest_id: existing.id, name });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO guests (id, event_id, display_name, device_id) VALUES (?, ?, ?, ?)')
    .bind(id, ev.id, name, deviceId).run();
  return json({ guest_id: id, name }, 201);
}

async function uploadThumb(slug, id, request, env) {
  const ev = await authorizeGuest(slug, request, env, true);
  if (ev instanceof Response) return ev;
  if (!UUID.test(id)) return json({ error: 'Bad id' }, 400);

  const type = (request.headers.get('Content-Type') || '').split(';')[0];
  if (type !== 'image/jpeg') return json({ error: 'Preview must be JPEG' }, 400);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_THUMB_BYTES) return json({ error: 'Preview too large' }, 413);

  await env.MEDIA.put(thumbKey(ev.id, id), request.body, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ ok: true });
}

async function uploadMedia(slug, id, request, env, url) {
  const ev = await authorizeGuest(slug, request, env, true);
  if (ev instanceof Response) return ev;
  if (!UUID.test(id)) return json({ error: 'Bad id' }, 400);

  // A retry of something that already arrived: nothing to do
  const done = await env.DB.prepare('SELECT id FROM media WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (done) return json({ ok: true, duplicate: true });

  const guestId = url.searchParams.get('guest') || '';
  const guest = await env.DB.prepare('SELECT id FROM guests WHERE id = ? AND event_id = ?').bind(guestId, ev.id).first();
  if (!guest) return json({ error: 'Please enter your name again', code: 'no_guest' }, 403);

  const type = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  const kind = PHOTO_TYPES.includes(type) ? 'photo' : VIDEO_TYPES.includes(type) ? 'video' : null;
  if (!kind) return json({ error: 'Only photos and videos can be shared' }, 400);

  const bytes = Number(request.headers.get('Content-Length') || 0);
  if (!bytes) return json({ error: 'Empty file' }, 400);
  if (bytes > MAX_MEDIA_BYTES) return json({ error: 'This video is too large. Try a clip under 45 seconds.', code: 'too_large' }, 413);

  const width = toInt(url.searchParams.get('w'));
  const height = toInt(url.searchParams.get('h'));
  const key = `events/${ev.id}/media/${id}.${EXT[type]}`;

  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO media (id, event_id, guest_id, r2_key, kind, mime, bytes, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).bind(id, ev.id, guest.id, key, kind, type, bytes, width, height).run();

  return json({ ok: true }, 201);
}

async function feed(slug, request, env, url) {
  const ev = await authorizeGuest(slug, request, env);
  if (ev instanceof Response) return ev;

  const since = url.searchParams.get('since');
  const before = url.searchParams.get('before');
  let where = 'm.event_id = ? AND m.approved = 1';
  const args = [ev.id];

  // Private albums: a guest only gets their own uploads back; the couple (admin token) gets everything
  const adminToken = request.headers.get('X-Admin-Token') || '';
  const isCouple = !!adminToken && (await safeEqual(await sha256(adminToken), ev.admin_token_hash));
  if (ev.privacy === 'private' && !isCouple) {
    where += ' AND m.guest_id = ?';
    args.push(request.headers.get('X-Guest-Id') || '-');
  }
  const countArgs = [...args];
  // since uses >= because several uploads can share a timestamp; the page drops duplicates by id
  if (since) { where += ' AND m.created_at >= ?'; args.push(since); }
  if (before) { where += ' AND m.created_at < ?'; args.push(before); }

  const queries = [
    env.DB.prepare(
      `SELECT m.id, m.kind, m.r2_key, m.width, m.height, m.created_at, g.display_name AS guest_name
         FROM media m LEFT JOIN guests g ON g.id = m.guest_id
        WHERE ${where}
        ORDER BY m.created_at DESC LIMIT ${FEED_PAGE}`
    ).bind(...args),
  ];
  // Counting the whole album reads every row, so only do it on the first load, not on each "anything new?" check
  if (!since) {
    const countWhere = where.replace(/ AND m\.created_at [<>]=? \?/g, '');
    queries.push(env.DB.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${countWhere}`).bind(...countArgs));
  }
  const [rows, total] = await env.DB.batch(queries);

  return json({
    privacy: ev.privacy,
    couple_view: isCouple,
    total: total ? total.results[0].n : null,
    has_more: !since && rows.results.length === FEED_PAGE,
    items: rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      url: `/media/${r.r2_key}`,
      thumb_url: `/media/${thumbKey(ev.id, r.id)}`,
      width: r.width,
      height: r.height,
      guest_name: r.guest_name || 'A guest',
      created_at: r.created_at,
    })),
  });
}

async function serveMedia(key, env) {
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable'); // keys never change
  return new Response(obj.body, { headers });
}

// ---------- helpers ----------

async function authorizeAdmin(slug, request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  const ev = await env.DB.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first();
  if (!ev) return json({ error: 'Album not found' }, 404);
  if (!token || !(await safeEqual(await sha256(token), ev.admin_token_hash))) {
    return json({ error: 'This admin link is not valid' }, 401);
  }
  return ev;
}

async function authorizeGuest(slug, request, env, forUpload = false) {
  const token = request.headers.get('X-Guest-Token') || '';
  const ev = await env.DB.prepare('SELECT id, guest_token, admin_token_hash, status, privacy FROM events WHERE slug = ?').bind(slug).first();
  if (!ev) return json({ error: 'Album not found' }, 404);
  if (!token || !(await safeEqual(token, ev.guest_token))) {
    return json({ error: 'Please scan the QR code again', code: 'bad_token' }, 401);
  }
  if (forUpload && ev.status !== 'live') return json({ error: 'This album is closed to new photos', code: 'closed' }, 403);
  return ev;
}

function thumbKey(eventId, mediaId) {
  return `events/${eventId}/thumbs/${mediaId}.jpg`;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

function validateEventFields(b, isNew) {
  const couple_names = String(b?.couple_names ?? '').trim();
  const event_type = String(b?.event_type ?? 'sanding').trim();
  const event_date = String(b?.event_date ?? '').trim();
  const venue = String(b?.venue ?? '').trim() || null;
  const theme = String(b?.theme ?? 'sapphire').trim();
  const privacy = String(b?.privacy ?? 'public').trim();

  if (!THEMES.includes(theme)) return { error: 'Pick a look from the list' };
  if (!PRIVACY.includes(privacy)) return { error: 'Pick who can see the photos' };
  if (couple_names.length < 3 || couple_names.length > 80) return { error: 'Enter the couple\'s names (3 to 80 characters)' };
  if (!EVENT_TYPES.includes(event_type)) return { error: 'Pick nikah, sanding, tandang or other' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date) || isNaN(Date.parse(event_date))) return { error: 'Enter a valid date' };
  if (venue && venue.length > 120) return { error: 'Venue is too long (120 characters max)' };
  return { couple_names, event_type, event_date, venue, theme, privacy };
}

function withCoverUrl(ev) {
  const { cover_key, ...rest } = ev;
  return { ...rest, cover_url: cover_key ? `/media/${cover_key}` : null };
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'album';
}

function randomString(len) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes (l, 1, o, 0)
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare via hashing both sides
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
