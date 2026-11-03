import * as THREE from 'three';

// Roadside landmarks from public/world/landmarks.json (tools/landmarks.py): signs (one texture atlas,
// one draw call, retro-reflective glow in your headlights at night), guard rails, gates, mailboxes,
// utility poles and wires. Rails, poles and gate posts are solid (added to the car's colliders).
const YELLOW = '#f5c400', GREEN = '#006b3f', RED = '#c8102e';

// ------------------------------------------------------------------ sign faces
function drawFace(key, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const [kind, a = '', b = ''] = key.split('|');
  const diamond = () => {
    g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
    const s = w * 0.68; g.fillStyle = '#111'; g.fillRect(-s / 2, -s / 2, s, s);
    g.fillStyle = YELLOW; g.fillRect(-s / 2 + 7, -s / 2 + 7, s - 14, s - 14); g.restore();
  };
  const arrowPath = (pts, head = true, lw = 15) => {
    g.strokeStyle = '#111'; g.lineWidth = lw; g.lineCap = 'butt'; g.lineJoin = 'round';
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    if (!head) return;
    const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1], ang = Math.atan2(y2 - y1, x2 - x1);
    g.fillStyle = '#111'; g.beginPath();
    g.moveTo(x2 + Math.cos(ang) * 22, y2 + Math.sin(ang) * 22);
    g.lineTo(x2 + Math.cos(ang + 2.2) * 26, y2 + Math.sin(ang + 2.2) * 26);
    g.lineTo(x2 + Math.cos(ang - 2.2) * 26, y2 + Math.sin(ang - 2.2) * 26); g.closePath(); g.fill();
  };
  const mir = (pts) => (a === 'L' ? pts.map(([x, y]) => [w - x, y]) : pts);
  const text = (t, x, y, size, color = '#111', weight = 800, font = 'Arial Narrow, Arial, sans-serif') => {
    g.fillStyle = color; g.font = `${weight} ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y);
  };
  if (kind === 'back') { g.fillStyle = '#8d9196'; g.fillRect(0, 0, w, h); }
  else if (kind === 'curve' || kind === 'turn' || kind === 'reverse_turn' || kind === 'reverse_curve' || kind === 'hairpin' || kind === 'winding') {
    diamond();
    const cx = w / 2, by = h * 0.78;
    if (kind === 'curve') arrowPath(mir([[cx - 8, by], [cx - 8, h * 0.56], [cx + 4, h * 0.42], [cx + 24, h * 0.3]]));
    if (kind === 'turn') arrowPath(mir([[cx - 14, by], [cx - 14, h * 0.4], [cx + 30, h * 0.4]]));
    if (kind === 'reverse_turn') arrowPath(mir([[cx - 22, by], [cx - 22, h * 0.6], [cx + 20, h * 0.6], [cx + 20, h * 0.25]]));
    if (kind === 'reverse_curve') arrowPath(mir([[cx - 16, by], [cx - 16, h * 0.64], [cx + 16, h * 0.48], [cx + 16, h * 0.26]]));
    if (kind === 'hairpin') arrowPath(mir([[cx + 22, by], [cx + 22, h * 0.42], [cx + 6, h * 0.3], [cx - 10, h * 0.3], [cx - 22, h * 0.42], [cx - 22, h * 0.62]]));
    if (kind === 'winding') arrowPath(mir([[cx - 4, by], [cx - 4, h * 0.7], [cx + 16, h * 0.62], [cx - 16, h * 0.5], [cx + 16, h * 0.38], [cx + 2, h * 0.27]]), true, 13);
  } else if (kind === 'plaque') {
    g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = YELLOW; g.fillRect(6, 6, w - 12, h - 12);
    const words = a.split(' ');
    if (words.length === 2 && words[1] === 'MPH') { text(words[0], w / 2, h * 0.4, h * 0.46); text('MPH', w / 2, h * 0.78, h * 0.2); }
    else { const [l1, l2] = [words.slice(0, 2).join(' '), words.slice(2).join(' ')]; text(l1, w / 2, h * 0.33, h * 0.28); text(l2, w / 2, h * 0.7, h * 0.26); }
  } else if (kind === 'chevron') {
    g.fillStyle = YELLOW; g.fillRect(0, 0, w, h); g.fillStyle = '#111';
    g.beginPath(); const p = a === 'L' ? [[w * 0.68, h * 0.12], [w * 0.28, h * 0.5], [w * 0.68, h * 0.88], [w * 0.88, h * 0.88], [w * 0.48, h * 0.5], [w * 0.88, h * 0.12]]
      : [[w * 0.32, h * 0.12], [w * 0.72, h * 0.5], [w * 0.32, h * 0.88], [w * 0.12, h * 0.88], [w * 0.52, h * 0.5], [w * 0.12, h * 0.12]];
    p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
  } else if (kind === 'speed') {
    g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(5, 5, w - 10, h - 10);
    text('SPEED', w / 2, h * 0.16, h * 0.13); text('LIMIT', w / 2, h * 0.3, h * 0.13); text(a, w / 2, h * 0.66, h * 0.42);
  } else if (kind === 'stop') {
    g.fillStyle = '#fff'; g.beginPath();
    for (let k = 0; k < 8; k++) { const t = Math.PI / 8 + k * Math.PI / 4; g.lineTo(w / 2 + Math.cos(t) * w * 0.49, h / 2 + Math.sin(t) * h * 0.49); }
    g.closePath(); g.fill(); g.fillStyle = RED; g.beginPath();
    for (let k = 0; k < 8; k++) { const t = Math.PI / 8 + k * Math.PI / 4; g.lineTo(w / 2 + Math.cos(t) * w * 0.45, h / 2 + Math.sin(t) * h * 0.45); }
    g.closePath(); g.fill(); text('STOP', w / 2, h / 2 + 3, h * 0.3, '#fff');
  } else if (kind === 'milepost') {
    g.fillStyle = GREEN; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.lineWidth = 4; g.strokeRect(5, 5, w - 10, h - 10);
    text('MILE', w / 2, h * 0.24, w * 0.24, '#fff'); text(a, w / 2, h * 0.62, w * 0.62, '#fff');
  } else if (kind === 'street') {
    g.fillStyle = GREEN; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, h - 8);
    let size = h * 0.62; g.font = `700 ${size}px Arial, sans-serif`; while (g.measureText(a).width > w - 24 && size > 10) { size -= 2; g.font = `700 ${size}px Arial, sans-serif`; }
    text(a, w / 2, h / 2 + 2, size, '#fff', 700, 'Arial, sans-serif');
  } else if (kind === 'cp') {
    g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = '#ff7a00'; g.fillRect(8, 8, w - 16, h - 16);
    text(a, w / 2, h * 0.42, h * 0.42); text(b, w / 2, h * 0.8, h * 0.16);
  }
  return c;
}
const FACE_PX = { curve: [256, 256], turn: [256, 256], reverse_turn: [256, 256], reverse_curve: [256, 256], hairpin: [256, 256], winding: [256, 256],
  plaque: [192, 168], chevron: [176, 224], speed: [176, 224], stop: [224, 224], milepost: [104, 200], street: [448, 72], cp: [256, 192], back: [32, 32] };
const FACE_M = { curve: [1.3, 1.3], turn: [1.3, 1.3], reverse_turn: [1.3, 1.3], reverse_curve: [1.3, 1.3], hairpin: [1.3, 1.3], winding: [1.3, 1.3],
  chevron: [0.46, 0.6], speed: [0.61, 0.76], stop: [0.76, 0.76], milepost: [0.25, 0.5], street: [1.15, 0.18], cp: [1.1, 0.82] };

class Atlas {
  constructor() { this.items = new Map(); }
  add(key) {
    if (this.items.has(key)) return;
    const kind = key.split('|')[0];
    let [w, h] = FACE_PX[kind];
    if (kind === 'plaque' && key.includes('MILES')) [w, h] = [232, 150];
    this.items.set(key, { w, h });
  }
  build() {
    // shelf packing, tallest first
    const W = 2048, list = [...this.items.entries()].sort((a, b) => b[1].h - a[1].h);
    let x = 0, y = 0, rowH = 0;
    for (const [, it] of list) { if (x + it.w > W) { x = 0; y += rowH + 2; rowH = 0; } it.x = x; it.y = y; x += it.w + 2; rowH = Math.max(rowH, it.h); }
    const H = 2 ** Math.ceil(Math.log2(y + rowH + 2));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    for (const [key, it] of list) g.drawImage(drawFace(key, it.w, it.h), it.x, it.y);
    for (const it of this.items.values()) it.uv = [it.x / W, 1 - (it.y + it.h) / H, (it.x + it.w) / W, 1 - it.y / H];
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    this.tex = tex;
  }
  uv(key) { return this.items.get(key).uv; }
}

// ------------------------------------------------------------------ geometry helpers
class Builder {
  constructor() { this.pos = []; this.uv = []; this.nor = []; }
  quad(c, ux, uz, w, h, yaw, uvr, inset = 0) {
    // centre c = [x, y, z], face normal along yaw; w across, h up
    const nx = Math.sin(yaw), nz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const x = c[0] + nx * inset, z = c[2] + nz * inset;
    const p = (a, b) => [x + rx * a * w / 2, c[1] + b * h / 2, z + rz * a * w / 2];   // a = -1 is the viewer's left
    const [u0, v0, u1, v1] = uvr;
    const A = p(-1, -1), B = p(1, -1), C = p(1, 1), D = p(-1, 1);
    this.pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    for (let k = 0; k < 6; k++) this.nor.push(nx, 0, nz);
    void ux; void uz;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    return g;
  }
}
function mergeBoxes(list) {   // [{ x, y, z, w, h, d, yaw }]
  const proto = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const pp = proto.attributes.position.array, pn = proto.attributes.normal.array, nv = pp.length / 3;
  const pos = new Float32Array(list.length * pp.length), nor = new Float32Array(list.length * pp.length);
  list.forEach((b, k) => {
    const c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0);
    for (let i = 0; i < nv; i++) {
      const x = pp[i * 3] * b.w, y = pp[i * 3 + 1] * b.h, z = pp[i * 3 + 2] * b.d;
      const o = (k * nv + i) * 3;
      pos[o] = b.x + x * c + z * s; pos[o + 1] = b.y + y; pos[o + 2] = b.z - x * s + z * c;
      const nx = pn[i * 3], nz = pn[i * 3 + 2];
      nor[o] = nx * c + nz * s; nor[o + 1] = pn[i * 3 + 1]; nor[o + 2] = -nx * s + nz * c;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
const boxCollider = (x, z, w, d, yaw) => {
  const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2, hd = d / 2;
  const p = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => [x + a * c + b * s, z - a * s + b * c]);
  return { p, cx: x, cz: z, rad: Math.hypot(hw, hd) };
};

// retro-reflective: faces turned toward the camera glow when lit at night, fading with distance
function reflective(mat, state) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = state.night;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vViewDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvViewDist = -mvPosition.z;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vViewDist;\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float retro = uNight * clamp(normal.z, 0.0, 1.0) * (1.0 - smoothstep(25.0, 230.0, vViewDist));
        totalEmissiveRadiance = diffuseColor.rgb * retro * 1.6;`);
  };
}

