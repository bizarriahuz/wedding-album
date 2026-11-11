// The photo strip: slides out of the slot over a curved lip, hangs, then flattens as it floats to the viewer.
// Photos start as dark emulsion and develop from the leading edge.
import { Mesh, PlaneGeometry, ShaderMaterial, DoubleSide, Color, Vector4, Group, MeshBasicMaterial } from 'three';

const VERT = /* glsl */`
uniform float uOut, uFlat, uL, uR, uA, uTime, uCurl;
varying vec2 vUv; varying vec3 vN;
void main() {
  vUv = uv;
  float s = uv.y * uL;                 // distance from the leading (bottom) edge
  float d = uOut - s;                  // how far this point has come out of the slot
  float arc = uR * 1.5707963;
  vec3 p; vec3 n;
  if (d < uA) { p = vec3(position.x, 0., d); n = vec3(0., 1., 0.); }
  else if (d < uA + arc) { float th = (d - uA) / uR; p = vec3(position.x, -uR * (1. - cos(th)), uA + uR * sin(th)); n = vec3(0., cos(th), sin(th)); }
  else {
    float hang = d - uA - arc;
    // the hanging length sways a touch, more towards its free end
    float sw = sin(uTime * 2.3 + hang * 9.) * 0.012 * hang;
    p = vec3(position.x, -uR - hang, uA + uR + sw); n = normalize(vec3(0., sw * 2., 1.));
  }
  // flat and floating: a breath of curl so it reads as paper
  float cx = position.x / 0.13;
  vec3 pf = vec3(position.x, position.y, -cx * cx * uCurl + sin(uv.y * 3.4 + uTime * 1.6) * 0.0035);
  vec3 nf = normalize(vec3(cx * uCurl * 14., 0., 1.));
  vec3 pos = mix(p, pf, uFlat);
  vN = normalize(normalMatrix * normalize(mix(n, nf, uFlat)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.);
}`;

const FRAG = /* glsl */`
uniform sampler2D map; uniform float uDev, uSweep, uShade; uniform vec4 uCell[3]; uniform int uCells; uniform vec3 uPaper;
varying vec2 vUv; varying vec3 vN;
void main() {
  vec3 N = normalize(vN) * (gl_FrontFacing ? 1. : -1.);
  vec3 col;
  if (gl_FrontFacing) {
    col = texture2D(map, vUv).rgb;
    float inCell = 0.;
    for (int i = 0; i < 3; i++) {
      if (i < uCells) { vec4 c = uCell[i]; inCell += step(c.x, vUv.x) * step(vUv.x, c.z) * step(c.y, vUv.y) * step(vUv.y, c.w); }
    }
    float local = clamp(uDev * 1.7 - vUv.y * 0.7, 0., 1.);       // develops from the leading edge upwards
    float g = dot(col, vec3(.299, .587, .114));
    vec3 chem = mix(vec3(.030, .020, .018), vec3(.105, .075, .060), g + .25 * sin(vUv.x * 5. + vUv.y * 11.));
    vec3 sep = vec3(g) * vec3(1.06, .86, .62) * .8 + .012;
    vec3 dv = mix(chem, sep, smoothstep(0., .55, local));
    dv = mix(dv, col, smoothstep(.4, 1., local));
    col = mix(col, dv, inCell);
    float band = clamp(1. - abs((vUv.x * .35 + vUv.y * 1.1) - uSweep) * 4.5, 0., 1.);
    band = band * band * (3. - 2. * band);
    col += band * mix(.02, .22, inCell);
  } else {
    col = uPaper * .93;
  }
  float lam = clamp(dot(N, normalize(vec3(-.25, .55, .8))), 0., 1.);
  col *= mix(.7, 1.06, lam) * uShade;
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

export function buildStrip(P, S, shadowTex) {
  const geo = new PlaneGeometry(S.W, S.L, 6, 72);
  const cells = [0, 1, 2].map((i) => new Vector4(...(S.cells[i] || [0, 0, 0, 0])));
  const mat = new ShaderMaterial({
    uniforms: {
      map: { value: S.texture }, uOut: { value: 0 }, uFlat: { value: 0 }, uL: { value: S.L }, uR: { value: 0.045 }, uA: { value: 0.012 },
      uTime: { value: 0 }, uCurl: { value: 0.006 }, uDev: { value: 0 }, uSweep: { value: -1 }, uShade: { value: 1 },
      uCell: { value: cells }, uCells: { value: S.cells.length }, uPaper: { value: new Color(P.paper) },
    },
    vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide,
  });
  const mesh = new Mesh(geo, mat); mesh.frustumCulled = false;
  // the same bending for the shadow pass, so the hanging strip throws a shadow on the cabinet
  mesh.castShadow = true;
  mesh.customDepthMaterial = new ShaderMaterial({ uniforms: mat.uniforms, vertexShader: VERT, fragmentShader: 'void main(){ gl_FragColor = vec4(1.); }', side: DoubleSide });
  const group = new Group(); group.add(mesh);
  // soft shadow that follows the strip once it is floating free
  const sh = new Mesh(new PlaneGeometry(S.W * 1.75, S.L * 1.36), new MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  sh.position.set(0.01, -0.022, -0.02); sh.renderOrder = -1; group.add(sh);
  return { group, mesh, u: mat.uniforms, shadow: sh.material };
}
