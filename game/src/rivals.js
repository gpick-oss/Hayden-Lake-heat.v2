import { kinematicBody, BOXES } from './contacts.js';

// AI rivals: blue BRZs driving the racing line. Their pace is calibrated so the leader's stage time
// matches the chosen level (Fast = 19:00), the others finish a little behind. With collisions on they
// treat you and traffic as real cars (follow, pass on the side with room, keep right for oncoming
// traffic); in ghost mode they drive straight through you instead of getting stuck behind.
const NAMES = [
  { name: 'Coyote', color: 0x1d4fb5 },   // WR Blue Pearl
  { name: 'Moose', color: 0x0f2a6b },    // Galaxy Blue
  { name: 'Osprey', color: 0x2c6fd6 },   // Sapphire Blue
];
const GAPS = [0, 18, 40];                 // seconds behind the leader's target time

export class Rivals {
  constructor({ line, terrain, scene, makeMesh, lineIdx, lineToTrackS }) {
    this.line = line; this.terrain = terrain; this.lineIdx = lineIdx; this.lineToTrackS = lineToTrackS;
    this.list = NAMES.map((n, k) => ({ ...n, mesh: makeMesh(n.color), s: 0, v: 0, off: 0, offT: 0, offPrev: 0, latV: 0, wob: 0, wobV: 0,
      yaw: 0, done: null, skill: 1, wobble: k * 2.1 + 0.5, ts: 0, active: true }));
    for (const r of this.list) {
      scene.add(r.mesh);
      r.nudge = (dF, dL) => { r.s += dF; r.off += dL; };
    }
    this.tmp = {}; this.tmp2 = {};
  }

  // simulate the pace logic alone (no traffic) to find the skill factor for a target stage time
  timeFor(skill, s0) {
    const L = this.line, dt = 1 / 30, len = L.length;
    let s = s0, v = 0, t = 0;
    while (s < len && t < 5400) {
      const target = Math.min(this.vAt(s), this.vAt(s + v * 0.6 + 2) + 1) * skill;
      v += Math.max(-9.5 * dt, Math.min(Math.min(4.6, 150 / Math.max(v, 5)) * dt, target - v));
      v = Math.max(0, v); s += v * dt; t += dt;
    }
    return t;
  }
  vAt(s) {
    const L = this.line; let lo = 0, hi = L.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.s[m] <= s) lo = m; else hi = m; }
    return L.v[lo];
  }
  calibrate(leaderTime) {
    this.list.forEach((r, k) => {
      const want = leaderTime + GAPS[k], s0 = this.startS(k);
      let lo = 0.3, hi = 1.05;
      for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (this.timeFor(mid, s0) > want) lo = mid; else hi = mid; }
      r.skill = (lo + hi) / 2;
      r.target = want;
    });
  }
  startS(k) { return 12 + k * 9; }

  setActive(on) { this.enabled = on; for (const r of this.list) { r.active = on; r.mesh.visible = on; } }

  reset() {
    this.list.forEach((r, k) => {
      r.s = this.startS(k); r.v = 0; r.done = null; r.latV = r.wob = r.wobV = 0;
      r.off = r.offT = r.offPrev = (k % 2 === 0 ? 3.2 : 0);       // two abreast, then merge onto the line
      r.ts = this.lineToTrackS(r.s);
    });
  }

  absAt(s) { const L = this.line; return L.alpha ? L.alpha[Math.min(L.n - 1, Math.floor(this.lineIdx(Math.min(s, L.length - 0.5))))] : 0; }

  // obstacles: [{ s (line distance), abs (lateral from centreline, left +), v, oncoming }]
  update(dt, { racing, raceT, clockT, obstacles, collisions }) {
    if (!this.enabled) return;
    const L = this.line;
    for (const r of this.list) {
      if (racing && r.s < L.length) {
        const here = L.sample(r.s, 0, this.tmp), ahead = L.sample(r.s + r.v * 0.6 + 2, 0, this.tmp2);
        let target = Math.min(here.v, ahead.v + 1) * r.skill * (1 + 0.025 * Math.sin(clockT * 0.37 + r.wobble));
        const alpha = this.absAt(r.s), myAbs = alpha + r.off;
        let offAbsT = alpha, keepRight = false;
        // the nearest thing ahead in our direction, and anything coming the other way
        let gap = 1e9, obs = null;
        const consider = (o) => {
          const g = o.s - r.s;
          if (o.oncoming) { if (g > -5 && g < 160) keepRight = true; return; }
          if (g > 0 && g < gap) { gap = g; obs = o; }
        };
        for (const o of this.list) if (o !== r && o.active) consider({ s: o.s, abs: this.absAt(o.s) + o.off, v: o.v });
        if (collisions) for (const o of obstacles) consider(o);
        if (keepRight) offAbsT = Math.min(offAbsT, -0.9);
        if (obs && gap < 30) {
          const roomL = 2.5 - (obs.abs + 1.0), roomR = (obs.abs - 1.0) + 2.5;
          let side = roomL > roomR ? 1 : -1;
          if (keepRight) side = -1;
          const passAbs = Math.max(-2.5, Math.min(2.5, obs.abs + side * 2.1));
          if (Math.abs(passAbs - obs.abs) >= 1.85) offAbsT = passAbs;
          if (Math.abs(myAbs - obs.abs) < 1.9 && gap < 8) target = Math.min(target, obs.v - 0.3);
        }
        r.offT = offAbsT - alpha;
        r.off += Math.max(-1.4 * dt, Math.min(1.4 * dt, r.offT - r.off));
        r.off += r.latV * dt; r.latV *= Math.exp(-2.2 * dt);       // knocked sideways: drift, then recover
        r.v += Math.max(-9.5 * dt, Math.min(Math.min(4.6, 150 / Math.max(r.v, 5)) * dt, target - r.v));
        r.v = Math.max(0, r.v);
        r.s += r.v * dt;
        if (r.s >= L.length && r.done == null) r.done = raceT;
      } else if (racing) r.v = Math.max(0, r.v - 6 * dt);
      // stay near the pavement after a shove
      const alphaHere = this.absAt(r.s), offAbs = alphaHere + r.off;
      if (Math.abs(offAbs) > 4.2) { r.off = Math.sign(offAbs) * 4.2 - alphaHere; r.latV = 0; }
      r.wobV += (-14 * r.wob - 5 * r.wobV) * dt; r.wob += r.wobV * dt;
      r.ts = this.lineToTrackS(Math.min(r.s, L.length - 0.5));
      const p = L.sample(Math.min(r.s, L.length - 0.5), r.off, this.tmp);
      const steerYaw = Math.atan2((r.off - r.offPrev) / Math.max(dt, 1e-3), Math.max(r.v, 3));
      r.offPrev = r.off;
      r.yaw = Math.atan2(p.hx, p.hz) + steerYaw + r.wob;
      r.px = p.x; r.pz = p.z;
      const T = this.terrain;
      r.mesh.position.set(p.x, T.heightAt(p.x, p.z), p.z);
      r.mesh.rotation.set(0, r.yaw, 0);
      const pitch = Math.atan(T.heightAt(p.x + p.hx * 1.3, p.z + p.hz * 1.3) - T.heightAt(p.x - p.hx * 1.3, p.z - p.hz * 1.3)) / 2.6;
      r.mesh.rotateX(-pitch);
      for (const w of r.mesh.userData.wheels) w.spin.rotation.x += r.v * dt / 0.31;
    }
  }

  bodies() { return this.enabled ? this.list.filter(r => r.px !== undefined).map(r => kinematicBody(r, BOXES.brz)) : []; }
}
