// Build the racing line + speed profile for the STI and prove it is drivable.
//
//   cd game && node tools/racingline.mjs
//
// 1. measure the car's real performance envelope from the physics (skidpad, braking, launch)
// 2. lap-simulate every candidate line from tools/racing_line.py (quasi-steady-state, friction
//    ellipse, slopes, crests/dips) and keep the fastest
// 3. drive the whole stage with the physics car + LineDriver on the real terrain; wherever it
//    can't hold the line, trim the target speed locally and repeat until a clean run
// 4. write public/world/racing_line.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Terrain, Forest, buildBuildings } from '../src/world.js';
import { Track } from '../src/track.js';
import { Car } from '../src/wrx.js';
import { LineDriver } from '../src/driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORLD = path.join(here, '../public/world');
const DATA = path.join(here, '../../data');
const G = 9.81;
const ab = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// ------------------------------------------------------------------ world
const meta = JSON.parse(fs.readFileSync(path.join(WORLD, 'meta.json')));
const route = JSON.parse(fs.readFileSync(path.join(WORLD, 'route.json')));
const terrain = new Terrain(ab(path.join(WORLD, 'terrain.bin')), meta.lake);
const track = new Track(route);
const forest = new Forest(ab(path.join(WORLD, 'trees.bin')), terrain);
const blds = buildBuildings(JSON.parse(fs.readFileSync(path.join(WORLD, 'buildings.json'))));
const world = { terrain, track, forest, buildings: blds.colliders, waterY: meta.water_y };
const flatWorld = { terrain: { heightAt: () => 10 }, track: { w: 1000, project: (x, z, h, o) => Object.assign(o, { i: 0, t: 0, d: 0, s: 0, lat: 0, hx: 0, hz: 1 }) },
  forest: { near: (x, z, r, o) => (o.length = 0, o), f: [] }, buildings: [], waterY: -1e9 };
const DT = 1 / 60;
const DBG = process.env.DBG ? process.env.DBG.split(',').map(Number) : null;
const ONE = !!process.env.ONE;
const TRACE = process.env.TRACE ? [] : null;
const I = (o) => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, analog: true, ...o });

