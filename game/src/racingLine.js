import * as THREE from 'three';

// Driving line: a minimum-curvature path inside the road edges with a speed profile for the STI,
// drawn as chevrons that are green where you can stay on the power, yellow to ease off and red
// to brake, judged from your current speed against what each corner ahead allows.
const MU_LAT = 10.0;   // usable lateral accel (m/s^2), a bit under the car's 1.13 g skidpad limit
const BRAKE = 9.5;     // braking the line plans for (m/s^2); the car can do ~11.5 with ABS
const POWER = 150;     // wheel power / mass (W/kg) for the acceleration pass

export class RacingLine {
  constructor(track, terrain) {
    const P = track.p, n = P.length, half = track.w / 2 - 1.05; // keep the car's width inside the paint
    // lateral offset (left of travel) per point, relaxed toward the chord of its neighbours
    const nx = new Float32Array(n), nz = new Float32Array(n), off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, n - 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      nx[i] = dz; nz[i] = -dx;   // left of travel (x east, z south)
    }
    const X = new Float32Array(n), Z = new Float32Array(n);
    const pos = () => { for (let i = 0; i < n; i++) { X[i] = P[i][0] + nx[i] * off[i]; Z[i] = P[i][2] + nz[i] * off[i]; } };
    for (const span of [12, 6, 3, 1]) {
      for (let it = 0; it < 120; it++) {
        pos();
        for (let i = span; i < n - span; i++) {
          const mx = (X[i - span] + X[i + span]) / 2, mz = (Z[i - span] + Z[i + span]) / 2;
          const want = off[i] + ((mx - X[i]) * nx[i] + (mz - Z[i]) * nz[i]);
          off[i] = Math.max(-half, Math.min(half, off[i] + 0.5 * (want - off[i])));
        }
      }
    }
    // start and finish on the right-hand side like the grid
    for (let i = 0; i < n; i++) { const e = Math.min(i, n - 1 - i); if (e < 40) off[i] = off[i] * (e / 40) + -1.6 * (1 - e / 40); }
    pos();
    this.x = X; this.z = Z; this.n = n;
    this.y = new Float32Array(n); for (let i = 0; i < n; i++) this.y[i] = P[i][1] - 0.05;
    this.s = new Float32Array(n);
    for (let i = 1; i < n; i++) this.s[i] = this.s[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);

    // speed profile: lateral limit from curvature, then braking and power passes
    const v = new Float32Array(n), k = 5;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - k, 0), c = Math.min(i + k, n - 1);
      const ax = X[i] - X[a], az = Z[i] - Z[a], bx = X[c] - X[i], bz = Z[c] - Z[i];
      const cross = ax * bz - az * bx, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(X[c] - X[a], Z[c] - Z[a]);
      const curv = la * lb * lc > 1e-6 ? Math.abs(2 * cross / (la * lb * lc)) : 0;
      v[i] = Math.min(Math.sqrt(MU_LAT / Math.max(curv, 1e-5)), 67);
    }
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * BRAKE * (this.s[i + 1] - this.s[i])));
    v[0] = 0;
    for (let i = 1; i < n; i++) { const a = Math.min(9, POWER / Math.max(v[i - 1], 3)); v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * a * (this.s[i] - this.s[i - 1]))); }
    this.v = v;

    this.mesh = this.build();
    this.mesh.visible = false;
    this.terrain = terrain;
  }

  build() {
    const n = this.n, w = 0.55;
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
    this.col = new Float32Array(n * 2 * 4);
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      let dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      for (let s = 0; s < 2; s++) {
        const sg = s ? 1 : -1, k = i * 2 + s;
        pos[k * 3] = this.x[i] - dz * w * sg; pos[k * 3 + 1] = this.y[i] + 0.04; pos[k * 3 + 2] = this.z[i] + dx * w * sg;
        uv[k * 2] = s; uv[k * 2 + 1] = this.s[i] / 1.6;
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.colAttr = new THREE.BufferAttribute(this.col, 4); this.colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.colAttr);
    g.setIndex(idx);
    // chevron texture (points along +v = direction of travel)
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.strokeStyle = '#fff'; x.lineWidth = 11; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(8, 50); x.lineTo(32, 22); x.lineTo(56, 50); x.stroke();
    const tex = new THREE.CanvasTexture(c); tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: true });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false;
    return m;
  }

  // colour the next ~450 m from the car's progress and speed
  update(sCar, speed) {
    if (!this.mesh.visible) return;
    const col = this.col, n = this.n;
    let i0 = 0, lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] < sCar) lo = m; else hi = m; }
    i0 = lo;
    const from = Math.max(0, i0), to = Math.min(n - 1, i0 + 230);
    if (this.lastFrom !== undefined) for (let i = this.lastFrom; i <= this.lastTo; i++) { col[i * 8 + 3] = 0; col[i * 8 + 7] = 0; }
    for (let i = from; i <= to; i++) {
      const d = Math.max(this.s[i] - sCar, 0.5), vt = this.v[i];
      // decel needed from current speed to make this point's speed
      const need = (speed * speed - vt * vt) / (2 * d);
      let r, g, b;
      if (speed > vt + 0.5 && need > BRAKE * 0.6) { r = 1; g = 0.12; b = 0.1; }
      else if (speed > vt * 0.94 && need > 0) { r = 1; g = 0.8; b = 0.1; }
      else { r = 0.15; g = 0.95; b = 0.3; }
      const fade = Math.min(1, (this.s[i] - sCar - 1) / 7) * Math.min(1, (to - i) / 40);
      const a = Math.max(0, fade) * 0.85;
      for (let s = 0; s < 2; s++) { const k = (i * 2 + s) * 4; col[k] = r; col[k + 1] = g; col[k + 2] = b; col[k + 3] = a; }
    }
    this.lastFrom = from; this.lastTo = to;
    this.colAttr.needsUpdate = true;
  }
}
