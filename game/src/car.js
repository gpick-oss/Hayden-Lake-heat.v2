import * as THREE from 'three';

const G = 9.81;

export function carModel(color = 0xc4161c) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111316, metalness: 0.2, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 0.8, roughness: 0.1 });
  const light = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = true; g.add(b); return b; };
  box(1.8, 0.5, 4.2, paint, 0, 0.55, 0);                 // body
  box(1.82, 0.18, 4.25, dark, 0, 0.3, 0);                 // sills / bumpers
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 2.0), glass); cab.position.set(0, 1.04, -0.25); g.add(cab);
  const roof = box(1.5, 0.08, 1.7, paint, 0, 1.32, -0.3);
  box(1.6, 0.06, 0.35, dark, 0, 1.0, -2.05).rotation.x = 0.0; // spoiler lip
  const wing = box(1.7, 0.05, 0.35, paint, 0, 1.18, -1.95);
  box(0.06, 0.2, 0.06, dark, 0.6, 1.07, -1.95); box(0.06, 0.2, 0.06, dark, -0.6, 1.07, -1.95);
  box(0.35, 0.1, 0.05, light, 0.6, 0.62, 2.11); box(0.35, 0.1, 0.05, light, -0.6, 0.62, 2.11);
  box(0.4, 0.1, 0.05, tail, 0.6, 0.65, -2.11); box(0.4, 0.1, 0.05, tail, -0.6, 0.65, -2.11);
  const wheels = [];
  const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14); tyre.rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.22, 0.22, 0.27, 6); rimG.rotateZ(Math.PI / 2);
  const rimM = new THREE.MeshStandardMaterial({ color: 0xbfc4c8, metalness: 0.9, roughness: 0.3 });
  for (const [x, z] of [[0.82, 1.32], [-0.82, 1.32], [0.82, -1.3], [-0.82, -1.3]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.34, z);
    const w = new THREE.Group();
    const t = new THREE.Mesh(tyre, dark); t.castShadow = true; w.add(t, new THREE.Mesh(rimG, rimM));
    pivot.add(w); g.add(pivot); wheels.push({ pivot, w, front: z > 0 });
  }
  void roof; void wing;
  g.userData.wheels = wheels;
  return g;
}

export class Car {
  constructor(world) {
    this.world = world;            // { terrain, track, forest, buildings, waterY }
    this.m = 1250; this.I = 1900;
    this.a = 1.3; this.b = 1.32; this.L = 2.62; this.hcg = 0.5;
    this.power = 210000; this.brakeF = 1.15 * this.m * G;
    this.pos = new THREE.Vector3(); this.yaw = 0;
    this.vx = 0; this.vy = 0; this.r = 0; this.vy3 = 0;
    this.steer = 0; this.air = false; this.surface = 'road';
    this.pitch = 0; this.roll = 0; this.ax = 0; this.ay = 0;
    this.wheelSpin = 0; this.slip = 0; this.rpm = 900; this.gear = 1;
    this.proj = { i: 0 };
    this.mesh = carModel();
    this._n = new THREE.Vector3();
    this._near = [];
  }

  place(x, z, yaw) {
    this.pos.set(x, this.world.terrain.heightAt(x, z), z); this.yaw = yaw;
    this.vx = this.vy = this.r = this.vy3 = 0; this.steer = 0; this.lastGround = undefined; this.air = false;
    this.world.track.project(x, z, -1, this.proj);
  }

  speed() { return Math.hypot(this.vx, this.vy); }

