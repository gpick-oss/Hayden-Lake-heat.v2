import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 2009 Subaru WRX 5-door (GH). Model space: +z forward, +x = driver's left, y up, origin on
// the ground under the centre of mass. Front axle z = +1.06, rear axle z = -1.56 (2.62 m wheelbase).
// Overall 4.415 m long, 1.795 m wide, 1.475 m tall.
const ZF = 1.06, ZR = -1.56, CG = 0.52, WR = 0.317;
const ARCH = 0.395;

const lerp = (a, b, t) => a + (b - a) * t;
// piecewise-linear key interpolation
function keyed(keys, z) {
  if (z >= keys[0][0]) return keys[0].slice(1);
  for (let k = 1; k < keys.length; k++) if (z >= keys[k][0]) {
    const a = keys[k - 1], b = keys[k], t = (z - a[0]) / (b[0] - a[0]);
    return a.slice(1).map((v, i) => lerp(v, b[i + 1], t));
  }
  return keys[keys.length - 1].slice(1);
}

// Loft: rings of right-half points (x >= 0) per station, mirrored to the left.
function loft(zs, ringFn, { capStart = true, capEnd = true, closed = true, flip = false } = {}) {
  const rings = zs.map(z => {
    const half = ringFn(z);
    const left = half.slice(1, closed ? -1 : undefined).reverse().map(([x, y]) => [-x, y]);
    return (closed ? [...half, ...left] : [...left.reverse().map(([x, y]) => [x, y]).reverse(), ...half]).map(([x, y]) => [x, y, z]);
  });
  const n = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(...p);
  for (let s = 0; s < rings.length - 1; s++) for (let k = 0; k < (closed ? n : n - 1); k++) {
    const a = s * n + k, b = s * n + (k + 1) % n, c = a + n, d = b + n;
    (closed || flip) ? idx.push(a, c, b, b, c, d) : idx.push(a, b, c, b, d, c);
  }
  const cap = (s, flip) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0; for (const p of rings[s]) { cx += p[0]; cy += p[1]; }
    pos.push(cx / n, cy / n, rings[s][0][2]);
    for (let k = 0; k < n; k++) { const a = s * n + k, b = s * n + (k + 1) % n; flip ? idx.push(base, b, a) : idx.push(base, a, b); }
  };
  if (closed && capStart) cap(0, false);
  if (closed && capEnd) cap(rings.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const range = (a, b, step) => { const out = []; for (let z = a; z > b; z -= step) out.push(z); out.push(b); return out; };

// lower body: [z, bottom, top(hood/beltline), half-width]
const BODY = [
  [2.040, 0.27, 0.64, 0.70], [2.000, 0.22, 0.75, 0.80], [1.900, 0.20, 0.805, 0.86], [1.700, 0.19, 0.845, 0.885],
  [1.400, 0.19, 0.88, 0.895], [1.060, 0.19, 0.91, 0.897], [0.700, 0.19, 0.94, 0.885], [0.450, 0.19, 0.965, 0.88],
  [-0.200, 0.19, 0.985, 0.88], [-1.000, 0.19, 1.0, 0.885], [-1.560, 0.20, 1.02, 0.897], [-2.000, 0.22, 1.03, 0.875],
  [-2.250, 0.27, 1.02, 0.84], [-2.360, 0.33, 0.99, 0.80], [-2.375, 0.43, 0.95, 0.76],
];
// greenhouse: [z, beltline y, roof y, half-width at belt, half-width at roof]
const GLASS = [
  [0.450, 0.965, 0.975, 0.80, 0.70], [0.200, 0.975, 1.13, 0.80, 0.69], [-0.050, 0.98, 1.29, 0.80, 0.665], [-0.400, 0.99, 1.455, 0.805, 0.645],
  [-0.900, 1.0, 1.475, 0.81, 0.64], [-1.550, 1.02, 1.46, 0.81, 0.635], [-1.800, 1.025, 1.43, 0.80, 0.625], [-2.050, 1.03, 1.31, 0.78, 0.60],
  [-2.270, 1.02, 1.08, 0.76, 0.58], [-2.300, 1.015, 1.03, 0.76, 0.58],
];

function bodyRing(z) {
  const [yb0, yt, hw] = keyed(BODY, z);
  // wheel arches: lift the sill line to an arc around each axle
  let yb = yb0;
  for (const za of [ZF, ZR]) { const dz = z - za; if (Math.abs(dz) < ARCH) yb = Math.max(yb, WR + Math.sqrt(ARCH * ARCH - dz * dz) * 0.97); }
  const h = yt - yb0;
  const lower = (y) => Math.max(y, yb);
  // flares: a touch wider right over the wheels
  let flare = 0; for (const za of [ZF, ZR]) flare = Math.max(flare, 0.018 * Math.max(0, 1 - Math.abs(z - za) / 0.6));
  const W = hw + flare;
  const pts = [
    [0.0, lower(yb0 + 0.02)], [W * 0.6, lower(yb0)], [W * 0.93, lower(yb0 + 0.03)], [W, lower(yb0 + h * 0.22)],
    [W, Math.max(yb0 + h * 0.55, yb + 0.02)], [W * 0.985, yt - 0.09], [W * 0.955, yt - 0.035], [W * 0.88, yt - 0.008],
    [W * 0.5, yt + 0.006], [0.0, yt + 0.012],
  ];
  return pts;
}

function glassRing(z) {
  const [yb, yt, wb, wt] = keyed(GLASS, z);
  return [[0.0, yt + 0.004], [wt, yt], [lerp(wt, wb, 0.6), lerp(yt, yb, 0.62)], [wb, yb]];
}

// ---------------------------------------------------------------------------------------------
function strut(a, b, w, d) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const g = new THREE.BoxGeometry(w, len, d);
  const m = new THREE.Matrix4().lookAt(A, B, new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.applyMatrix4(m);
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}
const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z); return g;
};
const mirrorX = (g) => { const c = g.clone(); c.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1)); flipWinding(c); return c; };
function flipWinding(g) {
  if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; } }
  else { const p = g.attributes.position; for (let i = 0; i < p.count; i += 3) for (const attr of Object.values(g.attributes)) { const s = attr.itemSize; for (let k = 0; k < s; k++) { const t = attr.array[i * s + k]; attr.array[i * s + k] = attr.array[(i + 2) * s + k]; attr.array[(i + 2) * s + k] = t; } } }
  g.computeVertexNormals();
}
function merge(list) {
  const gs = list.map(g => { let n = g.index ? g.toNonIndexed() : g; n = n.clone(); for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k); n.computeVertexNormals(); return n; });
  return mergeGeometries(gs);
}

