# Wedding Guest Album: phase 1

Foundation for the guest photo album: a Cloudflare Worker that serves the site and the API, a D1 database and an R2 bucket for photos. Runs on Cloudflare's free tier.

What works now:
- **Create album** (`/`): you enter the couple's names, event type, date and venue, protected by your own creator key. You get a secret admin link for the couple and a guest link for the QR codes.
- **Admin page** (`/admin/<slug>#<token>`): guest/photo/wish counts, guest link, cover photo upload (auto-resized), edit details.
- **Guest page** (`/e/<slug>`): placeholder showing the couple, date and cover. Camera and uploads come in phase 2.

## Files

| Path | What it is |
| --- | --- |
| `wrangler.jsonc` | Cloudflare config: Worker, static assets, D1 and R2 bindings |
| `schema.sql` | Database tables: events, guests, media, wishes, payments |
| `src/index.js` | The API (create/read/edit events, cover upload, media serving) |
| `public/` | The three pages and the shared stylesheet |

## Deploying

The repo is connected to Cloudflare Workers Builds: every push to `main` deploys automatically (about a minute). Check progress in the Cloudflare dashboard under Workers & Pages → wedding-album → Deployments. `/version.txt` shows when the live copy was built.

## One-time setup (already done for the live site)

You need Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login                        # opens a browser to sign in to Cloudflare
npx wrangler d1 create wedding-album      # prints a database_id
```

Paste that `database_id` into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Then:

```bash
npx wrangler r2 bucket create wedding-album-media
npm run db:remote                         # creates the tables in the live database
npx wrangler secret put CREATE_KEY        # type a strong password; this is your creator key
npm run deploy                            # prints your live URL, e.g. https://wedding-album.<you>.workers.dev
```

R2 has to be enabled once in the Cloudflare dashboard (R2 → Get started). It asks for a card, but the free tier covers 10 GB.

## Running locally

```bash
echo "CREATE_KEY=test-key-123" > .dev.vars
npm run db:local
npm run dev                               # http://localhost:8787
```

Local data lives in `.wrangler/` and never touches the live database.

## Notes

- The admin token sits after `#` in the link, so browsers never send it to the server logs. Only its SHA-256 hash is stored. Lose the link and the admin page is lost too (you could reset it directly in D1).
- Cover uploads go through the Worker (10 MB limit). Guest uploads in phase 2 will use the same route at first; Workers accept up to 100 MB per request on the free plan, which covers compressed photos and 60-second videos.
- Albums get an `expires_at` 30 days after the event date. Nothing deletes media yet; that's a later job.
