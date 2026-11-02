import * as THREE from 'three';

const BASE = 'world/';

// ---------------------------------------------------------------------------
// Terrain: one merged coarse mesh for everything, plus 2 m chunks streamed in
// near the car. The coarse mesh discards fragments wherever a fine chunk is live.
// ---------------------------------------------------------------------------
export class Terrain {
  constructor(buf, lake) {
    const dv = new DataView(buf);
    let o = 0;
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    this.nx = i32(); this.ny = i32(); this.chunk = i32(); this.fine = i32(); this.coarse = i32();
    const nFine = i32();
    this.ex = f32(); this.ez = f32(); this.lake = f32();
    this.gxN = i32(); this.gyN = i32();
    const dec = (u16) => { const a = new Float32Array(u16.length); for (let k = 0; k < u16.length; k++) a[k] = u16[k] / 50 + 600 - this.lake; return a; };
    const n = this.gxN * this.gyN;
    this.coarseH = dec(new Uint16Array(buf.slice(o, o + n * 2))); o += n * 2;
    this.fn = this.chunk / this.fine + 1;
    this.fineH = new Map();
    for (let k = 0; k < nFine; k++) {
      const i = i32(), j = i32();
      const m = this.fn * this.fn;
      this.fineH.set(j * this.nx + i, dec(new Uint16Array(buf.slice(o, o + m * 2)))); o += m * 2;
    }
    this.live = new Map(); // chunk id -> mesh
    this.liveTex = new Uint8Array(this.nx * this.ny * 4);
    this.liveData = new THREE.DataTexture(this.liveTex, this.nx, this.ny);
    this.liveData.needsUpdate = true;
    this.texLoader = new THREE.TextureLoader();
    this.group = new THREE.Group();
  }

