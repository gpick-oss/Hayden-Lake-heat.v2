import * as THREE from 'three';
import { wrxModel } from './wrxModel.js';

// 2009 Subaru WRX 5-door (GH), Stage 2 tune, straight pipe, on 225/45R17 R-compound race tyres.
// Four independent tyres with combined-slip friction, real drivetrain (5MT, 50/50 viscous centre
// diff, viscous rear LSD), turbo spool, ABS. Body frame: x forward, y left; yaw rate r > 0 = left.
const G = 9.81;
export const SPEC = {
  mass: 1560,                 // 1,490 kg curb + driver
  wheelbase: 2.62, frontWeight: 0.595, cgHeight: 0.52,
  trackF: 1.53, trackR: 1.54, Iz: 2450, rollF: 0.66, // front-biased roll stiffness: mild understeer like the real car
  wheelR: 0.317, wheelI: 1.15,
  dragCoef: 0.5 * 1.225 * 0.33 * 2.2,
  engineI: 0.21,
  gears: { '-1': -3.333, 1: 3.454, 2: 1.947, 3: 1.296, 4: 0.972, 5: 0.738 }, final: 4.444, eff: 0.86,
  idle: 850, upshift: 6450, limiter: 6750,
  // crank torque (Nm): EJ255 Stage 2 (~375 hp / 400 lb-ft, ~20 psi) at full boost, and off-boost
  boostTq: [[0, 140], [1000, 170], [1500, 205], [2000, 262], [2500, 365], [3000, 470], [3500, 530], [4000, 542], [4500, 532], [5000, 512], [5500, 482], [6000, 446], [6500, 402], [7000, 350]],
  naTq: [[0, 130], [1000, 155], [2000, 195], [3000, 218], [4000, 228], [5000, 220], [6000, 200], [7000, 170]],
  boostPsi: 20,
  brakeF: 2600, brakeR: 1050, handbrake: 2400, // Nm per wheel
  // R-compound semi-slick: ~1.3 g lateral peak at nominal load, peak at ~6 deg / 9 % slip, gentle fall-off
  tire: { muX: 1.36, muY: 1.30, kPeak: 0.09, aPeak: 0.105, N0: 3800, loadSens: 0.14, relax: 0.45, B: 1.402, C: 1.65 },
};

const SURF = { road: { mu: 1.0, roll: 0.011 }, gravel: { mu: 0.68, roll: 0.025 }, grass: { mu: 0.55, roll: 0.05 }, water: { mu: 0.3, roll: 0.4 } };

