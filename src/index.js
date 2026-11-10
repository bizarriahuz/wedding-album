// Wedding Guest Album: Worker API (phase 1)
//
// Routes
//   POST /api/events                 create an event (needs X-Create-Key = CREATE_KEY secret)
//   GET  /api/events/:slug           public event info for the guest page
//   GET  /api/admin/:slug            full event info (needs X-Admin-Token)
//   PATCH /api/admin/:slug           edit names, date, venue, type (needs X-Admin-Token)
//   PUT  /api/admin/:slug/cover      upload cover photo, raw image body (needs X-Admin-Token)
//   PUT|DELETE /api/admin/:slug/poster  the couple's own print poster (image or PDF)
//   PUT  /api/admin/:slug/status     {status: 'live' | 'closed'} pause or resume guest sharing
//   PUT  /api/admin/:slug/strip/:n   photo-booth strip photo n (0-2), raw image body; DELETE removes it
//   POST /api/events/:slug/guests    guest joins with a name (needs X-Guest-Token)
//   PUT  /api/events/:slug/thumbs/:id  small preview image, sent before its media (needs X-Guest-Token)
//   PUT  /api/events/:slug/media/:id   a photo or video, raw body; safe to retry (needs X-Guest-Token)
//   GET  /api/admin/:slug/media         every upload for the couple; DELETE /api/admin/:slug/media/:id and /wishes/:id remove one
//   DELETE /api/events/:slug/media/:id remove an upload: the guest who shared it (X-Guest-Id) or the couple (X-Admin-Token)
//   GET  /api/events/:slug/feed      gallery items, ?since= newer or ?before= older (needs X-Guest-Token)
//   PUT  /api/events/:slug/wishes/:id  a wish: JSON {body} for written, raw audio for voice; safe to retry (needs X-Guest-Token)
//   GET  /api/admin/:slug/wishes     every wish, for the couple (needs X-Admin-Token)
//   GET  /media/<key>                serve a file from R2
//   GET  /e/:slug                    guest page (static e.html)
//   GET  /admin/:slug                couple's admin page (static admin.html)
//   GET  /print/:slug                printable QR cards and poster (static print.html, needs admin token in #)
//   POST /api/enquiries              website enquiry form (public, rate limited)
//   GET  /api/enquiries              list enquiries (needs X-Create-Key)
//   POST /api/demo/setup             create or reset the demo album (needs X-Create-Key)
//   POST /api/owner/reset            before an event: clear guests, uploads and wishes; renew guest and/or admin link (needs X-Create-Key)
//   GET  /demo                       redirect to the live demo album
//   cron                             clears demo uploads older than a day

const EVENT_TYPES = ['nikah', 'sanding', 'tandang', 'other'];
const THEMES = ['ha-florals', 'ivory']; // ha-florals: Harris & Aqilah's invitation florals; ivory: the plain lace look (demo, other couples)
const PRIVACY = ['public', 'private']; // private: each guest sees only their own uploads; the couple sees all

