// A swag of flowers over the booth's corner: simple five-petal blooms and leaves, placed along a few curves.
import { InstancedMesh, SphereGeometry, MeshStandardMaterial, Object3D, Color, Vector3, Quaternion, Matrix4, Group } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function bloomGeometry() {
  const parts = [], m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), o = new Object3D();
  for (let i = 0; i < 5; i++) {
    const g = new SphereGeometry(1, 10, 7), a = (i / 5) * Math.PI * 2;
    o.position.set(Math.cos(a) * 0.52, 0.02, Math.sin(a) * 0.52); o.rotation.set(0, -a, 0.32); o.scale.set(0.58, 0.2, 0.46); o.updateMatrix();
    g.applyMatrix4(o.matrix); parts.push(g);
  }
  return mergeGeometries(parts);
}

export function buildFlowers(P) {
  const r = rng(1212);
  const spots = [];   // { p: [x,y,z], n: [x,y,z], s }
  const add = (p, n, s) => spots.push({ p, n, s });
  // cluster on the roof's front-left corner
  for (let i = 0; i < 11; i++) {
    const a = r() * 6.28, d = 0.05 + r() * 0.2;
    add([-0.68 + Math.cos(a) * d * 1.2, 2.02 + r() * 0.1 - d * 0.25, 0.42 + Math.sin(a) * d * 0.6], [-0.3 + r() * 0.5, 0.75, 0.6], 0.075 + r() * 0.05);
  }
  // cascading down the front-left edge
  for (let i = 0; i < 9; i++) {
    const k = i / 8;
    add([-0.77 + (r() - 0.5) * 0.08, 1.9 - k * 0.72 + (r() - 0.5) * 0.04, 0.47 + (r() - 0.5) * 0.06], [-0.55, 0.15, 0.82], 0.085 - k * 0.04 + r() * 0.015);
  }
  // a smaller spray at the right end
  for (let i = 0; i < 6; i++) {
    const a = r() * 6.28, d = 0.03 + r() * 0.11;
    add([0.68 + Math.cos(a) * d, 2.02 + r() * 0.06, 0.4 + Math.sin(a) * d * 0.7], [0.3, 0.8, 0.55], 0.055 + r() * 0.035);
  }
  const n = spots.length;
  const petalMat = new MeshStandardMaterial({ roughness: 0.75, envMapIntensity: 0.35 });
  const blooms = new InstancedMesh(bloomGeometry(), petalMat, n);
  const hearts = new InstancedMesh(new SphereGeometry(0.3, 10, 8), new MeshStandardMaterial({ color: P.gold, roughness: 0.6, envMapIntensity: 0.3 }), n);
  const leafGeo = new SphereGeometry(1, 10, 6); leafGeo.scale(0.5, 0.07, 0.22); leafGeo.translate(0.5, 0, 0);
  const leaves = new InstancedMesh(leafGeo, new MeshStandardMaterial({ roughness: 0.7, envMapIntensity: 0.3 }), n * 2);
  [blooms, hearts, leaves].forEach((m) => { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; });
  const cols = P.flowers.map((c) => new Color(c)), leafCols = P.leaves.map((c) => new Color(c));
  const o = new Object3D(), up = new Vector3(0, 1, 0), nv = new Vector3(), q = new Quaternion(), qs = new Quaternion();
  const items = spots.map((s, i) => {
    nv.set(s.n[0] + (r() - 0.5) * 0.5, s.n[1] + (r() - 0.5) * 0.3, s.n[2] + (r() - 0.5) * 0.4).normalize();
    q.setFromUnitVectors(up, nv).multiply(qs.setFromAxisAngle(up, r() * 6.28));
    blooms.setColorAt(i, cols[Math.floor(r() * cols.length)]);
    const lv = [0, 1].map((j) => {
      leaves.setColorAt(i * 2 + j, leafCols[Math.floor(r() * leafCols.length)]);
      return { q: q.clone().multiply(qs.setFromAxisAngle(up, r() * 6.28)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.35 - r() * 0.3)), s: s.s * (1.5 + r() * 0.9) };
    });
    return { p: new Vector3(...s.p), q: q.clone(), s: s.s, lv, order: r() };
  });
  // grow: 0 (nothing) -> 1 (all out); each bloom pops in turn
  function setGrow(g) {
    items.forEach((it, i) => {
      const x = Math.min(1, Math.max(0, g * 1.6 - it.order * 0.6));
      const e = x <= 0 ? 0 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);     // back-out
      o.position.copy(it.p); o.quaternion.copy(it.q); o.scale.setScalar(Math.max(0.0001, it.s * e)); o.updateMatrix();
      blooms.setMatrixAt(i, o.matrix); hearts.setMatrixAt(i, o.matrix);
      it.lv.forEach((l, j) => { o.quaternion.copy(l.q); o.scale.setScalar(Math.max(0.0001, l.s * e)); o.updateMatrix(); leaves.setMatrixAt(i * 2 + j, o.matrix); });
    });
    blooms.instanceMatrix.needsUpdate = hearts.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
  }
  setGrow(1);
  const group = new Group(); group.add(leaves, blooms, hearts);
  return { group, setGrow };
}