// ------------------------------------------------------------------ 1. envelope
function envelope() {
  const bins = []; for (let v = 0; v <= 72; v += 2) bins.push(v);
  // lateral: hold speed, ramp steering slowly; best 0.5 s-average lateral accel
  const lat = [], kus = [];
  for (const v0 of [8, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60]) {
    const c = new Car(flatWorld); c.place(0, 0, 0); c.vx = v0; for (const w of c.w) w.omega = v0 / c.S.wheelR;
    c.gear = Math.max(1, Math.min(5, [0, 13, 25, 37, 48, 99].findIndex(x => v0 < x)));
    let best = 0; const win = []; const pts = [];
    for (let t = 0; t < 14; t += DT) {
      const want = Math.min(1, t / 12);
      c.update(DT, I({ steer: want, throttle: c.vx < v0 ? Math.min(1, (v0 - c.vx) * 0.8 + 0.3) : 0 }));
      const ay = Math.abs(c.vx * c.r); win.push(ay); if (win.length > 30) win.shift();
      const avg = win.reduce((a, b) => a + b, 0) / win.length;
      if (Math.abs(c.vx - v0) < 1.5) best = Math.max(best, avg);
      if (ay > 1 && ay < 6) pts.push([ay, Math.abs(c.steer) - 2.62 * Math.abs(c.r) / Math.max(c.vx, 1)]);
    }
    lat.push([v0, best]);
    if (pts.length > 10) { let sxy = 0, sxx = 0; for (const [x, y] of pts) { sxy += x * y; sxx += x * x; } kus.push(sxy / sxx); }
  }
  // braking from top speed (ABS), decel vs speed
  const brk = [];
  { const c = new Car(flatWorld); c.place(0, 0, 0); c.vx = 66; for (const w of c.w) w.omega = 66 / c.S.wheelR; c.gear = 5;
    let last = c.vx;
    for (let t = 0; t < 12 && c.vx > 1; t += DT) { c.update(DT, I({ brake: 1 })); if (t > 0.3) brk.push([c.vx, (last - c.vx) / DT]); last = c.vx; } }
  // full-throttle launch: time to cross each 2 m/s mark gives average accel including shifts
  const cross = [0];
  { const c = new Car(flatWorld); c.place(0, 0, 0);
    for (let t = 0; t < 90; t += DT) { c.update(DT, I({ throttle: 1 })); while (c.vx >= cross.length * 2 && cross.length < bins.length) cross.push(t); } }
  const accLaunch = bins.map((b, k) => (k + 1 < cross.length ? 2 / Math.max(cross[k + 1] - cross[k], 1e-3) : 0));
  // corner exits: cruise part-throttle (turbo off boost), then floor it -- includes spool lag
  const roll = bins.map(() => []);
  for (const v0 of [6, 9, 12, 15, 19, 23, 28, 34, 40, 48]) {
    const c = new Car(flatWorld); c.place(0, 0, 0); c.vx = v0; for (const w of c.w) w.omega = v0 / c.S.wheelR;
    c.gear = Math.max(1, Math.min(5, [0, 13, 25, 37, 48, 99].findIndex(x => v0 + 2 < x)));
    for (let t = 0; t < 1.5; t += DT) c.update(DT, I({ throttle: c.vx < v0 ? 0.45 : 0.15 }));
    let last = c.vx;
    for (let t = 0; t < 4; t += DT) {
      c.update(DT, I({ throttle: 1 }));
      const k = Math.round(c.vx / 2); if (k < bins.length) roll[k].push((c.vx - last) / DT);
      last = c.vx;
    }
  }
  const accT0 = bins.map((b, k) => roll[k].length > 4 ? Math.min(accLaunch[k] || 99, roll[k].reduce((a, x) => a + x, 0) / roll[k].length) : accLaunch[k]);
  const binAvg = (rows) => bins.map(b => { const r = rows.filter(([v]) => Math.abs(v - b) < 1.6); return r.length ? r.reduce((a, [, y]) => a + y, 0) / r.length : NaN; });
  const fill = (arr) => { const o = arr.slice(); let p = NaN; for (let i = 0; i < o.length; i++) { if (isNaN(o[i])) o[i] = p; else p = o[i]; } p = NaN; for (let i = o.length - 1; i >= 0; i--) { if (isNaN(o[i])) o[i] = p; else p = o[i]; } return o; };
  const latT = bins.map(b => { let lo = lat[0], hi = lat[lat.length - 1]; for (let k = 0; k < lat.length - 1; k++) if (b >= lat[k][0] && b <= lat[k + 1][0]) { lo = lat[k]; hi = lat[k + 1]; } const t = hi[0] === lo[0] ? 0 : Math.max(0, Math.min(1, (b - lo[0]) / (hi[0] - lo[0]))); return lo[1] + (hi[1] - lo[1]) * t; });
  const brkT = fill(binAvg(brk)), accT = Array.from(gauss(accT0, 1));
  for (let k = 0; k < bins.length; k++) if (bins[k] > 62) accT[k] = Math.min(accT[k], 0.2);  // past top speed
  const kUs = kus.length ? kus.reduce((a, b) => a + b, 0) / kus.length : 0.002;
  return { bins, lat: latT, brake: brkT, acc: accT, kUs };
}