// Schema changes the live database needs, applied by the Worker itself on first use.
// Each must be safe to run again: a "duplicate column" error means it's already done.
const MIGRATIONS = [
  "ALTER TABLE events ADD COLUMN theme TEXT NOT NULL DEFAULT 'sapphire'",
  "ALTER TABLE events ADD COLUMN welcome_message TEXT",
  "UPDATE events SET theme = 'ha-florals' WHERE theme = 'sapphire'",
  "ALTER TABLE events ADD COLUMN strip_keys TEXT",
  "ALTER TABLE events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS enquiries (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, wedding_date TEXT, guests TEXT,
     package TEXT, message TEXT, ip_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "ALTER TABLE events ADD COLUMN poster_key TEXT",
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
const PART_BYTES = 10 * 1024 * 1024;        // big videos go up in 10 MB pieces (R2 multipart), so a dropped connection only re-sends one piece
const MAX_LARGE_BYTES = 1024 * 1024 * 1024; // 1 GB: several minutes of 4K video
const MAX_THUMB_BYTES = 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FEED_PAGE = 60;
const DEMO_MAX_ITEMS = 12;            // per visitor, in the public demo album
const DEMO_MAX_BYTES = 25 * 1024 * 1024;
const DEMO_KEEP_HOURS = 24;           // demo uploads are cleared after this
const MAX_WISH_CHARS = 1000;
const MAX_VOICE_BYTES = 10 * 1024 * 1024; // about two minutes of compressed voice; the page stops at one
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Pretty page URLs -> static HTML
      if (path.startsWith('/e/')) return env.ASSETS.fetch(new URL('/e', url));
      if (path.startsWith('/admin/')) return env.ASSETS.fetch(new URL('/admin', url));
      if (path.startsWith('/print/')) return env.ASSETS.fetch(new URL('/print', url));
      if (path === '/demo') return demoRedirect(env, url);

      if (path.startsWith('/media/')) return serveMedia(path.slice(7), env, url);

      if (path.startsWith('/api/')) await ensureSchema(env);

      if (path === '/api/events' && request.method === 'POST') return createEvent(request, env, url);

      let m = path.match(/^\/api\/events\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') return publicEvent(m[1], env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') return adminEvent(m[1], request, env, url);
      if (m && request.method === 'PATCH') return updateEvent(m[1], request, env, url);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/cover$/);
      if (m && request.method === 'PUT') return uploadCover(m[1], request, env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/status$/);
      if (m && request.method === 'PUT') return setStatus(m[1], request, env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/poster$/);
      if (m && request.method === 'PUT') return uploadPoster(m[1], request, env);
      if (m && request.method === 'DELETE') return deletePoster(m[1], request, env);

      if (path === '/api/owner/reset' && request.method === 'POST') return ownerReset(request, env, url);

      if (path === '/api/enquiries' && request.method === 'POST') return postEnquiry(request, env);
      if (path === '/api/enquiries' && request.method === 'GET') return listEnquiries(request, env);
      if (path === '/api/demo/setup' && request.method === 'POST') return setupDemo(request, env, url);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/strip\/([0-2])$/);
      if (m && request.method === 'PUT') return uploadStrip(m[1], Number(m[2]), request, env);
      if (m && request.method === 'DELETE') return deleteStrip(m[1], Number(m[2]), request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/guests$/);
      if (m && request.method === 'POST') return joinGuest(m[1], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/thumbs\/([0-9a-f-]{36})$/);
      if (m && request.method === 'PUT') return uploadThumb(m[1], m[2], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})$/);
      if (m && request.method === 'PUT') return uploadMedia(m[1], m[2], request, env, url);
      if (m && request.method === 'DELETE') return deleteMedia(m[1], m[2], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/feed$/);
      if (m && request.method === 'GET') return feed(m[1], request, env, url);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/wishes\/([0-9a-f-]{36})$/);
      if (m && request.method === 'PUT') return putWish(m[1], m[2], request, env, url);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/wishes$/);
      if (m && request.method === 'GET') return listWishes(m[1], request, env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/wishes\/([0-9a-f-]{36})$/);
      if (m && request.method === 'DELETE') return adminDeleteWish(m[1], m[2], request, env);

      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})\/parts$/);
      if (m && request.method === 'POST') return startParts(m[1], m[2], request, env, url);
      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})\/parts\/(\d{1,4})$/);
      if (m && request.method === 'PUT') return putPart(m[1], m[2], Number(m[3]), request, env, url);
      m = path.match(/^\/api\/events\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})\/parts\/complete$/);
      if (m && request.method === 'POST') return completeParts(m[1], m[2], request, env);

      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/media$/);
      if (m && request.method === 'GET') return adminMedia(m[1], request, env, url);
      m = path.match(/^\/api\/admin\/([a-z0-9-]+)\/media\/([0-9a-f-]{36})$/);
      if (m && request.method === 'DELETE') return adminDeleteMedia(m[1], m[2], request, env);

      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on our side' }, 500);
    }
  },

  // Cron: clear old uploads from the public demo album
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await ensureSchema(env); await cleanDemo(env); })());
  },
};

// ---------- handlers ----------

