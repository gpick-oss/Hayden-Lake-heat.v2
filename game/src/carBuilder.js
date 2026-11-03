import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural cars built from lofted cross-sections. Model space: +z forward, +x = driver's left,
// y up, origin on the ground under the centre of mass (front axle z = ZF, rear axle z = ZR).
// buildSTI(): 2018+ Subaru WRX STI sedan (VA).  buildBRZ(): 2017+ Subaru BRZ coupe (ZC6).
const CG = 0.52;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// smooth (Catmull-Rom) interpolation of keyed rows [z, ...values], keys in descending z
function keyed(keys, z) {
  if (z >= keys[0][0]) return keys[0].slice(1);
  const last = keys.length - 1;
  if (z <= keys[last][0]) return keys[last].slice(1);
  let k = 1; while (keys[k][0] > z) k++;
  const a = keys[k - 1], b = keys[k], p = keys[Math.max(k - 2, 0)], q = keys[Math.min(k + 1, last)];
  const t = (z - a[0]) / (b[0] - a[0]);
  const out = [];
  for (let i = 1; i < a.length; i++) {
    const m0 = (b[i] - p[i]) / ((b[0] - p[0]) || 1) * (b[0] - a[0]), m1 = (q[i] - a[i]) / ((q[0] - a[0]) || 1) * (b[0] - a[0]);
    const t2 = t * t, t3 = t2 * t;
    out.push((2 * t3 - 3 * t2 + 1) * a[i] + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * b[i] + (t3 - t2) * m1);
  }
  return out;
}
const range = (a, b, step) => { const o = []; for (let z = a; z > b + 1e-6; z -= step) o.push(z); o.push(b); return o; };

