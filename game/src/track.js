// The race road as a polyline with cumulative distance, plus nearest-point lookup.
export class Track {
  constructor(route) {
    this.w = route.w;
    this.p = route.pts;
    const n = this.p.length;
    this.s = new Float32Array(n);
    for (let k = 1; k < n; k++) this.s[k] = this.s[k - 1] + Math.hypot(this.p[k][0] - this.p[k - 1][0], this.p[k][2] - this.p[k - 1][2]);
    this.length = this.s[n - 1];
    // curvature-based speed limit for the AI (m/s), smoothed with accel/brake passes
    const v = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = this.p[Math.max(k - 8, 0)], b = this.p[k], c = this.p[Math.min(k + 8, n - 1)];
      const h1 = Math.atan2(b[2] - a[2], b[0] - a[0]), h2 = Math.atan2(c[2] - b[2], c[0] - b[0]);
      let dh = Math.abs(h2 - h1); if (dh > Math.PI) dh = 2 * Math.PI - dh;
      const ds = Math.max(this.s[Math.min(k + 8, n - 1)] - this.s[Math.max(k - 8, 0)], 1);
      const curv = dh / (ds / 2 + 1e-3);
      v[k] = Math.min(Math.sqrt(10.5 / Math.max(curv, 1e-4)), 62);
    }
    for (let k = n - 2; k >= 0; k--) { const ds = this.s[k + 1] - this.s[k]; v[k] = Math.min(v[k], Math.sqrt(v[k + 1] ** 2 + 2 * 9.0 * ds)); }
    for (let k = 1; k < n; k++) { const ds = this.s[k] - this.s[k - 1]; v[k] = Math.min(v[k], Math.sqrt(v[k - 1] ** 2 + 2 * 4.2 * ds)); }
    this.vmax = v;
  }

  // project (x,z) onto the road searching around a hint index; returns {i, s, lat, d}
  project(x, z, hint = -1, out = {}) {
    const n = this.p.length;
    let lo = 0, hi = n - 2;
    if (hint >= 0) { lo = Math.max(0, hint - 60); hi = Math.min(n - 2, hint + 60); }
    let best = Infinity;
    for (let k = lo; k <= hi; k++) {
      const a = this.p[k], b = this.p[k + 1];
      const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[2]) * dz) / L2; t = Math.max(0, Math.min(1, t));
      const px = a[0] + dx * t, pz = a[2] + dz * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best) {
        best = d2;
        const L = Math.sqrt(L2);
        out.i = k; out.t = t; out.s = this.s[k] + t * L; out.d = Math.sqrt(d2);
        out.lat = ((x - a[0]) * -dz + (z - a[2]) * dx) / L; // + = left of travel? sign only matters relatively
        out.hx = dx / L; out.hz = dz / L;
      }
    }
    if (hint >= 0 && out.d > 80) return this.project(x, z, -1, out);
    return out;
  }

  at(s, out = {}) {
    s = Math.max(0, Math.min(this.length - 0.01, s));
    let lo = 0, hi = this.s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    const a = this.p[lo], b = this.p[lo + 1] || a, L = (this.s[lo + 1] - this.s[lo]) || 1, t = (s - this.s[lo]) / L;
    out.x = a[0] + (b[0] - a[0]) * t; out.y = a[1] + (b[1] - a[1]) * t; out.z = a[2] + (b[2] - a[2]) * t;
    out.hx = (b[0] - a[0]) / L; out.hz = (b[2] - a[2]) / L; out.i = lo;
    out.vmax = this.vmax[lo] + (this.vmax[Math.min(lo + 1, this.vmax.length - 1)] - this.vmax[lo]) * t;
    return out;
  }
}