// Owner only. Gets an album ready for the real event: optionally clears every guest, photo, video and wish
// (cover, photo strip, poster, letter and look are kept) and issues fresh guest and/or admin links.
async function ownerReset(request, env, url) {
  const key = request.headers.get('X-Create-Key') || '';
  if (!env.CREATE_KEY || !(await safeEqual(key, env.CREATE_KEY))) return json({ error: 'Wrong creator key' }, 401);
  const body = await readJson(request);
  const slug = String(body.slug || '').trim().toLowerCase().replace(/^.*\/e\//, '').replace(/[?#].*$/, '');
  const ev = await env.DB.prepare('SELECT id, slug, guest_token FROM events WHERE slug = ?').bind(slug).first();
  if (!ev) return json({ error: 'No album at that address' }, 404);
  if (String(body.confirm || '').trim().toLowerCase() !== ev.slug) return json({ error: `Type the album address (${ev.slug}) to confirm` }, 400);

  const out = { slug: ev.slug };
  if (body.clear) {
    // delete stored files for uploads, previews and voice wishes, in pages of up to 1000
    let removed = 0;
    for (const prefix of [`events/${ev.id}/media/`, `events/${ev.id}/thumbs/`, `events/${ev.id}/wishes/`]) {
      let cursor;
      do {
        const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) { await env.MEDIA.delete(keys); removed += keys.length; }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM media WHERE event_id = ?').bind(ev.id),
      env.DB.prepare('DELETE FROM wishes WHERE event_id = ?').bind(ev.id),
      env.DB.prepare('DELETE FROM guests WHERE event_id = ?').bind(ev.id),
    ]);
    out.cleared = true; out.files_removed = removed;
  }
  let guestToken = ev.guest_token;
  if (body.renew_guest) {
    guestToken = randomString(16);
    await env.DB.prepare('UPDATE events SET guest_token = ? WHERE id = ?').bind(guestToken, ev.id).run();
    out.guest_renewed = true;
  }
  if (body.renew_admin) {
    const adminToken = randomString(32);
    await env.DB.prepare('UPDATE events SET admin_token_hash = ? WHERE id = ?').bind(await sha256(adminToken), ev.id).run();
    out.admin_url = `${url.origin}/admin/${ev.slug}#${adminToken}`;
  }
  out.guest_url = `${url.origin}/e/${ev.slug}?t=${guestToken}`;
  return json(out);
}

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
                         guest_token, admin_token_hash, expires_at, theme)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, slug, fields.couple_names, fields.event_type, fields.event_date,
          fields.venue, guestToken, await sha256(adminToken), expires.toISOString(), fields.theme)
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
    `SELECT slug, couple_names, event_type, event_date, venue, cover_key, strip_keys, status, theme, privacy, welcome_message, is_demo
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
    `UPDATE events SET couple_names = ?, event_type = ?, event_date = ?, venue = ?, theme = ?, privacy = ?, welcome_message = ? WHERE id = ?`
  ).bind(fields.couple_names, fields.event_type, fields.event_date, fields.venue, fields.theme, fields.privacy, fields.welcome_message, ev.id).run();

  return adminEvent(slug, request, env, url);
}

// Photo-booth strip: up to three photos that slide out of the frame on the entrance page
async function uploadStrip(slug, n, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;

  const type = (request.headers.get('Content-Type') || '').split(';')[0];
  if (!IMAGE_TYPES.includes(type)) return json({ error: 'Photo must be a JPEG, PNG or WebP image' }, 400);
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > MAX_COVER_BYTES) return json({ error: 'Photo is over 10 MB' }, 413);

  const ext = type.split('/')[1].replace('jpeg', 'jpg');
  const key = `events/${ev.id}/strip-${n}-${Date.now()}.${ext}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });

  const keys = stripKeys(ev);
  const old = keys[n];
  keys[n] = key;
  await env.DB.prepare('UPDATE events SET strip_keys = ? WHERE id = ?').bind(JSON.stringify(keys), ev.id).run();
  if (old) await env.MEDIA.delete(old);
  return json({ strip_urls: keys.map((k) => (k ? `/media/${k}` : null)) });
}

async function deleteStrip(slug, n, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const keys = stripKeys(ev);
  const old = keys[n];
  keys[n] = null;
  await env.DB.prepare('UPDATE events SET strip_keys = ? WHERE id = ?').bind(JSON.stringify(keys), ev.id).run();
  if (old) await env.MEDIA.delete(old);
  return json({ strip_urls: keys.map((k) => (k ? `/media/${k}` : null)) });
}