// rings of right-half points (x >= 0) per station, mirrored to the left
function loft(zs, ringFn, { capStart = false, capEnd = false, closed = true, flip = false } = {}) {
  const rings = zs.map(z => {
    const half = ringFn(z);
    const left = (closed ? half.slice(1, -1) : half.slice(1)).reverse().map(([x, y]) => [-x, y]);
    const ring = closed ? [...half, ...left] : [...left.slice().reverse().reverse(), ...half];
    return (closed ? ring : [...half.slice(1).map(([x, y]) => [-x, y]).reverse(), ...half]).map(([x, y]) => [x, y, z]);
  });
  const n = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(...p);
  for (let s = 0; s < rings.length - 1; s++) for (let k = 0; k < (closed ? n : n - 1); k++) {
    const a = s * n + k, b = s * n + (k + 1) % n, c = a + n, d = b + n;
    (closed || flip) ? idx.push(a, c, b, b, c, d) : idx.push(a, b, c, b, d, c);
  }
  const cap = (s, flipCap) => {
    const base = pos.length / 3; let cx = 0, cy = 0;
    for (const p of rings[s]) { cx += p[0]; cy += p[1]; }
    pos.push(cx / n, cy / n, rings[s][0][2]);
    for (let k = 0; k < n; k++) { const a = s * n + k, b = s * n + (k + 1) % n; flipCap ? idx.push(base, b, a) : idx.push(base, a, b); }
  };
  if (closed && capStart) cap(0, false);
  if (closed && capEnd) cap(rings.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function strip(zs, fn, mirror = true) {   // ribbon between two points per station
  const pos = [];
  for (let k = 0; k < zs.length - 1; k++) {
    const [a0, a1] = fn(zs[k]), [b0, b1] = fn(zs[k + 1]);
    pos.push(...a0, ...b0, ...a1, ...a1, ...b0, ...b1);
  }
  let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  if (mirror) g = merge([g, mirrorX(g)]);
  return g;
}
function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z); return g;
}
function strut(a, b, w, d) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), g = new THREE.BoxGeometry(w, A.distanceTo(B), d);
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.applyMatrix4(new THREE.Matrix4().lookAt(A, B, new THREE.Vector3(0, 1, 0)));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2); return g;
}
function mirrorX(g) {
  const c = g.clone(); c.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  if (c.index) { const a = c.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; } }
  else { const p = c.attributes.position.array; for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + k]; p[i + k] = p[i + 6 + k]; p[i + 6 + k] = t; } }
  c.computeVertexNormals(); return c;
}
const both = (g) => merge([g, mirrorX(g)]);
function merge(list) {
  const gs = list.filter(Boolean).map(g => { let n = g.index ? g.toNonIndexed() : g.clone(); for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k); n.computeVertexNormals(); return n; });
  return mergeGeometries(gs);
}
// extrude a 2D outline (in the x-y plane of a face) by depth along z, then place it
function plate(pts2, depth, place) {
  const sh = new THREE.Shape(pts2.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, steps: 1 });
  g.applyMatrix4(place); return g;
}
const M4 = (x, y, z, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

// ---------------------------------------------------------------------------------------------
// reflections: a painted sky / tree-line / road environment so black paint has something to show
let envTex = null;
export function carEnvironment(renderer) {
  if (envTex || typeof document === 'undefined') return envTex;
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#2f63b0'); sky.addColorStop(0.6, '#8fb4dc'); sky.addColorStop(1, '#d9e4ec');
  g.fillStyle = sky; g.fillRect(0, 0, 1024, 256);
  // soft clouds
  for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.12})`; g.beginPath(); g.ellipse(Math.random() * 1024, 60 + Math.random() * 150, 40 + Math.random() * 90, 8 + Math.random() * 16, 0, 0, 7); g.fill(); }
  // sun
  const sg = g.createRadialGradient(640, 110, 0, 640, 110, 70); sg.addColorStop(0, 'rgba(255,252,235,1)'); sg.addColorStop(0.15, 'rgba(255,248,220,0.9)'); sg.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = sg; g.fillRect(560, 30, 160, 160);
  // conifer tree line on the horizon
  g.fillStyle = '#16231a';
  g.beginPath(); g.moveTo(0, 256);
  for (let x = 0; x <= 1024; x += 6) { const h = 22 + Math.abs(Math.sin(x * 0.05) * 18) + Math.random() * 26; g.lineTo(x, 256 - h); g.lineTo(x + 3, 256 - h * 0.55); }
  g.lineTo(1024, 256); g.closePath(); g.fill();
  // ground: asphalt + grass
  const gr = g.createLinearGradient(0, 256, 0, 512); gr.addColorStop(0, '#5d6a4f'); gr.addColorStop(0.18, '#56605a'); gr.addColorStop(0.45, '#5a5d61'); gr.addColorStop(1, '#2b2c2e');
  g.fillStyle = gr; g.fillRect(0, 256, 1024, 256);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromEquirectangular(t).texture; pm.dispose();
  return envTex;
}

let honey = null;
function honeycombTexture() {
  if (honey || typeof document === 'undefined') return honey;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#050505'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#6a6c70'; g.lineWidth = 3;
  const r = 10, w = r * Math.sqrt(3);
  for (let row = -1; row < 9; row++) for (let col = -1; col < 9; col++) {
    const cx = col * w + (row % 2 ? w / 2 : 0), cy = row * r * 1.5;
    g.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.closePath(); g.stroke();
  }
  honey = new THREE.CanvasTexture(c); honey.wrapS = honey.wrapT = THREE.RepeatWrapping; honey.repeat.set(6, 6); honey.colorSpace = THREE.SRGBColorSpace;
  return honey;
}

function materials(color, env, rimColor, caliperColor) {
  const std = (o) => new THREE.MeshStandardMaterial({ envMap: env, ...o });
  return {
    paint: new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, envMap: env, envMapIntensity: 1.7 }),
    glass: std({ color: 0x0b0f14, metalness: 0.1, roughness: 0.03, transparent: true, opacity: 0.86, envMapIntensity: 1.5, side: THREE.DoubleSide, depthWrite: false }),
    black: std({ color: 0x0a0a0b, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.3 }),
    gloss: std({ color: 0x050506, roughness: 0.18, metalness: 0.2, envMapIntensity: 0.9 }),
    honeycomb: std({ color: 0x9a9ca0, roughness: 0.55, metalness: 0.3, envMapIntensity: 0.5, map: honeycombTexture() }),
    chrome: std({ color: 0xdfe3e8, roughness: 0.12, metalness: 1.0 }),
    head: std({ color: 0x1a2028, roughness: 0.02, metalness: 0.2, transparent: true, opacity: 0.35, envMapIntensity: 2.5, depthWrite: false }),
    reflector: std({ color: 0xe4e9ef, roughness: 0.1, metalness: 1.0, envMapIntensity: 2.0 }),
    drl: new THREE.MeshBasicMaterial({ color: 0xf2f8ff }),
    tail: std({ color: 0x5a040b, roughness: 0.08, metalness: 0.3, emissive: 0x2a0003, envMapIntensity: 1.5 }),
    tailLit: new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
    amber: std({ color: 0xd07a10, roughness: 0.3, emissive: 0x201000 }),
    tyre: std({ color: 0x141414, roughness: 0.95, envMapIntensity: 0.1 }),
    rim: std({ color: rimColor, roughness: 0.32, metalness: 0.8, envMapIntensity: 1.4, side: THREE.DoubleSide }),
    disc: std({ color: 0x5c5d60, roughness: 0.45, metalness: 0.85 }),
    caliper: std({ color: caliperColor, roughness: 0.4, metalness: 0.2 }),
    badge: std({ color: 0xc8ccd2, roughness: 0.2, metalness: 1.0 }),
    badgeRed: std({ color: 0xc8101e, roughness: 0.3, metalness: 0.4 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.85, side: THREE.BackSide }),
    dash: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.8 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.9 }),
    seatRed: new THREE.MeshStandardMaterial({ color: 0x6d0f14, roughness: 0.85 }),
    headliner: new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.95, side: THREE.BackSide }),
  };
}

// ---------------------------------------------------------------------------------------------
// wheels: tyre lathe + barrel + spokes; style 'y10' = five Y spokes (STI), 'ten' = ten straight
function wheel(M, { R, rimR, width, style, bigBrake, left }) {
  const g = new THREE.Group(), spin = new THREE.Group();
  const prof = [];
  for (let k = 0; k <= 18; k++) {
    const t = k / 18, a = t * Math.PI, x = -width / 2 + width * t, bul = Math.sin(a);
    prof.push(new THREE.Vector2(rimR + (R - rimR) * (0.12 + 0.88 * Math.pow(bul, 0.3)), x * (0.93 + 0.07 * bul)));
  }
  const tyre = new THREE.LatheGeometry(prof, 40); tyre.rotateZ(Math.PI / 2);
  const barrel = new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 36, 1, true); barrel.rotateZ(Math.PI / 2);
  const lip = new THREE.TorusGeometry(rimR - 0.004, 0.008, 6, 40); lip.rotateY(Math.PI / 2); lip.translate(width / 2 - 0.012, 0, 0);
  const face = width / 2 - 0.03;
  const spokes = [];
  const spoke = (ang, w0, w1, len) => {
    // tapered spoke from hub to rim, slightly dished
    const s = new THREE.BufferGeometry();
    const r0 = 0.07, r1 = rimR - 0.012;
    const p = [[-w0 / 2, r0, 0.0], [w0 / 2, r0, 0.0], [w1 / 2, r1, -0.025], [-w1 / 2, r1, -0.025]];
    const v = [];
    const T = (x, y, z) => [face + z, y * Math.cos(ang) - x * Math.sin(ang), y * Math.sin(ang) + x * Math.cos(ang)];
    const q = p.map(([x, y, z]) => T(x, y, z)), qb = p.map(([x, y, z]) => T(x, y, z - 0.03));
    const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad(q[0], q[1], q[2], q[3]); quad(qb[3], qb[2], qb[1], qb[0]);
    quad(q[1], qb[1], qb[2], q[2]); quad(q[3], qb[3], qb[0], q[0]);
    s.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); s.computeVertexNormals();
    spokes.push(s);
  };
  if (style === 'y10') {
    for (let k = 0; k < 5; k++) { const a = k * Math.PI * 2 / 5; spoke(a - 0.11, 0.055, 0.038, 0); spoke(a + 0.11, 0.055, 0.038, 0); }
  } else {
    for (let k = 0; k < 10; k++) spoke(k * Math.PI * 2 / 10, 0.04, 0.028, 0);
  }
  const hub = new THREE.CylinderGeometry(0.065, 0.075, 0.05, 20); hub.rotateZ(Math.PI / 2); hub.translate(face - 0.01, 0, 0);
  const cap = new THREE.CylinderGeometry(0.03, 0.03, 0.01, 16); cap.rotateZ(Math.PI / 2); cap.translate(face + 0.016, 0, 0);
  const disc = new THREE.CylinderGeometry(rimR - 0.045, rimR - 0.045, 0.028, 32); disc.rotateZ(Math.PI / 2); disc.translate(-0.01, 0, 0);
  const mk = (geo, mat, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; return m; };
  spin.add(mk(tyre, M.tyre), mk(merge([barrel, lip, hub, ...spokes]), M.rim), mk(cap, M.badge, false), mk(disc, M.disc, false));
  // caliper sits ahead of/above the axle and doesn't spin
  const ch = bigBrake ? 0.2 : 0.13, cd = bigBrake ? 0.11 : 0.08;
  const cal = box(0.07, ch, cd, 0.005, rimR - 0.07, 0.04, -0.75, 0, 0);
  g.add(spin, mk(cal, M.caliper, false));
  if (!left) g.scale.x = -1;
  return { group: g, spin };
}

// ---------------------------------------------------------------------------------------------
function assemble(spec, M, { interior }) {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.position.y = CG; root.add(body);
  const shell = new THREE.Group(); shell.position.y = -CG; body.add(shell);
  const add = (geo, mat, parent = shell, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m; };
  const { ZF, ZR, R, arch } = spec;
  const B = spec.body, Gk = spec.glass;

  // ---- body cross-section
  const ring = (z, open = false) => {
    const [yb0, yt, W0, ys, Wt] = keyed(B, z);
    let yb = yb0;
    for (const za of [ZF, ZR]) { const dz = z - za; if (Math.abs(dz) < arch) yb = Math.max(yb, R + Math.sqrt(arch * arch - dz * dz) * 0.98); }
    let fl = 0; for (const za of [ZF, ZR]) fl = Math.max(fl, spec.flare * Math.max(0, 1 - Math.pow(Math.abs(z - za) / 0.75, 2)));
    const W = W0 + fl, h = ys - yb0;
    const lo = (y) => Math.max(y, yb);
    const pts = [
      [0, lo(yb0 + 0.015)], [W * 0.6, lo(yb0)], [W * 0.92, lo(yb0 + 0.025)], [W * 0.975, lo(yb0 + 0.09)],
      [W, Math.max(lo(yb0 + h * 0.45), yb + 0.015)], [W * 0.997, Math.max(ys - 0.05, yb + 0.02)], [W * 0.985, ys],
      [lerp(W * 0.985, Wt, 0.55), lerp(ys, yt, 0.6)], [Wt, yt - 0.012], [Wt * 0.55, yt - 0.002], [0, yt + 0.006],
    ];
    return open ? pts.slice(0, -3) : pts;
  };
  const zFront = B[0][0], zRear = B[B.length - 1][0];
  const bodyGeo = merge([
    loft(range(zFront, spec.cowl, 0.03), (z) => ring(z)),
    loft(range(spec.cowl, spec.deck, 0.03), (z) => ring(z, true), { closed: false, flip: true }),
    loft(range(spec.deck, zRear, 0.03), (z) => ring(z)),
  ]);
  add(bodyGeo, M.paint);
  // nose/tail end caps (the bumper faces) in paint, firewall/back panel dark
  add(loft([zFront + 0.001, zFront], (z) => ring(zFront), { capStart: true }), M.paint);
  add(loft([zRear, zRear - 0.001], (z) => ring(zRear), { capEnd: true }), M.paint);
  add(merge([box(1.6, 0.13, Math.abs(zRear - zFront) - 0.6, 0, 0.27, (zFront + zRear) / 2)]), M.black, shell, false); // underbody
  add(merge([ZF, ZR].flatMap(z => [box(0.3, 0.45, arch * 2, 0.62, R + 0.15, z), box(0.3, 0.45, arch * 2, -0.62, R + 0.15, z)])), M.black, shell, false);

  // ---- greenhouse
  const gz = range(spec.cowl, spec.deck, 0.04);
  const gring = (z) => { const [yb, yt, wb, wt] = keyed(Gk, z); return [[0, yt + 0.004], [wt, yt], [lerp(wt, wb, 0.62), lerp(yt, yb, 0.6)], [wb, yb]]; };
  add(loft(gz, gring, { closed: false }), M.glass, shell, false);
  const roofRing = (z) => { const [, yt, , wt] = keyed(Gk, z); return [[0, yt + 0.03], [wt * 0.55, yt + 0.026], [wt + 0.02, yt - 0.006], [wt + 0.024, yt - 0.05]]; };
  add(loft(range(spec.roof[0], spec.roof[1], 0.04), roofRing, { closed: false }), M.paint);
  const gp = (z, t) => { const [yb, yt, wb, wt] = keyed(Gk, z); return [lerp(wb, wt, t) + 0.01, lerp(yb, yt, t), z]; };
  const pil = [], darkPil = [];
  for (const sg of [1, -1]) {
    const S = (p) => [p[0] * sg, p[1], p[2]];
    pil.push(strut(S(gp(spec.cowl, 0)), S(gp(spec.roof[0], 1)), 0.05, 0.045));           // A pillar
    for (const [za, zb] of spec.cPillar) pil.push(strut(S(gp(za, 1)), S(gp(zb, 0.02)), 0.07, 0.07));
    pil.push(strut(S(gp(spec.cowl - 0.03, 0.02)), S(gp(spec.deck + 0.05, 0.02)), 0.022, 0.03)); // belt
    for (const zb of spec.bPillars) darkPil.push(strut(S(gp(zb, 0)), S(gp(zb, 1)), 0.03, 0.09));
    darkPil.push(strut(S(gp(spec.roof[0] + 0.02, 0.97)), S(gp(spec.roof[1], 0.97)), 0.018, 0.02)); // drip rail
  }
  add(merge(pil), M.paint);
  add(merge(darkPil), M.gloss, shell, false);
  if (spec.sail) {
    // body-colour sail panel from the rear door glass back to the rear window
    const [z0, z1] = spec.sail;
    add(strip(range(z0, z1, 0.03), (z) => {
      const [yb, yt, wb, wt] = keyed(Gk, z);
      return [[wb + 0.006, yb, z], [lerp(wb, wt, 0.97) + 0.006, yt - 0.004, z]];
    }), M.paint, shell, true);
  }

  // ---- details: the spec draws them (fascia, lights, wing, trims) using these helpers
  const H = { add, M, ring, keyed: (z) => keyed(B, z), glass: (z) => keyed(Gk, z), box, strut, strip, both, merge, plate, M4, loft, range, shell };
  spec.details(H);

  // ---- wheels FL FR RL RR
  const wheels = [];
  for (const [x, z, front] of [[spec.trackF / 2, ZF, 1], [-spec.trackF / 2, ZF, 1], [spec.trackR / 2, ZR, 0], [-spec.trackR / 2, ZR, 0]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, R, z);
    const w = wheel(M, { R, rimR: spec.rimR, width: spec.tyreW, style: spec.wheelStyle, bigBrake: !!front && spec.bigBrake, left: x > 0 });
    pivot.add(w.group); root.add(pivot); wheels.push({ pivot, spin: w.spin });
  }

  // ---- interior + camera anchors
  let steeringWheel = null, eye = null, gauges = null, mirror = null;
  if (interior) ({ steeringWheel, eye, gauges, mirror } = cabin(H, spec, bodyGeo));
  const hoodCam = new THREE.Object3D(); hoodCam.position.set(0, spec.hoodCam[1], spec.hoodCam[0]); shell.add(hoodCam);
  root.userData = { body, wheels, eye, hoodCam, gauges, mirror, materials: M, steeringWheel };
  return root;
}

function cabin(H, spec, bodyGeo) {
  const { add, M, box, merge, loft, range } = H;
  const c = spec.cab;
  const inner = bodyGeo.clone(); inner.scale(0.985, 0.995, 0.99);
  add(inner, M.interior, H.shell, false);
  add(loft(range(spec.roof[0] - 0.02, spec.roof[1] + 0.02, 0.05), (z) => { const [, yt, , wt] = H.glass(z); return [[0, yt - 0.012], [wt * 0.96, yt - 0.035]]; }, { closed: false }), M.headliner, H.shell, false);
  add(merge([
    box(1.62, 0.76, 0.02, 0, 0.58, spec.cowl + 0.05), box(1.5, 0.66, 0.02, 0, 0.62, spec.deck - 0.02),   // firewall, rear bulkhead
    box(1.55, 0.2, 0.42, 0, c.dashY - 0.1, spec.cowl - 0.07, -0.08),                                     // dash
    box(0.42, 0.03, 0.2, 0.37, c.dashY + 0.145, spec.cowl - 0.26, -0.12),                                // gauge hood
    box(0.42, 0.16, 0.05, 0.37, c.dashY + 0.06, spec.cowl - 0.17),
    box(0.3, 0.36, 0.12, 0, c.dashY - 0.28, spec.cowl - 0.3, 0.25),                                       // centre stack
    box(0.26, 0.14, 0.95, 0, 0.42, spec.cowl - 0.85),                                                     // console
    box(0.05, 0.12, 0.05, 0, 0.55, spec.cowl - 0.55),                                                     // shifter
  ]), M.dash, H.shell, false);
  add(new THREE.SphereGeometry(0.034, 10, 8).translate(0, 0.62, spec.cowl - 0.55), M.chrome, H.shell, false);
  const seats = [], red = [];
  for (const x of [0.37, -0.37]) {
    seats.push(box(0.5, 0.13, 0.5, x, 0.36, c.seatZ, 0), box(0.52, 0.64, 0.12, x, 0.73, c.seatZ - 0.3, -0.18), box(0.28, 0.17, 0.1, x, 1.12, c.seatZ - 0.37, -0.18));
    red.push(box(0.11, 0.24, 0.47, x + 0.22, 0.49, c.seatZ), box(0.11, 0.24, 0.47, x - 0.22, 0.49, c.seatZ));
  }
  if (c.rearSeat) seats.push(box(1.35, 0.5, 0.45, 0, 0.6, c.rearSeat, -0.12), box(1.35, 0.12, 0.5, 0, 0.36, c.rearSeat + 0.3));
  add(merge(seats), M.seat, H.shell, false); add(merge(red), M.seatRed, H.shell, false);
  // gauges
  let gauges = null;
  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.135), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0.37, c.dashY + 0.065, spec.cowl - 0.2); face.rotation.set(0, Math.PI, 0); face.rotateX(-0.25);
    H.shell.add(face); gauges = { canvas: cv, ctx: cv.getContext('2d'), tex };
  }
  // steering wheel (flat-bottom STI wheel)
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(c.eyeX ?? 0.37, c.dashY - 0.03, spec.cowl - 0.58); steeringWheel.rotation.x = 0.42;
  const sw = new THREE.Group(); steeringWheel.add(sw);
  const rim = new THREE.TorusGeometry(0.185, 0.02, 10, 44, Math.PI * 1.7); rim.rotateZ(-Math.PI * 0.35 + Math.PI / 2 - Math.PI * 0.5);
  const flat = new THREE.CylinderGeometry(0.02, 0.02, 0.21, 8); flat.rotateZ(Math.PI / 2); flat.translate(0, -0.165, 0);
  const hub = new THREE.CylinderGeometry(0.065, 0.075, 0.05, 16); hub.rotateX(Math.PI / 2);
  const sp = [box(0.15, 0.035, 0.02, 0.1, 0, 0), box(0.15, 0.035, 0.02, -0.1, 0, 0), box(0.035, 0.14, 0.02, 0, -0.09, 0)];
  sw.add(new THREE.Mesh(merge([rim, flat, hub, ...sp]), M.dash));
  const col = new THREE.CylinderGeometry(0.035, 0.045, 0.32, 10); col.rotateX(Math.PI / 2); col.translate(0, 0, 0.17);
  steeringWheel.add(new THREE.Mesh(col, M.dash)); H.shell.add(steeringWheel);
  // rear-view mirror housing; the game puts a live rear view on `mirror`
  // mounted on the windscreen just below the headliner, a little ahead of the driver's eyes
  const mz = spec.roof[0] + 0.13, [, yTop] = H.glass(mz);
  add(box(0.25, 0.075, 0.03, 0, yTop - 0.085, mz - 0.03), M.gloss, H.shell, false);
  add(box(0.03, 0.05, 0.03, 0, yTop - 0.035, mz - 0.01), M.gloss, H.shell, false);
  const mirror = new THREE.Object3D(); mirror.position.set(0, yTop - 0.085, mz - 0.047); H.shell.add(mirror);
  const eye = new THREE.Object3D(); eye.position.set(c.eyeX ?? 0.37, c.eyeY, c.seatZ - 0.06); H.shell.add(eye);
  return { steeringWheel: sw, eye, gauges, mirror };
}

// =============================================================================================
// 2018+ WRX STI (VA): 4,595 x 1,795 x 1,475 mm, 2,650 mm wheelbase, 245/35R19
export function buildSTI(color = 0x07080a, opts = {}) {
  const env = opts.envMap ?? envTex;
  const M = materials(color, env, 0x464a50, 0xf2c200);
  const ZF = 1.06, ZR = -1.56, R = 0.327;
  const spec = {
    ZF, ZR, R, arch: 0.375, flare: 0.026, rimR: 0.2413, tyreW: 0.245, trackF: 1.53, trackR: 1.54,
    wheelStyle: 'y10', bigBrake: true,
    cowl: 0.40, deck: -1.95, roof: [-0.47, -1.38], cPillar: [], bPillars: [-0.82], sail: [-1.42, -1.96],
    hoodCam: [1.16, 1.0],
    cab: { dashY: 0.96, seatZ: -0.74, eyeY: 1.2, eyeX: 0.33, rearSeat: -1.6 },
    //        z      yBot   yTop   W      yShoulder  Wtop
    body: [
      [2.060, 0.210, 0.700, 0.720, 0.600, 0.56],
      [2.030, 0.200, 0.762, 0.808, 0.668, 0.65],
      [1.960, 0.200, 0.795, 0.858, 0.712, 0.71],
      [1.800, 0.210, 0.825, 0.886, 0.740, 0.755],
      [1.550, 0.210, 0.858, 0.895, 0.770, 0.78],
      [1.060, 0.210, 0.902, 0.897, 0.800, 0.79],
      [0.700, 0.210, 0.935, 0.890, 0.830, 0.78],
      [0.400, 0.210, 0.962, 0.886, 0.858, 0.775],
      [0.000, 0.210, 0.985, 0.886, 0.880, 0.80],
      [-0.600, 0.210, 1.002, 0.890, 0.898, 0.80],
      [-1.200, 0.212, 1.022, 0.891, 0.918, 0.79],
      [-1.560, 0.220, 1.040, 0.897, 0.930, 0.78],
      [-1.950, 0.232, 1.068, 0.880, 0.950, 0.76],
      [-2.200, 0.250, 1.076, 0.862, 0.952, 0.74],
      [-2.420, 0.300, 1.066, 0.822, 0.942, 0.70],
      [-2.500, 0.300, 1.050, 0.800, 0.930, 0.67],
      [-2.548, 0.300, 1.005, 0.770, 0.900, 0.63],
    ],
    //        z     yBase  yTop   Wbase  Wtop
    glass: [
      [0.400, 0.965, 0.975, 0.800, 0.700],
      [0.100, 0.975, 1.130, 0.800, 0.690],
      [-0.200, 0.985, 1.292, 0.802, 0.665],
      [-0.470, 0.992, 1.448, 0.805, 0.645],
      [-0.950, 1.005, 1.475, 0.810, 0.640],
      [-1.380, 1.022, 1.452, 0.812, 0.632],
      [-1.600, 1.040, 1.360, 0.800, 0.620],
      [-1.800, 1.055, 1.220, 0.782, 0.600],
      [-1.950, 1.068, 1.085, 0.762, 0.585],
    ],
    details: (H) => stiDetails(H, ZF, ZR),
  };
  return assemble(spec, M, { interior: opts.interior !== false });
}

function stiDetails(H, ZF, ZR) {
  const { add, M, box, strut, strip, both, merge, plate, M4, loft, range } = H;
  const top = (z) => H.keyed(z)[1], wid = (z) => H.keyed(z)[2], sh = (z) => H.keyed(z)[3];
  const fz = 2.06;

  // hood scoop: wide, flat-topped, opening at the front, fairing into the hood toward the screen
  add(loft(range(1.44, 0.82, 0.03), (z) => {
    const t = (1.44 - z) / 0.62, base = top(z) + 0.004, h = 0.012 + 0.072 * Math.pow(1 - t, 0.55), w = 0.33 - 0.05 * t;
    return [[0, base + h], [w * 0.86, base + h * 0.97], [w, base + h * 0.45], [w + 0.04, base - 0.008]];
  }, { closed: false }), M.paint);
  add(box(0.54, 0.062, 0.012, 0, top(1.44) + 0.044, 1.442), M.honeycomb, H.shell, false);
  add(both(strut([0.43, top(1.9) + 0.004, 1.9], [0.37, top(0.45) + 0.004, 0.45], 0.012, 0.008)), M.paint, H.shell, false);

  // ---- front fascia (body-colour bumper with black openings)
  // upper hexagonal grille between the headlights, with the wing-shaped bar and badge
  add(plate([[-0.40, 0.0], [0.40, 0.0], [0.44, 0.07], [0.33, 0.125], [-0.33, 0.125], [-0.44, 0.07]], 0.06, M4(0, 0.545, fz - 0.05, -0.15, 0, 0)), M.honeycomb, H.shell, false);
  add(plate([[-0.42, 0], [0.42, 0], [0.38, 0.018], [-0.38, 0.018]], 0.02, M4(0, 0.6, fz + 0.005, -0.15, 0, 0)), M.gloss, H.shell, false);
  const badge = new THREE.CylinderGeometry(0.05, 0.05, 0.012, 24); badge.rotateX(Math.PI / 2); badge.scale(1, 0.55, 1); badge.translate(0, 0.61, fz + 0.022);
  add(badge, M.badge, H.shell, false);
  add(box(0.06, 0.018, 0.008, 0.25, 0.575, fz + 0.012, -0.15), M.badgeRed, H.shell, false);
  // big lower intake with a body-colour bar, and the angular fog-light pods at the corners
  add(plate([[-0.46, 0.0], [0.46, 0.0], [0.4, 0.2], [-0.4, 0.2]], 0.07, M4(0, 0.235, fz - 0.06, 0.08, 0, 0)), M.honeycomb, H.shell, false);
  add(box(0.84, 0.03, 0.03, 0, 0.36, fz + 0.012, 0.08), M.paint, H.shell, true);
  for (const s of [1, -1]) {
    add(plate([[0, 0], [0.19, 0], [0.24, 0.2], [0.06, 0.17]].map(([x, y]) => [x * s, y]), 0.07, M4(s * 0.5, 0.235, fz - 0.08)), M.gloss, H.shell, false);
    const fog = new THREE.CylinderGeometry(0.036, 0.036, 0.02, 18); fog.rotateX(Math.PI / 2); fog.translate(s * 0.64, 0.33, fz + 0.0);
    add(fog, M.reflector, H.shell, false);
    add(box(0.12, 0.012, 0.01, s * 0.62, 0.395, fz - 0.004, 0, 0, s * -0.35), M.drl, H.shell, false);
  }
  add(box(1.56, 0.028, 0.13, 0, 0.205, fz - 0.03), M.gloss, H.shell, false);                                  // splitter lip

  // ---- headlights: clear lens over a chrome reflector, with the C-shaped LED running light
  const lensFn = (z) => {
    const t = (2.05 - z) / 0.4, y0 = top(z) - 0.125 + 0.07 * t, y1 = top(z) - 0.008, w = wid(z);
    return [[w * 1.007, y0, z], [Math.min(w * 0.985, 0.8), y1, z]];
  };
  add(strip(range(2.05, 1.65, 0.01), (z) => { const [a, b] = lensFn(z); return [[a[0] - 0.006, a[1] + 0.012, z], [b[0] - 0.006, b[1] - 0.006, z]]; }), M.reflector, H.shell, false);
  const lens = strip(range(2.05, 1.65, 0.01), lensFn);
  add(lens, M.head, H.shell, false);
  add(strip(range(2.04, 1.80, 0.01), (z) => { const [a] = lensFn(z); return [[a[0] + 0.002, a[1] + 0.004, z], [a[0] + 0.002, a[1] + 0.018, z]]; }), M.drl, H.shell, false);
  add(strip(range(1.80, 1.74, 0.01), (z) => { const [a, b] = lensFn(z); return [[a[0] + 0.002, a[1] + 0.004, z], [b[0] + 0.002, b[1] - 0.02, z]]; }), M.drl, H.shell, false);
  // projector bowls
  for (const s of [1, -1]) { const p = new THREE.SphereGeometry(0.04, 14, 10); p.scale(1, 1, 0.5); p.translate(s * 0.62, top(1.98) - 0.06, 1.99); add(p, M.reflector, H.shell, false); }
  add(both(box(0.02, 0.035, 0.11, wid(1.45) + 0.006, sh(1.45) - 0.05, 1.45)), M.amber, H.shell, false);

  // ---- side: STI fender garnish, mirrors, handles, skirts, shut lines
  for (const s of [1, -1]) {
    add(plate([[0, 0], [0.2, 0], [0.24, 0.06], [0.03, 0.06]], 0.012, M4(s * (wid(0.62) + 0.012), sh(0.62) - 0.09, 0.52 + (s > 0 ? 0.24 : 0), 0, s * Math.PI / 2, 0)), M.gloss, H.shell, false);
    add(box(0.018, 0.012, 0.05, s * (wid(0.62) + 0.02), sh(0.62) - 0.06, 0.64), M.badgeRed, H.shell, false);
    const head = new THREE.SphereGeometry(1, 18, 12); head.scale(0.1, 0.06, 0.05); head.translate(s * 0.97, 1.075, 0.29);
    add(head, M.paint, H.shell, true);
    add(box(0.11, 0.045, 0.07, s * 0.87, 1.035, 0.31), M.gloss, H.shell, false);
    add(box(0.13, 0.012, 0.02, s * 0.985, 1.06, 0.33, 0, s * 0.25, 0), M.amber, H.shell, false);
    for (const z of [-0.06, -1.06]) add(box(0.018, 0.026, 0.13, s * (wid(z) + 0.004), sh(z) - 0.055, z), M.gloss, H.shell, false);
    add(box(0.05, 0.08, ZF - ZR - 0.85, s * (wid(-0.25) - 0.012), 0.235, (ZF + ZR) / 2), M.gloss, H.shell, false);
  }
  for (const z of [0.36, -0.82, -1.62]) add(both(strut([wid(z) + 0.003, 0.3, z], [wid(z) + 0.003, sh(z) - 0.01, z], 0.004, 0.006)), M.black, H.shell, false);

  // ---- rear: boomerang tail lights wrapping onto the bootlid, bumper, diffuser, quad tips
  const rz = -2.548;
  add(strip(range(-2.16, -2.53, 0.01), (z) => {
    const t = (-2.16 - z) / 0.37, w = wid(z) * 1.01;
    return [[w, sh(z) - 0.03 - 0.06 * t, z], [w * (1 - 0.04 * t), top(z) - 0.02, z]];
  }), M.tail, H.shell, false);
  for (const s of [1, -1]) {
    // on the rear face: the lens continues inboard as a "C"
    add(plate([[0, 0], [0.22, 0.03], [0.22, 0.075], [0.05, 0.09], [0, 0.07]].map(([x, y]) => [x * s, y]), 0.02, M4(s * 0.53, top(-2.53) - 0.13, rz - 0.012)), M.tail, H.shell, false);
    add(plate([[0, 0], [0.16, 0.022], [0.16, 0.036], [0, 0.014]].map(([x, y]) => [x * s, y]), 0.022, M4(s * 0.56, top(-2.53) - 0.1, rz - 0.013)), M.tailLit, H.shell, false);
  }
  add(box(0.26, 0.022, 0.01, 0, top(-2.53) - 0.07, rz - 0.003), M.badge, H.shell, false);                    // SUBARU script bar
  add(box(1.55, 0.03, 0.05, 0, 0.92, rz - 0.01), M.gloss, H.shell, false);                                   // bumper top crease
  add(plate([[-0.64, 0], [0.64, 0], [0.6, 0.15], [-0.6, 0.15]], 0.05, M4(0, 0.21, rz - 0.035)), M.gloss, H.shell, false); // diffuser
  for (let k = -2; k <= 2; k++) add(box(0.01, 0.06, 0.06, k * 0.11, 0.24, rz - 0.04), M.black, H.shell, false);
  for (const x of [0.33, 0.46, -0.33, -0.46]) {
    const tip = new THREE.CylinderGeometry(0.046, 0.046, 0.12, 22, 1, true); tip.rotateX(Math.PI / 2); tip.translate(x, 0.3, rz - 0.03);
    const m = add(tip, M.chrome, H.shell, false); m.material.side = THREE.DoubleSide;
    const inn = new THREE.CircleGeometry(0.043, 16); inn.rotateY(Math.PI); inn.translate(x, 0.3, rz + 0.01); add(inn, M.black, H.shell, false);
  }
  add(box(0.36, 0.13, 0.02, 0, 0.6, rz - 0.004), M.black, H.shell, false);                                  // plate recess

  // ---- the wing: airfoil on two swan-neck stalks with small end fins
  const af = [];
  for (let k = 0; k <= 16; k++) { const t = k / 16; af.push([lerp(0.0, 0.27, t), 0.03 * Math.sin(Math.PI * Math.pow(t, 0.7)) * (1 - 0.3 * t)]); }
  for (let k = 15; k > 0; k--) { const t = k / 16; af.push([lerp(0.0, 0.27, t), -0.007 * Math.sin(Math.PI * t)]); }
  const wing = plate(af, 1.42, new THREE.Matrix4());
  wing.translate(0, 0, -0.71);
  wing.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  wing.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.12));
  wing.translate(0, 1.29, -2.2);
  add(wing, M.paint, H.shell, true);
  for (const s of [1, -1]) {
    add(plate([[0, 0], [0.2, 0], [0.17, 0.05], [0.02, 0.06]], 0.01, M4(s * 0.715 - (s > 0 ? 0 : 0.01), 1.255, -2.2, 0, Math.PI / 2, 0)), M.paint, H.shell, true);  // end fins
    add(strut([s * 0.46, top(-2.3) - 0.01, -2.33], [s * 0.46, 1.27, -2.29], 0.034, 0.11), M.paint, H.shell, true);                  // stalks
  }
  // shark fin antenna
  add(plate([[0, 0], [0.16, 0], [0.04, 0.06]], 0.05, M4(0.025, H.glass(-1.3)[1] + 0.02, -1.25, 0, -Math.PI / 2, 0)), M.paint, H.shell, true);
}

// =============================================================================================
// 2017+ Subaru BRZ (ZC6): 4,240 x 1,775 x 1,285 mm, 2,570 mm wheelbase, 215/40R18
export function buildBRZ(color = 0x1d4fb5, opts = {}) {
  const env = opts.envMap ?? envTex;
  const M = materials(color, env, 0x3a3c40, 0xb8bbbf);
  const ZF = 1.06, ZR = -1.51, R = 0.31;
  const spec = {
    ZF, ZR, R, arch: 0.39, flare: 0.03, rimR: 0.2286, tyreW: 0.215, trackF: 1.52, trackR: 1.54,
    wheelStyle: 'ten', bigBrake: false,
    cowl: 0.2, deck: -1.55, roof: [-0.36, -1.02], cPillar: [[-1.0, -1.52]], bPillars: [],
    hoodCam: [1.0, 0.86],
    cab: { dashY: 0.83, seatZ: -0.78, eyeY: 1.03, rearSeat: null },
    body: [
      [1.990, 0.250, 0.560, 0.640, 0.500, 0.48],
      [1.950, 0.200, 0.640, 0.800, 0.580, 0.60],
      [1.850, 0.190, 0.690, 0.865, 0.640, 0.70],
      [1.600, 0.190, 0.735, 0.885, 0.700, 0.73],
      [1.060, 0.190, 0.790, 0.888, 0.745, 0.70],
      [0.600, 0.190, 0.830, 0.875, 0.770, 0.70],
      [0.200, 0.190, 0.858, 0.868, 0.800, 0.72],
      [-0.400, 0.190, 0.880, 0.868, 0.830, 0.76],
      [-1.000, 0.195, 0.912, 0.880, 0.866, 0.77],
      [-1.510, 0.200, 0.948, 0.900, 0.900, 0.76],
      [-1.800, 0.230, 0.965, 0.880, 0.915, 0.73],
      [-2.050, 0.290, 0.968, 0.830, 0.910, 0.68],
      [-2.170, 0.400, 0.930, 0.770, 0.880, 0.60],
    ],
    glass: [
      [0.200, 0.858, 0.866, 0.740, 0.660],
      [-0.050, 0.866, 1.050, 0.744, 0.640],
      [-0.360, 0.874, 1.268, 0.748, 0.610],
      [-0.700, 0.885, 1.285, 0.752, 0.600],
      [-1.020, 0.912, 1.260, 0.755, 0.590],
      [-1.250, 0.930, 1.140, 0.740, 0.575],
      [-1.550, 0.952, 0.975, 0.720, 0.560],
    ],
    details: (H) => brzDetails(H),
  };
  return assemble(spec, M, { interior: opts.interior === true });
}

function brzDetails(H) {
  const { add, M, box, strip, both, plate, M4, range } = H;
  const top = (z) => H.keyed(z)[1], wid = (z) => H.keyed(z)[2], sh = (z) => H.keyed(z)[3];
  const fz = 1.99;
  // wide low mouth, fog pockets, sharp headlights high on the fenders
  add(plate([[-0.42, 0], [0.42, 0], [0.36, 0.18], [-0.36, 0.18]], 0.06, M4(0, 0.27, fz - 0.035, 0.1, 0, 0)), M.honeycomb, H.shell, false);
  add(box(0.08, 0.03, 0.01, 0, 0.5, fz + 0.005), M.badge, H.shell, false);
  for (const s of [1, -1]) add(plate([[0, 0], [0.17, 0], [0.2, 0.12], [0.04, 0.12]].map(([x, y]) => [x * s, y]), 0.05, M4(s * 0.52, 0.27, fz - 0.07)), M.gloss, H.shell, false);
  add(strip(range(1.98, 1.64, 0.012), (z) => { const t = (1.98 - z) / 0.34, w = wid(z) * 1.005; return [[w * 1.004, top(z) - 0.1 + 0.05 * t, z], [Math.min(w, 0.78) * 0.98, top(z) - 0.012, z]]; }), M.head, H.shell, false);
  add(strip(range(1.97, 1.72, 0.012), (z) => { const w = wid(z) * 1.012, y = top(z) - 0.08 + 0.04 * ((1.97 - z) / 0.25); return [[w, y - 0.01, z], [w, y, z]]; }), M.drl, H.shell, false);
  // fender vents, mirrors, handles
  for (const s of [1, -1]) {
    add(plate([[0, 0], [0.16, 0], [0.19, 0.05], [0.02, 0.05]], 0.012, M4(s * (wid(0.55) + 0.012), sh(0.55) - 0.1, 0.47 + (s > 0 ? 0.19 : 0), 0, s * Math.PI / 2, 0)), M.gloss, H.shell, false);
    add(box(0.18, 0.1, 0.08, s * 0.93, 0.93, 0.12, 0, s * 0.22, 0), M.paint, H.shell, true);
    add(box(0.018, 0.025, 0.12, s * (wid(-0.5) + 0.004), sh(-0.5) - 0.05, -0.5), M.gloss, H.shell, false);
    add(box(0.05, 0.07, 1.4, s * (wid(-0.2) - 0.015), 0.23, -0.22), M.gloss, H.shell, false);
  }
  // tail lights (wide, wrap-around), ducktail lip, diffuser, twin tips
  add(strip(range(-1.78, -2.16, 0.012), (z) => { const t = (-1.78 - z) / 0.38, w = wid(z) * 1.01; return [[w, sh(z) - 0.06, z], [w * (1 - 0.05 * t), top(z) - 0.015, z]]; }), M.tail, H.shell, false);
  add(box(1.3, 0.035, 0.08, 0, top(-2.1) + 0.02, -2.08, 0.25), H.M.paint, H.shell, true);
  add(plate([[-0.6, 0], [0.6, 0], [0.56, 0.14], [-0.56, 0.14]], 0.05, M4(0, 0.24, -2.22)), M.gloss, H.shell, false);
  for (const x of [0.55, -0.55]) {
    const tip = new THREE.CylinderGeometry(0.045, 0.045, 0.12, 18, 1, true); tip.rotateX(Math.PI / 2); tip.translate(x, 0.29, -2.2);
    const m = add(tip, M.chrome, H.shell, false); m.material.side = THREE.DoubleSide;
  }
  add(box(0.34, 0.12, 0.02, 0, 0.58, -2.18), M.black, H.shell, false);
}

// =============================================================================================
// Traffic: everyday cars you'd meet on E Hayden Lake Rd — a midsize sedan, an SUV and a crew-cab pickup.
const CIV = {
  sedan: {
    ZF: 1.4, ZR: -1.4, R: 0.33, arch: 0.38, flare: 0.01, rimR: 0.216, tyreW: 0.215, trackF: 1.58, trackR: 1.58,
    wheelStyle: 'ten', bigBrake: false, cowl: 0.75, deck: -1.65, roof: [-0.27, -1.15], cPillar: [], bPillars: [-0.55], sail: [-1.18, -1.66],
    hoodCam: [1.5, 1.0], cab: { dashY: 0.95, seatZ: -0.4, eyeY: 1.18, rearSeat: -1.2 },
    body: [[2.42, 0.28, 0.66, 0.80, 0.58, 0.62], [2.35, 0.24, 0.76, 0.88, 0.66, 0.72], [2.10, 0.22, 0.82, 0.91, 0.72, 0.80], [1.40, 0.22, 0.88, 0.92, 0.78, 0.82],
      [0.75, 0.22, 0.935, 0.92, 0.82, 0.82], [0.0, 0.22, 0.97, 0.92, 0.86, 0.84], [-1.0, 0.22, 1.0, 0.92, 0.90, 0.83], [-1.65, 0.23, 1.03, 0.91, 0.92, 0.80],
      [-2.1, 0.26, 1.04, 0.89, 0.93, 0.76], [-2.38, 0.33, 1.02, 0.84, 0.91, 0.70], [-2.43, 0.40, 0.97, 0.80, 0.88, 0.64]],
    glass: [[0.75, 0.935, 0.945, 0.84, 0.74], [0.4, 0.95, 1.15, 0.84, 0.72], [0.05, 0.96, 1.33, 0.84, 0.70], [-0.27, 0.97, 1.44, 0.845, 0.68],
      [-0.8, 0.99, 1.45, 0.85, 0.67], [-1.15, 1.01, 1.38, 0.84, 0.66], [-1.45, 1.02, 1.22, 0.82, 0.64], [-1.65, 1.03, 1.05, 0.80, 0.62]],
    lamps: { front: 2.38, rear: -2.4, x: 0.66, y: 0.7, yRear: 0.9 },
  },
  suv: {
    ZF: 1.32, ZR: -1.32, R: 0.35, arch: 0.41, flare: 0.02, rimR: 0.216, tyreW: 0.225, trackF: 1.57, trackR: 1.57,
    wheelStyle: 'ten', bigBrake: false, cowl: 0.75, deck: -2.24, roof: [-0.05, -2.0], cPillar: [[-2.0, -2.22]], bPillars: [-0.55, -1.45],
    hoodCam: [1.4, 1.2], cab: { dashY: 1.05, seatZ: -0.4, eyeY: 1.38, rearSeat: -1.3 },
    body: [[2.32, 0.34, 0.80, 0.80, 0.70, 0.62], [2.25, 0.30, 0.90, 0.88, 0.78, 0.74], [2.0, 0.28, 0.96, 0.905, 0.85, 0.80], [1.3, 0.28, 1.02, 0.91, 0.92, 0.82],
      [0.75, 0.28, 1.065, 0.91, 0.96, 0.82], [0.0, 0.28, 1.08, 0.91, 0.99, 0.84], [-1.4, 0.29, 1.10, 0.91, 1.02, 0.84], [-2.0, 0.31, 1.10, 0.90, 1.03, 0.82],
      [-2.24, 0.36, 1.10, 0.88, 1.02, 0.78], [-2.33, 0.45, 1.04, 0.84, 1.0, 0.74]],
    glass: [[0.75, 1.065, 1.075, 0.84, 0.76], [0.45, 1.07, 1.30, 0.845, 0.74], [0.15, 1.08, 1.52, 0.85, 0.72], [-0.05, 1.085, 1.66, 0.85, 0.71],
      [-1.0, 1.1, 1.69, 0.86, 0.71], [-1.9, 1.10, 1.67, 0.85, 0.70], [-2.1, 1.10, 1.58, 0.84, 0.69], [-2.2, 1.10, 1.30, 0.83, 0.68], [-2.24, 1.10, 1.12, 0.82, 0.67]],
    lamps: { front: 2.28, rear: -2.3, x: 0.68, y: 0.86, yRear: 1.0 },
  },
  pickup: {
    ZF: 1.85, ZR: -1.85, R: 0.40, arch: 0.47, flare: 0.03, rimR: 0.254, tyreW: 0.27, trackF: 1.70, trackR: 1.70,
    wheelStyle: 'ten', bigBrake: false, cowl: 1.15, deck: -0.65, roof: [0.45, -0.55], cPillar: [], bPillars: [-0.05],
    hoodCam: [1.9, 1.4], cab: { dashY: 1.25, seatZ: 0.0, eyeY: 1.6, rearSeat: -0.45 },
    body: [[2.95, 0.40, 0.98, 0.86, 0.88, 0.70], [2.88, 0.36, 1.10, 0.96, 0.98, 0.84], [2.6, 0.34, 1.16, 0.99, 1.04, 0.90], [1.6, 0.34, 1.22, 1.0, 1.10, 0.92],
      [1.15, 0.34, 1.25, 1.0, 1.13, 0.92], [0.4, 0.36, 1.27, 1.0, 1.16, 0.93], [-0.6, 0.36, 1.28, 1.0, 1.17, 0.93], [-0.7, 0.38, 1.32, 1.0, 1.2, 0.97],
      [-2.85, 0.42, 1.32, 1.0, 1.2, 0.97], [-2.95, 0.50, 1.28, 0.98, 1.18, 0.95]],
    glass: [[1.15, 1.25, 1.26, 0.90, 0.82], [0.9, 1.255, 1.50, 0.905, 0.80], [0.6, 1.26, 1.80, 0.91, 0.78], [0.45, 1.265, 1.92, 0.91, 0.77],
      [-0.4, 1.275, 1.94, 0.91, 0.77], [-0.55, 1.28, 1.92, 0.91, 0.77], [-0.65, 1.28, 1.30, 0.90, 0.76]],
    lamps: { front: 2.9, rear: -2.93, x: 0.74, y: 1.0, yRear: 1.15 },
  },
};
export const CIV_COLORS = [0xf2f2f0, 0xbfc3c7, 0x8a8e93, 0x2b2d30, 0x0b0c0e, 0x7a1418, 0x23406e, 0x2f4a36, 0xb9a98a, 0x5a3a26];

export function buildCivilian(kind = 'sedan', color = 0xbfc3c7, opts = {}) {
  const env = opts.envMap ?? envTex;
  const spec = { ...CIV[kind] };
  const M = materials(color, env, 0x9a9da2, 0x55585c);
  spec.details = (H) => civDetails(H, spec, kind);
  const car = assemble(spec, M, { interior: false });
  car.userData.lampSpec = spec.lamps;
  return car;
}

function civDetails(H, spec, kind) {
  const { add, M, box, strip, both, plate, M4, range } = H;
  const top = (z) => H.keyed(z)[1], wid = (z) => H.keyed(z)[2], sh = (z) => H.keyed(z)[3];
  const zf = spec.body[0][0], zr = spec.body[spec.body.length - 1][0];
  // grille, headlights, tail lights, bumpers, mirrors, handles
  const gw = kind === 'pickup' ? 0.62 : 0.46, gh = kind === 'pickup' ? 0.3 : 0.14;
  add(plate([[-gw, 0], [gw, 0], [gw, gh], [-gw, gh]], 0.04, M4(0, top(zf) - gh - 0.08, zf - 0.02)), M.honeycomb, H.shell, false);
  add(box(1.5, 0.12, 0.08, 0, 0.34 + (kind === 'pickup' ? 0.1 : 0), zf - 0.02), kind === 'pickup' ? M.chrome : M.gloss, H.shell, false);
  add(strip(range(zf - 0.01, zf - 0.32, 0.015), (z) => { const w = wid(z) * 1.006; return [[w, top(z) - 0.13, z], [Math.min(w, 0.84) * 0.97, top(z) - 0.02, z]]; }), M.reflector, H.shell, false);
  add(strip(range(zr + 0.32, zr + 0.01, 0.015), (z) => { const w = wid(z) * 1.008; return [[w, sh(z) - 0.12, z], [w * 0.98, top(z) - 0.03, z]]; }), M.tail, H.shell, false);
  add(box(1.5, 0.12, 0.08, 0, 0.36 + (kind === 'pickup' ? 0.12 : 0), zr + 0.01), kind === 'pickup' ? M.chrome : M.gloss, H.shell, false);
  const [, yb] = H.glass(spec.cowl - 0.1);
  for (const s of [1, -1]) {
    add(box(0.2, 0.13, 0.07, s * (wid(spec.cowl - 0.1) + 0.09), yb + 0.08, spec.cowl - 0.12), M.gloss, H.shell, true);
    add(box(0.018, 0.026, 0.13, s * (wid(spec.cowl - 0.6) + 0.004), sh(spec.cowl - 0.6) - 0.06, spec.cowl - 0.6), M.gloss, H.shell, false);
  }
  if (kind === 'suv') for (const s of [1, -1]) add(box(0.04, 0.04, 1.6, s * 0.58, H.glass(-1.0)[1] + 0.05, -1.0), M.gloss, H.shell, false);   // roof rails
  if (kind === 'pickup') add(box(1.9, 0.02, 2.1, 0, top(-1.7) + 0.012, -1.75), M.black, H.shell, false);                                        // tonneau cover
}
