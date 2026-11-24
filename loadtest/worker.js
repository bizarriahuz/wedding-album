// Load-test Worker entry: the production app unchanged, plus two inspection routes that
// only exist on the isolated test stack (wrangler.loadtest.jsonc). Guarded by the test CREATE_KEY.
//   GET  /__lt/r2?prefix=events/<id>/    every object under a prefix: {count, bytes, keys}
//   POST /__lt/purge?prefix=events/<id>/ delete every object under a prefix
import app from '../src/index.js';

async function listAll(env, prefix) {
  const keys = []; let bytes = 0; let cursor;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) { keys.push(o.key); bytes += o.size; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { count: keys.length, bytes, keys };
}

export default {
  ...app,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/__lt/')) return app.fetch(request, env, ctx);
    if (!env.CREATE_KEY || request.headers.get('X-Create-Key') !== env.CREATE_KEY) return new Response('no', { status: 401 });
    const prefix = url.searchParams.get('prefix') ?? '';
    if (url.pathname === '/__lt/r2') return Response.json(await listAll(env, prefix));
    if (url.pathname === '/__lt/purge' && request.method === 'POST') {
      const { keys } = await listAll(env, prefix);
      for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
      return Response.json({ deleted: keys.length, remaining: (await listAll(env, prefix)).count });
    }
    return new Response('not found', { status: 404 });
  },
};