// ------------------------------------------------------------------ geometry helpers
function lineFrom(alpha) {
  const P = route.pts, n = P.length;
  const x = new Float64Array(n), z = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, n - 1)];
    let dx = b[0] - a[0], dz = b[2] - a[2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    x[i] = P[i][0] + dz * alpha[i]; z[i] = P[i][2] - dx * alpha[i]; y[i] = P[i][1];
  }
  const s = new Float64Array(n); for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  // heading (yaw convention: forward = (sin h, cos h)) and signed curvature dh/ds over a 6 m chord
  const h = new Float64Array(n), k = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1); h[i] = Math.atan2(x[b] - x[a], z[b] - z[a]); }
  for (let i = 1; i < n; i++) { let d = h[i] - h[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); h[i] = h[i - 1] + d; }
  const K = 3;
  for (let i = 0; i < n; i++) { const a = Math.max(i - K, 0), b = Math.min(i + K, n - 1); k[i] = (h[b] - h[a]) / Math.max(s[b] - s[a], 1e-3); }
  // vertical: slope and curvature of the road profile (+ = dip, loads the tyres)
  const ys = gauss(y, 4), th = new Float64Array(n), kv = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 2, 0), b = Math.min(i + 2, n - 1); th[i] = Math.atan((ys[b] - ys[a]) / Math.max(s[b] - s[a], 1e-3)); }
  const ths = gauss(th, 4);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 4, 0), b = Math.min(i + 4, n - 1); kv[i] = (ths[b] - ths[a]) / Math.max(s[b] - s[a], 1e-3); }
  for (let i = 0; i < n; i++) h[i] = Math.atan2(Math.sin(h[i]), Math.cos(h[i]));
  return { n, x, z, y, s, h: unwrapCopy(h), k, th: ths, kv: gauss(kv, 3) };
}
function unwrapCopy(h) { const o = Float64Array.from(h); for (let i = 1; i < o.length; i++) { let d = o[i] - o[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); o[i] = o[i - 1] + d; } return o; }
function gauss(a, sig) {
  const r = Math.ceil(sig * 3), w = []; let ws = 0; for (let k = -r; k <= r; k++) { const v = Math.exp(-k * k / (2 * sig * sig)); w.push(v); ws += v; }
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { let acc = 0, wt = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j < 0 || j >= a.length) continue; acc += a[j] * w[k + r]; wt += w[k + r]; } o[i] = acc / wt; }
  return o;
}

// ------------------------------------------------------------------ 2. quasi-steady-state lap sim
function qss(L, E, cap) {
  const n = L.n, v = new Float64Array(n);
  const tab = (t, x) => { const f = Math.max(0, Math.min(E.bins.length - 1.001, x / 2)), i = Math.floor(f), u = f - i; return t[i] * (1 - u) + t[i + 1] * u; };
  const nf = (i, vv) => Math.max(0.05, Math.cos(L.th[i]) + vv * vv * L.kv[i] / G);
  for (let i = 0; i < n; i++) {
    const kk = Math.abs(L.k[i]); let vv = 60;
    for (let it = 0; it < 4; it++) {
      const A = tab(E.lat, vv), den = kk - A * L.kv[i] / G;
      vv = den > 1e-6 ? Math.min(66, Math.sqrt(A * Math.cos(L.th[i]) / den)) : 66;
    }
    if (L.kv[i] < -1e-4) vv = Math.min(vv, Math.sqrt(G * Math.cos(L.th[i]) * 0.8 / -L.kv[i]));   // crest: keep 20 % load
    v[i] = Math.min(vv, cap ? cap[i] : 99);
  }
  for (let i = n - 2; i >= 0; i--) {
    const vn = v[i + 1], ds = L.s[i + 1] - L.s[i];
    const Ay = tab(E.lat, vn) * nf(i, vn), u = Math.min(1, vn * vn * Math.abs(L.k[i]) / Ay);
    // braking while cornering: weight comes off the rear axle, so the usable share falls faster than a circle
    const a = tab(E.brake, vn) * nf(i, vn) * Math.pow(Math.max(0, 1 - u * u), 0.75) * (u > 0.3 ? 0.9 : 1) + G * Math.sin(L.th[i]);
    v[i] = Math.min(v[i], Math.sqrt(vn * vn + 2 * ds * Math.max(a, 0.5)));
  }
  v[0] = 0;
  for (let i = 0; i < n - 1; i++) {
    const vi = v[i], ds = L.s[i + 1] - L.s[i];
    const Ay = tab(E.lat, vi) * nf(i, vi), u = Math.min(1, vi * vi * Math.abs(L.k[i]) / Ay);
    const a = Math.min(tab(E.acc, vi), 1.3 * G * nf(i, vi) * Math.sqrt(1 - u * u)) - G * Math.sin(L.th[i]);
    v[i + 1] = Math.min(v[i + 1], Math.sqrt(Math.max(0.25, vi * vi + 2 * ds * a)));
  }
  let t = 0; for (let i = 0; i < n - 1; i++) t += (L.s[i + 1] - L.s[i]) / Math.max(0.5 * (v[i] + v[i + 1]), 0.3);
  return { v, t };
}

