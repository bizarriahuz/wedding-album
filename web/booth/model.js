// The photo booth itself, built from simple shapes: cabinet, curtain, lit sign, lamps, start button and print slot.
import {
  Group, Mesh, MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial, BoxGeometry, CylinderGeometry, SphereGeometry,
  TorusGeometry, PlaneGeometry, CircleGeometry, Shape, ExtrudeGeometry, InstancedMesh, Object3D, Color, DoubleSide, AdditiveBlending,
  BufferGeometry, BufferAttribute, Points, ShaderMaterial, PointLight, CustomBlending, AddEquation, OneFactor, ZeroFactor,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const SLOT = { x: 0.47, y: 0.80, z: 0.492 };     // where the strip comes out
export const BUTTON = { x: 0.47, y: 1.12, z: 0.47 };
// Points that hug the booth's outline (cabinet, sign, flowers), used to frame it on screen
export const OUTLINE = [];
for (const x of [-0.81, 0.81]) for (const y of [0, 2.0]) for (const z of [-0.52, 0.52]) OUTLINE.push([x, y, z]);
for (const x of [-0.58, 0.58]) for (const y of [2.06, 2.45]) for (const z of [0.12, 0.28]) OUTLINE.push([x, y, z]);
OUTLINE.push([-0.93, 2.08, 0.5], [-0.9, 1.2, 0.55], [0.84, 2.1, 0.45]);

// Light that adds to whatever is behind it without making the see-through canvas opaque
export const GLOW = { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor, premultipliedAlpha: true, transparent: true, depthWrite: false };

const CURTAIN = { left: -0.68, width: 0.87, top: 1.80, bottom: 0.70, z: 0.405, cols: 56, rows: 14 };

export function buildBooth(P, T) {
  const root = new Group();
  const parts = [];   // { g, kind } for the assembling intro
  const mat = {
    body: new MeshStandardMaterial({ color: P.body, roughness: 0.4, metalness: 0.0, envMapIntensity: 0.9 }),
    trim: new MeshStandardMaterial({ color: P.trim, roughness: 0.42, metalness: 0.0, envMapIntensity: 1.0 }),
    brass: new MeshStandardMaterial({ color: P.brass, roughness: 0.26, metalness: 1.0, envMapIntensity: 2.4 }),
    inside: new MeshStandardMaterial({ color: P.inside, roughness: 0.85, map: T.wall }),
    dark: new MeshStandardMaterial({ color: '#1a0d0f', roughness: 0.9 }),
    velvet: new MeshPhysicalMaterial({ color: P.curtain, roughness: 0.92, sheen: 1, sheenColor: new Color(P.sheen), sheenRoughness: 0.4, side: DoubleSide, envMapIntensity: 0.3 }),
    drape: new MeshPhysicalMaterial({ color: P.curtain, roughness: 0.92, sheen: 1, sheenColor: new Color(P.sheen), sheenRoughness: 0.4, side: DoubleSide, envMapIntensity: 0.3, vertexColors: true }),
    valance: new MeshStandardMaterial({ color: P.valance, roughness: 0.8 }),
  };
  const shadow = (m, cast = true, recv = true) => { m.castShadow = cast; m.receiveShadow = recv; return m; };
  // a part anchored at (ax, ay, az) so the intro can grow or drop it from that point
  const part = (kind, ax, ay, az, ...meshes) => {
    const g = new Group(); g.position.set(ax, ay, az);
    meshes.forEach((m) => { m.position.x -= ax; m.position.y -= ay; m.position.z -= az; g.add(m); });
    root.add(g); parts.push({ g, kind }); return g;
  };
  const box = (w, h, d, r, m, x, y, z) => { const o = shadow(new Mesh(new RoundedBoxGeometry(w, h, d, 4, r), m)); o.position.set(x, y, z); return o; };

  // --- cabinet ---
  part('base', 0, 0, 0, box(1.58, 0.12, 1.0, 0.03, mat.trim, 0, 0.06, 0));
  const tower = part('rise', 0.47, 0.12, 0, box(0.56, 1.72, 0.92, 0.035, mat.body, 0.47, 0.98, 0));
  const sideWall = box(0.07, 1.72, 0.92, 0.03, mat.body, -0.715, 0.98, 0);
  const backWall = box(0.90, 1.72, 0.06, 0.02, mat.body, -0.245, 0.98, -0.43);
  const linerBack = shadow(new Mesh(new PlaneGeometry(0.87, 1.72), mat.inside), false); linerBack.position.set(-0.245, 0.98, -0.399);
  const linerSide = shadow(new Mesh(new PlaneGeometry(0.86, 1.72), mat.inside), false); linerSide.position.set(-0.679, 0.98, 0.03); linerSide.rotation.y = Math.PI / 2;
  part('rise', -0.3, 0.12, 0, sideWall, backWall, linerBack, linerSide);
  const header = box(1.54, 0.12, 0.96, 0.035, mat.trim, 0, 1.94, 0);
  const cornice = box(1.62, 0.06, 1.04, 0.025, mat.trim, 0, 1.87, 0);
  const headerLine = box(1.625, 0.012, 1.045, 0.005, mat.brass, 0, 1.842, 0);
  const ceiling = shadow(new Mesh(new PlaneGeometry(0.87, 0.86), mat.inside), false); ceiling.position.set(-0.245, 1.839, 0.03); ceiling.rotation.x = Math.PI / 2;
  part('drop', 0, 1.84, 0, header, cornice, headerLine, ceiling);

  // --- the camera inside: a lens on the back wall and the flash panel above it ---
  const lensRing = shadow(new Mesh(new TorusGeometry(0.06, 0.016, 12, 36), mat.brass)); lensRing.position.set(-0.4, 1.32, -0.392);
  const lensBack = shadow(new Mesh(new CylinderGeometry(0.075, 0.075, 0.02, 36), mat.brass)); lensBack.rotation.x = Math.PI / 2; lensBack.position.set(-0.4, 1.32, -0.392);
  const lens = new Mesh(new SphereGeometry(0.052, 24, 16), new MeshStandardMaterial({ color: '#0d0a10', roughness: 0.05, metalness: 0.6, envMapIntensity: 3 })); lens.scale.z = 0.45; lens.position.set(-0.4, 1.32, -0.38);
  const flashMat = new MeshStandardMaterial({ color: '#f4ecdc', roughness: 0.3, emissive: new Color('#fff3d9'), emissiveIntensity: 0.15 });
  const flashPanel = shadow(new Mesh(new RoundedBoxGeometry(0.26, 0.08, 0.02, 3, 0.01), flashMat)); flashPanel.position.set(-0.4, 1.52, -0.39);
  part('pop', -0.4, 1.4, -0.4, lensRing, lensBack, lens, flashPanel);

  // --- stool ---
  const seat = shadow(new Mesh(new CylinderGeometry(0.15, 0.15, 0.06, 32), mat.velvet)); seat.position.set(-0.22, 0.60, -0.04);
  const seatRing = shadow(new Mesh(new TorusGeometry(0.15, 0.012, 10, 40), mat.brass)); seatRing.rotation.x = Math.PI / 2; seatRing.position.set(-0.22, 0.575, -0.04);
  const pole = shadow(new Mesh(new CylinderGeometry(0.022, 0.022, 0.44, 16), mat.brass)); pole.position.set(-0.22, 0.35, -0.04);
  const foot = shadow(new Mesh(new CylinderGeometry(0.13, 0.15, 0.025, 32), mat.brass)); foot.position.set(-0.22, 0.133, -0.04);
  part('pop', -0.22, 0.12, -0.04, seat, seatRing, pole, foot);

  // --- scalloped valance over the opening, and the curtain rail behind it ---
  const sh = new Shape(); const hw = CURTAIN.width / 2, drop = 0.085, rad = CURTAIN.width / 10;
  sh.moveTo(-hw, 0); sh.lineTo(hw, 0); sh.lineTo(hw, -drop);
  for (let i = 4; i >= 0; i--) sh.absarc(-hw + rad + i * rad * 2, -drop, rad, 0, Math.PI, true);
  sh.lineTo(-hw, 0);
  const valGeo = new ExtrudeGeometry(sh, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 14 });
  const valance = shadow(new Mesh(valGeo, mat.valance)); valance.position.set(CURTAIN.left + hw, 1.84, 0.44);
  const rail = shadow(new Mesh(new CylinderGeometry(0.012, 0.012, CURTAIN.width, 12), mat.brass)); rail.rotation.z = Math.PI / 2; rail.position.set(CURTAIN.left + hw, 1.79, CURTAIN.z);
  part('drop', CURTAIN.left + hw, 1.84, 0.44, valance, rail);

  // --- curtain: a pleated sheet, reshaped every frame ---
  const cGeo = new PlaneGeometry(1, 1, CURTAIN.cols, CURTAIN.rows);
  cGeo.setAttribute('color', new BufferAttribute(new Float32Array(cGeo.attributes.position.count * 3).fill(1), 3));
  const curtain = shadow(new Mesh(cGeo, mat.drape)); curtain.frustumCulled = false;
  const curtainPart = new Group(); curtainPart.position.set(0, CURTAIN.top, 0); curtain.position.y = -CURTAIN.top; curtainPart.add(curtain);
  root.add(curtainPart); parts.push({ g: curtainPart, kind: 'unroll' });
  const cPos = cGeo.attributes.position, cUv = cGeo.attributes.uv, cCol = cGeo.attributes.color;
  function setCurtain(open, t, gust) {
    const w = CURTAIN.width * (1 - open) + 0.2 * open, amp = 0.026 + 0.03 * open, h = CURTAIN.top - CURTAIN.bottom;
    for (let i = 0; i < cPos.count; i++) {
      const u = cUv.getX(i), v = cUv.getY(i), low = 1 - v;
      const sway = Math.sin(t * 1.25 + u * 5.0 + v * 1.6) * 0.007 * low + Math.sin(t * 9 + u * 14) * 0.03 * gust * low;
      const fold = Math.sin(u * 13 * Math.PI + 0.6);
      cPos.setXYZ(i,
        CURTAIN.left + 0.004 + u * w + sway * 0.6,
        CURTAIN.bottom + v * h + Math.abs(fold) * 0.012 * low,
        CURTAIN.z + fold * amp * (0.55 + 0.45 * low) + sway);
      // the valleys of each fold sit in shade; the hem is a little darker too
      const shade = (0.62 + 0.38 * (fold * 0.5 + 0.5)) * (0.82 + 0.18 * Math.min(1, low * 6 + 0.2) * Math.min(1, v * 9 + 0.35));
      cCol.setXYZ(i, shade, shade, shade);
    }
    cPos.needsUpdate = true; cCol.needsUpdate = true; cGeo.computeVertexNormals();
  }
  setCurtain(0.7, 0, 0);

  // --- lit sign with a ring of bulbs ---
  const signZ = 0.2, signY = 2.25;
  const signBox = box(1.14, 0.38, 0.15, 0.07, mat.trim, 0, signY, signZ);
  const postL = shadow(new Mesh(new CylinderGeometry(0.02, 0.02, 0.08, 12), mat.brass)); postL.position.set(-0.36, 2.03, signZ);
  const postR = postL.clone(); postR.position.x = 0.36;
  const face = new Mesh(new PlaneGeometry(0.80, 0.181), new MeshBasicMaterial({ map: T.sign, transparent: true, toneMapped: false })); face.position.set(0, signY, signZ + 0.0765);
  const bulbPts = [];
  { // points along a rounded rectangle on the sign's face
    const w = 0.99, h = 0.245, r = 0.085, n = 26, per = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
    for (let i = 0; i < n; i++) {
      let d = (i / n) * per + (w - 2 * r) / 2, x, y;
      const sx = w - 2 * r, sy = h - 2 * r, q = Math.PI * r / 2;
      d %= per;
      if (d < sx) { x = -sx / 2 + d; y = h / 2; }
      else if ((d -= sx) < q) { const a = d / r; x = sx / 2 + Math.sin(a) * r; y = sy / 2 + Math.cos(a) * r; }
      else if ((d -= q) < sy) { x = w / 2; y = sy / 2 - d; }
      else if ((d -= sy) < q) { const a = d / r; x = sx / 2 + Math.cos(a) * r; y = -sy / 2 - Math.sin(a) * r; }
      else if ((d -= q) < sx) { x = sx / 2 - d; y = -h / 2; }
      else if ((d -= sx) < q) { const a = d / r; x = -sx / 2 - Math.sin(a) * r; y = -sy / 2 - Math.cos(a) * r; }
      else if ((d -= q) < sy) { x = -w / 2; y = -sy / 2 + d; }
      else { d -= sy; const a = d / r; x = -sx / 2 - Math.cos(a) * r; y = sy / 2 + Math.sin(a) * r; }
      bulbPts.push([x, signY + y, signZ + 0.078]);
    }
  }
  const bulbs = new InstancedMesh(new SphereGeometry(0.021, 14, 10), new MeshBasicMaterial({ toneMapped: false }), bulbPts.length);
  const dummy = new Object3D();
  bulbPts.forEach((p, i) => { dummy.position.set(p[0], p[1], p[2]); dummy.updateMatrix(); bulbs.setMatrixAt(i, dummy.matrix); bulbs.setColorAt(i, new Color('#8a7a66')); });
  // halos: one soft sprite per bulb, drawn additively
  const hGeo = new BufferGeometry();
  hGeo.setAttribute('position', new BufferAttribute(new Float32Array(bulbPts.flat()), 3));
  hGeo.setAttribute('glow', new BufferAttribute(new Float32Array(bulbPts.length), 1));
  const halos = new Points(hGeo, new ShaderMaterial({
    uniforms: { map: { value: T.glow }, uSize: { value: 1 }, uGain: { value: 1 } },
    vertexShader: 'attribute float glow; varying float vG; uniform float uSize; void main(){ vG = glow; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = uSize * (0.6 + 0.4 * glow) / -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform sampler2D map; uniform float uGain; varying float vG; void main(){ vec4 c = texture2D(map, gl_PointCoord); gl_FragColor = vec4(c.rgb * c.a * vG * uGain, 0.); }',
    ...GLOW,
  }));
  halos.frustumCulled = false; halos.position.z = 0.012;
  part('pop', 0, 2.0, signZ, signBox, postL, postR, face, bulbs, halos);

  // --- the tower's front: lamps, plate, start button, print slot ---
  const fz = 0.46;
  const lamps = [];
  const lampMeshes = [];
  [0.35, 0.47, 0.59].forEach((lx) => {
    const lm = new MeshStandardMaterial({ color: '#d9c29a', roughness: 0.22, emissive: new Color('#ffb24a'), emissiveIntensity: 0 });
    const lens = new Mesh(new SphereGeometry(0.034, 20, 14), lm); lens.scale.z = 0.5; lens.position.set(lx, 1.58, fz + 0.004);
    const bezel = shadow(new Mesh(new TorusGeometry(0.039, 0.009, 10, 28), mat.brass)); bezel.position.set(lx, 1.58, fz + 0.004);
    lamps.push(lm); lampMeshes.push(lens, bezel);
  });
  const plateBack = box(0.4, 0.118, 0.012, 0.005, mat.brass, 0.47, 1.36, fz + 0.004);
  const plate = new Mesh(new PlaneGeometry(0.372, 0.093), new MeshStandardMaterial({ map: T.plate, roughness: 0.5, transparent: true })); plate.position.set(0.47, 1.36, fz + 0.0105);
  const lampPart = part('pop', 0.47, 1.47, fz, ...lampMeshes, plateBack, plate);

  const btnMat = new MeshStandardMaterial({ color: P.button, roughness: 0.22, emissive: new Color(P.buttonGlow), emissiveIntensity: 0.35, envMapIntensity: 1 });
  const btnBase = shadow(new Mesh(new CylinderGeometry(0.094, 0.1, 0.022, 40), mat.brass)); btnBase.rotation.x = Math.PI / 2; btnBase.position.set(BUTTON.x, BUTTON.y, fz + 0.011);
  const btnRing = shadow(new Mesh(new TorusGeometry(0.083, 0.014, 12, 44), mat.brass)); btnRing.position.set(BUTTON.x, BUTTON.y, fz + 0.022);
  const dome = shadow(new Mesh(new SphereGeometry(0.07, 32, 20), btnMat)); dome.scale.z = 0.5; dome.position.set(BUTTON.x, BUTTON.y, fz + 0.024);
  // the "tap here" ripple: a flat ring that swells and fades
  const ripple = new Mesh(new TorusGeometry(0.1, 0.006, 8, 48), new MeshBasicMaterial({ color: P.buttonGlow, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  ripple.position.set(BUTTON.x, BUTTON.y, fz + 0.03);
  part('pop', BUTTON.x, BUTTON.y, fz, btnBase, btnRing, dome, ripple);

  const slotFrame = box(0.41, 0.12, 0.032, 0.012, mat.brass, SLOT.x, SLOT.y, fz + 0.014);
  const slotHole = new Mesh(new BoxGeometry(0.31, 0.03, 0.006), mat.dark); slotHole.position.set(SLOT.x, SLOT.y, fz + 0.0285);
  const slotGlow = new Mesh(new PlaneGeometry(0.3, 0.022), new MeshBasicMaterial({ color: '#ffd9a0', opacity: 0, ...GLOW, toneMapped: false }));
  slotGlow.position.set(SLOT.x, SLOT.y, fz + 0.0322);
  // small screws at the corners of the brass plates
  const screws = [];
  const screwGeo = new SphereGeometry(0.009, 10, 8);
  [[SLOT.x, SLOT.y, 0.185, 0.04, 0.03]].forEach(([cx, cy, dx, dy, dz]) => {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const s = new Mesh(screwGeo, mat.brass); s.scale.z = 0.5; s.position.set(cx + sx * dx, cy + sy * dy, fz + dz); screws.push(s); }
  });
  part('pop', SLOT.x, SLOT.y, fz, slotFrame, slotHole, slotGlow, ...screws);

  // --- side panel with the couple's initials ---
  const mono = shadow(new Mesh(new PlaneGeometry(0.62, 1.124), new MeshStandardMaterial({ map: T.monogram, roughness: 0.55, metalness: 0.1, transparent: true })), false);
  mono.rotation.y = Math.PI / 2; mono.position.set(0.7512, 1.0, 0);
  tower.add(mono); mono.position.x -= 0.47; mono.position.y -= 0.12;

  // --- light inside the booth (also the camera flash) ---
  const inner = new PointLight('#ffe2b0', 0.5, 3.2, 1.6); inner.position.set(-0.25, 1.45, 0.05); root.add(inner);
  // light thrown onto the floor in front of the opening when the flash fires
  const spill = new Mesh(new PlaneGeometry(1.7, 1.5), new MeshBasicMaterial({ map: T.spill, opacity: 0, ...GLOW, toneMapped: false }));
  spill.rotation.x = -Math.PI / 2; spill.position.set(-0.24, 0.004, 1.2); root.add(spill);

  return { root, parts, mat, flashMat, setCurtain, bulbs, halos, bulbCount: bulbPts.length, lamps, btnMat, dome, ripple, slotGlow, inner, spill, face, domeZ: fz + 0.024 };
}