// quad from 4 points (for light lenses, grilles)
function quad(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]], 3));
  g.computeVertexNormals(); return g;
}

// ---------------------------------------------------------------------------------------------
function wheel(mats, left) {
  const g = new THREE.Group();
  // tyre: 225/45R17 cross-section lathed around the axle
  const tw = 0.225, rr = 0.216, prof = [];
  const sh = WR - rr;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16, a = t * Math.PI;
    const x = -tw / 2 + tw * t;
    const bulge = Math.sin(a);
    prof.push(new THREE.Vector2(rr + sh * (0.15 + 0.85 * Math.pow(bulge, 0.35)), x * (0.92 + 0.08 * bulge)));
  }
  const tyre = new THREE.LatheGeometry(prof, 32); tyre.rotateZ(Math.PI / 2);
  // rim barrel + 5 spokes (gold, 17")
  const barrel = new THREE.CylinderGeometry(rr, rr, tw * 0.92, 28, 1, true); barrel.rotateZ(Math.PI / 2);
  const lip = new THREE.TorusGeometry(rr - 0.005, 0.009, 6, 32); lip.rotateY(Math.PI / 2); lip.translate(0.105, 0, 0);
  const spokes = [];
  for (let k = 0; k < 5; k++) {
    const a = k * Math.PI * 2 / 5;
    for (const off of [-0.09, 0.09]) {
      const s = box(0.03, rr * 0.9, 0.026, 0.085, 0, 0);
      s.translate(0, rr * 0.47, 0); s.rotateX(a + off); spokes.push(s);
    }
  }
  const hub = new THREE.CylinderGeometry(0.075, 0.08, 0.05, 16); hub.rotateZ(Math.PI / 2); hub.translate(0.08, 0, 0);
  const disc = new THREE.CylinderGeometry(0.165, 0.165, 0.026, 24); disc.rotateZ(Math.PI / 2); disc.translate(-0.01, 0, 0);
  const spin = new THREE.Group();
  const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
  spin.add(mk(tyre, mats.tyre), mk(merge([barrel, lip, hub, ...spokes]), mats.rim), mk(disc, mats.disc));
  // caliper doesn't spin
  const cal = box(0.05, 0.13, 0.09, 0.0, 0.11, -0.07, 0.6, 0, 0);
  g.add(spin, mk(cal, mats.caliper));
  if (!left) g.scale.x = -1;
  return { group: g, spin };
}

