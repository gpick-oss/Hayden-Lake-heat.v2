import * as THREE from 'three';
import { kinematicBody, resolve, BOXES } from './contacts.js';

// Deer crossings. Each run rolls how many deer you'll meet: round(Normal(mean 3, sd 1.5)), never
// below zero, so usually 1-5 but sometimes none and sometimes a lot. Each deer is 50/50 a slow,
// steady walker or a fast runner that bolts across. They're triggered by your approach so you
// actually meet them: walkers start crossing well ahead, runners dart out a few seconds in front.
const BROWN = 0x8b5e3c, BELLY = 0xd9c3a5, DARK = 0x2a1d14;

function gauss(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function deerModel(buck) {
  const g = new THREE.Group();
  const fur = new THREE.MeshLambertMaterial({ color: BROWN }), pale = new THREE.MeshLambertMaterial({ color: BELLY }), dark = new THREE.MeshLambertMaterial({ color: DARK });
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; g.add(m); return m; };
  const body = new THREE.SphereGeometry(1, 14, 10); body.scale(0.27, 0.3, 0.62);
  add(body, fur, 0, 0.98, 0);
  const belly = new THREE.SphereGeometry(1, 10, 8); belly.scale(0.22, 0.12, 0.45); add(belly, pale, 0, 0.82, 0);
  const neck = new THREE.CylinderGeometry(0.08, 0.12, 0.5, 8); add(neck, fur, 0, 1.25, 0.5, 0.6);
  const head = new THREE.SphereGeometry(1, 12, 8); head.scale(0.1, 0.11, 0.2); const hd = add(head, fur, 0, 1.48, 0.7);
  const snout = new THREE.SphereGeometry(1, 8, 6); snout.scale(0.06, 0.06, 0.09); add(snout, dark, 0, 1.44, 0.86);
  for (const s of [1, -1]) {
    const ear = new THREE.ConeGeometry(0.05, 0.16, 6); const e = add(ear, fur, s * 0.09, 1.6, 0.66); e.rotation.z = -s * 0.7;
  }
  const tail = new THREE.SphereGeometry(1, 8, 6); tail.scale(0.06, 0.1, 0.05); add(tail, pale, 0, 1.05, -0.6);
  if (buck) {
    const ant = new THREE.MeshLambertMaterial({ color: 0xcbb89a });
    for (const s of [1, -1]) {
      const a = new THREE.CylinderGeometry(0.012, 0.018, 0.34, 5); const m = add(a, ant, s * 0.08, 1.75, 0.68); m.rotation.z = -s * 0.5; m.rotation.x = -0.3;
      const b = new THREE.CylinderGeometry(0.01, 0.014, 0.18, 5); const n = add(b, ant, s * 0.18, 1.86, 0.74); n.rotation.z = -s * 0.2; n.rotation.x = 0.4;
    }
  }
  // eyes catch the headlights at night
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
  const eyes = [];
  for (const s of [1, -1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 4), eyeMat); e.position.set(s * 0.075, 1.52, 0.8); e.visible = false; g.add(e); eyes.push(e); }
  // legs pivot at the hips/shoulders so they can swing
  const legs = [];
  for (const [x, z] of [[0.13, 0.42], [-0.13, 0.42], [0.13, -0.42], [-0.13, -0.42]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.86, z); g.add(pivot);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.035, 0.86, 6), fur); leg.position.y = -0.43; leg.castShadow = true; pivot.add(leg);
    const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 6), dark); hoof.position.y = -0.85; pivot.add(hoof);
    legs.push(pivot);
  }
  g.userData = { legs, eyes, head: hd };
  return g;
}

export class Deer {
  constructor({ scene, track, terrain }) {
    Object.assign(this, { scene, track, terrain });
    this.events = []; this.active = []; this.enabled = false; this.night = false;
    this.pool = [];
  }
  setEnabled(on) { this.enabled = on; if (!on) this.clear(); }
  setNight(on) { this.night = on; for (const d of this.active) for (const e of d.mesh.userData.eyes) e.visible = on; }
  clear() { for (const d of this.active) { d.mesh.visible = false; this.pool.push(d.mesh); } this.active = []; this.events = []; }

  // plan this run's crossings (from - to: the stretch of road the run covers)
  plan(from, to, rng = Math.random) {
    this.clear();
    if (!this.enabled) return 0;
    const n = Math.max(0, Math.round(3 + 1.5 * gauss(rng)));
    const a = from + 300, b = to - 120;
    for (let i = 0; i < n && b > a; i++) this.events.push({ s: a + rng() * (b - a), side: rng() < 0.5 ? 1 : -1, run: rng() < 0.5, buck: rng() < 0.35, done: false });
    this.events.sort((p, q) => p.s - q.s);
    return n;
  }