export async function buildLandmarks(terrain) {
  let data;
  try {
    const r = await fetch('world/landmarks.json');
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
    data = await r.json();
  } catch { return null; }
  const group = new THREE.Group();
  const colliders = [];
  const state = { night: { value: 0 } };
  const H = (x, z) => terrain.heightAt(x, z);

  // ---------------- signs
  const atlas = new Atlas();
  atlas.add('back');
  const keyOf = (s) => (s.kind === 'speed' || s.kind === 'milepost' || s.kind === 'street') ? `${s.kind}|${s.text}`
    : s.kind === 'stop' ? 'stop' : `${s.kind}|${s.text}`;
  for (const s of data.signs) {
    atlas.add(keyOf(s));
    if (s.plaque) atlas.add(`plaque|${s.plaque}`);
    if (s.plaque2) atlas.add(`plaque|${s.plaque2}`);
  }
  atlas.build();
  const faces = new Builder(), backs = new Builder(), posts = [];
  for (const s of data.signs) {
    const g = H(s.x, s.z), key = keyOf(s), [fw, fh] = FACE_M[s.kind];
    let y = g + s.h;                                              // bottom of the stack
    const stack = [];
    if (s.plaque2) stack.push([`plaque|${s.plaque2}`, 0.64, 0.42]);
    if (s.plaque) stack.push([`plaque|${s.plaque}`, 0.46, 0.4]);
    for (const [k, w, h] of stack) { faces.quad([s.x, y + h / 2, s.z], 0, 0, w, h, s.yaw, atlas.uv(k), 0.03); backs.quad([s.x, y + h / 2, s.z], 0, 0, w, h, s.yaw + Math.PI, atlas.uv('back'), -0.02); y += h + 0.04; }
    const cy = y + fh / 2;
    faces.quad([s.x, cy, s.z], 0, 0, fw, fh, s.yaw, atlas.uv(key), 0.03);
    if (s.kind === 'street') faces.quad([s.x, cy, s.z], 0, 0, fw, fh, s.yaw + Math.PI, atlas.uv(key), 0.03);
    else backs.quad([s.x, cy, s.z], 0, 0, fw * (s.kind === 'curve' || s.kind === 'turn' || s.kind === 'hairpin' || s.kind === 'winding' || s.kind.startsWith('reverse') ? 0.7 : 1), fh * (FACE_M[s.kind][0] === 1.3 ? 0.7 : 1), s.yaw + Math.PI, atlas.uv('back'), -0.02);
    posts.push({ x: s.x, y: g + (cy - g) / 2, z: s.z, w: 0.055, h: cy - g + (s.kind === 'street' ? 0.1 : 0), d: 0.055, yaw: s.yaw });
  }
  const signMat = new THREE.MeshLambertMaterial({ map: atlas.tex, side: THREE.FrontSide, alphaTest: 0.02, emissive: 0x000000 });
  reflective(signMat, state);
  // the atlas is opaque, but diamond corners / octagon corners are transparent cut-outs
  atlas.tex.premultiplyAlpha = false;
  signMat.transparent = false;
  group.add(new THREE.Mesh(faces.geometry(), signMat));
  group.add(new THREE.Mesh(backs.geometry(), new THREE.MeshLambertMaterial({ color: 0x8d9196 })));

  // ---------------- guard rails (W-beam on posts every 1.9 m)
  const railPos = [], railNor = [];
  const prof = [[0.0, 0.0], [0.04, 0.05], [0.0, 0.1], [0.04, 0.16], [0.0, 0.21], [0.04, 0.27], [0.0, 0.31]];
  for (const r of data.rails) {
    const P = r.pts, n = P.length;
    if (n < 2) continue;
    const ys = P.map(([x, z]) => H(x, z));
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) acc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      if (i === 0 || acc >= 1.9) { acc = 0; posts.push({ x: P[i][0], y: ys[i] + 0.38, z: P[i][1], w: 0.15, h: 0.85, d: 0.15, yaw: 0 }); }
    }
    for (let i = 0; i < n - 1; i++) {
      const [x0, z0] = P[i], [x1, z1] = P[i + 1];
      let dx = x1 - x0, dz = z1 - z0; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const ox = dz * r.side, oz = -dx * r.side;            // toward the road
      for (let q = 0; q < prof.length - 1; q++) {
        const [a0, h0] = prof[q], [a1, h1] = prof[q + 1];
        const v = (x, z, y, a, hh) => [x - ox * a, y + 0.48 + hh, z - oz * a];
        const A = v(x0, z0, ys[i], a0, h0), B = v(x1, z1, ys[i + 1], a0, h0), C = v(x1, z1, ys[i + 1], a1, h1), D = v(x0, z0, ys[i], a1, h1);
        railPos.push(...A, ...B, ...C, ...A, ...C, ...D);
        const ny = -(a1 - a0), nh = h1 - h0, ln = Math.hypot(ny, nh) || 1;
        for (let k = 0; k < 6; k++) railNor.push(ox * nh / ln, ny / ln * 0 + Math.abs(ny) / ln * 0.2, oz * nh / ln);
      }
      colliders.push(boxCollider((x0 + x1) / 2, (z0 + z1) / 2, 0.3, L + 0.05, Math.atan2(dx, dz) + Math.PI / 2 - Math.PI / 2));
    }
  }
  if (railPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(railNor, 3));
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xb5b9bd, side: THREE.DoubleSide })); m.castShadow = true; group.add(m);
  }

  // ---------------- gates (steel tube farm gates), mailboxes
  const gateBoxes = [];
  for (const gt of data.gates) {
    const y = H(gt.x, gt.z), c = Math.cos(gt.yaw), s = Math.sin(gt.yaw), hw = gt.w / 2;
    for (const e of [-1, 1]) {
      const px = gt.x + c * hw * e, pz = gt.z - s * hw * e;
      posts.push({ x: px, y: H(px, pz) + 0.75, z: pz, w: 0.14, h: 1.5, d: 0.14, yaw: gt.yaw });
      colliders.push(boxCollider(px, pz, 0.2, 0.2, gt.yaw));
    }
    for (let k = 0; k < 5; k++) gateBoxes.push({ x: gt.x, y: y + 0.25 + k * 0.24, z: gt.z, w: gt.w - 0.2, h: 0.045, d: 0.045, yaw: gt.yaw });
    gateBoxes.push({ x: gt.x, y: y + 0.73, z: gt.z, w: 0.05, h: 0.96, d: 0.05, yaw: gt.yaw });
    colliders.push(boxCollider(gt.x, gt.z, gt.w, 0.12, gt.yaw));
  }
  if (gateBoxes.length) group.add(new THREE.Mesh(mergeBoxes(gateBoxes), new THREE.MeshLambertMaterial({ color: 0x6f7a6a })));
  const MAILC = [0x111111, 0xe8e8e8, 0x9a1b1b, 0x1f4d2e];
  const boxesByColor = MAILC.map(() => []);
  for (const mb of data.mailboxes) {
    const y = H(mb.x, mb.z);
    posts.push({ x: mb.x, y: y + 0.55, z: mb.z, w: 0.09, h: 1.1, d: 0.09, yaw: mb.yaw });
    boxesByColor[mb.c].push({ x: mb.x, y: y + 1.2, z: mb.z, w: 0.24, h: 0.24, d: 0.5, yaw: mb.yaw });
  }
  boxesByColor.forEach((list, k) => { if (list.length) group.add(new THREE.Mesh(mergeBoxes(list), new THREE.MeshLambertMaterial({ color: MAILC[k] }))); });

  // ---------------- utility poles + wires
  const poleBoxes = [], arms = [];
  const tops = data.poles.map((p) => {
    const y = H(p.x, p.z);
    poleBoxes.push({ x: p.x, y: y + 5.5, z: p.z, w: 0.26, h: 11, d: 0.26, yaw: p.yaw });
    arms.push({ x: p.x, y: y + 10.2, z: p.z, w: 2.4, h: 0.1, d: 0.1, yaw: p.yaw + Math.PI / 2 });
    colliders.push(boxCollider(p.x, p.z, 0.32, 0.32, p.yaw));
    return { x: p.x, y: y + 10.3, z: p.z, yaw: p.yaw };
  });
  if (poleBoxes.length) {
    group.add(new THREE.Mesh(mergeBoxes(poleBoxes), new THREE.MeshLambertMaterial({ color: 0x5e5246 })));
    group.add(new THREE.Mesh(mergeBoxes(arms), new THREE.MeshLambertMaterial({ color: 0x4d4238 })));
  }
  const wire = [];
  for (const [a, b] of data.wires) {
    const A = tops[a], B = tops[b];
    for (const off of [-1.05, 0, 1.05]) {
      const ax = A.x + Math.cos(A.yaw) * off, az = A.z - Math.sin(A.yaw) * off, bx = B.x + Math.cos(B.yaw) * off, bz = B.z - Math.sin(B.yaw) * off;
      const ay = A.y + (off === 0 ? 0.35 : 0), by = B.y + (off === 0 ? 0.35 : 0);
      let px = ax, py = ay, pz = az;
      for (let k = 1; k <= 10; k++) {
        const t = k / 10, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - 0.9 * 4 * t * (1 - t);
        wire.push(px, py, pz, x, y, z); px = x; py = y; pz = z;
      }
    }
  }
  if (wire.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x23262a })));
  }

  // ---------------- all posts in one mesh
  group.add(new THREE.Mesh(mergeBoxes(posts), new THREE.MeshLambertMaterial({ color: 0x9a9fa5 })));

  // checkpoint boards depend on direction/session, built on demand
  const cpGroup = new THREE.Group(); group.add(cpGroup);
  function setCheckpoints(track, list) {
    cpGroup.clear();
    const at = new Atlas(); at.add('back');
    for (const c of list) at.add(`cp|${c.label}|${c.sub}`);
    at.build();
    const fb = new Builder(), bb = new Builder(), ps = [];
    const mat = new THREE.MeshLambertMaterial({ map: at.tex }); reflective(mat, state);
    for (const c of list) {
      const p = track.at(c.s), yaw = Math.atan2(p.hx, p.hz) + Math.PI;
      for (const side of [-1, 1]) {
        const off = track.w / 2 + 2.4, x = p.x + p.hz * off * side, z = p.z - p.hx * off * side, y = H(x, z) + 1.7;
        fb.quad([x, y, z], 0, 0, 1.1, 0.82, yaw, at.uv(`cp|${c.label}|${c.sub}`), 0.03);
        bb.quad([x, y, z], 0, 0, 1.1, 0.82, yaw + Math.PI, at.uv('back'), -0.02);
        ps.push({ x, y: (y - 0.41 + H(x, z)) / 2, z, w: 0.07, h: y - 0.41 - H(x, z), d: 0.07, yaw });
      }
    }
    cpGroup.add(new THREE.Mesh(fb.geometry(), mat), new THREE.Mesh(bb.geometry(), new THREE.MeshLambertMaterial({ color: 0x8d9196 })));
    if (ps.length) cpGroup.add(new THREE.Mesh(mergeBoxes(ps), new THREE.MeshLambertMaterial({ color: 0x222222 })));
  }

  return {
    group, colliders, setCheckpoints,
    setNight: (on) => { state.night.value = on ? 1 : 0; },
    counts: { signs: data.signs.length, rails: data.rails.length, gates: data.gates.length, mailboxes: data.mailboxes.length, poles: data.poles.length },
  };
}