// ---------------------------------------------------------------------------------------------
export function wrxModel(color = 0x123a8f, { interior = true } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.position.y = CG; root.add(body);
  const shell = new THREE.Group(); shell.position.y = -CG; body.add(shell);

  const env = (typeof window !== 'undefined' && window.__env) || null;
  const M = {
    paint: new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.28, envMap: env, envMapIntensity: 1.0 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0c1218, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.86, envMap: env, envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false }),
    black: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.7, metalness: 0.1 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.45, metalness: 0.3, envMap: env }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.15, metalness: 1.0, envMap: env }),
    head: new THREE.MeshStandardMaterial({ color: 0xdfe7ee, roughness: 0.05, metalness: 0.6, emissive: 0x30363c, envMap: env }),
    tail: new THREE.MeshStandardMaterial({ color: 0x8a0710, roughness: 0.2, metalness: 0.2, emissive: 0x3a0004, envMap: env }),
    amber: new THREE.MeshStandardMaterial({ color: 0xd07a10, roughness: 0.3, emissive: 0x201000 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xb08d3a, roughness: 0.32, metalness: 0.85, envMap: env }),
    disc: new THREE.MeshStandardMaterial({ color: 0x6e6e70, roughness: 0.5, metalness: 0.8 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0x8b8f94, roughness: 0.4, metalness: 0.6 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.85, side: THREE.BackSide }),
    dash: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.8 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.9 }),
    headliner: new THREE.MeshStandardMaterial({ color: 0x5a5a58, roughness: 0.95, side: THREE.BackSide }),
  };
  const add = (geo, mat, parent = shell, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m; };

  // --- body shell
  // nose (capped at the firewall), open-topped cabin section, and tail
  const openRing = (z) => bodyRing(z).slice(0, -2);
  const bodyGeo = merge([
    loft(range(2.04, 0.45, 0.035), bodyRing, { capEnd: false }),
    loft(range(0.45, -2.30, 0.035), openRing, { closed: false, flip: true }),
    loft(range(-2.30, -2.375, 0.025), bodyRing, { capStart: false }),
  ]);
  add(bodyGeo, M.paint);
  // light lenses laid on the body surface (slightly proud of it)
  const lens = (zs, fn) => {
    const pos = [];
    for (let k = 0; k < zs.length - 1; k++) {
      const [a0, a1] = fn(zs[k]), [b0, b1] = fn(zs[k + 1]);
      pos.push(...a0, ...b0, ...a1, ...a1, ...b0, ...b1);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  };
  const onBody = (z, i, out = 1.012, dy = 0) => { const p = bodyRing(z)[i]; return [p[0] * out, p[1] * out + dy, z]; };
  const headL = lens(range(2.035, 1.82, 0.012), (z) => { const [, yt, hw] = keyed(BODY, z); return [[hw * 1.005, yt - 0.12, z], [hw * 0.965, yt - 0.025, z]]; });
  const tailL = lens(range(-2.12, -2.37, 0.015), (z) => [onBody(z, 4, 1.012, 0.12), onBody(z, 6, 1.012, -0.01)]);
  for (const g of [headL, tailL]) { g.computeBoundingSphere(); }
  const lensMat = (m) => { const c = m.clone(); c.side = THREE.DoubleSide; c.polygonOffset = true; c.polygonOffsetFactor = -2; return c; };
  add(merge([headL, mirrorX(headL)]), lensMat(M.head), shell, false);
  add(merge([tailL, mirrorX(tailL)]), lensMat(M.tail), shell, false);
  // underbody between the wheels
  add(box(1.5, 0.12, 3.9, 0, 0.24, -0.15), M.black, shell, false);

  // --- greenhouse glass, roof skin, pillars
  const gz = range(0.45, -2.30, 0.05);
  add(loft(gz, glassRing, { closed: false }), M.glass, shell, false);
  const roofZ = range(-0.36, -1.80, 0.05);
  const roofRing = (z) => { const [, yt, , wt] = keyed(GLASS, z); return [[0, yt + 0.035], [wt * 0.55, yt + 0.03], [wt + 0.02, yt - 0.005], [wt + 0.025, yt - 0.045]]; };
  add(loft(roofZ, roofRing, { closed: false }), M.paint);
  const pil = [];
  const gp = (z, t) => { const [yb, yt, wb, wt] = keyed(GLASS, z); return [lerp(wb, wt, t) + 0.012, lerp(yb, yt, t), z]; };
  for (const sgn of [1, -1]) {
    const S = (p) => [p[0] * sgn, p[1], p[2]];
    pil.push(strut(S(gp(0.45, 0)), S(gp(-0.40, 1)), 0.06, 0.05));              // A
    pil.push(strut(S(gp(-1.62, 0)), S(gp(-1.62, 1)), 0.04, 0.2));             // C
    pil.push(strut(S(gp(-1.80, 1)), S(gp(-2.29, 0.0)), 0.06, 0.06));           // D (hatch edge)
    pil.push(strut(S(gp(0.42, 0.02)), S(gp(-2.25, 0.02)), 0.025, 0.025));        // window seal line
  }
  add(merge(pil), M.paint);
  const trim = [];
  for (const sgn of [1, -1]) {
    trim.push(strut([sgn * (keyed(GLASS, -0.86)[2] + 0.012), keyed(GLASS, -0.86)[0], -0.86], [sgn * (keyed(GLASS, -0.86)[3] + 0.012), keyed(GLASS, -0.86)[1], -0.86], 0.035, 0.09)); // blacked-out B pillar
    // black window surrounds on the doors
    trim.push(strut([sgn * 0.818, 1.0, -0.4], [sgn * 0.83, 1.02, -1.6], 0.02, 0.035));
    // side mirrors
    trim.push(box(0.17, 0.11, 0.07, sgn * 0.93, 1.05, 0.33, 0, sgn * 0.25, 0));
    trim.push(box(0.1, 0.04, 0.05, sgn * 0.85, 1.01, 0.35));
    // door handles
    trim.push(box(0.02, 0.025, 0.12, sgn * 0.892, 0.89, -0.05));
    trim.push(box(0.02, 0.025, 0.12, sgn * 0.892, 0.91, -1.05));
  }
  add(merge(trim), M.trim);

  // --- hood scoop (STI-style intercooler scoop on the GH WRX)
  const scoop = loft(range(1.38, 0.86, 0.04), (z) => {
    const t = (1.38 - z) / 0.52, hood = keyed(BODY, z)[1] + 0.008, h = 0.012 + 0.07 * Math.pow(1 - t, 0.6), w = 0.24 + 0.03 * t;
    return [[0, hood + h], [w * 0.8, hood + h * 0.95], [w, hood + 0.005], [w + 0.02, hood - 0.01]];
  }, { closed: false });
  add(scoop, M.paint);
  add(box(0.44, 0.055, 0.012, 0, keyed(BODY, 1.38)[1] + 0.045, 1.385), M.black, shell, false);
  // wheel-well liners
  add(merge([ZF, ZR].flatMap(z => [box(0.32, 0.42, 0.78, 0.6, 0.52, z), box(0.32, 0.42, 0.78, -0.6, 0.52, z)])), M.black, shell, false);

  // --- front: grille, lower intake, fog lights, headlights
  const fy = (z) => keyed(BODY, z);
  add(merge([
    box(0.56, 0.1, 0.04, 0, 0.63, 2.015, 0.25),             // upper grille
    box(1.0, 0.15, 0.06, 0, 0.36, 2.035, -0.1),             // lower intake
    box(0.05, 0.11, 0.05, 0.6, 0.37, 2.0), box(0.05, 0.11, 0.05, -0.6, 0.37, 2.0),
  ]), M.black, shell, false);
  add(box(0.08, 0.012, 0.01, 0, 0.63, 2.04, 0.25), M.chrome, shell, false); // badge bar
  for (const sgn of [1, -1]) {
    add(box(0.11, 0.06, 0.03, sgn * 0.62, 0.35, 2.02), M.head, shell, false);  // fog light
    add(box(0.02, 0.04, 0.12, sgn * 0.892, 0.7, 1.45), M.amber, shell, false);  // side marker
  }
  // --- rear: tail lights, hatch glass trim, spoiler, bumper, exhaust
  for (const sgn of [1, -1]) {
  }
  add(loft(range(-1.74, -1.98, 0.04), (z) => { const [, yt, , wt] = keyed(GLASS, -1.76); const t = (-1.74 - z) / 0.24; return [[0, yt + 0.05 - t * 0.02], [wt + 0.01, yt + 0.045 - t * 0.02], [wt + 0.015, yt + 0.0]]; }, { closed: false }), M.paint);
  add(box(1.3, 0.12, 0.08, 0, 0.36, -2.38), M.black, shell, false);       // rear diffuser/bumper lower
  add(box(0.36, 0.12, 0.02, 0, 0.62, -2.385), M.black, shell, false);     // plate recess
  const tip = new THREE.CylinderGeometry(0.052, 0.052, 0.16, 18, 1, true); tip.rotateX(Math.PI / 2); tip.translate(-0.42, 0.27, -2.37);
  add(tip, M.chrome, shell, false).material.side = THREE.DoubleSide;
  const tipIn = new THREE.CircleGeometry(0.048, 16); tipIn.rotateY(Math.PI); tipIn.translate(-0.42, 0.27, -2.33);
  add(tipIn, M.black, shell, false);

  // --- interior (cockpit view)
  let steeringWheel = null, eye = null, gauges = null;
  if (interior) {
    const inner = bodyGeo.clone(); inner.scale(0.985, 0.995, 0.985);
    add(inner, M.interior, shell, false);
    const headl = loft(roofZ, (z) => { const [, yt, , wt] = keyed(GLASS, z); return [[0, yt - 0.01], [wt * 0.95, yt - 0.03]]; }, { closed: false });
    add(headl, M.headliner, shell, false);
    // dashboard, binnacle, centre stack, console, seats, firewall, rear wall
    add(merge([
      box(1.62, 0.76, 0.02, 0, 0.58, 0.46), box(1.48, 0.7, 0.02, 0, 0.6, -2.29),
      box(1.55, 0.2, 0.43, 0, 0.86, 0.335, -0.08),
      box(0.42, 0.03, 0.2, 0.37, 1.105, 0.16, -0.12),      // gauge hood
      box(0.42, 0.16, 0.05, 0.37, 1.02, 0.25),             // binnacle back
      box(0.32, 0.38, 0.12, 0, 0.66, 0.08, 0.25),          // centre stack
      box(0.26, 0.14, 0.95, 0, 0.42, -0.45),               // console
      box(0.05, 0.12, 0.05, 0, 0.55, -0.15),               // gear lever
    ]), M.dash, shell, false);
    add(new THREE.SphereGeometry(0.035, 10, 8).translate(0, 0.62, -0.15), M.chrome, shell, false);
    const seats = [];
    for (const x of [0.37, -0.37]) {
      seats.push(box(0.5, 0.13, 0.5, x, 0.36, -0.68), box(0.5, 0.62, 0.12, x, 0.72, -0.98, -0.18), box(0.28, 0.16, 0.1, x, 1.1, -1.04, -0.18));
      seats.push(box(0.1, 0.2, 0.45, x + 0.22, 0.48, -0.7), box(0.1, 0.2, 0.45, x - 0.22, 0.48, -0.7));
    }
    seats.push(box(1.35, 0.5, 0.45, 0, 0.6, -1.6, -0.12));
    add(merge(seats), M.seat, shell, false);
    // gauge faces (canvas: tach + speedo), updated by the game
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas'); c.width = 512; c.height = 192;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.135), new THREE.MeshBasicMaterial({ map: tex }));
      face.position.set(0.37, 1.025, 0.2); face.rotation.set(0, Math.PI, 0); face.rotateX(-0.25);
      shell.add(face);
      gauges = { canvas: c, ctx: c.getContext('2d'), tex };
    }
    // steering wheel: rim + three spokes + hub, on the column
    steeringWheel = new THREE.Group();
    steeringWheel.position.set(0.37, 0.95, -0.14);
    steeringWheel.rotation.x = 0.42; // column rake: rim top leans away from the driver
    const sw = new THREE.Group(); steeringWheel.add(sw);
    const rim = new THREE.TorusGeometry(0.185, 0.019, 10, 40);
    const hub = new THREE.CylinderGeometry(0.06, 0.07, 0.05, 16); hub.rotateX(Math.PI / 2);
    const sp = [box(0.15, 0.035, 0.02, 0.1, 0, 0), box(0.15, 0.035, 0.02, -0.1, 0, 0), box(0.035, 0.15, 0.02, 0, -0.1, 0)];
    sw.add(new THREE.Mesh(merge([rim, hub, ...sp]), M.dash));
    const col = new THREE.CylinderGeometry(0.035, 0.045, 0.32, 10); col.rotateX(Math.PI / 2); col.translate(0, 0, 0.17);
    steeringWheel.add(new THREE.Mesh(col, M.dash));
    shell.add(steeringWheel);
    steeringWheel.userData.sw = sw;
    // rear-view mirror
    add(box(0.23, 0.065, 0.03, 0, 1.4, -0.36), M.trim, shell, false);
    eye = new THREE.Object3D(); eye.position.set(0.37, 1.21, -0.7); shell.add(eye);
  }
  // hood camera mount
  const hoodCam = new THREE.Object3D(); hoodCam.position.set(0, 1.0, 1.12); shell.add(hoodCam);

  // --- wheels: FL, FR, RL, RR (x>0 = left)
  const wheels = [];
  for (const [x, z] of [[0.765, ZF], [-0.765, ZF], [0.77, ZR], [-0.77, ZR]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, WR, z);
    const w = wheel(M, x > 0); pivot.add(w.group); root.add(pivot);
    wheels.push({ pivot, spin: w.spin });
  }

  root.userData = { body, wheels, eye, hoodCam, gauges, materials: M,
    steeringWheel: steeringWheel ? steeringWheel.userData.sw : null };
  return root;
}

