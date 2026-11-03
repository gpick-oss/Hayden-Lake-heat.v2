import { buildCivilian, CIV_COLORS } from './carBuilder.js';
import { addCarLamps } from './lighting.js';
import { kinematicBody, BOXES } from './contacts.js';

// Random everyday traffic in both lanes. Cars spawn out of sight ahead of you and despawn behind,
// drive at civilian speeds (slowing for each curve), keep their following distance (IDM), and an
// oncoming driver who finds you in their lane brakes hard and heads for the shoulder.
const DENSITY = { off: 0, light: 0.45, normal: 0.9, heavy: 1.8 };   // cars per km, per direction
const KINDS = [['sedan', 0.45], ['suv', 0.35], ['pickup', 0.2]];
const LANE = 1.65;
const AHEAD = 1500, BEHIND = 300;

export class Traffic {
  constructor({ scene, track, terrain, envMap, lighting }) {
    Object.assign(this, { scene, track, terrain, envMap, lighting });
    this.cars = []; this.pool = { sedan: [], suv: [], pickup: [] };
    this.density = 0;
    // civilian speed for each direction: comfortable cornering, 40 mph ceiling, gentle accel/brake
    const n = track.p.length, k = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 6, 0), b = Math.min(i + 6, n - 1);
      const h1 = Math.atan2(track.p[i][0] - track.p[a][0], track.p[i][2] - track.p[a][2]);
      const h2 = Math.atan2(track.p[b][0] - track.p[i][0], track.p[b][2] - track.p[i][2]);
      let d = h2 - h1; d = Math.atan2(Math.sin(d), Math.cos(d));
      k[i] = Math.abs(d) / Math.max(track.s[b] - track.s[a], 1) * 2;
    }
    const prof = (order) => {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = Math.min(17.9, Math.sqrt(2.6 / Math.max(k[i], 1e-4)));
      const idx = order > 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
      for (let q = idx.length - 2; q >= 0; q--) { const i = idx[q], j = idx[q + 1]; v[i] = Math.min(v[i], Math.sqrt(v[j] ** 2 + 2 * 2.2 * Math.abs(track.s[j] - track.s[i]))); }
      for (let q = 1; q < idx.length; q++) { const i = idx[q], j = idx[q - 1]; v[i] = Math.min(v[i], Math.sqrt(v[j] ** 2 + 2 * 1.6 * Math.abs(track.s[j] - track.s[i]))); }
      return v;
    };
    this.vF = prof(1); this.vB = prof(-1);
    this.tmp = {};
  }

  setDensity(level) { this.density = DENSITY[level] ?? 0; if (!this.density) this.clear(); }
  clear() { for (const c of this.cars) this.release(c); this.cars = []; }

  vAt(c) {
    const T = this.track; let lo = 0, hi = T.s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T.s[m] <= c.s) lo = m; else hi = m; }
    return (c.dir > 0 ? this.vF[lo] : this.vB[lo]) * c.vf;
  }

  acquire(kind) {
    let mesh = this.pool[kind].pop();
    if (!mesh) {
      mesh = buildCivilian(kind, CIV_COLORS[0], { envMap: this.envMap });
      addCarLamps(mesh, mesh.userData.lampSpec); this.lighting?.registerLamps(mesh);
      for (const l of mesh.userData.lamps) l.visible = this.lighting?.mode === 'night';
      this.scene.add(mesh);
    }
    mesh.visible = true;
    mesh.userData.materials.paint.color.setHex(CIV_COLORS[Math.floor(Math.random() * CIV_COLORS.length)]);
    return mesh;
  }
  release(c) { c.mesh.visible = false; this.pool[c.kind].push(c.mesh); }

  spawn(s, dir) {
    const r = Math.random(); let acc = 0, kind = 'sedan';
    for (const [kk, p] of KINDS) { acc += p; if (r < acc) { kind = kk; break; } }
    const c = { kind, mesh: this.acquire(kind), dir, s, vf: Math.max(0.85, Math.min(1.15, 1 + (Math.random() + Math.random() - 1) * 0.12)),
      lane: dir > 0 ? -LANE : LANE, lat: 0, latV: 0, wob: 0, wobV: 0, v: 0, yaw: 0, px: 0, pz: 0, swerve: 0 };
    c.v = this.vAt(c);
    // contact pushes come back as along-track / lateral moves in this car's own frame
    c.nudge = (dF, dL) => { c.s += dF * c.dir; c.lat += dL * c.dir; };
    c.kick = (dF, dL, dw) => { c.v = Math.max(0, c.v + dF); c.latV += dL * c.dir; c.wobV += dw * 0.6; };
    this.cars.push(c);
    return c;
  }

  reset(playerS) {
    this.clear();
    if (!this.density) return;
    const L = this.track.length;
    for (const dir of [1, -1]) {
      const count = Math.round(this.density * AHEAD / 1000);
      for (let i = 0; i < count; i++) {
        const s = playerS + 220 + Math.random() * (AHEAD - 220);
        if (s > 10 && s < L - 10 && this.clearAt(s, dir, 45)) this.spawn(s, dir);
      }
    }
  }
  clearAt(s, dir, gap) { return !this.cars.some(c => c.dir === dir && Math.abs(c.s - s) < gap); }

  // player / rivals: [{ s (track distance), abs (lateral, left +), v (along track, + = forward) }]
  update(dt, { playerS, others, racing }) {
    if (!this.density) return;
    const T = this.track, L = T.length;
    // keep the window populated
    for (const dir of [1, -1]) {
      const want = this.density * (AHEAD + BEHIND) / 1000;
      const have = this.cars.filter(c => c.dir === dir).length;
      if (have < want && Math.random() < dt * 0.6) {
        const s = playerS + 700 + Math.random() * (AHEAD - 700);
        if (s > 10 && s < L - 10 && this.clearAt(s, dir, 60)) this.spawn(s, dir);
      }
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.s < playerS - BEHIND || c.s > playerS + AHEAD + 200 || c.s < 2 || c.s > L - 2) { this.release(c); this.cars.splice(i, 1); }
    }
    const abs = (c) => c.lane + c.lat;
    for (const c of this.cars) {
      let v0 = racing ? this.vAt(c) : 0;
      // leader in my lane, in my direction of travel: other traffic, you, rivals
      let gap = 1e9, lv = 0;
      const look = (s, a, v) => {
        const g = (s - c.s) * c.dir - 4.6; if (g < -2 || g > 120) return;
        if (Math.abs(a - abs(c)) > 1.7) return;
        const along = v * c.dir;             // their speed in my direction of travel
        if (along < -1) {                     // coming at me in my lane: brake and head for the shoulder
          if (g < 90) { c.swerve = 1.5; v0 = 0; }
          return;
        }
        if (g < gap) { gap = Math.max(g, 0.1); lv = along; }
      };
      for (const o of this.cars) if (o !== c) look(o.s, abs(o), o.v * o.dir);
      for (const o of others) look(o.s, o.abs, o.v);
      // IDM car-following
      const a0 = 1.6, b = 2.5, s0 = 4, Th = 1.4;
      const sStar = s0 + c.v * Th + c.v * (c.v - lv) / (2 * Math.sqrt(a0 * b));
      let acc = a0 * (1 - Math.pow(c.v / Math.max(v0, 0.5), 4) - (gap < 1e8 ? (sStar / gap) ** 2 : 0));
      if (v0 === 0) acc = Math.min(acc, -7);
      c.v = Math.max(0, c.v + Math.max(-8, Math.min(a0, acc)) * dt);
      c.s += c.v * dt * c.dir;
      // swerve toward the shoulder, then drift back to the lane centre
      c.swerve = Math.max(0, c.swerve - dt);
      const latT = c.swerve > 0 ? Math.sign(c.lane) * 1.1 : 0;
      c.lat += Math.max(-1.2 * dt, Math.min(1.2 * dt, latT - c.lat)) + c.latV * dt;
      c.latV *= Math.exp(-2.2 * dt); c.latVOwn = c.latV * c.dir;
      c.wobV += (-14 * c.wob - 5 * c.wobV) * dt; c.wob += c.wobV * dt;
      // place it
      const p = T.at(Math.max(0, Math.min(L - 0.01, c.s)), this.tmp);
      const a = abs(c);
      c.px = p.x + p.hz * a; c.pz = p.z - p.hx * a;
      c.yaw = Math.atan2(p.hx * c.dir, p.hz * c.dir) + c.wob;
      const m = c.mesh, H = this.terrain;
      m.position.set(c.px, H.heightAt(c.px, c.pz), c.pz);
      m.rotation.set(0, c.yaw, 0);
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      m.rotateX(-Math.atan((H.heightAt(c.px + fx * 1.4, c.pz + fz * 1.4) - H.heightAt(c.px - fx * 1.4, c.pz - fz * 1.4)) / 2.8));
      for (const w of m.userData.wheels) w.spin.rotation.x += c.v * dt / 0.35;
    }
  }

  // for contacts
  bodies() { return this.cars.map(c => kinematicBody(c, BOXES[c.kind])); }
  // for rivals / the demo driver: positions as seen along the racing direction
  list() { return this.cars.map(c => ({ s: c.s, abs: c.lane + c.lat, v: c.v * c.dir, oncoming: c.dir < 0, px: c.px, pz: c.pz })); }
}