  spawn(ev, playerV) {
    const T = this.track, p = T.at(ev.s), half = T.w / 2;
    const ang = (Math.random() - 0.5) * 0.6;                 // not quite square to the road
    const nx = p.hz, nz = -p.hx;                              // left of travel
    const start = half + (ev.run ? 7 + Math.random() * 4 : 3 + Math.random() * 3);
    const dirx = -ev.side * nx * Math.cos(ang) + p.hx * Math.sin(ang), dirz = -ev.side * nz * Math.cos(ang) + p.hz * Math.sin(ang);
    const mesh = this.pool.pop() || deerModel(ev.buck);
    if (!mesh.parent) this.scene.add(mesh);
    mesh.visible = true;
    for (const e of mesh.userData.eyes) e.visible = this.night;
    const d = { mesh, run: ev.run, px: p.x + nx * ev.side * start, pz: p.z + nz * ev.side * start, dx: dirx, dz: dirz,
      speed: ev.run ? 9 + Math.random() * 4 : 1.1 + Math.random() * 0.5, travelled: 0, total: 2 * start + 4, phase: Math.random() * 6,
      hit: false, vy: 0, y: 0, spin: 0, t: 0 };
    d.yaw = Math.atan2(dirx, dirz); d.v = d.speed;
    d.nudge = (dF, dL) => { const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw); d.px += fx * dF + fz * dL; d.pz += fz * dF - fx * dL; };
    d.kick = (dF, dL, dw, jx, jz) => { d.hit = true; d.flyX = jx / BOXES.deer.m; d.flyZ = jz / BOXES.deer.m; d.vy = 3 + Math.hypot(d.flyX, d.flyZ) * 0.25; d.spin = dw * 3 + 4; };
    this.active.push(d);
    void playerV;
  }

  // returns impact speed if you hit one this frame
  update(dt, { playerS, playerV, car, playerBody, collisions }) {
    if (!this.enabled) return 0;
    const half = this.track.w / 2;
    for (const ev of this.events) {
      if (ev.done) continue;
      const ahead = ev.s - playerS;
      // walkers step out so they're on the road about when you get there (a little early, so a
      // careful driver can stop); runners bolt 1.5-3 s ahead of you
      if (ev.lead === undefined) ev.lead = ev.run ? 1.5 + Math.random() * 1.5 : 0.6 + Math.random() * 0.8;
      const reach = ev.run ? (half + 9) / 11 : (half + 9) / 1.3;     // seconds for the deer to reach the road
      const trigger = Math.max(ev.run ? 30 : 60, playerV * (ev.run ? ev.lead : reach * ev.lead));
      if (ahead > 0 && ahead < Math.min(trigger, ev.run ? 140 : 260)) { ev.done = true; this.spawn(ev, playerV); }
      else if (ahead <= 0 && ahead > -30) { ev.done = true; }   // already past it (e.g. after a reset)
      else if (ahead < -30) ev.done = true;
    }
    let impact = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const d = this.active[i], m = d.mesh;
      d.t += dt;
      if (d.hit) {
        // thrown by the impact
        d.px += d.flyX * dt; d.pz += d.flyZ * dt; d.flyX *= Math.exp(-1.5 * dt); d.flyZ *= Math.exp(-1.5 * dt);
        d.vy -= 9.8 * dt; d.y = Math.max(0, d.y + d.vy * dt); if (d.y === 0) d.vy = 0;
        m.rotation.z += d.spin * dt; d.spin *= Math.exp(-1.2 * dt);
        if (d.t > 30) { m.visible = false; this.pool.push(m); this.active.splice(i, 1); continue; }
      } else {
        d.px += d.dx * d.speed * dt; d.pz += d.dz * d.speed * dt; d.travelled += d.speed * dt;
        d.phase += dt * d.speed * (d.run ? 1.1 : 2.2);
        const L = m.userData.legs, amp = d.run ? 0.7 : 0.35;
        L[0].rotation.x = Math.sin(d.phase) * amp; L[3].rotation.x = Math.sin(d.phase) * amp;
        L[1].rotation.x = -Math.sin(d.phase) * amp; L[2].rotation.x = -Math.sin(d.phase) * amp;
        if (d.run) { L[0].rotation.x = L[1].rotation.x = Math.sin(d.phase) * amp; L[2].rotation.x = L[3].rotation.x = -Math.sin(d.phase) * amp; }
        d.y = d.run ? Math.max(0, Math.sin(d.phase)) * 0.35 : 0;
        if (d.travelled > d.total || d.t > 40) { m.visible = false; this.pool.push(m); this.active.splice(i, 1); continue; }
        if (collisions && Math.hypot(d.px - car.pos.x, d.pz - car.pos.z) < 4) impact = Math.max(impact, resolve(playerBody(), kinematicBody(d, BOXES.deer)));
      }
      m.position.set(d.px, this.terrain.heightAt(d.px, d.pz) + d.y, d.pz);
      m.rotation.y = d.yaw;
    }
    return impact;
  }
}