// ------------------------------------------------------------------ 3. drive it with the physics
function driveLap(L, v, kUs, { log = false } = {}) {
  const car = new Car(world);
  const lineObj = { n: L.n, x: L.x, z: L.z, s: L.s, v, h: L.h, k: L.k };
  const drv = new LineDriver(lineObj, { kUs });
  const h0 = Math.atan2(L.x[3] - L.x[0], L.z[3] - L.z[0]);
  car.place(L.x[0], L.z[0], h0);
  const inc = []; let t = 0, offT = 0, maxE = 0, maxBeta = 0, impacts = 0;
  let lastS = 0, stuck = 0;
  while (t < 2400) {
    const ctl = drv.drive(car);
    car.update(DT, ctl);
    const imp = car.collide();
    t += DT;
    const s = drv.s;
    if (DBG && s > DBG[0] && s < DBG[1] && Math.round(t * 60) % 3 === 0) {
      const vt = drv.at(v, s);
      console.log(`  s ${s.toFixed(0)} v ${car.vx.toFixed(1)} vt ${vt.toFixed(1)} e ${drv.e.toFixed(2)} he ${(drv.headErr * 57.3).toFixed(1)} beta ${(Math.atan2(car.vy, Math.max(car.vx, 1)) * 57.3).toFixed(1)} steer ${(car.steer * 57.3).toFixed(1)}deg in ${ctl.steer.toFixed(2)} thr ${ctl.throttle.toFixed(2)} brk ${ctl.brake.toFixed(2)} k ${drv.at(L.k, s).toFixed(4)} ay ${(car.vx * car.r / 9.81).toFixed(2)}g g${car.gear} surf ${car.w.map(w => w.surf[0]).join('')} N ${car.w.map(w => (w.N / 1000).toFixed(1)).join('/')} kap ${car.w.map(w => w.kappa.toFixed(2)).join('/')}`);
    }
    if (imp > 2) { impacts++; inc.push({ s, why: 'impact ' + imp.toFixed(1) }); }
    const off = car.w.some(w => w.surf !== 'road');
    offT = off ? offT + DT : 0;
    if (offT > 0.25) { inc.push({ s, why: 'off road' }); offT = -1e9; }
    if (!off && offT < 0) offT = 0;
    maxE = Math.max(maxE, Math.abs(drv.e));
    if (car.vx > 12) { const b = Math.abs(Math.atan2(car.vy, car.vx)); maxBeta = Math.max(maxBeta, b); if (b > 0.14) inc.push({ s, why: 'slide ' + (b * 57.3).toFixed(0) + ' deg' }); }
    if (Math.abs(drv.e) > 1.6) inc.push({ s, why: 'wide ' + drv.e.toFixed(1) + ' m' });
    if (TRACE) TRACE.push([s, car.vx, drv.at(v, s)]);
    if (s >= L.s[L.n - 1] - 3) break;
    if (s < lastS + 0.05) { stuck += DT; if (stuck > 8) { inc.push({ s, why: 'stuck' }); break; } } else stuck = 0;
    lastS = Math.max(lastS, s);
  }
  return { time: t, inc, maxE, maxBeta, impacts, finished: lastS >= L.s[L.n - 1] - 5 };
}

// ------------------------------------------------------------------ main
const t0 = Date.now();
const E = envelope();
console.log('envelope (g):');
for (let k = 0; k < E.bins.length; k += 3) console.log(`  ${(E.bins[k] * 2.237).toFixed(0).padStart(4)} mph  lat ${(E.lat[k] / G).toFixed(2)}  brake ${(E.brake[k] / G).toFixed(2)}  accel ${(E.acc[k] / G).toFixed(2)}`);
console.log(`  understeer gradient ${E.kUs.toFixed(4)} rad/(m/s^2)`);

const cands = JSON.parse(fs.readFileSync(path.join(DATA, 'racing_line_candidates.json')));
const centre = lineFrom(new Float64Array(route.pts.length));
console.log(`centreline: QSS ${qss(centre, E).t.toFixed(1)} s`);
let best = null;
for (const c of cands.candidates) {
  const L = lineFrom(c.alpha), r = qss(L, E);
  console.log(`w_len ${String(c.w_len).padEnd(7)} QSS ${r.t.toFixed(1)} s`);
  if (!best || r.t < best.t) best = { L, t: r.t, w_len: c.w_len, alpha: c.alpha };
}
console.log(`fastest: w_len ${best.w_len} (${best.t.toFixed(1)} s)`);