function table(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let k = 1; k < t.length; k++) if (x <= t[k][0]) { const [x0, y0] = t[k - 1], [x1, y1] = t[k]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return t[t.length - 1][1];
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const RPM = 60 / (2 * Math.PI);
const F = [0, 0, 0];

export class Car {
  constructor(world, color) {
    this.world = world;             // { terrain, track, forest, buildings, waterY }
    const S = this.S = SPEC;
    this.a = S.wheelbase * (1 - S.frontWeight); this.b = S.wheelbase * S.frontWeight;
    // wheel order FL, FR, RL, RR
    this.wx = [this.a, this.a, -this.b, -this.b];
    this.wy = [S.trackF / 2, -S.trackF / 2, S.trackR / 2, -S.trackR / 2];
    this.w = [0, 1, 2, 3].map(() => ({ omega: 0, alpha: 0, kappa: 0, N: 0, Fx: 0, Fy: 0, steer: 0, abs: 1, surf: 'road', s: 0, spin: 0 }));
    this.pos = new THREE.Vector3(); this.yaw = 0;
    this.vx = 0; this.vy = 0; this.r = 0; this.vy3 = 0;
    this.steer = 0; this.air = false; this.surface = 'road';
    this.pitch = 0; this.roll = 0; this.bodyPitch = 0; this.bodyRoll = 0;
    this.axF = 0; this.ayF = 0; this.aVert = 0;
    this.gear = 1; this.auto = true; this.shiftT = 0; this.clutch = 'locked'; this.slipT = 0;
    this.engW = S.idle / RPM; this.rpm = S.idle; this.boost = 0; this.cut = false; this.load = 0;
    this.slip = 0; this.absActive = false; this.events = [];
    this.revHold = 0;
    this.proj = { i: 0, d: 0, s: 0, lat: 0, hx: 1, hz: 0 };
    this.mesh = wrxModel(color);
    this._near = [];
    this._gn = new THREE.Vector3();
  }

  place(x, z, yaw) {
    this.pos.set(x, this.world.terrain.heightAt(x, z), z); this.yaw = yaw;
    this.vx = this.vy = this.r = this.vy3 = 0; this.steer = 0;
    this.lastGround = undefined; this.groundVel = 0; this.air = false;
    this.axF = this.ayF = this.aVert = 0; this.bodyPitch = this.bodyRoll = 0;
    for (const w of this.w) { w.omega = 0; w.alpha = 0; w.kappa = 0; w.abs = 1; }
    this.gear = 1; this.shiftT = 0; this.engW = this.S.idle / RPM; this.boost = 0;
    this.world.track.project(x, z, -1, this.proj);
  }

  speed() { return Math.hypot(this.vx, this.vy); }
  ratio(g = this.gear) { return g === 0 ? 0 : this.S.gears[g] * this.S.final; }

  shift(dir) {
    const g = this.gear + dir;
    if (g < 1 || g > 5 || this.shiftT > 0) return;
    this.gear = g; this.shiftT = 0.2; this.events.push(dir > 0 ? 'upshift' : 'downshift');
  }

  // per-frame: driver aids that run at frame rate, then the fixed-step physics
  update(dt, input) {
    const S = this.S, v = this.vx;
    // surfaces per wheel from the road centreline
    this.world.track.project(this.pos.x, this.pos.z, this.proj.i, this.proj);
    const rx = -this.proj.hz, rz = this.proj.hx; // right of travel
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);
    const half = this.world.track.w / 2;
    let onRoad = 0;
    for (let i = 0; i < 4; i++) {
      const ox = fx * this.wx[i] + lx * this.wy[i], oz = fz * this.wx[i] + lz * this.wy[i];
      const d = Math.abs(this.proj.lat + ox * rx + oz * rz);
      const gy = this.world.terrain.heightAt(this.pos.x + ox, this.pos.z + oz);
      this.w[i].surf = gy < this.world.waterY - 0.25 ? 'water' : d < half + 0.2 ? 'road' : d < half + 1.4 ? 'gravel' : 'grass';
      if (this.w[i].surf === 'road') onRoad++;
    }
    this.surface = onRoad >= 2 ? 'road' : this.w.some(w => w.surf === 'water') ? 'water' : this.w.some(w => w.surf === 'grass') ? 'grass' : 'gravel';

    // reverse: hold brake at a standstill
    let throttle = input.throttle, brake = input.brake;
    if (input.hold) { brake = 1; throttle = 0; }
    else if (this.gear === -1) {
      [throttle, brake] = [input.brake, input.throttle];
      if (input.throttle > 0 && v > -0.5) { this.gear = 1; [throttle, brake] = [input.throttle, 0]; }
    } else if (brake > 0 && !throttle && Math.abs(v) < 0.4) {
      this.revHold += dt;
      if (this.revHold > 0.35) { this.gear = -1; this.revHold = 0; }
    } else this.revHold = 0;

    // automatic gearbox (manual override with shift keys)
    if (this.auto && this.gear >= 1 && this.shiftT <= 0) {
      const down = this.gear > 1 ? Math.abs(this.wheelAvg()) * this.ratio(this.gear - 1) * RPM : 9e9;
      if (this.rpm > S.upshift && this.gear < 5 && throttle > 0.3) this.shift(1);
      else if (this.gear > 1 && down < 5900 && this.rpm < (brake > 0 ? 3600 : 2500)) this.shift(-1);
    }
    if (this.shiftT > 0) throttle = this.auto ? 0 : throttle;

    // steering: wheel angle limited by speed so keyboard/pad can't ask far past peak slip angle
    const sp = Math.abs(v);
    const lock = input.analog ? Math.min(0.56, 0.07 + 4.2 / Math.max(sp, 1)) : Math.min(0.56, 0.055 + 3.0 / Math.max(sp, 1));
    const target = input.steer * lock;
    const rate = (input.analog ? 3.5 : (Math.abs(target) < Math.abs(this.steer) ? 6 : 3.5)) * Math.max(lock, 0.15);
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));

    this.ctl = { throttle, brake, handbrake: input.handbrake };
    const h = 1 / 1000;
    this.acc = (this.acc || 0) + dt;
    while (this.acc >= h) { this.step(h); this.acc -= h; }
    this.shiftT = Math.max(0, this.shiftT - dt);

    // squeal / slide amount for audio
    let ms = 0; for (const w of this.w) ms = Math.max(ms, w.s); this.slip = Math.max(0, ms - 0.75) * Math.min(1, this.speed() / 6);
    this.absActive = brake > 0 && this.w.some(w => w.abs < 0.95) && sp > 3;
  }

  wheelAvg() { let s = 0; for (const w of this.w) s += w.omega; return s / 4; }

  step(dt) {
    const S = this.S, T = this.world.terrain, tire = S.tire, ctl = this.ctl;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = sin, fz = cos, lx = cos, lz = -sin;

    // ---- ground contact / vertical
    const hF = T.heightAt(this.pos.x + fx * this.a, this.pos.z + fz * this.a);
    const hR = T.heightAt(this.pos.x - fx * this.b, this.pos.z - fz * this.b);
    const hL = T.heightAt(this.pos.x + lx * 0.77, this.pos.z + lz * 0.77);
    const hRt = T.heightAt(this.pos.x - lx * 0.77, this.pos.z - lz * 0.77);
    const ground = (hF * this.b + hR * this.a) / S.wheelbase * 0.5 + (hL + hRt) * 0.25;
    const sF = (hF - hR) / S.wheelbase, sL = (hL - hRt) / 1.54;
    this.vy3 -= G * dt;
    this.pos.y += this.vy3 * dt;
    const gv = this.lastGround !== undefined ? (ground - this.lastGround) / dt : 0;
    this.lastGround = ground;
    if (this.pos.y <= ground) {
      if (this.air && this.vy3 < -6) this.landed = Math.min(1, -this.vy3 / 15);
      this.pos.y = ground;
      // vertical acceleration imposed by the road (dips load the tyres, crests unload them)
      const av = (gv - (this.groundVel ?? gv)) / dt;
      this.aVert += (Math.max(-G, Math.min(2 * G, av)) - this.aVert) * Math.min(1, dt / 0.08);
      this.vy3 = Math.max(this.vy3, gv); this.air = false;
    } else {
      this.air = this.pos.y > ground + 0.12;
      this.aVert += (0 - this.aVert) * Math.min(1, dt / 0.08);
    }
    this.groundVel = gv;

    // ---- loads: static + filtered longitudinal/lateral transfer
    const m = S.mass, L = S.wheelbase, cosT = 1 / Math.sqrt(1 + sF * sF + sL * sL);
    const Nt = this.air ? 0 : Math.max(0, m * (G * cosT + this.aVert));
    const dLong = m * this.axF * S.cgHeight / L / 2;
    const dLatF = m * this.ayF * S.cgHeight * S.rollF / S.trackF, dLatR = m * this.ayF * S.cgHeight * (1 - S.rollF) / S.trackR;
    const NfS = Nt * this.b / L / 2, NrS = Nt * this.a / L / 2;
    const N = [NfS - dLong - dLatF, NfS - dLong + dLatF, NrS + dLong - dLatR, NrS + dLong + dLatR];

    // ---- engine, clutch, gearbox
    const ratio = this.ratio();
    const wAvg = this.wheelAvg();
    const drivenW = wAvg * ratio;                   // engine-side speed of the driveline (rad/s)
    let rpm = this.engW * RPM;
    const spool = smooth(1700, 3300, rpm);
    const bTarget = ctl.throttle * spool;
    this.boost += (bTarget - this.boost) * Math.min(1, dt / (bTarget > this.boost ? 0.42 + Math.max(0, 3200 - rpm) / 3000 : 0.12));
    if (this.boost > 0.45 && ctl.throttle < 0.2 && !this.liftArmed) { this.events.push('bov'); this.liftArmed = true; }
    if (ctl.throttle > 0.5) this.liftArmed = false;
    if (rpm > S.limiter) this.cut = true; else if (rpm < S.limiter - 180) this.cut = false;
    const full = table(S.naTq, rpm) + this.boost * (table(S.boostTq, rpm) - table(S.naTq, rpm));
    const fric = 22 + rpm * 0.0085;
    const thr = this.cut ? 0 : ctl.throttle;
    let Te = thr * full - (1 - thr) * fric;
    if (rpm < S.idle && thr < 0.15) Te += (S.idle - rpm) * 0.4; // idle controller
    this.load = thr;

    let Tdrive = 0, Ie = 0;
    const inGear = this.gear !== 0 && this.shiftT <= 0;
    const drivenRpm = drivenW * RPM;
    if (!inGear || (drivenRpm < 900 && ctl.throttle < 0.05)) {
      this.clutch = 'open'; this.slipT = 0;
      this.engW += Te / S.engineI * dt;
      // auto rev-match while the gear changes
      if (this.shiftT > 0 && this.gear !== 0) this.engW += (Math.max(drivenW, S.idle / RPM) - this.engW) * Math.min(1, dt / 0.07);
    } else if (this.clutch === 'locked' && drivenRpm > 950) {
      this.slipT = 0;
      this.engW = drivenW;
      Tdrive = Te * ratio * S.eff; Ie = S.engineI * ratio * ratio;
    } else {
      // slipping clutch: launch, or re-engaging after a shift
      this.clutch = 'slip';
      const dW = this.engW - drivenW;
      let Tc;
      if (Math.abs(drivenRpm) > 1500) Tc = Math.max(-560, Math.min(560, dW * 25));   // re-engaging after a shift
      else {
        // launch: slip the clutch holding ~4,000 rpm at full throttle so the turbo spools
        // driver lets the clutch out over ~0.8 s: hold revs, then bring them down to meet the wheels
        this.slipT += dt;
        const target = 1300 + 2700 * ctl.throttle - 3000 * Math.max(0, this.slipT - 0.45);
        Tc = Math.max(0, Math.min(390 + 300 * Math.max(0, this.slipT - 0.45), Te + 0.2 * (rpm - target))) * Math.sign(dW);
        if (ctl.throttle < 0.05) Tc = Math.max(-40, Math.min(40, dW * 4));          // creeping
      }
      this.engW += (Te - Tc) / S.engineI * dt;
      Tdrive = Tc * ratio * S.eff;
      if (Math.abs(dW) < 12 && drivenRpm > 1100) this.clutch = 'locked';
    }
    this.engW = Math.max(300 / RPM, Math.min(7400 / RPM, this.engW));
    this.rpm = this.engW * RPM;

    // AWD: 50/50 centre viscous, open front, viscous rear LSD
    const w = this.w;
    const wf = (w[0].omega + w[1].omega) / 2, wr = (w[2].omega + w[3].omega) / 2;
    const cTq = 60 * (wf - wr);
    const Tf = Tdrive * 0.5 - cTq, Tr = Tdrive * 0.5 + cTq;
    const rTq = 18 * (w[2].omega - w[3].omega);
    const Tw = [Tf / 2, Tf / 2, Tr / 2 - rTq, Tr / 2 + rTq];
    const Iw = S.wheelI + Ie / 4;

    // steering with Ackermann
    const tanD = Math.tan(this.steer);
    w[0].steer = Math.atan(L * tanD / (L - tanD * S.trackF / 2));
    w[1].steer = Math.atan(L * tanD / (L + tanD * S.trackF / 2));
    w[2].steer = w[3].steer = 0;

    let Fx = 0, Fy = 0, Mz = 0;
    for (let i = 0; i < 4; i++) {
      const wh = w[i], surf = SURF[wh.surf];
      const n = Math.max(0, N[i]); wh.N = n;
      // contact patch velocity in the wheel frame
      const bvx = this.vx - this.r * this.wy[i], bvy = this.vy + this.r * this.wx[i];
      const cd = Math.cos(wh.steer), sd = Math.sin(wh.steer);
      const vxw = bvx * cd + bvy * sd, vyw = -bvx * sd + bvy * cd;

      // brakes (with ABS on the service brakes)
      let Tb = 0;
      if (ctl.brake > 0) {
        // ABS: fronts run at peak slip; rears are held to a lower slip target so the tail stays planted
        const k = wh.kappa, lim = i < 2 ? tire.kPeak * 1.1 : tire.kPeak * 0.5;
        if (k < -lim && Math.abs(vxw) > 2) wh.abs = Math.max(0.15, wh.abs - dt * 45);
        else wh.abs = Math.min(1, wh.abs + dt * 18);
        Tb = ctl.brake * (i < 2 ? S.brakeF : S.brakeR) * wh.abs;
      } else wh.abs = 1;
      if (ctl.handbrake && i >= 2) Tb += S.handbrake;

      // slip angle with relaxation length (tyre carcass lag; keeps low speed stable)
      const vden = Math.max(Math.abs(vxw), 2.5);
      const aKin = Math.atan2(vyw, Math.max(Math.abs(vxw), 0.5));
      wh.alpha += (aKin - wh.alpha) * Math.min(1, dt * (Math.abs(vxw) + 2) / tire.relax);

      // combined-slip friction (normalised slip vector, Pacejka-style curve)
      const muScale = surf.mu * (1 - tire.loadSens * (n / tire.N0 - 1));
      const Dx = tire.muX * muScale * n, Dy = tire.muY * muScale * n;
      const sy = Math.tan(wh.alpha) / Math.tan(tire.aPeak);
      const force = (om) => {
        const sx = (om * S.wheelR - vxw) / vden / tire.kPeak, s = Math.hypot(sx, sy);
        if (s < 1e-9) { F[0] = F[1] = 0; F[2] = 0; return F; }
        const mf = Math.sin(tire.C * Math.atan(tire.B * s));
        F[0] = Dx * mf * sx / s; F[1] = -Dy * mf * sy / s; F[2] = s; return F;
      };

      // wheel spin: backward-Euler step linearised about the current speed (stiff tyre, 1 kHz)
      const om = wh.omega;
      const f0 = force(om)[0];
      const net = Tw[i] - surf.roll * n * S.wheelR * Math.sign(om) - f0 * S.wheelR;
      const kk = S.wheelR * S.wheelR * (Dx * tire.B * tire.C / tire.kPeak) / (Iw * vden) * dt;
      const dir = om !== 0 ? Math.sign(om) : Math.sign(net);
      let omNew = om + (net - Tb * dir) / Iw * dt / (1 + kk);
      if (Tb > 0 && (om === 0 ? Math.abs(net) <= Tb : Math.sign(omNew) !== Math.sign(om))) omNew = 0; // brake holds the wheel
      wh.omega = omNew;
      wh.kappa = (omNew * S.wheelR - vxw) / vden;
      force(omNew);
      let fxw = F[0], fyw = F[1]; wh.s = F[2];
      if (Math.abs(vxw) < 0.3 && Math.abs(vyw) < 0.3) { fyw = -vyw * n * 0.5; }
      const om2 = omNew;

      wh.Fx = fxw; wh.Fy = fyw;
      const bx = fxw * cd - fyw * sd, by = fxw * sd + fyw * cd;
      Fx += bx; Fy += by; Mz += this.wx[i] * by - this.wy[i] * bx;
      wh.spin += om2 * dt;
    }

    // gravity along the slope, aero, water
    Fx += -m * G * sF * cosT;
    Fy += -m * G * sL * cosT;
    Fx -= S.dragCoef * this.vx * Math.abs(this.vx);
    Fy -= 2.5 * this.vy * Math.abs(this.vy);
    if (this.surface === 'water') { Fx -= 800 * this.vx; Fy -= 800 * this.vy; }

    const ax = Fx / m, ay = Fy / m;
    // body acceleration felt by the suspension (≈ tyre forces / mass), lagged by the dampers
    const kf = Math.min(1, dt / 0.07);
    this.axF += (ax + G * sF - this.axF) * kf; this.ayF += (ay + G * sL - this.ayF) * kf;
    this.vx += (ax + this.vy * this.r) * dt;
    this.vy += (ay - this.vx * this.r) * dt;
    this.r += Mz / S.Iz * dt;
    if (this.air) this.r *= 1 - 0.3 * dt;

    this.yaw += this.r * dt;
    this.pos.x += (fx * this.vx + lx * this.vy) * dt;
    this.pos.z += (fz * this.vx + lz * this.vy) * dt;

    // attitude: terrain + suspension (squat/dive/roll)
    const k = Math.min(1, dt * 12);
    this.pitch += (Math.atan(sF) - this.pitch) * k; this.roll += (Math.atan(sL) - this.roll) * k;
    this.bodyPitch = this.axF * 0.0042; this.bodyRoll = this.ayF * 0.0065;
  }

  // push out of trees and buildings; returns impact speed
  collide() {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let impact = 0;
    const F = this.world.forest;
    const circles = [[1.35, 0.9], [-1.75, 0.9], [-0.2, 0.9]];
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
      for (const w of this.w) w.omega = this.vx / this.S.wheelR;
    }
    return impact;
  }

  sync() {
    const m = this.mesh, u = m.userData;
    m.position.copy(this.pos);
    m.rotation.set(0, 0, 0);
    m.rotateY(this.yaw); m.rotateX(-this.pitch); m.rotateZ(this.roll);
    // body moves on its springs relative to the wheels
    u.body.rotation.set(-this.bodyPitch, 0, this.bodyRoll, 'YXZ');
    for (let i = 0; i < 4; i++) {
      const wm = u.wheels[i];
      wm.pivot.rotation.y = this.w[i].steer;
      wm.spin.rotation.x = this.w[i].spin;
    }
    if (u.steeringWheel) u.steeringWheel.rotation.z = -this.steer * 15.2;
  }
}

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
