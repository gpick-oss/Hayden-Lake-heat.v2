// A driver that follows a racing line with the real car physics: Stanley-style steering with
// curvature + understeer feed-forward, and speed tracking against the line's target speeds.
// Used offline to validate/learn the speed profile, and available in-game as an autopilot.
export class LineDriver {
  constructor(line, opts = {}) {
    this.line = line;           // { n, x, z, s, v, h (heading), k (signed curvature, + = left) }
    this.i = 0;
    this.kUs = opts.kUs ?? 0.0;         // understeer gradient (rad per m/s^2 of lateral accel)
    this.pace = opts.pace ?? 1.0;
    this.wheelbase = 2.62;
    this.out = { steer: 0, throttle: 0, brake: 0, handbrake: false, analog: true };
    this.e = 0; this.headErr = 0;
  }

  locate(x, z) {
    const L = this.line, n = L.n;
    let best = Infinity, bi = this.i;
    const lo = Math.max(0, this.i - 40), hi = Math.min(n - 2, this.i + 80);
    for (let i = lo; i <= hi; i++) {
      const dx = x - L.x[i], dz = z - L.z[i], d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    if (best > 400) { // lost: global search
      for (let i = 0; i < n - 1; i++) { const dx = x - L.x[i], dz = z - L.z[i], d = dx * dx + dz * dz; if (d < best) { best = d; bi = i; } }
    }
    // refine onto the segment (the one before the nearest point if we're behind it)
    let i = Math.min(bi, n - 2);
    let ax = L.x[i], az = L.z[i], sx = L.x[i + 1] - ax, sz = L.z[i + 1] - az, l2 = sx * sx + sz * sz || 1;
    let t = ((x - ax) * sx + (z - az) * sz) / l2;
    if (t < 0 && i > 0) {
      i -= 1; ax = L.x[i]; az = L.z[i]; sx = L.x[i + 1] - ax; sz = L.z[i + 1] - az; l2 = sx * sx + sz * sz || 1;
      t = ((x - ax) * sx + (z - az) * sz) / l2;
    }
    t = Math.max(0, Math.min(1, t));
    this.i = i; this.t = t;
    this.s = L.s[i] + t * (L.s[i + 1] - L.s[i]);
    const len = Math.sqrt(l2), nx = sz / len, nz = -sx / len;     // left normal
    this.e = (x - (ax + sx * t)) * nx + (z - (az + sz * t)) * nz;
    return this.s;
  }

  at(arr, s) {
    const L = this.line;
    let i = this.i;
    while (i < L.n - 2 && L.s[i + 1] < s) i++;
    while (i > 0 && L.s[i] > s) i--;
    const t = Math.max(0, Math.min(1, (s - L.s[i]) / ((L.s[i + 1] - L.s[i]) || 1)));
    return arr[i] + (arr[Math.min(i + 1, L.n - 1)] - arr[i]) * t;
  }

  drive(car) {
    const L = this.line, o = this.out;
    const v = Math.max(car.vx, 0), sp = car.speed();
    const s = this.locate(car.pos.x, car.pos.z);
    // path heading here and curvature a little ahead (steering lag)
    const hPath = this.at(L.h, s);
    const kAhead = this.at(L.k, s + Math.max(1, v * 0.10));
    // heading error of the BODY (not the velocity): if the tail steps out the body yaws past the
    // path and this term counter-steers automatically, exactly like a driver catching a slide
    let he = car.yaw - hPath; he = Math.atan2(Math.sin(he), Math.cos(he));
    // in a steady corner the body points slightly inside the path by the rear slip angle
    const beta0 = -Math.atan2(car.vy, Math.max(car.vx, 1)) * 0;
    this.headErr = he;
    const ay = v * v * kAhead;
    const ff = Math.atan(this.wheelbase * kAhead) + this.kUs * ay;
    const fb = -0.9 * (he - beta0) - Math.atan(2.0 * this.e / (v + 3)) - 0.08 * (car.r - v * this.at(L.k, s));
    const delta = ff + fb;
    const lock = Math.min(0.56, 0.07 + 4.2 / Math.max(Math.abs(car.vx), 1));
    o.steer = Math.max(-1, Math.min(1, delta / lock));

    // speed: the profile already contains the brake points (its braking curve is the fastest you
    // can be at each spot and still make the corner), so: over the target here -> brake as hard
    // as it takes to follow the curve a moment ahead; under it -> full throttle
    const vt = this.pace * this.at(L.v, s + 1 + v * 0.08);
    const look = 2 + v * 0.35, vtAhead = this.pace * this.at(L.v, s + look);
    const aFF = Math.max(0, (v * v - vtAhead * vtAhead) / (2 * look));
    const err = vt - v;
    if (err < -0.15 || aFF > 4) {
      o.throttle = 0;
      o.brake = Math.max(0, Math.min(1, aFF / 11.5 + Math.max(0, -err) * 0.35));
    } else if (err > 0.15) { o.throttle = Math.min(1, 0.7 + err * 0.8); o.brake = 0; }
    else { o.throttle = 0.4 + err; o.brake = 0; }
    // running wide: lift
    if (Math.abs(this.e) > 1.1) o.throttle *= 0.5;
    return o;
  }
}