  step(dt, input) {
    const T = this.world.terrain;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = sin, fz = cos, lx = cos, lz = -sin;  // forward, left
    const v = this.speed();

    // steering: speed-sensitive lock, rate limited
    const maxSteer = 0.6 / (1 + v / 22);
    const target = input.steer * maxSteer;
    const rate = (input.analog ? 6 : 3.2) * dt;
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));
    const d = this.steer;

    // ground under each axle
    const hF = T.heightAt(this.pos.x + fx * this.a, this.pos.z + fz * this.a);
    const hR = T.heightAt(this.pos.x - fx * this.b, this.pos.z - fz * this.b);
    const hLft = T.heightAt(this.pos.x + lx * 0.8, this.pos.z + lz * 0.8);
    const hRgt = T.heightAt(this.pos.x - lx * 0.8, this.pos.z - lz * 0.8);
    const ground = (hF + hR + hLft + hRgt) / 4;
    const slopeF = (hF - hR) / this.L, slopeL = (hLft - hRgt) / 1.6;

    // vertical: follow ground, go airborne over crests
    this.vy3 -= G * dt;
    this.pos.y += this.vy3 * dt;
    if (this.pos.y <= ground) {
      const groundVel = this.lastGround !== undefined ? (ground - this.lastGround) / dt : 0;
      if (this.air && this.vy3 < -6) this.landed = Math.min(1, -this.vy3 / 15);
      this.pos.y = ground; this.vy3 = Math.max(this.vy3, groundVel); this.air = false;
    } else this.air = this.pos.y > ground + 0.15;
    this.lastGround = ground;

    // surface
    this.world.track.project(this.pos.x, this.pos.z, this.proj.i, this.proj);
    const off = this.proj.d - this.world.track.w / 2;
    const inWater = ground < this.world.waterY - 0.25;
    this.surface = inWater ? 'water' : off < 0.3 ? 'road' : off < 1.6 ? 'gravel' : 'grass';
    const mu = { road: 1.05, gravel: 0.78, grass: 0.68, water: 0.3 }[this.surface];
    const roll = { road: 0.012, gravel: 0.03, grass: 0.06, water: 0.6 }[this.surface];

    let Fx = 0, Fy = 0, Mz = 0;
    if (!this.air) {
      const N = this.m * G * Math.cos(Math.atan(slopeF));
      const Nf = Math.max(0, N * this.b / this.L - this.hcg / this.L * this.m * this.ax);
      const Nr = Math.max(0, N - Nf);
      const vxa = Math.max(Math.abs(this.vx), 2.0);
      const sgn = this.vx >= 0 ? 1 : -1;
      const af = Math.atan2(this.vy + this.a * this.r, vxa) - d * sgn;
      const ar = Math.atan2(this.vy - this.b * this.r, vxa);

      // longitudinal: AWD 40/60, reverse when stopped and braking
      let drive = 0, brake = 0;
      const fwd = this.vx > -0.5;
      if (input.throttle > 0) drive = fwd || this.vx > -0.5 ? input.throttle : 0;
      if (input.brake > 0) {
        if (this.vx > 1) brake = input.brake;
        else drive = -0.45 * input.brake;
      }
      if (input.throttle > 0 && this.vx < -1) brake = input.throttle;
      let Fdrive = drive * this.power / Math.max(Math.abs(this.vx), 7);
      Fdrive = Math.max(-mu * N, Math.min(mu * N, Fdrive));
      const Fb = brake * this.brakeF * Math.sign(this.vx);
      let Fxf = Fdrive * 0.4 - Fb * 0.62, Fxr = Fdrive * 0.6 - Fb * 0.38;
      let muR = mu;
      if (input.handbrake) { muR *= 0.45; Fxr -= 0.5 * this.m * G * Math.sign(this.vx) * Math.min(1, Math.abs(this.vx)); }
      Fxf = clampMag(Fxf, mu * Nf); Fxr = clampMag(Fxr, muR * Nr);

      const tyre = (alpha, Nz, m_, Fx_) => {
        const cap = Math.sqrt(Math.max((m_ * Nz) ** 2 - Fx_ * Fx_, (0.15 * m_ * Nz) ** 2));
        return -cap * Math.sin(1.55 * Math.atan(9 * alpha));
      };
      let Fyf = tyre(af, Nf, mu, Fxf), Fyr = tyre(ar, Nr, muR, Fxr);
      // fade lateral forces at a crawl so the car doesn't jitter
      const fade = Math.min(1, v / 1.5);
      Fyf *= fade; Fyr *= fade;
      this.slip = Math.max(Math.abs(ar), Math.abs(af) * 0.7) * Math.min(1, v / 8) + (input.handbrake && v > 5 ? 0.3 : 0);

      Fx = Fxf * Math.cos(d) - Fyf * Math.sin(d) + Fxr;
      Fy = Fxr * 0 + Fyf * Math.cos(d) + Fyr + Fxf * Math.sin(d);
      Mz = this.a * (Fyf * Math.cos(d) + Fxf * Math.sin(d)) - this.b * Fyr;

      // gravity along the slope, rolling resistance
      Fx += -this.m * G * slopeF;
      Fy += -this.m * G * slopeL * 0.6;
      Fx -= roll * this.m * G * Math.sign(this.vx) * Math.min(1, Math.abs(this.vx));
      if (inWater) { Fx -= 900 * this.vx; Fy -= 900 * this.vy; }
    }
    // aero
    Fx -= 0.42 * this.vx * Math.abs(this.vx);
    Fy -= 1.2 * this.vy * Math.abs(this.vy);

    const ax = Fx / this.m, ay = Fy / this.m;
    this.ax = ax; this.ay = ay;
    this.vx += (ax + this.vy * this.r) * dt;
    this.vy += (ay - this.vx * this.r) * dt;
    this.r += (Mz / this.I) * dt;
    if (this.air) this.r *= 1 - 0.5 * dt;
    if (!this.air && v < 0.3 && !input.throttle && !input.brake) { this.vx *= 0.9; this.vy *= 0.9; this.r *= 0.8; }

    this.yaw += this.r * dt;
    this.pos.x += (fx * this.vx + lx * this.vy) * dt;
    this.pos.z += (fz * this.vx + lz * this.vy) * dt;

    // visual attitude
    const tp = Math.atan(slopeF) - ax * 0.004, tr = Math.atan(slopeL) + ay * 0.006;
    const k = Math.min(1, dt * 10);
    this.pitch += (tp - this.pitch) * k; this.roll += (tr - this.roll) * k;
    this.wheelSpin += this.vx * dt / 0.34;

    // fake rpm with 6 gears for the sound
    const kmh = Math.abs(this.vx) * 3.6, ups = [0, 45, 80, 115, 150, 190, 999];
    while (this.gear < 6 && kmh > ups[this.gear]) this.gear++;
    while (this.gear > 1 && kmh < ups[this.gear - 1] - 8) this.gear--;
    const lo = ups[this.gear - 1], hi = ups[this.gear];
    const target_rpm = this.air || input.throttle > 0 && this.slip > 0.4 ? 7200 : 1600 + 5600 * Math.min(1, (kmh - lo) / (Math.min(hi, 230) - lo + 1)) * (this.gear === 1 ? 1 : 0.85) + 900 * input.throttle;
    this.rpm += (target_rpm - this.rpm) * Math.min(1, dt * 8);
  }

  // push out of trees and buildings; returns impact speed
  collide() {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let impact = 0;
    const F = this.world.forest;
    const circles = [[1.25, 1.0], [-1.25, 1.0], [0, 1.0]];
    const vwx = fx * this.vx + Math.cos(this.yaw) * this.vy, vwz = fz * this.vx - Math.sin(this.yaw) * this.vy;
    let nvx = vwx, nvz = vwz;
    const hit = (nx, nz, pen) => {
      this.pos.x += nx * pen; this.pos.z += nz * pen;
      const vn = nvx * nx + nvz * nz;
      if (vn < 0) { impact = Math.max(impact, -vn); nvx -= 1.25 * vn * nx; nvz -= 1.25 * vn * nz; nvx *= 0.85; nvz *= 0.85; }
    };
    for (const [o, rad] of circles) {
      const cx = this.pos.x + fx * o, cz = this.pos.z + fz * o;
      for (const k of F.near(cx, cz, 4, this._near)) {
        const tr = 0.18 + F.f[k * 4 + 3] * 0.012;
        const dx = cx - F.f[k * 4], dz = cz - F.f[k * 4 + 2], dist = Math.hypot(dx, dz);
        if (dist < tr + rad && dist > 1e-3) hit(dx / dist, dz / dist, tr + rad - dist);
      }
      for (const b of this.world.buildings) {
        if (Math.abs(b.cx - cx) > b.rad + 2 || Math.abs(b.cz - cz) > b.rad + 2) continue;
        const r = circlePoly(cx, cz, rad, b.p);
        if (r) hit(r[0], r[1], r[2]);
      }
    }
    if (impact > 0) {
      const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
      this.vx = nvx * sin + nvz * cos;
      this.vy = nvx * cos - nvz * sin;
      this.r *= 0.5;
    }
    return impact;
  }

  sync() {
    const m = this.mesh;
    m.position.copy(this.pos);
    m.rotation.set(0, 0, 0);
    m.rotateY(this.yaw); m.rotateX(-this.pitch); m.rotateZ(this.roll);
    for (const w of m.userData.wheels) {
      w.pivot.rotation.y = w.front ? this.steer : 0;
      w.w.rotation.x = this.wheelSpin;
    }
  }
}

const clampMag = (v, m) => Math.max(-m, Math.min(m, v));

// circle vs simple polygon (x,z pairs). returns [nx, nz, penetration] or null
function circlePoly(cx, cz, r, p) {
  let inside = false, best = Infinity, bx = 0, bz = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ax = p[j][0], az = p[j][1], qx = p[i][0], qz = p[i][1];
    if ((qz > cz) !== (az > cz) && cx < (ax - qx) * (cz - qz) / (az - qz) + qx) inside = !inside;
    const dx = qx - ax, dz = qz - az, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / L2));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(cx - px, cz - pz);
    if (d < best) { best = d; bx = px; bz = pz; }
  }
  if (!inside && best >= r) return null;
  let nx = cx - bx, nz = cz - bz; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
  if (inside) { nx = -nx; nz = -nz; return [nx, nz, best + r]; }
  return [nx, nz, r - best];
}
