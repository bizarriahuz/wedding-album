// Bundles the 3D photo-booth entrance (web/booth) into public/booth/booth.js.
// Run: node scripts/build-booth.mjs   (the built file is committed, so deploys need no build step)
import { build } from 'esbuild';
const r = await build({
  entryPoints: ['web/booth/main.js'], bundle: true, format: 'esm', minify: true, target: 'es2020',
  outfile: 'public/booth/booth.js', legalComments: 'none', metafile: true,
  banner: { js: '/* Made of Memories photo booth. Uses three.js (MIT) and GSAP (gsap.com standard licence). */' },
});
const out = Object.values(r.metafile.outputs)[0];
console.log('booth.js', (out.bytes / 1024).toFixed(0) + ' KB');