// Pause or resume guest sharing (e.g. if the guest link ends up somewhere public)
async function setStatus(slug, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const body = await readJson(request);
  const status = body.status === 'closed' ? 'closed' : body.status === 'live' ? 'live' : null;
  if (!status) return json({ error: 'Unknown status' }, 400);
  await env.DB.prepare('UPDATE events SET status = ? WHERE id = ?').bind(status, ev.id).run();
  return json({ status });
}

// The couple's own designed poster for printing: an image or a PDF, kept at full quality
const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_POSTER_BYTES = 25 * 1024 * 1024; // 25 MB

async function uploadPoster(slug, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const type = (request.headers.get('Content-Type') || '').split(';')[0];
  if (!POSTER_TYPES.includes(type)) return json({ error: 'Poster must be a PNG, JPEG, WebP or PDF file' }, 400);
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > MAX_POSTER_BYTES) return json({ error: 'Poster is over 25 MB' }, 413);
  const ext = type === 'application/pdf' ? 'pdf' : type.split('/')[1].replace('jpeg', 'jpg');
  const key = `events/${ev.id}/poster-${Date.now()}.${ext}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  if (ev.poster_key) await env.MEDIA.delete(ev.poster_key);
  await env.DB.prepare('UPDATE events SET poster_key = ? WHERE id = ?').bind(key, ev.id).run();
  return json({ poster_url: `/media/${key}` });
}

async function deletePoster(slug, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  if (ev.poster_key) await env.MEDIA.delete(ev.poster_key);
  await env.DB.prepare('UPDATE events SET poster_key = NULL WHERE id = ?').bind(ev.id).run();
  return json({ ok: true });
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

// ---------- wishes ----------

async function putWish(slug, id, request, env, url) {
  const ev = await authorizeGuest(slug, request, env, true);
  if (ev instanceof Response) return ev;
  if (!UUID.test(id)) return json({ error: 'Bad id' }, 400);

  const done = await env.DB.prepare('SELECT id FROM wishes WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (done) return json({ ok: true, duplicate: true });

  const guest = await env.DB.prepare('SELECT id FROM guests WHERE id = ? AND event_id = ?')
    .bind(url.searchParams.get('guest') || '', ev.id).first();
  if (!guest) return json({ error: 'Please enter your name again', code: 'no_guest' }, 403);
  if (ev.is_demo) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes WHERE event_id = ? AND guest_id = ?').bind(ev.id, guest.id).first();
    if (n.n >= DEMO_MAX_ITEMS) return json({ error: `The demo keeps up to ${DEMO_MAX_ITEMS} wishes per visitor`, code: 'demo_limit' }, 429);
  }

  const type = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  const insert = (kind, body, key) => env.DB.prepare(
    `INSERT OR IGNORE INTO wishes (id, event_id, guest_id, kind, body, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).bind(id, ev.id, guest.id, kind, body, key).run();

  if (type === 'application/json') {
    const data = await readJson(request);
    const body = String(data.body ?? '').trim();
    if (!body) return json({ error: 'Write a few words first' }, 400);
    if (body.length > MAX_WISH_CHARS) return json({ error: `Please keep it under ${MAX_WISH_CHARS} characters` }, 400);
    await insert('text', body, null);
    return json({ ok: true }, 201);
  }

  if (AUDIO_EXT[type]) {
    const bytes = Number(request.headers.get('Content-Length') || 0);
    if (!bytes) return json({ error: 'The recording is empty' }, 400);
    if (bytes > MAX_VOICE_BYTES) return json({ error: 'That recording is too long' }, 413);
    const key = `events/${ev.id}/wishes/${id}.${AUDIO_EXT[type]}`;
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
    await insert('voice', null, key);
    return json({ ok: true }, 201);
  }

  return json({ error: 'Send a written or voice wish' }, 400);
}

async function listWishes(slug, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const rows = await env.DB.prepare(
    `SELECT w.id, w.kind, w.body, w.r2_key, w.created_at, g.display_name AS guest_name
       FROM wishes w LEFT JOIN guests g ON g.id = w.guest_id
      WHERE w.event_id = ? ORDER BY w.created_at DESC`
  ).bind(ev.id).all();
  return json({
    items: rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      body: r.body,
      audio_url: r.r2_key ? `/media/${r.r2_key}` : null,
      guest_name: r.guest_name || 'A guest',
      created_at: r.created_at,
    })),
  });
}