  heightAt(x, z) {
    const lx = x - this.ex, lz = z - this.ez;
    const i = Math.floor(lx / this.chunk), j = Math.floor(lz / this.chunk);
    if (i >= 0 && j >= 0 && i < this.nx && j < this.ny) {
      const f = this.fineH.get(j * this.nx + i);
      if (f) return bilerp(f, this.fn, (lx - i * this.chunk) / this.fine, (lz - j * this.chunk) / this.fine);
    }
    return bilerp(this.coarseH, this.gxN, clamp(lx / this.coarse, 0, this.gxN - 1.001), clamp(lz / this.coarse, 0, this.gyN - 1.001));
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.0;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  buildCoarse(farTex) {
    const step = 2; // every 2nd coarse sample = 16 m
    const cols = Math.floor((this.gxN - 1) / step) + 1, rows = Math.floor((this.gyN - 1) / step) + 1;
    const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
    const W = this.nx * this.chunk, H = this.ny * this.chunk;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const x = c * step * this.coarse, z = r * step * this.coarse;
      pos[k * 3] = this.ex + x; pos[k * 3 + 1] = this.coarseH[r * step * this.gxN + c * step] - 0.05; pos[k * 3 + 2] = this.ez + z;
      uv[k * 2] = x / W; uv[k * 2 + 1] = 1 - z / H;
    }
    const geo = gridGeometry(pos, uv, cols, rows);
    const mat = new THREE.MeshLambertMaterial({ map: farTex });
    const t = this;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.liveMap = { value: t.liveData };
      sh.uniforms.chunkInfo = { value: new THREE.Vector4(t.ex, t.ez, t.chunk, 0) };
      sh.uniforms.gridN = { value: new THREE.Vector2(t.nx, t.ny) };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed,1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;\nuniform sampler2D liveMap;\nuniform vec4 chunkInfo;\nuniform vec2 gridN;')
        .replace('void main() {', 'void main() {\n vec2 cc = floor((vWorldXZ - chunkInfo.xy) / chunkInfo.z);\n if (texture2D(liveMap, (cc + 0.5) / gridN).r > 0.5) discard;');
    };
    this.coarseMesh = new THREE.Mesh(geo, mat);
    this.coarseMesh.receiveShadow = true;
    this.group.add(this.coarseMesh);
  }

  makeFine(id) {
    const i = id % this.nx, j = Math.floor(id / this.nx);
    const h = this.fineH.get(id), n = this.fn;
    // grid + a skirt ring to hide seams against neighbours
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    const x0 = this.ex + i * this.chunk, z0 = this.ez + j * this.chunk;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const k = r * n + c;
      pos[k * 3] = x0 + c * this.fine; pos[k * 3 + 1] = h[k]; pos[k * 3 + 2] = z0 + r * this.fine;
      uv[k * 2] = c / (n - 1); uv[k * 2 + 1] = 1 - r / (n - 1);
    }
    const geo = gridGeometry(pos, uv, n, n, 3);
    const tex = this.texLoader.load(`${BASE}tex/${i}_${j}.jpg`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    mesh.receiveShadow = true;
    return mesh;
  }

  update(px, pz, radius = 650) {
    const ci = Math.floor((px - this.ex) / this.chunk), cj = Math.floor((pz - this.ez) / this.chunk);
    const rc = Math.ceil(radius / this.chunk);
    const want = new Set();
    for (let j = cj - rc; j <= cj + rc; j++) for (let i = ci - rc; i <= ci + rc; i++) {
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
      const id = j * this.nx + i;
      if (!this.fineH.has(id)) continue;
      const cx = this.ex + (i + 0.5) * this.chunk, cz = this.ez + (j + 0.5) * this.chunk;
      if (Math.hypot(cx - px, cz - pz) < radius + this.chunk * 0.7) want.add(id);
    }
    let changed = false, built = 0;
    for (const [id, m] of this.live) if (!want.has(id)) {
      this.group.remove(m); m.geometry.dispose(); m.material.map.dispose(); m.material.dispose();
      this.live.delete(id); this.liveTex[id * 4] = 0; changed = true;
    }
    for (const id of want) if (!this.live.has(id) && built < 2) {
      const m = this.makeFine(id); this.group.add(m); this.live.set(id, m);
      this.liveTex[id * 4] = 255; changed = true; built++;
    }
    if (changed) this.liveData.needsUpdate = true;
  }
}

