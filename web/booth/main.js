// Photo-booth entrance for the guest album: a small 3D booth that takes the couple's photos and prints the strip.
// guest.js loads this file only when the entrance is going to show.
import {
  WebGLRenderer, Scene, PerspectiveCamera, OrthographicCamera, HemisphereLight, DirectionalLight, PMREMGenerator, Mesh, PlaneGeometry,
  ShadowMaterial, MeshBasicMaterial, SRGBColorSpace, NeutralToneMapping, VSMShadowMap, Color, Vector2, Vector3, Quaternion, Euler, Group, ImageLoader,
  WebGLRenderTarget, ShaderMaterial, LinearFilter,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import gsap from 'gsap';
import { PALETTES } from './palette.js';
import { signTexture, plateTexture, monogramTexture, glowTexture, blobTexture, spillTexture, stripTexture, wallTexture } from './textures.js';
import { buildBooth, SLOT, OUTLINE } from './model.js';
import { buildStrip } from './strip.js';
import { buildPetals } from './petals.js';
import { buildFlowers } from './flowers.js';

// keep the show on the clock: a slow phone drops frames rather than dragging the entrance out
gsap.ticker.lagSmoothing(0);

const ENV0 = 0.5, FOV = 27, TAN = Math.tan((FOV / 2) * Math.PI / 180);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sstep = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

export function supported() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/* opts: { mount, frame() -> rect, input, theme, names, dateText, initials, photos: [url], portrait, fonts: { script, caps },
           reduceMotion, onFlash(i), onFail() } */
export async function create(opts) {
  const P = PALETTES[opts.theme] || PALETTES['ha-florals'];
  const F = {
    script: opts.fonts.script, caps: opts.fonts.caps,
    serif: opts.theme === 'ivory' ? '"Cormorant Garamond", Georgia, serif' : '"Sorts Mill Goudy", "Cormorant Garamond", Georgia, serif',
  };
  const mount = opts.mount;
  let disposed = false;

  // ----- layers: page dimmer, the 3D canvas, the camera-flash wash -----
  const dimEl = document.createElement('div');
  dimEl.style.cssText = `position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(120% 90% at 50% 52%, ${P.dim} 0%, ${P.dim.replace(/[\d.]+\)$/, '.86)')} 100%)`;
  const flashEl = document.createElement('div');
  flashEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(90% 60% at 44% 56%, #fffdf6 0%, rgba(255,250,238,.82) 45%, rgba(255,246,228,.4) 100%)';
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .5s ease';
  canvas.setAttribute('aria-hidden', 'true');
  mount.append(dimEl, canvas, flashEl);

  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping; renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = VSMShadowMap;
  renderer.shadowMap.autoUpdate = false;       // shadows are redrawn only while something is moving
  renderer.autoClear = false; renderer.setClearColor(0x000000, 0);

  // wait briefly for the album's fonts, so the sign and the strip are lettered properly from the first frame
  const fontJobs = [`400 60px ${F.script}`, `500 22px ${F.caps}`, `italic 400 60px ${F.serif}`].map((f) => document.fonts.load(f, 'photo booth 0123').catch(() => {}));
  await Promise.race([Promise.all(fontJobs), new Promise((r) => setTimeout(r, 1500))]);
  if (disposed) return null;

  // ----- textures -----
  const count = clamp(opts.photos.length, 1, 3);
  const stripArt = stripTexture(P, F, { count, portrait: !!opts.portrait, names: opts.names, dateText: opts.dateText, initials: opts.initials });
  const T = {
    sign: signTexture(P, F), plate: plateTexture(P, F), monogram: monogramTexture(P, F, opts.initials, opts.dateText),
    glow: glowTexture(), spill: spillTexture(), blob: blobTexture(P.shadow), stripShadow: blobTexture(P.shadow, 1), wall: wallTexture(),
  };
  // photos: painted into the strip as each arrives; the print waits for them (within reason)
  let photosReady = !opts.photos.length, onPhotos = null;
  if (opts.photos.length) {
    const images = [], loader = new ImageLoader();
    let left = count;
    const one = () => { if (--left <= 0 && !disposed) { stripArt.paint(images); photosReady = true; if (onPhotos) onPhotos(); } };
    opts.photos.slice(0, 3).forEach((url, i) => loader.load(url, (im) => { images[i] = im; one(); }, undefined, one));
  }

  // ----- scenes -----
  const scene = new Scene(), front = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.035);
  scene.environment = envRT.texture; pmrem.dispose();
  scene.environmentIntensity = ENV0;
  const hemi = new HemisphereLight('#fff6ea', '#dcbfb2', 0.5); scene.add(hemi);
  const key = new DirectionalLight('#ffeed6', 1.75); key.position.set(-3.3, 4.6, 3.0); key.target.position.set(0, 1, 0);
  const rim = new DirectionalLight('#ffe4e0', 0.55); rim.position.set(3.5, 2.2, -1.5); scene.add(rim);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 7; key.shadow.blurSamples = 12; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
  Object.assign(key.shadow.camera, { left: -2.4, right: 2.4, top: 3.0, bottom: -1.2, near: 0.5, far: 12 }); key.shadow.camera.updateProjectionMatrix();
  scene.add(key, key.target);
  const HEMI0 = hemi.intensity, KEY0 = key.intensity, RIM0 = rim.intensity;

  const booth = buildBooth(P, T);
  scene.add(booth.root);
  const flowers = buildFlowers(P); booth.root.add(flowers.group);
  const ground = new Mesh(new PlaneGeometry(14, 14), new ShadowMaterial({ color: new Color(P.shadow), opacity: 0.26 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const blob = new Mesh(new PlaneGeometry(3.0, 2.3), new MeshBasicMaterial({ map: T.blob, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.set(0.05, 0.003, 0.02); scene.add(blob);

  const strip = buildStrip(P, stripArt, T.stripShadow);
  const stripHome = new Group(); stripHome.position.set(SLOT.x, SLOT.y, SLOT.z); booth.root.add(stripHome);
  stripHome.add(strip.group);
  let stripInFront = false;
  const petals = buildPetals(P); front.add(petals.mesh);

  // a sheet of the page colour between the booth and the floating strip
  const veilScene = new Scene(), veilCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const veil = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: new Color(P.page), transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }));
  veilScene.add(veil);

  // once the strip is up, the booth sits behind it out of focus: drawn small, then blurred across and down
  const rtOpts = { minFilter: LinearFilter, magFilter: LinearFilter };
  const blurA = new WebGLRenderTarget(8, 8, { ...rtOpts, depthBuffer: true }), blurB = new WebGLRenderTarget(8, 8, { ...rtOpts, depthBuffer: false });
  const blurMat = new ShaderMaterial({
    uniforms: { tex: { value: null }, uDir: { value: new Vector2() }, uVeil: { value: 0 }, uPage: { value: new Color(P.page) }, uGlow: { value: 0 }, uFinal: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `uniform sampler2D tex; uniform vec2 uDir; uniform float uVeil, uGlow, uFinal; uniform vec3 uPage; varying vec2 vUv;
      void main(){
        vec2 o1 = uDir * 1.3846154, o2 = uDir * 3.2307692;
        vec4 c = texture2D(tex, vUv) * .227027 + (texture2D(tex, vUv + o1) + texture2D(tex, vUv - o1)) * .3162162 + (texture2D(tex, vUv + o2) + texture2D(tex, vUv - o2)) * .0702703;
        if (uFinal > .5) {
          c = mix(c, vec4(uPage, 1.), uVeil);
          float d = distance(vUv, vec2(.5, .54));
          c.rgb += vec3(1., .94, .84) * uGlow * smoothstep(.7, 0., d) * c.a * .16;
        }
        gl_FragColor = c;
        #include <colorspace_fragment>
      }`,
    transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const blurQuad = new Mesh(new PlaneGeometry(2, 2), blurMat); blurQuad.frustumCulled = false;
  const blurScene = new Scene(); blurScene.add(blurQuad);

  const camera = new PerspectiveCamera(FOV, 1, 0.1, 40);
  let W = 1, H = 1, shiftX = 0, shiftY = 0, bw = 8, bh = 8;

  // ----- everything that moves, in one place; GSAP tweens these numbers and the frame loop reads them -----
  const S = {
    bulbs: 0, bulbsFull: 0, idle: 0, btn: 0, btnGlow: 0, dim: 0, curtain: 0.7, gust: 0, lamp: [0, 0, 0], flash: 0, squash: 0, kick: 0,
    hum: 0, slot: 0, out: 0, dev: 0, rel: 0, flat: 0, veil: 0, sweep: -0.8, petalT: 0, push: 0, introCam: 0, grow: 1, blur: 0, grounded: 1,
  };
  const rig = { tx: 0, ty: 1.2, tz: 0, yaw: 0.45, pitch: 0.14, dist: 9, shift: 1 };
  const orbit = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0 };

  function shots() {
    const aspect = W / H;
    const frame = (fw, fh) => Math.max(fh, fw / aspect) / (2 * TAN);
    return {
      flash: { tx: -0.06, ty: 1.24, tz: 0.1, yaw: 0.2, pitch: 0.06, dist: frame(2.25, 3.1), shift: 0 },
      print: { tx: SLOT.x - 0.01, ty: SLOT.y - L * 0.42, tz: SLOT.z + 0.05, yaw: 0.34, pitch: 0.15, dist: frame(0.6, L + 0.36), shift: 0 },
      reveal: { tx: -0.04, ty: 1.24, tz: 0.2, yaw: 0.2, pitch: 0.04, dist: frame(1.12, 2.15), shift: 0 },
    };
  }

  // Hero framing: fit the whole booth into the free space between the names and the hint
  const corners = OUTLINE.map((p) => new Vector3(p[0], p[1], p[2]));
  const tmpV = new Vector3();
  function heroShot() {
    const base = { tx: 0, ty: 1.2, tz: 0, yaw: 0.5, pitch: 0.12 };
    let sr = { left: W * 0.08, top: H * 0.2, width: W * 0.84, height: H * 0.62 };
    if (opts.frame) {
      const a = opts.frame(), m = mount.getBoundingClientRect();
      if (a && a.width > 40 && a.height > 40) sr = { left: a.left - m.left, top: a.top - m.top, width: a.width, height: a.height };
    }
    const box = (dist) => {
      placeCamera({ ...base, dist }, 0, 0, 0);
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const c of corners) {
        tmpV.copy(c).project(camera);
        const px = (tmpV.x * 0.5 + 0.5) * W, py = (-tmpV.y * 0.5 + 0.5) * H;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      return { x0, x1, y0, y1 };
    };
    let lo = 3, hi = 40;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2, b = box(mid);
      if (b.x1 - b.x0 > sr.width || b.y1 - b.y0 > sr.height) lo = mid; else hi = mid;
    }
    const b = box(hi);
    shiftX = sr.left + sr.width / 2 - (b.x0 + b.x1) / 2;
    shiftY = sr.top + sr.height / 2 - (b.y0 + b.y1) / 2;
    return { ...base, dist: hi, shift: 1 };
  }

  function placeCamera(r, yawAdd, pitchAdd, shift) {
    const yaw = r.yaw + yawAdd, pitch = r.pitch + pitchAdd;
    camera.position.set(r.tx + r.dist * Math.sin(yaw) * Math.cos(pitch), r.ty + r.dist * Math.sin(pitch), r.tz + r.dist * Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(r.tx, r.ty, r.tz);
    if (shift) camera.setViewOffset(W, H, -shiftX * shift, -shiftY * shift, W, H); else camera.clearViewOffset();
    camera.updateMatrixWorld();
  }

  let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const r = mount.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    const cap = Math.sqrt(3.4e6 / (W * H));               // keep very large screens within a sane pixel budget
    renderer.setPixelRatio(Math.min(pixelRatio, Math.max(1, cap)));
    renderer.setSize(W, H, false);
    bw = Math.max(8, Math.round(W / 5)); bh = Math.max(8, Math.round(H / 5));
    blurA.setSize(bw, bh); blurB.setSize(bw, bh);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    if (!show) Object.assign(rig, heroShot());
    settle = 3;
  }

  // ----- timelines -----
  let intro = null, show = null, nudge = null, shownResolve = null, waitingForPhotos = false;
  const L = stripArt.L;
  // the strip comes out in pushes, like a print head working
  const pushes = (p) => { const n = 4, x = p * n, i = Math.min(n - 1, Math.floor(x)), f = x - i; const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; return Math.min(1, (i + e) / n); };

  function buildIntro() {
    const tl = gsap.timeline({ paused: true });
    const order = { base: 0, rise: 0.14, drop: 0.5, unroll: 0.86, pop: 0.8 };
    let pops = 0;
    booth.parts.forEach(({ g, kind }) => {
      const at = order[kind] + (kind === 'pop' ? (pops++) * 0.07 : 0);
      if (at > 0) tl.set(g, { visible: false }, 0).set(g, { visible: true }, at);
      if (kind === 'base') tl.fromTo(g.scale, { x: 0.001, z: 0.001 }, { x: 1, z: 1, duration: 0.55, ease: 'back.out(1.5)' }, at);
      else if (kind === 'rise') tl.fromTo(g.scale, { y: 0.001 }, { y: 1, duration: 0.6, ease: 'back.out(1.25)' }, at);
      else if (kind === 'drop') tl.fromTo(g.position, { y: g.position.y + 1.1 }, { y: g.position.y, duration: 0.62, ease: 'bounce.out' }, at);
      else if (kind === 'unroll') tl.fromTo(g.scale, { y: 0.001 }, { y: 1, duration: 0.6, ease: 'power3.out' }, at);
      else tl.fromTo(g.scale, { x: 0.001, y: 0.001, z: 0.001 }, { x: 1, y: 1, z: 1, duration: 0.5, ease: 'back.out(2.2)' }, at);
    });
    tl.fromTo(S, { grounded: 0 }, { grounded: 1, duration: 0.7, ease: 'power2.out' }, 0);
    // the camera swings round to its resting view while the booth goes up
    tl.fromTo(S, { introCam: 1 }, { introCam: 0, duration: 1.9, ease: 'power3.out' }, 0);
    tl.fromTo(S, { squash: 0.9 }, { squash: 0, duration: 0.7, ease: 'elastic.out(1, .4)' }, 1.06);
    tl.fromTo(S, { bulbs: 0 }, { bulbs: 1, duration: 0.9, ease: 'none' }, 1.05);
    tl.fromTo(S, { grow: 0 }, { grow: 1, duration: 0.9, ease: 'none' }, 1.0);
    tl.fromTo(S, { idle: 0 }, { idle: 1, duration: 0.5 }, 1.7);
    return tl;
  }

  function buildShow() {
    const tl = gsap.timeline({ paused: true });
    const sh = shots();
    tl.to(S, { btn: 1, duration: 0.08, ease: 'power2.in' }, 0).to(S, { btn: 0, duration: 0.4, ease: 'elastic.out(1, .45)' }, 0.13)
      .to(S, { btnGlow: 1, duration: 0.08 }, 0).to(S, { btnGlow: 0, duration: 0.9 }, 0.25)
      .to(S, { idle: 0, duration: 0.25 }, 0)
      .to(S, { dim: 1, duration: 0.85, ease: 'power2.inOut' }, 0.05)
      .to(S, { curtain: 0, duration: 0.8, ease: 'back.out(1.3)' }, 0.14)
      .fromTo(S, { gust: 1 }, { gust: 0, duration: 1.2, ease: 'power2.out', immediateRender: false }, 0.14)
      .to(S, { bulbsFull: 1, duration: 0.4 }, 0.2)
      .to(rig, { ...sh.flash, duration: 1.05, ease: 'power3.inOut' }, 0.05);
    [0, 1, 2].forEach((i) => tl.to(S.lamp, { [i]: 1, duration: 0.1 }, 0.42 + i * 0.26));
    const f0 = 1.2, gap = 0.42;
    for (let i = 0; i < count; i++) {
      const at = f0 + i * gap;
      tl.call(() => { if (opts.onFlash && tl.timeScale() > 0) opts.onFlash(i); }, null, at);
      tl.fromTo(S, { flash: 1 }, { flash: 0, duration: 0.36, ease: 'power2.out', immediateRender: false }, at);
      tl.fromTo(S, { squash: 1 }, { squash: 0, duration: 0.55, ease: 'elastic.out(1.1, .4)', immediateRender: false }, at);
      tl.fromTo(S, { kick: 1 }, { kick: 0, duration: 0.45, ease: 'power2.out', immediateRender: false }, at);
    }
    const pr = f0 + count * gap + 0.05;
    tl.addLabel('print', pr)
      .to(S.lamp, { 0: 0, 1: 0, 2: 0, duration: 0.3 }, pr)
      .to(rig, { ...sh.print, duration: 0.95, ease: 'power3.inOut' }, pr - 0.05)
      .to(S, { hum: 1, slot: 1, duration: 0.25 }, pr + 0.35)
      // hold here if the couple's photos are still loading
      .call(() => { if (!photosReady) { waitingForPhotos = true; tl.pause(); } }, null, pr + 0.55)
      .to(S, { out: L + 0.012, duration: 1.85, ease: pushes }, pr + 0.6)
      .to(rig, { ty: sh.print.ty - 0.05, dist: sh.print.dist * 0.93, yaw: sh.print.yaw + 0.07, duration: 2.0, ease: 'sine.inOut' }, pr + 0.9)
      .to(S, { push: 4, duration: 1.85, ease: 'none' }, pr + 0.6)
      .to(S, { dev: 1, duration: 2.9, ease: 'none' }, pr + 0.95);
    const rl = pr + 2.55;
    tl.addLabel('release', rl)
      .to(S, { hum: 0, slot: 0, duration: 0.3 }, rl - 0.15)
      .to(S, { rel: 1, duration: 1.4, ease: 'power3.inOut' }, rl)
      .to(S, { flat: 1, duration: 0.95, ease: 'power2.inOut' }, rl + 0.05)
      .to(S, { dim: 0, duration: 0.9, ease: 'power2.inOut' }, rl + 0.1)
      // the room brightens to the page colour, then the booth comes back soft and out of focus behind the strip
      .to(S, { veil: 0.95, duration: 0.6, ease: 'power2.in' }, rl + 0.1)
      .set(S, { blur: 1 }, rl + 0.71)
      .to(S, { veil: 0.62, duration: 1.2, ease: 'power2.out' }, rl + 0.72)
      .to(S, { bulbsFull: 0, curtain: 0.7, duration: 0.8 }, rl + 0.2)
      .to(rig, { ...sh.reveal, duration: 1.45, ease: 'power2.inOut' }, rl)
      .to(S, { petalT: 3.4, duration: 3.4, ease: 'none' }, rl + 0.8)
      .to(S, { sweep: 2.6, duration: 1.15, ease: 'power1.inOut' }, rl + 1.25)
      .addLabel('shown', rl + 1.5)
      .call(() => { if (shownResolve) { shownResolve(); shownResolve = null; } }, null, rl + 1.5);
    return tl;
  }

  // ----- per-frame update -----
  const onCol = new Color('#fff0c4'), offCol = new Color('#8f7f6a'), tmpC = new Color();
  const qA = new Quaternion(), qB = new Quaternion(), qS = new Quaternion(), eul = new Euler(), vA = new Vector3(), vB = new Vector3(), yAxis = new Vector3(0, 1, 0);
  let lastFlash = -1, lastDim = -1, lastGrow = -1;
  function update(t) {
    booth.setCurtain(S.curtain, t, S.gust);
    if (S.grow !== lastGrow) { flowers.setGrow(S.grow); lastGrow = S.grow; }
    const n = booth.bulbCount, glow = booth.halos.geometry.attributes.glow;
    for (let i = 0; i < n; i++) {
      const ord = i / n, lit = sstep(ord, ord + 0.07, S.bulbs * 1.08);
      const chase = 0.74 + 0.26 * Math.sin(t * 4.2 - ord * Math.PI * 2 * 3);
      const v = lit * (chase + (1 - chase) * S.bulbsFull) * (1 - 0.35 * S.flash);
      booth.bulbs.setColorAt(i, tmpC.lerpColors(offCol, onCol, v));
      glow.setX(i, v * v);
    }
    booth.bulbs.instanceColor.needsUpdate = true; glow.needsUpdate = true;
    booth.halos.material.uniforms.uGain.value = 0.3 + 0.7 * S.dim;
    booth.halos.material.uniforms.uSize.value = 0.15 * H * renderer.getPixelRatio() / TAN * 0.5;
    booth.face.material.color.setScalar(0.86 + 0.14 * S.bulbs + 0.1 * S.dim);
    booth.lamps.forEach((m, i) => { m.emissiveIntensity = S.lamp[i] * 2.4 + S.flash * 2; });
    booth.flashMat.emissiveIntensity = 0.15 + S.flash * 6;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
    booth.btnMat.emissiveIntensity = 0.25 + 0.5 * pulse * S.idle + S.btnGlow * 2.2;
    booth.dome.position.z = booth.dome.userData.z0 - S.btn * 0.016;
    const ph = (t * 0.75) % 1;
    booth.ripple.scale.setScalar(1 + ph * 0.9); booth.ripple.material.opacity = (1 - ph) * 0.75 * S.idle;
    booth.slotGlow.material.opacity = S.slot * (0.75 + 0.25 * Math.sin(t * 31));
    booth.inner.intensity = 0.5 + S.dim * 1.4 + S.flash * 46;
    booth.spill.material.opacity = S.flash * (0.3 + 0.6 * S.dim);
    const k = 1 - 0.52 * S.dim;
    hemi.intensity = HEMI0 * k; key.intensity = KEY0 * k; rim.intensity = RIM0 * k; scene.environmentIntensity = ENV0 * (1 - 0.4 * S.dim);
    ground.material.opacity = 0.26 * (1 - 0.3 * S.dim) * S.grounded; blob.material.opacity = 0.55 * S.grounded;
    if (S.flash !== lastFlash) { flashEl.style.opacity = (S.flash * 0.55).toFixed(3); lastFlash = S.flash; }
    if (S.dim !== lastDim) { dimEl.style.opacity = S.dim.toFixed(3); lastDim = S.dim; }

    // the cabinet: a little squash on the flash, a shiver while printing, a nudge with each push of paper
    const pushPhase = S.push % 1, jolt = S.hum * Math.max(0, 1 - pushPhase * 3.5) * 0.004;
    booth.root.scale.set(1 - S.squash * 0.014, 1 + S.squash * 0.026, 1 - S.squash * 0.014);
    booth.root.position.set(Math.sin(t * 73) * 0.0016 * S.hum, 0, Math.cos(t * 61) * 0.0012 * S.hum - jolt);
    booth.root.rotation.z = Math.sin(t * 67) * 0.0012 * S.hum;

    // camera
    orbit.yaw += (orbit.yawT - orbit.yaw) * 0.09; orbit.pitch += (orbit.pitchT - orbit.pitch) * 0.09;
    const float = S.idle, kick = S.kick;
    const ic = S.introCam;
    placeCamera({ ...rig, dist: rig.dist * (1 - kick * 0.028) * (1 - ic * 0.1) },
      orbit.yaw * float + Math.sin(t * 0.42) * 0.03 * float + Math.sin(t * 57) * 0.0025 * kick + ic * 0.55,
      orbit.pitch * float + Math.sin(t * 0.31 + 1) * 0.008 * float + ic * 0.1, rig.shift);

    // strip
    const u = strip.u;
    strip.mesh.visible = S.out > 0.0005 || S.rel > 0;
    u.uOut.value = S.out; u.uFlat.value = S.flat; u.uDev.value = S.dev; u.uSweep.value = S.sweep; u.uTime.value = t;
    u.uShade.value = 1 - 0.1 * S.dim * (1 - S.flat);
    const wantFront = S.rel > 0;
    if (wantFront !== stripInFront) {
      stripInFront = wantFront;
      if (wantFront) front.add(strip.group); else { stripHome.add(strip.group); strip.group.position.set(0, 0, 0); strip.group.quaternion.identity(); strip.group.scale.setScalar(1); }
    }
    if (wantFront) {
      const e = S.rel;
      // where it rests: square to the camera, a touch tilted, sized to the screen
      const aspect = W / H, fill = aspect < 0.8 ? 0.6 : 0.66;
      const d = Math.max(L / (fill * 2 * TAN), stripArt.W / (0.6 * aspect * 2 * TAN));
      camera.getWorldDirection(vB);
      vB.multiplyScalar(d).add(camera.position);
      vB.addScaledVector(vA.set(0, 1, 0).applyQuaternion(camera.quaternion), d * TAN * 0.05 + Math.sin(t * 1.1) * 0.006 * e);
      stripHome.getWorldPosition(vA);
      strip.group.position.lerpVectors(vA, vB, e);
      strip.group.position.y += Math.sin(Math.PI * e) * 0.1;
      qB.copy(camera.quaternion).multiply(qS.setFromEuler(eul.set(Math.sin(t * 0.9) * 0.02 * e, Math.sin(t * 0.7) * 0.05 * e, -0.045)));
      qA.identity().slerp(qB, e);
      const spin = Math.sin(Math.PI * e) * (1 - e) * 1.5;      // a lazy swing on the way up, never showing its blank back
      strip.group.quaternion.copy(qA).multiply(qS.setFromAxisAngle(yAxis, -spin));
      strip.shadow.opacity = 0.4 * sstep(0.55, 1, e);
      petals.mesh.position.copy(vB); petals.mesh.quaternion.copy(camera.quaternion);
    }
    petals.update(S.petalT);
    veil.material.opacity = Math.min(1, S.veil);
  }

  function draw() {
    if (S.blur > 0) {
      const bu = blurMat.uniforms;
      renderer.setRenderTarget(blurA); renderer.clear(); renderer.render(scene, camera);
      // two rounds of across-then-down, the second wider, for a smooth soft-focus
      const pass = (from, to, dx, dy, final) => {
        bu.tex.value = from.texture; bu.uDir.value.set(dx / bw, dy / bh); bu.uFinal.value = final;
        renderer.setRenderTarget(to); renderer.clear(); renderer.render(blurScene, veilCam);
      };
      bu.uVeil.value = S.veil; bu.uGlow.value = S.blur;
      pass(blurA, blurB, 1, 0, 0); pass(blurB, blurA, 0, 1, 0); pass(blurA, blurB, 2.1, 0, 0); pass(blurB, null, 0, 2.1, 1);
    } else {
      renderer.clear();
      renderer.render(scene, camera);
      if (S.veil > 0.001) renderer.render(veilScene, veilCam);
    }
    if (stripInFront) { renderer.clearDepth(); renderer.render(front, camera); }
  }

  let raf = 0, debugT = null, debugFrames = 0, settle = 3, t0 = performance.now(), frames = 0, slow = 0, lastNow = 0;
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (debugT != null && --debugFrames < 0) return;      // frozen for a frame check: draw only when asked
    const t = debugT != null ? debugT : (now - t0) / 1000;
    const moving = debugT != null || (intro && intro.isActive()) || (nudge && nudge.isActive()) || (show && show.isActive() && S.blur === 0);
    if (moving) settle = 3;
    if (settle > 0) { settle--; renderer.shadowMap.needsUpdate = true; }
    update(t); draw();
    // ease off the resolution on phones that cannot keep up
    if (lastNow && frames > 20 && frames < 140) { if (now - lastNow > 30) slow++; if (frames === 139 && slow > 55 && pixelRatio > 1) { pixelRatio = Math.max(1, pixelRatio * 0.7); resize(); } }
    lastNow = now; frames++;
  }

  // ----- input: drag (or move the mouse) to look around the booth before the show -----
  const input = opts.input || mount;
  let down = null, dragged = false;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, yaw: orbit.yawT, pitch: orbit.pitchT }; dragged = false; };
  const onMove = (e) => {
    if (show) return;
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) dragged = true;
      orbit.yawT = clamp(down.yaw - dx * 0.006, -0.75, 0.6); orbit.pitchT = clamp(down.pitch + dy * 0.003, -0.08, 0.2);
    } else if (e.pointerType === 'mouse') {
      orbit.yawT = -((e.clientX / window.innerWidth) - 0.5) * 0.3; orbit.pitchT = ((e.clientY / window.innerHeight) - 0.5) * 0.08;
    }
  };
  const onUp = () => { if (down) { down = null; orbit.yawT = 0; orbit.pitchT = 0; } };
  input.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
  const ro = new ResizeObserver(() => { if (!disposed) resize(); }); ro.observe(mount);
  const onLost = (e) => { e.preventDefault(); if (opts.onFail) opts.onFail(); };
  canvas.addEventListener('webglcontextlost', onLost);

  // ----- first frame -----
  booth.dome.userData.z0 = booth.dome.position.z;
  resize();
  intro = buildIntro();
  intro.progress(opts.reduceMotion ? 1 : 0);
  update(0);
  try { await renderer.compileAsync(scene, camera); await renderer.compileAsync(front, camera); } catch {}
  if (disposed) return null;
  // warm-up: draw every stage of the show once, unseen, so nothing has to be prepared mid-animation
  {
    const keep = { ...S, lamp: [...S.lamp] };
    Object.assign(S, { out: 0.2, rel: 0.5, flat: 0.5, veil: 0.5, blur: 1, petalT: 1, flash: 1, dim: 1, grow: 1 });
    renderer.shadowMap.needsUpdate = true; update(0); draw();
    Object.assign(S, { blur: 0, rel: 0 });
    renderer.shadowMap.needsUpdate = true; update(0); draw();
    Object.assign(S, keep); S.lamp = keep.lamp; lastGrow = -1;
    renderer.shadowMap.needsUpdate = true; update(0);
  }
  draw();
  raf = requestAnimationFrame(loop);

  const api = {
    // lights up and assembles; resolves when the booth is ready to be pressed
    intro() {
      canvas.style.opacity = '1';
      if (opts.reduceMotion) return Promise.resolve();
      return new Promise((res) => {
        intro.eventCallback('onComplete', () => {
          // left alone for a while, the booth gives a little hop and its button a brighter blink
          nudge = gsap.timeline({ repeat: -1, repeatDelay: 4.4, delay: 4.6 })
            .to(S, { squash: 0.75, btnGlow: 0.8, duration: 0.14, ease: 'power2.out' })
            .to(S, { squash: 0, duration: 0.7, ease: 'elastic.out(1, .35)' })
            .to(S, { btnGlow: 0, duration: 0.6 }, '<');
          res();
        });
        intro.play(0);
      });
    },
    wasDragged() { const d = dragged; dragged = false; return d; },
    // runs the show; resolves when the finished strip is on screen
    press() {
      if (show) return Promise.resolve();
      if (nudge) { nudge.kill(); nudge = null; S.squash = 0; S.btnGlow = 0; }
      intro.progress(1);
      show = buildShow();
      onPhotos = () => { if (waitingForPhotos) { waitingForPhotos = false; show.play(); } };
      setTimeout(() => { if (waitingForPhotos && !disposed) { waitingForPhotos = false; photosReady = true; show.play(); } }, 9000);
      return new Promise((res) => {
        shownResolve = res;
        if (opts.reduceMotion) {
          canvas.style.opacity = '0';
          setTimeout(() => { if (disposed) return; show.seek('shown', false); S.petalT = 0; canvas.style.opacity = '1'; res(); shownResolve = null; }, 380);
        } else show.play(0);
      });
    },
    // a tap during the show hurries it along
    fastForward() { if (show && show.isActive()) show.timeScale(3.2); },
    // the strip lifts away as the next scene comes in
    leave(duration = 0.6) {
      if (show) show.pause();
      gsap.to(S, { veil: 1.04, duration, ease: 'power2.in' });
      canvas.style.transition = `opacity ${duration}s ease, transform ${duration}s cubic-bezier(.5,0,.8,.4)`;
      canvas.style.opacity = '0'; canvas.style.transform = 'translateY(-6%) scale(1.03)';
    },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(raf); ro.disconnect();
      if (intro) intro.kill(); if (show) show.kill(); if (nudge) nudge.kill(); gsap.killTweensOf(S); gsap.killTweensOf(rig);
      input.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      [scene, front, veilScene].forEach((s) => s.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      }));
      Object.values(T).forEach((x) => x.dispose()); stripArt.texture.dispose(); envRT.dispose(); blurA.dispose(); blurB.dispose();
      renderer.dispose();
      dimEl.remove(); flashEl.remove(); canvas.remove();
    },
    // for checking frames by hand: freeze the clock and jump to any moment of the intro or the show
    debug: {
      S, rig,
      seekIntro(t) { debugT = t; debugFrames = 3; intro.pause().time(t); },
      redraw() { debugFrames = 3; },
      seek(t, clock) { if (!show) { intro.progress(1); show = buildShow(); photosReady = true; } debugT = clock != null ? clock : 10 + t; debugFrames = 3; show.pause().time(t, true); },
      label(name) { if (!show) { intro.progress(1); show = buildShow(); photosReady = true; } return show.labels[name]; },
      duration() { if (!show) show = buildShow(); return show.duration(); },
      free() { debugT = null; },
    },
  };
  return api;
}