// draw tach/speedo into the cockpit gauge canvas
export function drawGauges(g, rpm, mph, gear, boostPsi) {
  if (!g) return;
  const c = g.ctx, W = g.canvas.width, H = g.canvas.height;
  c.fillStyle = '#050607'; c.fillRect(0, 0, W, H);
  const dial = (cx, val, max, red, label, ticks) => {
    const r = 82, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    c.lineWidth = 3; c.strokeStyle = '#d33'; c.beginPath(); c.arc(cx, 96, r, a0 + (a1 - a0) * red / max, a1); c.stroke();
    c.strokeStyle = '#ccc'; c.fillStyle = '#ddd'; c.font = '14px sans-serif'; c.textAlign = 'center';
    for (let k = 0; k <= ticks; k++) {
      const a = a0 + (a1 - a0) * k / ticks;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (r - 10), 96 + Math.sin(a) * (r - 10)); c.lineTo(cx + Math.cos(a) * r, 96 + Math.sin(a) * r); c.stroke();
      c.fillText(String(Math.round(max / ticks * k / (label === 'RPM' ? 1000 : 1))), cx + Math.cos(a) * (r - 24), 101 + Math.sin(a) * (r - 24));
    }
    const a = a0 + (a1 - a0) * Math.min(1, val / max);
    c.strokeStyle = '#ff6a1a'; c.lineWidth = 4; c.beginPath(); c.moveTo(cx, 96); c.lineTo(cx + Math.cos(a) * (r - 8), 96 + Math.sin(a) * (r - 8)); c.stroke();
    c.fillStyle = '#888'; c.font = '12px sans-serif'; c.fillText(label, cx, 140);
  };
  dial(130, rpm, 8000, 6700, 'RPM', 8);
  dial(382, mph, 160, 999, 'MPH', 8);
  c.fillStyle = '#ff8a2a'; c.font = 'bold 34px sans-serif'; c.textAlign = 'center'; c.fillText(String(gear), 256, 80);
  c.fillStyle = '#9cf'; c.font = '16px sans-serif'; c.fillText(`${boostPsi.toFixed(0)} psi`, 256, 120);
  g.tex.needsUpdate = true;
}