function bilerp(a, w, u, v) {
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const k = j * w + i;
  const h00 = a[k], h10 = a[k + 1], h01 = a[k + w], h11 = a[k + w + 1];
  return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function gridGeometry(pos, uv, cols, rows, skirt = 0) {
  const idx = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  let P = pos, U = uv;
  if (skirt) {
    // duplicate the border ring dropped down by `skirt` metres
    const ring = [];
    for (let c = 0; c < cols; c++) ring.push(c);
    for (let r = 1; r < rows; r++) ring.push(r * cols + cols - 1);
    for (let c = cols - 2; c >= 0; c--) ring.push((rows - 1) * cols + c);
    for (let r = rows - 2; r > 0; r--) ring.push(r * cols);
    const base = pos.length / 3;
    P = new Float32Array(pos.length + ring.length * 3); P.set(pos);
    U = new Float32Array(uv.length + ring.length * 2); U.set(uv);
    ring.forEach((v, k) => {
      P[(base + k) * 3] = pos[v * 3]; P[(base + k) * 3 + 1] = pos[v * 3 + 1] - skirt; P[(base + k) * 3 + 2] = pos[v * 3 + 2];
      U[(base + k) * 2] = uv[v * 2]; U[(base + k) * 2 + 1] = uv[v * 2 + 1];
    });
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length], a2 = base + k, b2 = base + (k + 1) % ring.length;
      idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------
function roadTexture(main) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = main ? '#3b3b3d' : '#424244'; g.fillRect(0, 0, 256, 512);
  const img = g.getImageData(0, 0, 256, 512);
  for (let k = 0; k < img.data.length; k += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[k] += n; img.data[k + 1] += n; img.data[k + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // tar snakes / patches
  g.strokeStyle = 'rgba(20,20,22,0.5)'; g.lineWidth = 2;
  for (let k = 0; k < 6; k++) { g.beginPath(); let x = Math.random() * 256; g.moveTo(x, 0); for (let y = 0; y < 512; y += 32) { x += (Math.random() - 0.5) * 20; g.lineTo(x, y); } g.stroke(); }
  if (main) {
    g.fillStyle = '#e8e4d8'; g.fillRect(10, 0, 5, 512); g.fillRect(241, 0, 5, 512);   // white edge lines
    g.fillStyle = '#d9a821'; g.fillRect(121, 0, 5, 512); g.fillRect(131, 0, 5, 512);  // double yellow
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function dirtTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#7d6c55'; g.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(${90 + Math.random() * 80},${80 + Math.random() * 60},${60 + Math.random() * 50},0.7)`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ribbon along a polyline of [x,y,z]; heightFn lets the edges follow the ground
function ribbon(pts, width, vScale, heightFn, lift) {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const p = pts[k], a = pts[Math.max(k - 1, 0)], b = pts[Math.min(k + 1, n - 1)];
    let dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    if (k > 0) s += Math.hypot(p[0] - pts[k - 1][0], p[2] - pts[k - 1][2]);
    const nx = -dz, nz = dx, hw = width / 2;
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      const x = p[0] + nx * hw * sg, z = p[2] + nz * hw * sg;
      const y = heightFn ? heightFn(x, z) + lift : p[1];
      const v = (k * 2 + side);
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      uv[v * 2] = side; uv[v * 2 + 1] = s / vScale;
    }
  }
  const idx = [];
  for (let k = 0; k < n - 1; k++) { const a = k * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
  return { pos, uv, idx };
}

function mergeRibbons(list) {
  let nv = 0, ni = 0;
  for (const r of list) { nv += r.pos.length / 3; ni += r.idx.length; }
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const r of list) {
    pos.set(r.pos, ov * 3); uv.set(r.uv, ov * 2);
    for (let k = 0; k < r.idx.length; k++) idx[oi + k] = r.idx[k] + ov;
    ov += r.pos.length / 3; oi += r.idx.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function buildRoads(route, sideRoads, terrain) {
  const group = new THREE.Group();
  const roadPts = route.pts.map(p => [p[0], p[1] - 0.08, p[2]]);
  const offset = (f) => ({ polygonOffset: true, polygonOffsetFactor: -f, polygonOffsetUnits: -f * 2 });
  const shoulderGeo = mergeRibbons([ribbon(roadPts, route.w + 2.4, 6, null)]);
  group.add(new THREE.Mesh(shoulderGeo, new THREE.MeshLambertMaterial({ map: dirtTexture(), ...offset(1) })));
  const main = new THREE.Mesh(mergeRibbons([ribbon(roadPts, route.w, 14, null)]), new THREE.MeshLambertMaterial({ map: roadTexture(true), ...offset(2) }));
  main.receiveShadow = true;
  group.add(main);

  const paved = [], dirt = [];
  for (const r of sideRoads) {
    if (r.pts.length < 2) continue;
    (r.dirt ? dirt : paved).push(ribbon(r.pts, r.w, 10, (x, z) => terrain.heightAt(x, z), 0.1));
  }
  if (paved.length) group.add(new THREE.Mesh(mergeRibbons(paved), new THREE.MeshLambertMaterial({ map: roadTexture(false), ...offset(1) })));
  if (dirt.length) group.add(new THREE.Mesh(mergeRibbons(dirt), new THREE.MeshLambertMaterial({ map: dirtTexture(), ...offset(1) })));
  group.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
  return group;
}

// ---------------------------------------------------------------------------
// Buildings: footprints extruded to their lidar height, gable roofs where the
// footprint is a simple rectangle, roof colour sampled from the aerial photo.
// ---------------------------------------------------------------------------
const WALLS = [[0.82, 0.78, 0.7], [0.62, 0.52, 0.42], [0.88, 0.88, 0.85], [0.55, 0.6, 0.58], [0.72, 0.62, 0.5], [0.45, 0.36, 0.3], [0.78, 0.72, 0.6]];

export function buildBuildings(list) {
  const pos = [], col = [];
  const tri = (a, b, c, color) => { pos.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) col.push(...color); };
  const colliders = [];
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const b of list) {
    let p = b.p;
    // ensure counter-clockwise in x/-z so wall normals face out
    let area = 0;
    for (let k = 0; k < p.length; k++) { const a = p[k], c = p[(k + 1) % p.length]; area += a[0] * c[1] - c[0] * a[1]; }
    if (area > 0) p = [...p].reverse();
    const y0 = b.b - 0.5, wallH = b.gable ? Math.max(2.6, b.h * 0.62) : b.h, y1 = b.b + wallH;
    const wall = WALLS[Math.floor(rnd() * WALLS.length)];
    const roof = b.roof.map(v => Math.min(1, (v / 255) * 1.15));
    for (let k = 0; k < p.length; k++) {
      const a = p[k], c = p[(k + 1) % p.length];
      const shade = 0.85 + 0.15 * Math.abs(Math.sin(Math.atan2(c[1] - a[1], c[0] - a[0])));
      const w = wall.map(v => v * shade);
      tri([a[0], y0, a[1]], [c[0], y0, c[1]], [c[0], y1, c[1]], w);
      tri([a[0], y0, a[1]], [c[0], y1, c[1]], [a[0], y1, a[1]], w);
    }
    if (b.gable && p.length === 4) {
      // ridge along the long axis
      const e0 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), e1 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
      const q = e0 >= e1 ? p : [p[1], p[2], p[3], p[0]];
      const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
      const r0 = mid(q[0], q[3]), r1 = mid(q[1], q[2]);
      const yr = b.b + b.h;
      const R = (pt, y) => [pt[0], y, pt[1]];
      tri(R(q[0], y1), R(r1, yr), R(q[1], y1), roof); tri(R(q[0], y1), R(r0, yr), R(r1, yr), roof);
      const dk = roof.map(v => v * 0.8);
      tri(R(q[2], y1), R(r0, yr), R(q[3], y1), dk); tri(R(q[2], y1), R(r1, yr), R(r0, yr), dk);
      tri(R(q[1], y1), R(r1, yr), R(q[2], y1), wall); tri(R(q[3], y1), R(r0, yr), R(q[0], y1), wall);
    } else {
      // flat / low roof: fan triangulation via THREE.ShapeUtils
      const tris = THREE.ShapeUtils.triangulateShape(p.map(v => new THREE.Vector2(v[0], v[1])), []);
      for (const t of tris) tri([p[t[0]][0], y1, p[t[0]][1]], [p[t[2]][0], y1, p[t[2]][1]], [p[t[1]][0], y1, p[t[1]][1]], roof);
    }
    let cx = 0, cz = 0; for (const v of p) { cx += v[0]; cz += v[1]; } cx /= p.length; cz /= p.length;
    let rad = 0; for (const v of p) rad = Math.max(rad, Math.hypot(v[0] - cx, v[1] - cz));
    colliders.push({ p, cx, cz, rad });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, colliders };
}

// ---------------------------------------------------------------------------
// Trees: positions/heights from the canopy height model, colour from NAIP.
// Instanced per 256 m cell with a near (detailed) and far (cheap) LOD.
// ---------------------------------------------------------------------------
function conifer(detail) {
  const seg = detail ? 7 : 4;
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5); trunk.translate(0, 0.15, 0);
  parts.push([trunk, [0.33, 0.24, 0.17]]);
  const tiers = detail ? [[0.2, 0.62, 0.3], [0.42, 0.48, 0.24], [0.62, 0.38, 0.17]] : [[0.2, 0.8, 0.27]];
  for (const [y, h, r] of tiers) { const c = new THREE.ConeGeometry(r, h, seg); c.translate(0, y + h / 2, 0); parts.push([c, null]); }
  return mergeColored(parts);
}
function broadleaf(detail) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.45, 5); trunk.translate(0, 0.22, 0);
  parts.push([trunk, [0.36, 0.3, 0.24]]);
  const crown = new THREE.IcosahedronGeometry(0.3, detail ? 1 : 0); crown.scale(1, 1.15, 1); crown.translate(0, 0.66, 0);
  if (detail) { const p = crown.attributes.position; for (let k = 0; k < p.count; k++) { const f = 0.88 + 0.24 * Math.abs(Math.sin(k * 12.9898) * 43758.5453 % 1); p.setXYZ(k, p.getX(k) * f, 0.66 + (p.getY(k) - 0.66) * f, p.getZ(k) * f); } }
  parts.push([crown, null]);
  return mergeColored(parts);
}
// "null" colour = foliage (white so the instance colour shows through)
function mergeColored(parts) {
  const geos = parts.map(([g, c]) => {
    g = g.toNonIndexed();
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) col.set(c || [1, 1, 1], k * 3);
    if (!c) { const p = g.attributes.position; for (let k = 0; k < n; k++) { const v = 0.75 + 0.35 * Math.min(1, p.getY(k) / 0.9); col[k * 3] *= v; col[k * 3 + 1] *= v; col[k * 3 + 2] *= v; } }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  });
  let total = 0; geos.forEach(g => total += g.attributes.position.count);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export class Forest {
  constructor(buf, terrain) {
    const n = new DataView(buf).getInt32(0, true);
    this.n = n;
    this.f = new Float32Array(buf, 4, n * 4);
    this.c = new Uint8Array(buf, 4 + n * 16, n * 4);
    this.cell = 128;
    this.ex = terrain.ex; this.ez = terrain.ez;
    this.cx = Math.ceil(terrain.nx * terrain.chunk / this.cell); this.cy = Math.ceil(terrain.ny * terrain.chunk / this.cell);
    this.buckets = new Map();
    for (let k = 0; k < n; k++) {
      const id = this.cellId(this.f[k * 4], this.f[k * 4 + 2]);
      let b = this.buckets.get(id); if (!b) this.buckets.set(id, b = []); b.push(k);
    }
    this.geo = { c: [conifer(true), conifer(false)], b: [broadleaf(true), broadleaf(false)] };
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.group = new THREE.Group();
    this.live = new Map();
    this.nearDist = 170; this.farDist = 700;
  }
  cellId(x, z) { return Math.floor((z - this.ez) / this.cell) * this.cx + Math.floor((x - this.ex) / this.cell); }

  near(x, z, r, out) {
    out.length = 0;
    const i0 = Math.floor((x - r - this.ex) / this.cell), i1 = Math.floor((x + r - this.ex) / this.cell);
    const j0 = Math.floor((z - r - this.ez) / this.cell), j1 = Math.floor((z + r - this.ez) / this.cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const b = this.buckets.get(j * this.cx + i); if (!b) continue;
      for (const k of b) { const dx = this.f[k * 4] - x, dz = this.f[k * 4 + 2] - z; if (dx * dx + dz * dz < r * r) out.push(k); }
    }
    return out;
  }

  buildCell(id) {
    const idx = this.buckets.get(id);
    const g = new THREE.Group();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    const sets = { c: [], b: [] };
    for (const k of idx) sets[this.c[k * 4 + 3] ? 'b' : 'c'].push(k);
    const lods = [];
    for (const kind of ['c', 'b']) {
      const list = sets[kind]; if (!list.length) continue;
      const hi = new THREE.InstancedMesh(this.geo[kind][0], this.mat, list.length);
      list.forEach((k, n) => {
        const h = this.f[k * 4 + 3];
        const spread = kind === 'c' ? 0.85 + 0.3 * ((k * 0.618) % 1) : 1.2 + 0.4 * ((k * 0.618) % 1);
        q.setFromAxisAngle(up, k * 2.39);
        s.set(h * spread, h, h * spread);
        p.set(this.f[k * 4], this.f[k * 4 + 1] - 0.2, this.f[k * 4 + 2]);
        hi.setMatrixAt(n, m4.compose(p, q, s));
        // NAIP colour is the canopy as seen from above; push it toward foliage and add variety
        const r = this.c[k * 4] / 255, gg = this.c[k * 4 + 1] / 255, b = this.c[k * 4 + 2] / 255;
        const jit = 0.85 + 0.3 * ((k * 0.7548) % 1);
        if (kind === 'c') col.setRGB((0.10 + r * 0.45) * jit, (0.17 + gg * 0.55) * jit, (0.12 + b * 0.4) * jit, THREE.SRGBColorSpace);
        else col.setRGB((0.2 + r * 0.6) * jit, (0.3 + gg * 0.6) * jit, (0.1 + b * 0.3) * jit, THREE.SRGBColorSpace);
        hi.setColorAt(n, col);
      });
      hi.computeBoundingSphere();
      const lo = new THREE.InstancedMesh(this.geo[kind][1], this.mat, list.length);
      lo.instanceMatrix = hi.instanceMatrix; lo.instanceColor = hi.instanceColor;
      lo.boundingSphere = hi.boundingSphere;
      hi.castShadow = true;
      g.add(hi, lo);
      lods.push([hi, lo]);
    }
    g.userData.lods = lods;
    return g;
  }

  update(x, z, shadows) {
    const r = this.farDist, rc = Math.ceil(r / this.cell);
    const ci = Math.floor((x - this.ex) / this.cell), cj = Math.floor((z - this.ez) / this.cell);
    const want = new Set();
    for (let j = cj - rc; j <= cj + rc; j++) for (let i = ci - rc; i <= ci + rc; i++) {
      const id = j * this.cx + i;
      if (!this.buckets.has(id)) continue;
      const dx = this.ex + (i + 0.5) * this.cell - x, dz = this.ez + (j + 0.5) * this.cell - z;
      if (Math.hypot(dx, dz) < r) want.add(id);
    }
    for (const [id, g] of this.live) if (!want.has(id)) { this.group.remove(g); g.children.forEach(m => m.dispose()); this.live.delete(id); }
    let built = 0;
    for (const id of want) if (!this.live.has(id) && built < 6) { const g = this.buildCell(id); this.group.add(g); this.live.set(id, g); built++; }
    for (const [id, g] of this.live) {
      const i = id % this.cx, j = Math.floor(id / this.cx);
      const d = Math.hypot(this.ex + (i + 0.5) * this.cell - x, this.ez + (j + 0.5) * this.cell - z);
      const nearLod = d < this.nearDist;
      for (const [hi, lo] of g.userData.lods) { hi.visible = nearLod; lo.visible = !nearLod; hi.castShadow = shadows && d < 140; }
    }
  }
}

export async function loadWorld(onProgress) {
  const step = async (label, p) => { onProgress?.(label); return p; };
  const meta = await step('meta', fetch(BASE + 'meta.json').then(r => r.json()));
  const [terrBuf, route, roads, blds, treeBuf] = await Promise.all([
    step('terrain', fetch(BASE + 'terrain.bin').then(r => r.arrayBuffer())),
    step('route', fetch(BASE + 'route.json').then(r => r.json())),
    step('roads', fetch(BASE + 'roads.json').then(r => r.json())),
    step('buildings', fetch(BASE + 'buildings.json').then(r => r.json())),
    step('trees', fetch(BASE + 'trees.bin').then(r => r.arrayBuffer())),
  ]);
  const farTex = await new THREE.TextureLoader().loadAsync(BASE + 'far.jpg');
  farTex.colorSpace = THREE.SRGBColorSpace; farTex.anisotropy = 4;
  return { meta, terrBuf, route, roads, blds, treeBuf, farTex };
}