// The couple's own list of every upload, newest first, for removing anything from admin
async function adminMedia(slug, request, env, url) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const before = url.searchParams.get('before');
  const args = [ev.id];
  let where = 'm.event_id = ?';
  if (before) { where += ' AND m.created_at < ?'; args.push(before); }
  const rows = await env.DB.prepare(
    `SELECT m.id, m.kind, m.r2_key, m.created_at, g.display_name AS guest_name
       FROM media m LEFT JOIN guests g ON g.id = m.guest_id
      WHERE ${where} ORDER BY m.created_at DESC LIMIT ${FEED_PAGE}`
  ).bind(...args).all();
  return json({
    has_more: rows.results.length === FEED_PAGE,
    items: rows.results.map((r) => ({
      id: r.id, kind: r.kind, url: `/media/${r.r2_key}`, thumb_url: `/media/${thumbKey(ev.id, r.id)}`,
      guest_name: r.guest_name || 'A guest', created_at: r.created_at,
    })),
  });
}

async function adminDeleteMedia(slug, id, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const row = await env.DB.prepare('SELECT id, r2_key FROM media WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (!row) return json({ ok: true, gone: true });
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  await env.MEDIA.delete([row.r2_key, thumbKey(ev.id, id)]);
  return json({ ok: true });
}

async function adminDeleteWish(slug, id, request, env) {
  const ev = await authorizeAdmin(slug, request, env);
  if (ev instanceof Response) return ev;
  const row = await env.DB.prepare('SELECT id, r2_key FROM wishes WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (!row) return json({ ok: true, gone: true });
  await env.DB.prepare('DELETE FROM wishes WHERE id = ?').bind(id).run();
  if (row.r2_key) await env.MEDIA.delete(row.r2_key);
  return json({ ok: true });
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

  if (ev.is_demo) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE event_id = ? AND guest_id = ?').bind(ev.id, guest.id).first();
    if (n.n >= DEMO_MAX_ITEMS) return json({ error: `The demo keeps up to ${DEMO_MAX_ITEMS} photos or videos per visitor`, code: 'demo_limit' }, 429);
    if (Number(request.headers.get('Content-Length') || 0) > DEMO_MAX_BYTES) return json({ error: 'The demo takes videos up to 25 MB', code: 'too_large' }, 413);
  }

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

// ---------- large videos in pieces (R2 multipart) ----------
// start -> one PUT per 10 MB piece (each retried on its own) -> complete. Safe to resume with the same upload id.
async function largeUploadContext(slug, id, request, env, guestId) {
  const ev = await authorizeGuest(slug, request, env, true);
  if (ev instanceof Response) return { res: ev };
  if (ev.is_demo) return { res: json({ error: 'The demo takes videos up to 25 MB', code: 'too_large' }, 413) };
  const done = await env.DB.prepare('SELECT id FROM media WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (done) return { res: json({ ok: true, duplicate: true }) };
  const guest = await env.DB.prepare('SELECT id FROM guests WHERE id = ? AND event_id = ?').bind(guestId, ev.id).first();
  if (!guest) return { res: json({ error: 'Please enter your name again', code: 'no_guest' }, 403) };
  return { ev, guest };
}

function largeKey(ev, id, type) { return `events/${ev.id}/media/${id}.${EXT[type]}`; }

async function startParts(slug, id, request, env, url) {
  const c = await largeUploadContext(slug, id, request, env, url.searchParams.get('guest') || '');
  if (c.res) return c.res;
  const type = (url.searchParams.get('type') || '').toLowerCase();
  if (!VIDEO_TYPES.includes(type) && !PHOTO_TYPES.includes(type)) return json({ error: 'Only photos and videos can be shared' }, 400);
  const bytes = Math.max(0, Number(url.searchParams.get('bytes')) || 0);
  if (bytes > MAX_LARGE_BYTES) return json({ error: 'That video is over 1 GB. Trim it to a few minutes and try again.', code: 'too_large' }, 413);
  const up = await env.MEDIA.createMultipartUpload(largeKey(c.ev, id, type), { httpMetadata: { contentType: type } });
  return json({ upload_id: up.uploadId, part_bytes: PART_BYTES }, 201);
}

async function putPart(slug, id, n, request, env, url) {
  const c = await largeUploadContext(slug, id, request, env, url.searchParams.get('guest') || '');
  if (c.res) return c.res;
  const type = (url.searchParams.get('type') || '').toLowerCase();
  const uploadId = url.searchParams.get('upload') || '';
  if (!EXT[type] || !uploadId || n < 1 || n > 10000) return json({ error: 'Bad piece' }, 400);
  const size = Number(request.headers.get('Content-Length') || 0);
  if (!size || size > PART_BYTES) return json({ error: 'Bad piece size' }, 400);
  try {
    const up = env.MEDIA.resumeMultipartUpload(largeKey(c.ev, id, type), uploadId);
    const part = await up.uploadPart(n, request.body);
    return json({ part_number: part.partNumber, etag: part.etag });
  } catch (e) {
    // the upload expired or was never started: the page starts it again from the first piece
    return json({ error: 'Upload expired, starting again', code: 'upload_gone' }, 409);
  }
}

async function completeParts(slug, id, request, env) {
  const body = await readJson(request);
  const c = await largeUploadContext(slug, id, request, env, String(body.guest || ''));
  if (c.res) return c.res;
  const type = String(body.type || '').toLowerCase();
  const kind = PHOTO_TYPES.includes(type) ? 'photo' : VIDEO_TYPES.includes(type) ? 'video' : null;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!kind || !body.upload_id || !parts.length) return json({ error: 'Bad upload' }, 400);
  const key = largeKey(c.ev, id, type);
  try {
    const up = env.MEDIA.resumeMultipartUpload(key, String(body.upload_id));
    await up.complete(parts.map((p) => ({ partNumber: Number(p.part_number), etag: String(p.etag) })).sort((a, b) => a.partNumber - b.partNumber));
  } catch (e) {
    return json({ error: 'Upload expired, starting again', code: 'upload_gone' }, 409);
  }
  const bytes = Math.max(0, Math.round(Number(body.bytes) || 0));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO media (id, event_id, guest_id, r2_key, kind, mime, bytes, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).bind(id, c.ev.id, c.guest.id, key, kind, type, bytes, toInt(body.w), toInt(body.h)).run();
  return json({ ok: true }, 201);
}

async function isCoupleRequest(request, ev) {
  const t = request.headers.get('X-Admin-Token') || '';
  return !!t && (await safeEqual(await sha256(t), ev.admin_token_hash));
}

async function deleteMedia(slug, id, request, env) {
  const ev = await authorizeGuest(slug, request, env);
  if (ev instanceof Response) return ev;
  const row = await env.DB.prepare('SELECT id, guest_id, r2_key FROM media WHERE id = ? AND event_id = ?').bind(id, ev.id).first();
  if (!row) return json({ ok: true, gone: true }); // already deleted: nothing to do
  const isCouple = await isCoupleRequest(request, ev);
  const guestId = request.headers.get('X-Guest-Id') || '';
  if (!isCouple && (!guestId || row.guest_id !== guestId)) {
    return json({ error: 'You can only delete photos you shared' }, 403);
  }
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  await env.MEDIA.delete([row.r2_key, thumbKey(ev.id, id)]);
  return json({ ok: true });
}

async function feed(slug, request, env, url) {
  const ev = await authorizeGuest(slug, request, env);
  if (ev instanceof Response) return ev;

  const since = url.searchParams.get('since');
  const before = url.searchParams.get('before');
  let where = 'm.event_id = ? AND m.approved = 1';
  const args = [ev.id];

  // Private albums: a guest only gets their own uploads back; the couple (admin token) gets everything
  const isCouple = await isCoupleRequest(request, ev);
  const viewerGuestId = request.headers.get('X-Guest-Id') || '';
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
      `SELECT m.id, m.guest_id, m.kind, m.r2_key, m.width, m.height, m.created_at, g.display_name AS guest_name
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
      can_delete: isCouple || (!!viewerGuestId && r.guest_id === viewerGuestId),
    })),
  });
}

async function serveMedia(key, env, url) {
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable'); // keys never change
  // ?download=<name> saves the file instead of opening it (the couple's poster)
  const dl = url && url.searchParams.get('download');
  if (dl) headers.set('Content-Disposition', `attachment; filename="${dl.replace(/[^\w .()-]/g, '').slice(0, 80) || 'download'}"`);
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
  const ev = await env.DB.prepare('SELECT id, guest_token, admin_token_hash, status, privacy, is_demo FROM events WHERE slug = ?').bind(slug).first();
  if (!ev) return json({ error: 'Album not found' }, 404);
  if (!token || !(await safeEqual(token, ev.guest_token))) {
    return json({ error: 'Please scan the QR code again', code: 'bad_token' }, 401);
  }
  if (forUpload && ev.status !== 'live') return json({ error: 'The couple has paused sharing for now', code: 'closed' }, 403);
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
  const theme = THEMES.includes(String(b?.theme)) ? String(b.theme) : 'ha-florals';
  const privacy = String(b?.privacy ?? 'public').trim();
  const welcome_message = String(b?.welcome_message ?? '').trim() || null;

  if (!THEMES.includes(theme)) return { error: 'Pick a look from the list' };
  if (!PRIVACY.includes(privacy)) return { error: 'Pick who can see the photos' };
  if (welcome_message && welcome_message.length > 300) return { error: 'Keep the welcome message under 300 characters' };
  if (couple_names.length < 3 || couple_names.length > 80) return { error: 'Enter the couple\'s names (3 to 80 characters)' };
  if (!EVENT_TYPES.includes(event_type)) return { error: 'Pick an event type' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date) || isNaN(Date.parse(event_date))) return { error: 'Enter a valid date' };
  if (venue && venue.length > 120) return { error: 'Venue is too long (120 characters max)' };
  return { couple_names, event_type, event_date, venue, theme, privacy, welcome_message };
}

function stripKeys(ev) {
  try { const k = JSON.parse(ev.strip_keys || '[]'); return [0, 1, 2].map((i) => (typeof k[i] === 'string' ? k[i] : null)); }
  catch { return [null, null, null]; }
}

function withCoverUrl(ev) {
  const { cover_key, strip_keys, poster_key, ...rest } = ev;
  return {
    ...rest,
    cover_url: cover_key ? `/media/${cover_key}` : null,
    ...(poster_key !== undefined ? { poster_url: poster_key ? `/media/${poster_key}` : null } : {}),
    strip_urls: stripKeys({ strip_keys }).map((k) => (k ? `/media/${k}` : null)),
  };
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

// ---------- website: enquiries ----------

async function postEnquiry(request, env) {
  const b = await readJson(request);
  if (String(b?.website ?? '').trim()) return json({ ok: true }); // honeypot: bots fill every field
  const name = String(b?.name ?? '').trim();
  const email = String(b?.email ?? '').trim();
  const wedding_date = String(b?.wedding_date ?? '').trim() || null;
  const guests = String(b?.guests ?? '').trim().slice(0, 20) || null;
  const pkg = String(b?.package ?? '').trim().slice(0, 30) || null;
  const message = String(b?.message ?? '').trim();
  if (name.length < 2 || name.length > 80) return json({ error: 'Please enter your name' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return json({ error: 'Please enter a valid email address' }, 400);
  if (wedding_date && !/^\d{4}-\d{2}-\d{2}$/.test(wedding_date)) return json({ error: 'Please pick your wedding date' }, 400);
  if (message.length > 2000) return json({ error: 'Please keep your message under 2000 characters' }, 400);

  const ipHash = await sha256(`${request.headers.get('CF-Connecting-IP') || 'local'}:${env.CREATE_KEY || ''}`);
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM enquiries WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')"
  ).bind(ipHash).first();
  if (recent.n >= 5) return json({ error: 'Thank you! We already have your message and will reply soon.' }, 429);

  await env.DB.prepare(
    'INSERT INTO enquiries (id, name, email, wedding_date, guests, package, message, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), name, email, wedding_date, guests, pkg, message || null, ipHash).run();
  return json({ ok: true }, 201);
}

async function listEnquiries(request, env) {
  const key = request.headers.get('X-Create-Key') || '';
  if (!env.CREATE_KEY || !(await safeEqual(key, env.CREATE_KEY))) return json({ error: 'Wrong creator key' }, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, name, email, wedding_date, guests, package, message, created_at FROM enquiries ORDER BY created_at DESC LIMIT 200'
  ).all();
  return json({ enquiries: results });
}

// ---------- website: live demo album ----------

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

async function setupDemo(request, env, url) {
  const key = request.headers.get('X-Create-Key') || '';
  if (!env.CREATE_KEY || !(await safeEqual(key, env.CREATE_KEY))) return json({ error: 'Wrong creator key' }, 401);
  const reset = url.searchParams.get('reset') === '1';
  const existing = await getSetting(env, 'demo');
  if (existing && !reset) return json(JSON.parse(existing));

  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 3);
  const res = await createEvent(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Create-Key': key },
    body: JSON.stringify({ couple_names: 'Aina & Hakim', event_type: 'sanding', event_date: next.toISOString().slice(0, 10), venue: 'Your wedding venue', theme: 'ivory' }),
  }), env, url);
  const made = await res.json();
  if (!res.ok) return json(made, res.status);

  await env.DB.prepare(
    `UPDATE events SET is_demo = 1, privacy = 'private', expires_at = NULL,
       welcome_message = ? WHERE slug = ?`
  ).bind('Thank you for trying our demo! Take a photo, record a voice wish, and see how your guests will share your day. Everything here is private to you and cleared daily.', made.slug).run();

  // Placeholder strip and cover photos, copied from the site's static files into storage
  const evRow = await env.DB.prepare('SELECT id FROM events WHERE slug = ?').bind(made.slug).first();
  const keys = [];
  for (const [i, file] of ['demo-strip-0', 'demo-strip-1', 'demo-strip-2', 'demo-cover'].entries()) {
    const img = await env.ASSETS.fetch(new URL(`/site/${file}.jpg`, url));
    if (!img.ok) continue;
    const key = `events/${evRow.id}/${i < 3 ? `strip-${i}` : 'cover'}-${Date.now()}.jpg`;
    await env.MEDIA.put(key, await img.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
    keys[i] = key;
  }
  await env.DB.prepare('UPDATE events SET strip_keys = ?, cover_key = ? WHERE id = ?')
    .bind(JSON.stringify([keys[0] || null, keys[1] || null, keys[2] || null]), keys[3] || null, evRow.id).run();

  const demo = { slug: made.slug, guest_path: new URL(made.guest_url).pathname + new URL(made.guest_url).search, admin_url: made.admin_url };
  await setSetting(env, 'demo', JSON.stringify(demo));
  return json(demo, 201);
}

async function demoRedirect(env, url) {
  await ensureSchema(env);
  const demo = await getSetting(env, 'demo');
  if (!demo) return Response.redirect(new URL('/#demo', url).toString(), 302);
  return Response.redirect(new URL(JSON.parse(demo).guest_path, url).toString(), 302);
}

async function cleanDemo(env) {
  const cutoff = new Date(Date.now() - DEMO_KEEP_HOURS * 3600 * 1000).toISOString();
  const { results: evs } = await env.DB.prepare('SELECT id FROM events WHERE is_demo = 1').all();
  for (const ev of evs) {
    const { results: media } = await env.DB.prepare('SELECT id, r2_key FROM media WHERE event_id = ? AND created_at < ?').bind(ev.id, cutoff).all();
    const { results: wishes } = await env.DB.prepare('SELECT id, r2_key FROM wishes WHERE event_id = ? AND created_at < ?').bind(ev.id, cutoff).all();
    const keys = [...media.flatMap((m) => [m.r2_key, thumbKey(ev.id, m.id)]), ...wishes.map((w) => w.r2_key).filter(Boolean)];
    for (let i = 0; i < keys.length; i += 900) await env.MEDIA.delete(keys.slice(i, i + 900));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM media WHERE event_id = ? AND created_at < ?').bind(ev.id, cutoff),
      env.DB.prepare('DELETE FROM wishes WHERE event_id = ? AND created_at < ?').bind(ev.id, cutoff),
      env.DB.prepare("DELETE FROM guests WHERE event_id = ? AND created_at < datetime('now', ?)").bind(ev.id, `-${DEMO_KEEP_HOURS} hours`),
    ]);
  }
}
