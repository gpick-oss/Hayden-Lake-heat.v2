// Car-to-car (and car-to-deer) contact: oriented boxes at the real footprint, separating-axis test,
// mass-weighted separation and impulses with restitution and friction, so a nudge from behind pushes a
// car along and an off-centre hit spins it.
//
// A body is { cx, cz, fx, fz, lx, lz, hl, hw, m, I, vx, vz, w, ox, oz, apply(jx, jz, px, pz), move(dx, dz) }:
// centre, forward/left unit vectors, half length/width, mass, yaw inertia, world velocity, yaw rate,
// the point it rotates about, and callbacks that push the impulse / correction back into its owner.

export const BOXES = {
  sti: { hl: 2.3, hw: 0.9, off: -0.244, m: 1560, I: 2450 },
  brz: { hl: 2.08, hw: 0.89, off: -0.09, m: 1270, I: 1900 },
  sedan: { hl: 2.35, hw: 0.91, off: -0.1, m: 1500, I: 2400 },
  suv: { hl: 2.4, hw: 0.95, off: -0.1, m: 1900, I: 3200 },
  pickup: { hl: 2.85, hw: 1.0, off: -0.35, m: 2200, I: 4300 },
  deer: { hl: 0.8, hw: 0.25, off: 0, m: 70, I: 12 },
};

export function sat(A, B) {
  const dx = A.cx - B.cx, dz = A.cz - B.cz;
  let best = Infinity, nx = 0, nz = 0;
  for (const [ax, az] of [[A.fx, A.fz], [A.lx, A.lz], [B.fx, B.fz], [B.lx, B.lz]]) {
    const ra = A.hl * Math.abs(A.fx * ax + A.fz * az) + A.hw * Math.abs(A.lx * ax + A.lz * az);
    const rb = B.hl * Math.abs(B.fx * ax + B.fz * az) + B.hw * Math.abs(B.lx * ax + B.lz * az);
    const d = dx * ax + dz * az, o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) { best = o; const sg = d >= 0 ? 1 : -1; nx = ax * sg; nz = az * sg; }
  }
  return { nx, nz, depth: best };
}

function contactPoint(A, B) {
  const inside = (P, x, z) => { const dx = x - P.cx, dz = z - P.cz; return Math.abs(dx * P.fx + dz * P.fz) <= P.hl && Math.abs(dx * P.lx + dz * P.lz) <= P.hw; };
  let sx = 0, sz = 0, n = 0;
  for (const [P, Q] of [[A, B], [B, A]]) for (const a of [-1, 1]) for (const b of [-1, 1]) {
    const x = P.cx + P.fx * P.hl * a + P.lx * P.hw * b, z = P.cz + P.fz * P.hl * a + P.lz * P.hw * b;
    if (inside(Q, x, z)) { sx += x; sz += z; n++; }
  }
  return n ? [sx / n, sz / n] : [(A.cx + B.cx) / 2, (A.cz + B.cz) / 2];
}

// returns the closing speed of the impact (0 if they weren't touching or were separating)
export function resolve(A, B) {
  const c = sat(A, B); if (!c) return 0;
  const { nx, nz, depth } = c;
  const tm = A.m + B.m;
  A.move(nx * depth * B.m / tm, nz * depth * B.m / tm);
  B.move(-nx * depth * A.m / tm, -nz * depth * A.m / tm);
  const [px, pz] = contactPoint(A, B);
  const pv = (b) => { const ox = px - b.ox, oz = pz - b.oz; return [b.vx + b.w * oz, b.vz - b.w * ox]; };
  const [vax, vaz] = pv(A), [vbx, vbz] = pv(B);
  const rvx = vax - vbx, rvz = vaz - vbz, vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const crossN = (b) => { const ox = px - b.ox, oz = pz - b.oz; return oz * nx - ox * nz; };
  const k = 1 / A.m + 1 / B.m + crossN(A) ** 2 / A.I + crossN(B) ** 2 / B.I;
  const e = vn < -1 ? 0.15 : 0, j = -(1 + e) * vn / k;     // no bounce when just leaning on each other
  let tx = rvx - vn * nx, tz = rvz - vn * nz; const tl = Math.hypot(tx, tz);
  let jt = 0; if (tl > 1e-3) { tx /= tl; tz /= tl; jt = Math.min(0.35 * j, tl / k); }
  const Jx = j * nx - jt * tx, Jz = j * nz - jt * tz;
  A.apply(Jx, Jz, px, pz);
  B.apply(-Jx, -Jz, px, pz);
  return -vn;
}

const frame = (yaw) => [Math.sin(yaw), Math.cos(yaw), Math.cos(yaw), -Math.sin(yaw)];

// the player's physics car
export function playerBody(car, box = BOXES.sti) {
  const [fx, fz, lx, lz] = frame(car.yaw);
  return {
    fx, fz, lx, lz, hl: box.hl, hw: box.hw, m: box.m, I: box.I,
    cx: car.pos.x + fx * box.off, cz: car.pos.z + fz * box.off,
    vx: fx * car.vx + lx * car.vy, vz: fz * car.vx + lz * car.vy, w: car.r, ox: car.pos.x, oz: car.pos.z,
    apply(jx, jz, px, pz) {
      const ox = px - this.ox, oz = pz - this.oz;
      const vx = this.vx + jx / this.m, vz = this.vz + jz / this.m;
      car.vx = vx * fx + vz * fz; car.vy = vx * lx + vz * lz; car.r += (oz * jx - ox * jz) / this.I;
      for (const w of car.w) w.omega = car.vx / car.S.wheelR;   // tyres follow the jolt
    },
    move(dx, dz) { car.pos.x += dx; car.pos.z += dz; },
  };
}

// a scripted car (rival, traffic) or animal: o = { px, pz, yaw, v, latV, wobV, nudge(dFwd, dLeft), kick? }
// v is speed along its own heading, latV sideways (left +); the owner turns nudges back into its own path coordinates
export function kinematicBody(o, box) {
  const [fx, fz, lx, lz] = frame(o.yaw);
  const lv = o.latVOwn ?? o.latV ?? 0;        // sideways speed in the object's own frame
  return {
    fx, fz, lx, lz, hl: box.hl, hw: box.hw, m: box.m, I: box.I,
    cx: o.px + fx * box.off, cz: o.pz + fz * box.off,
    vx: fx * o.v + lx * lv, vz: fz * o.v + lz * lv, w: o.wobV || 0, ox: o.px, oz: o.pz,
    apply(jx, jz, px, pz) {
      const ox = px - this.ox, oz = pz - this.oz;
      const dF = (jx * fx + jz * fz) / this.m, dL = (jx * lx + jz * lz) / this.m, dw = (oz * jx - ox * jz) / this.I;
      if (o.kick) o.kick(dF, dL, dw, jx, jz);
      else { o.v = Math.max(0, o.v + dF); o.latV = (o.latV || 0) + dL; o.wobV = (o.wobV || 0) + dw * 0.6; }
    },
    move(dx, dz) { o.nudge(dx * fx + dz * fz, dx * lx + dz * lz); },
  };
}
