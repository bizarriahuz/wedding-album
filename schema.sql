-- Wedding Guest Album: D1 schema (phase 1)
-- Apply locally:  npx wrangler d1 execute wedding-album --local --file=schema.sql
-- Apply live:     npx wrangler d1 execute wedding-album --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,          -- used in guest links: /e/<slug>
  couple_names     TEXT NOT NULL,
  event_type       TEXT NOT NULL DEFAULT 'sanding', -- nikah | sanding | tandang | other
  event_date       TEXT NOT NULL,                 -- YYYY-MM-DD
  venue            TEXT,
  cover_key        TEXT,                          -- R2 key of the cover photo
  strip_keys       TEXT,                          -- JSON array of up to 3 R2 keys: photo-booth strip on the entrance
  paynow_qr_key    TEXT,                          -- R2 key of the couple's PayNow QR (later)
  guest_token      TEXT NOT NULL,                 -- guests must present this to upload
  admin_token_hash TEXT NOT NULL,                 -- SHA-256 of the couple's secret admin token
  privacy          TEXT NOT NULL DEFAULT 'public', -- public | private | approve
  status           TEXT NOT NULL DEFAULT 'live',  -- draft | live | closed
  theme            TEXT NOT NULL DEFAULT 'ha-florals', -- ha-florals (Harris & Aqilah's invitation) | ivory (plain lace)
  welcome_message  TEXT,                          -- couple's thank-you note on the entrance page
  is_demo          INTEGER NOT NULL DEFAULT 0,    -- the public demo album on the website
  expires_at       TEXT,                          -- when media gets deleted
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guests (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, device_id)
);

CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id   TEXT REFERENCES guests(id) ON DELETE SET NULL,
  r2_key     TEXT NOT NULL,
  kind       TEXT NOT NULL,                       -- photo | video
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  approved   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS media_event_created ON media (event_id, created_at);

CREATE TABLE IF NOT EXISTS wishes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id   TEXT REFERENCES guests(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'text',        -- text | voice
  body       TEXT,
  r2_key     TEXT,
  approved   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wishes_event_created ON wishes (event_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reference    TEXT NOT NULL,                     -- e.g. WED-A7K2, shown on the PayNow QR
  plan         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'SGD',
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | paid
  paid_at      TEXT
);

-- Website enquiry form
CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, wedding_date TEXT, guests TEXT,
  package TEXT, message TEXT, ip_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value settings (e.g. which album is the demo)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
