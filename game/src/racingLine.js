import * as THREE from 'three';

// The driving line. Geometry and target speeds come from public/world/racing_line.json, built by
// tools/racing_line.py (minimum-curvature line inside the pavement) and tools/racingline.mjs (lap
// simulation with this car's measured grip/braking/power, verified by driving the whole stage with
// the physics). Each chevron is coloured by comparing your speed with the target speed at that
// spot: green = you can be on the power there, yellow = lift/ease off, red = you're too fast for
// it, so the first red chevron is where to start braking.
export const LINE_MODES = ['off', 'full', 'braking'];

export class RacingLine {
  constructor(data, track) {
    this.n = data.n; this.x = data.x; this.z = data.z; this.y = data.y; this.s = data.s; this.v = data.v; this.alpha = data.alpha || null;
    this.track = track;
    this.kUs = data.meta?.kUs;
    // heading (yaw convention) and signed curvature, for drivers that follow the line
    const n = this.n; this.h = new Float64Array(n); this.k = new Float64Array(n);
    for (let i = 0; i < n; i++) { const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1); this.h[i] = Math.atan2(this.x[b] - this.x[a], this.z[b] - this.z[a]); }
    for (let i = 1; i < n; i++) { let d = this.h[i] - this.h[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); this.h[i] = this.h[i - 1] + d; }
    for (let i = 0; i < n; i++) { const a = Math.max(i - 3, 0), b = Math.min(i + 3, n - 1); this.k[i] = (this.h[b] - this.h[a]) / Math.max(this.s[b] - this.s[a], 1e-3); }
    this.mode = 0;
    this.mesh = this.build();
    this.mesh.visible = false;
  }

  static async load(track, file = 'racing_line.json') {
    try {
      const r = await fetch('world/' + file);
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return new RacingLine(await r.json(), track);
    } catch { }
    return null;
  }

  setMode(m) { this.mode = m; this.mesh.visible = m !== 0; }

  build() {
    const n = this.n, w = 0.6;    // half-width (m)
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
    this.col = new Float32Array(n * 2 * 4);
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      let dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      for (let s = 0; s < 2; s++) {
        const sg = s ? 1 : -1, k = i * 2 + s;
        // right side first so the chevron texture points along the direction of travel
        pos[k * 3] = this.x[i] + dz * w * sg; pos[k * 3 + 1] = this.y[i] - 0.04; pos[k * 3 + 2] = this.z[i] - dx * w * sg;
        uv[k * 2] = s; uv[k * 2 + 1] = this.s[i] / 2.4;
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.colAttr = new THREE.BufferAttribute(this.col, 4); this.colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.colAttr);
    g.setIndex(idx);
    g.computeVertexNormals();

    // chevron arrow with a dark rim so it reads on pale asphalt and in shadow
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x = c.getContext('2d');
    const arrow = () => { x.beginPath(); x.moveTo(14, 104); x.lineTo(64, 40); x.lineTo(114, 104); };
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.strokeStyle = 'rgba(0,0,0,0.6)'; x.lineWidth = 40; arrow(); x.stroke();
    x.strokeStyle = '#fff'; x.lineWidth = 26; arrow(); x.stroke();
    const tex = new THREE.CanvasTexture(c); tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: true });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false;
    return m;
  }

  // index on the line for a track projection (both use the same 2 m route stations)
  index(proj) { return Math.min(this.n - 2, Math.max(0, proj.i)) + (proj.t || 0); }

  // colour ~380 m ahead of the car from its current speed
  update(proj, speed) {
    if (!this.mesh.visible) return;
    const col = this.col, n = this.n;
    const f = this.index(proj), i0 = Math.floor(f), sCar = this.s[i0] + (f - i0) * (this.s[i0 + 1] - this.s[i0]);
    const from = Math.max(0, i0), to = Math.min(n - 1, i0 + 190);
    if (this.lastFrom !== undefined) for (let i = this.lastFrom; i <= this.lastTo; i++) { col[i * 8 + 3] = 0; col[i * 8 + 7] = 0; }
    const v = Math.max(speed, 0);
    for (let i = from; i <= to; i++) {
      const vt = Math.max(this.v[i], 1);
      const q = v / vt;                         // > 1: too fast for this spot
      let r, g, b, need;
      if (q <= 0.97) { r = 0.16; g = 0.92; b = 0.36; need = 0; }
      else if (q <= 1.04) { const u = (q - 0.97) / 0.07; r = 0.16 + 0.84 * u; g = 0.92 - 0.1 * u; b = 0.36 - 0.26 * u; need = 0.5 * u; }
      else { const u = Math.min(1, (q - 1.04) / 0.08); r = 1; g = 0.82 - 0.7 * u; b = 0.1 - 0.02 * u; need = 0.5 + 0.5 * u; }
      const ahead = this.s[i] - sCar;
      let a = Math.min(1, (ahead - 2) / 6) * Math.min(1, (to - i) / 45);
      if (this.mode === 2) a *= need > 0.05 ? 1 : 0;   // braking-zones-only mode
      a = Math.max(0, a);
      for (let s = 0; s < 2; s++) { const k = (i * 2 + s) * 4; col[k] = r; col[k + 1] = g; col[k + 2] = b; col[k + 3] = a; }
    }
    this.lastFrom = from; this.lastTo = to;
    this.colAttr.needsUpdate = true;
  }

  // position on the line + lateral offset, and the target speed, at distance s (for AI drivers)
  sample(s, off, out) {
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    const i = lo, j = Math.min(lo + 1, this.n - 1), t = Math.max(0, Math.min(1, (s - this.s[i]) / ((this.s[j] - this.s[i]) || 1)));
    let dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    out.x = this.x[i] + (this.x[j] - this.x[i]) * t + dz * off;
    out.z = this.z[i] + (this.z[j] - this.z[i]) * t - dx * off;
    out.hx = dx; out.hz = dz; out.v = this.v[i] + (this.v[j] - this.v[i]) * t;
    return out;
  }
  get length() { return this.s[this.n - 1]; }
}
