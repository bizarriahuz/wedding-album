// A small burst of petals when the strip is revealed. Positions are a pure function of time,
// so the burst can be scrubbed or replayed exactly.
import { InstancedMesh, Shape, ShapeGeometry, MeshBasicMaterial, DoubleSide, Object3D, Color } from 'three';

// tiny seeded random, so every phone sees the same burst
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function buildPetals(P, count = 64) {
  const sh = new Shape();
  sh.moveTo(0, -0.5); sh.bezierCurveTo(0.42, -0.3, 0.46, 0.25, 0, 0.5); sh.bezierCurveTo(-0.46, 0.25, -0.42, -0.3, 0, -0.5);
  const geo = new ShapeGeometry(sh, 6);
  const mesh = new InstancedMesh(geo, new MeshBasicMaterial({ side: DoubleSide, toneMapped: false, transparent: true, opacity: 1 }), count);
  mesh.frustumCulled = false; mesh.visible = false;
  const r = rng(20261212), items = [], dummy = new Object3D(), cols = P.petals.map((c) => new Color(c));
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2, sp = 0.35 + r() * 0.95;
    items.push({
      dir: [Math.cos(a) * sp, Math.sin(a) * sp * 0.9 + 0.35, r() < 0.22 ? 0.35 + r() * 0.8 : -(0.1 + r() * 0.9)],
      size: 0.02 + r() * 0.026, spin: [r() * 6 - 3, r() * 6 - 3, r() * 4 - 2], ph: r() * 6.28, fall: 0.10 + r() * 0.12, delay: r() * 0.12,
    });
    mesh.setColorAt(i, cols[Math.floor(r() * cols.length)]);
  }
  // t: seconds since the burst
  function update(t) {
    mesh.visible = t > 0;
    if (!mesh.visible) return;
    for (let i = 0; i < count; i++) {
      const it = items[i], tt = Math.max(0, t - it.delay);
      const k = 1 - Math.exp(-tt * 2.6);                    // fast out, easing to a drift
      const x = it.dir[0] * k * 0.5 + Math.sin(tt * 1.7 + it.ph) * 0.018 * tt;
      const y = it.dir[1] * k * 0.55 - it.fall * tt * tt * 0.55 - it.fall * tt * 0.25;
      const z = it.dir[2] * k * 0.3;
      dummy.position.set(x, y, z);
      dummy.rotation.set(it.spin[0] * tt + it.ph, it.spin[1] * tt, it.spin[2] * tt + it.ph);
      const grow = Math.min(1, tt * 9);
      dummy.scale.setScalar(it.size * grow);
      dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.material.opacity = Math.max(0, Math.min(1, 1.25 - t / 3.4));
  }
  return { mesh, update };
}