// learn: drive, trim speed where the driver can't hold it, repeat
const L = best.L;
const cap = new Float64Array(L.n).fill(99);
let prof = qss(L, E, cap), res;
for (let lap = 1; lap <= (ONE ? 1 : 14); lap++) {
  res = driveLap(L, prof.v, E.kUs);
  const uniq = [];
  for (const x of res.inc) if (!uniq.some(u => Math.abs(u.s - x.s) < 60)) uniq.push(x);
  console.log(`lap ${lap}: ${res.time.toFixed(1)} s (QSS ${prof.t.toFixed(1)}), incidents ${uniq.length}, max line error ${res.maxE.toFixed(2)} m, max slip ${(res.maxBeta * 57.3).toFixed(1)} deg, impacts ${res.impacts}${res.finished ? '' : ', DID NOT FINISH'}`);
  if (!uniq.length && res.finished) break;
  for (const u of uniq) {
    console.log(`   - ${u.why} at ${u.s.toFixed(0)} m`);
    // trim the target speed over the corner entry and through the problem spot
    for (let i = 0; i < L.n; i++) if (L.s[i] > u.s - 90 && L.s[i] < u.s + 25) cap[i] = Math.min(cap[i], prof.v[i] * 0.95);
  }
  prof = qss(L, E, cap);
}

if (TRACE) {
  // where does the driver lose time against the profile? classify by profile slope
  let lossB = 0, lossA = 0, lossC = 0, lossStart = 0;
  for (let k = 1; k < TRACE.length; k++) {
    const [s0, v0, vt0] = TRACE[k - 1], [s1] = TRACE[k], ds = s1 - s0;
    if (ds <= 0) continue;
    const dt = DT, dtIdeal = ds / Math.max(vt0, 0.5), loss = dt - dtIdeal;
    const i = Math.min(L.n - 2, Math.max(0, Math.round(s0 / 2)));
    const slope = prof.v[Math.min(i + 5, L.n - 1)] - prof.v[Math.max(i - 5, 0)];
    if (s0 < 300) lossStart += loss; else if (slope < -0.5) lossB += loss; else if (slope > 0.5) lossA += loss; else lossC += loss;
  }
  console.log(`time lost vs profile: braking zones ${lossB.toFixed(1)} s, acceleration zones ${lossA.toFixed(1)} s, steady/corners ${lossC.toFixed(1)} s, first 300 m ${lossStart.toFixed(1)} s`);
  const ratio = TRACE.filter(r => r[2] > 5).map(r => r[1] / r[2]);
  ratio.sort((a, b) => a - b);
  console.log(`v/v_target percentiles: p10 ${ratio[Math.floor(ratio.length * 0.1)].toFixed(3)} p50 ${ratio[Math.floor(ratio.length * 0.5)].toFixed(3)} p90 ${ratio[Math.floor(ratio.length * 0.9)].toFixed(3)}`);
}
const out = {
  step: 2, n: L.n,
  x: Array.from(L.x, v => +v.toFixed(2)), z: Array.from(L.z, v => +v.toFixed(2)), y: Array.from(L.y, v => +v.toFixed(2)),
  s: Array.from(L.s, v => +v.toFixed(2)), v: Array.from(prof.v, v => +v.toFixed(2)),
  alpha: best.alpha.map(v => +v.toFixed(3)),
  meta: { w_len: best.w_len, qssTime: +prof.t.toFixed(2), simTime: +res.time.toFixed(2), clean: !res.inc.length, kUs: E.kUs,
    envelope: { bins: E.bins, lat: E.lat.map(v => +v.toFixed(3)), brake: E.brake.map(v => +v.toFixed(3)), acc: E.acc.map(v => +v.toFixed(3)) } },
};
fs.writeFileSync(path.join(WORLD, 'racing_line.json'), JSON.stringify(out));
console.log(`wrote racing_line.json in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
