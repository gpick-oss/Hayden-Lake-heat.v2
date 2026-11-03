import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Terrain, Forest, buildRoads, buildBuildings, loadWorld } from './world.js';
import { Track } from './track.js';
import { Car } from './wrx.js';
import { drawGauges } from './wrxModel.js';
import { buildSTI, buildBRZ, carEnvironment } from './carBuilder.js';
import { loadCarModel, fitCar } from './carModels.js';
import { RacingLine, LINE_MODES } from './racingLine.js';
import { LineDriver } from './driver.js';
import { Input } from './input.js';
import { Engine } from './audio.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('loading-msg').textContent = t; };

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
let quality = Number(localStorage.getItem('hr-quality') ?? 1); // 0 low, 1 medium, 2 high
renderer.setPixelRatio(Math.min(devicePixelRatio, [0.75, 1, 1.5][quality]));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = quality > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 6000);
const fogColor = new THREE.Color(0xa9bdd0);
scene.fog = new THREE.Fog(fogColor, 400, [1400, 2200, 3200][quality]);

// sky + sun (late summer afternoon over the lake)
const sky = new Sky(); sky.scale.setScalar(20000); scene.add(sky);
const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(215));
Object.assign(sky.material.uniforms, {});
sky.material.uniforms.sunPosition.value.copy(sun);
sky.material.uniforms.turbidity.value = 4; sky.material.uniforms.rayleigh.value = 1.2;
sky.material.uniforms.mieCoefficient.value = 0.004; sky.material.uniforms.mieDirectionalG.value = 0.8;
sky.material.fog = false;
const pmrem = new THREE.PMREMGenerator(renderer);
// reflections: a painted sky-to-forest gradient (the Sky shader doesn't survive PMREM here)
{
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#3f78c4'); gr.addColorStop(0.45, '#a8c6e4'); gr.addColorStop(0.5, '#c9d6de');
  gr.addColorStop(0.52, '#3a4a33'); gr.addColorStop(1, '#232b1f');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  // applied per material: in this three version scene.environment also tints Lambert surfaces
  window.__env = pmrem.fromEquirectangular(t).texture;
}
const envMap = window.__env;

const hemi = new THREE.HemisphereLight(0xe3e9ee, 0x3b4a2c, 0.9); scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.6);
sunLight.castShadow = quality > 0;
sunLight.shadow.mapSize.setScalar(quality > 1 ? 2048 : 1024);
const sc = sunLight.shadow.camera; sc.left = sc.bottom = -70; sc.right = sc.top = 70; sc.near = 1; sc.far = 400;
sunLight.shadow.bias = -0.0005; sunLight.shadow.normalBias = 0.05;
scene.add(sunLight, sunLight.target);

// ---------------------------------------------------------------- world
status('Downloading Hayden Lake…');
const W = await loadWorld((s) => status(`Loading ${s}…`));
status('Building terrain…');
const terrain = new Terrain(W.terrBuf, W.meta.lake);
terrain.buildCoarse(W.farTex);
scene.add(terrain.group);
const track = new Track(W.route);
// racing line (built offline from the car's own physics); fall back to the centreline if missing
const line = (await RacingLine.load(track)) || new RacingLine({ n: track.p.length, x: track.p.map(p => p[0]), z: track.p.map(p => p[2]),
  y: track.p.map(p => p[1]), s: Array.from(track.s), v: Array.from(track.vmax) }, track);
scene.add(line.mesh);
try { line.setMode(Math.max(0, Math.min(2, Number(localStorage.getItem('hr-line') || 0)))); } catch { }
// line distance <-> track distance (both are sampled on the same 2 m route stations)
const lineIdx = (sl) => { let lo = 0, hi = line.n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (line.s[m] <= sl) lo = m; else hi = m; } return lo + Math.max(0, Math.min(1, (sl - line.s[lo]) / ((line.s[lo + 1] - line.s[lo]) || 1))); };
const lineToTrackS = (sl) => { const f = Math.min(lineIdx(sl), track.p.length - 1.001), i = Math.floor(f); return track.s[i] + (f - i) * (track.s[i + 1] - track.s[i]); };
const playerLineOff = () => {
  const f = line.index(car.proj), i = Math.min(Math.floor(f), line.n - 2);
  let dx = line.x[i + 1] - line.x[i], dz = line.z[i + 1] - line.z[i]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  return (car.pos.x - line.x[i]) * dz - (car.pos.z - line.z[i]) * dx;
};
const playerLineS = () => { const f = line.index(car.proj), i = Math.floor(f); return line.s[i] + (f - i) * (line.s[i + 1] - line.s[i]); };
status('Paving roads…');
scene.add(buildRoads(W.route, W.roads, terrain));
status('Building houses…');
const blds = buildBuildings(W.blds); scene.add(blds.mesh);
status('Planting trees…');
const forest = new Forest(W.treeBuf, terrain); scene.add(forest.group);
const waterY = W.meta.water_y;

// lake: reflective plane with procedural ripples
const water = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'); const img = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const a = Math.sin(x * 0.098 + Math.sin(y * 0.05) * 2) * 0.5 + Math.sin((x + y) * 0.147) * 0.3 + Math.sin(y * 0.245 - x * 0.05) * 0.2;
    const b = Math.cos(y * 0.098 + Math.sin(x * 0.05) * 2) * 0.5 + Math.cos((x - y) * 0.147) * 0.3 + Math.sin(x * 0.196) * 0.2;
    const k = (y * 256 + x) * 4; img.data[k] = 128 + a * 50; img.data[k + 1] = 128 + b * 50; img.data[k + 2] = 255; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const n = new THREE.CanvasTexture(c); n.wrapS = n.wrapT = THREE.RepeatWrapping; n.repeat.set(900, 900);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ color: 0x1d3a4f, roughness: 0.08, metalness: 0.1, normalMap: n, normalScale: new THREE.Vector2(0.25, 0.25), envMap, envMapIntensity: 1.2 }));
  m.rotation.x = -Math.PI / 2; m.position.y = waterY; m.receiveShadow = true;
  scene.add(m); return m;
})();

// ---------------------------------------------------------------- race state
const world = { terrain, track, forest, buildings: blds.colliders, waterY };
// player: black WRX STI hatch; rivals: blue BRZs (real glTF models if present in public/models/)
status('Loading cars…');
const [stiProto, brzProto] = await Promise.all([loadCarModel('sti'), loadCarModel('brz')]);
const STI_BLACK = 0x07080a;
const carEnv = carEnvironment(renderer);
// 2018+ WRX STI sedan in Crystal Black Silica; real model if public/models/sti exists, else procedural
const makeSti = (color, interior = true) => stiProto
  ? fitCar(stiProto, { length: 4.595, color, envMap: carEnv, rimColor: 0x26282c, caliperColor: 0xf2c200 })
  : buildSTI(color, { envMap: carEnv, interior });
const makeBrz = (color) => brzProto ? fitCar(brzProto, { length: 4.24, color, envMap: carEnv, eyeY: 1.05, hoodY: 0.93 }) : buildBRZ(color, { envMap: carEnv });
const car = new Car(world, STI_BLACK, makeSti(STI_BLACK)); scene.add(car.mesh);
// live rear-view mirror for the cockpit: a small camera at the mirror looking back, rendered to a texture
const mirrorRT = new THREE.WebGLRenderTarget(512, 160);
const mirrorCam = new THREE.PerspectiveCamera(19, 512 / 160, 0.12, 900);
const mirrorMesh = (() => {
  const g = new THREE.PlaneGeometry(0.235, 0.07), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));          // a mirror flips left/right
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: mirrorRT.texture }));
  m.rotation.y = Math.PI;                                                 // face the driver
  return m;
})();
if (car.mesh.userData.mirror) car.mesh.userData.mirror.add(mirrorMesh);
const mq = new THREE.Quaternion();
let mirrorTick = 0;
function renderMirror() {
  const anchor = car.mesh.userData.mirror; if (!anchor) return;
  anchor.getWorldPosition(mirrorCam.position);
  anchor.getWorldQuaternion(mq);
  mirrorCam.quaternion.copy(mq);                                          // camera looks down -z = backwards
  mirrorCam.rotateX(0.02);
  mirrorMesh.visible = false;
  const auto = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(mirrorRT); renderer.render(scene, mirrorCam); renderer.setRenderTarget(null);
  renderer.shadowMap.autoUpdate = auto; mirrorMesh.visible = true;
}
const input = new Input();
// demo lap: the same driver that validated the line can take over (P)
const autoDriver = new LineDriver(line, { kUs: line.kUs ?? 0.0007 });
let autopilot = false;
const engine = new Engine();
const CHECK_EVERY = 1000;
const checkpoints = []; for (let s = CHECK_EVERY; s < track.length - 100; s += CHECK_EVERY) checkpoints.push(s);

const rivals = [
  { name: 'Coyote', color: 0x1d4fb5, skill: 0.96 },   // WR Blue Pearl
  { name: 'Moose', color: 0x0f2a6b, skill: 0.93 },    // Galaxy Blue
  { name: 'Osprey', color: 0x2c6fd6, skill: 0.90 },   // Sapphire Blue
].map((r, k) => ({ ...r, mesh: makeBrz(r.color), s: 0, v: 0, off: 0, offT: 0, offPrev: 0, latV: 0, wob: 0, wobV: 0, yaw: 0, done: null, wobble: Math.random() * 10 }));
rivals.forEach(r => scene.add(r.mesh));

const ghostMesh = makeSti(0xffffff, false);
ghostMesh.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; o.material.depthWrite = false; } o.castShadow = false; });
scene.add(ghostMesh);
let best = null; try { best = JSON.parse(localStorage.getItem('hr-best') || 'null'); } catch { }

let race;
function reset() {
  const p = track.at(0);
  const yaw = Math.atan2(p.hx, p.hz);
  // start in the right-hand lane
  const lane = laneOffset(p, -1.6);
  car.place(lane.x, lane.z, yaw);
  // rivals line up ahead of you, two abreast, then merge onto the racing line
  rivals.forEach((r, k) => { r.s = 12 + k * 9; r.v = 0; r.done = null; r.off = r.offT = r.offPrev = (k % 2 === 0 ? 3.2 : 0); r.latV = r.wob = r.wobV = 0; r.ts = lineToTrackS(r.s); });
  race = { phase: 'countdown', t: -3.5, next: 0, splits: [], rec: [], finished: null, lastS: 0, wrong: 0, impact: 0 };
  $('result').hidden = true;
}
// left vector of travel direction (hx,hz): (hz,-hx)?  forward f=(hx,hz); with x east/z south, left = (hz, -hx)
function laneOffset(p, off) { return { x: p.x + p.hz * off, z: p.z - p.hx * off }; }

function respawn() {
  const s = Math.max(0, car.proj.s - 5);
  const p = track.at(s); const lane = laneOffset(p, -1.6);
  car.place(lane.x, lane.z, Math.atan2(p.hx, p.hz));
  race.penalty = (race.penalty || 0) + 2;
  flash('Reset +2s');
}

let flashT = 0;
function flash(t) { $('flash').textContent = t; $('flash').style.opacity = 1; flashT = 1.6; }

// ---------------------------------------------------------------- HUD
const fmt = (t) => { if (t == null || !isFinite(t)) return '--:--.--'; const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
const mini = $('minimap'), mctx = mini.getContext('2d');
const miniImg = new Image(); miniImg.src = 'world/minimap.jpg';
const ext = W.meta.extent; // [x0, z0, width, height]
function drawMinimap() {
  const w = mini.width, h = mini.height;
  mctx.clearRect(0, 0, w, h);
  if (miniImg.complete) mctx.drawImage(miniImg, 0, 0, w, h);
  const X = (x) => (x - ext[0]) / ext[2] * w, Z = (z) => (z - ext[1]) / ext[3] * h;
  mctx.lineWidth = 3; mctx.strokeStyle = 'rgba(255,230,80,0.9)'; mctx.beginPath();
  track.p.forEach((p, k) => { if (k % 5) return; k ? mctx.lineTo(X(p[0]), Z(p[2])) : mctx.moveTo(X(p[0]), Z(p[2])); }); mctx.stroke();
  const dot = (x, z, c, r = 5) => { mctx.fillStyle = c; mctx.beginPath(); mctx.arc(X(x), Z(z), r, 0, 7); mctx.fill(); mctx.strokeStyle = '#000'; mctx.lineWidth = 1.5; mctx.stroke(); };
  const fin = track.p[track.p.length - 1]; dot(fin[0], fin[2], '#fff', 4);
  rivals.forEach(r => dot(r.mesh.position.x, r.mesh.position.z, '#' + r.color.toString(16).padStart(6, '0'), 4));
  dot(car.pos.x, car.pos.z, '#ff2a2a', 6);
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camMode = 0, firstFrame = true, camWasInside = false, gaugeT = 0, camYaw = 0;
const camQ = new THREE.Quaternion(), camQ2 = new THREE.Quaternion(), camE = new THREE.Euler();
const tmp = {}, tmp2 = {};

function updateRivals(dt) {
  const racing = race.phase === 'racing' || race.phase === 'finished';
  const pS = playerLineS(), pOff = playerLineOff();
  for (const r of rivals) {
    if (racing && r.s < line.length) {
      const here = line.sample(r.s, 0, tmp), ahead = line.sample(r.s + r.v * 0.6 + 2, 0, tmp2);
      let target = Math.min(here.v, ahead.v + 1) * r.skill * (1 + 0.025 * Math.sin(clock.elapsedTime * 0.37 + r.wobble));
      // traffic: the nearest car ahead (rivals and you) within 16 m
      let gap = 1e9, other = null;
      for (const o of rivals) if (o !== r && o.s - r.s > 0 && o.s - r.s < gap) { gap = o.s - r.s; other = { v: o.v, off: o.off }; }
      if (pS - r.s > 0 && pS - r.s < gap) { gap = pS - r.s; other = { v: Math.max(car.vx, 0), off: pOff }; }
      if (other && gap < 16) {
        // pull out to the side with room, and don't drive into the car while still alongside
        const alpha = line.alpha ? line.alpha[Math.floor(lineIdx(r.s))] : 0;
        const side = (alpha + other.off) > 0 ? -2.0 : 2.0;
        r.offT = Math.max(-2.3, Math.min(2.3, alpha + side)) - alpha;   // stay on the pavement
        if (Math.abs(r.off - other.off) < 1.6 && gap < 7) target = Math.min(target, other.v - 0.5);
      } else r.offT = 0;
      r.off += Math.max(-1.2 * dt, Math.min(1.2 * dt, r.offT - r.off));
      // knocked sideways by a hit: drift, scrubbed off by the tyres, then steer back to the line
      r.off += r.latV * dt; r.latV *= Math.exp(-2.2 * dt);
      r.v += Math.max(-9.5 * dt, Math.min(Math.min(4.6, 150 / Math.max(r.v, 5)) * dt, target - r.v));
      r.v = Math.max(0, r.v);
      r.s += r.v * dt;
      if (r.s >= line.length && !r.done) r.done = race.t;
    } else if (racing) r.v = Math.max(0, r.v - 6 * dt);
    // stay on (or near) the pavement after a shove
    const alphaHere = line.alpha ? line.alpha[Math.floor(lineIdx(Math.min(r.s, line.length - 0.5)))] : 0;
    const offAbs = alphaHere + r.off;
    if (Math.abs(offAbs) > 4.2) { r.off = Math.sign(offAbs) * 4.2 - alphaHere; r.latV = 0; }
    // yaw wobble from a hit settles like a car catching a slide
    r.wobV += (-14 * r.wob - 5 * r.wobV) * dt; r.wob += r.wobV * dt;
    r.ts = lineToTrackS(Math.min(r.s, line.length - 0.5));
    const p = line.sample(Math.min(r.s, line.length - 0.5), r.off, tmp);
    const x = p.x, z = p.z;
    r.mesh.position.set(x, terrain.heightAt(x, z), z);
    const steerYaw = Math.atan2((r.off - r.offPrev) / Math.max(dt, 1e-3), Math.max(r.v, 3));
    r.offPrev = r.off;
    r.yaw = Math.atan2(p.hx, p.hz) + steerYaw + r.wob;
    r.px = x; r.pz = z;
    r.mesh.rotation.set(0, r.yaw, 0);
    const pitch = Math.atan(terrain.heightAt(x + p.hx * 1.3, z + p.hz * 1.3) - terrain.heightAt(x - p.hx * 1.3, z - p.hz * 1.3)) / 2.6;
    r.mesh.rotateX(-pitch);
    for (const w of r.mesh.userData.wheels) w.spin.rotation.x += r.v * dt / 0.317;
  }
}

// ---------------------------------------------------------------- car-to-car contact (toggle: K)
// Cars are oriented boxes at their real footprint; contacts are resolved with impulses (restitution
// + friction), so a nudge from behind pushes a rival along and a hit off-centre spins your car.
let carCollisions = true; try { carCollisions = localStorage.getItem('hr-collide') !== '0'; } catch { }
const STI_BOX = { hl: 2.3, hw: 0.9, off: -0.244, m: 1560, I: 2450 };
const BRZ_BOX = { hl: 2.08, hw: 0.89, off: -0.09, m: 1270, I: 1900 };
function playerBody() {
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw), lx = Math.cos(car.yaw), lz = -Math.sin(car.yaw);
  return { kind: 'player', fx, fz, lx, lz, hl: STI_BOX.hl, hw: STI_BOX.hw, m: STI_BOX.m, I: STI_BOX.I,
    cx: car.pos.x + fx * STI_BOX.off, cz: car.pos.z + fz * STI_BOX.off,
    vx: fx * car.vx + lx * car.vy, vz: fz * car.vx + lz * car.vy, w: car.r, ox: car.pos.x, oz: car.pos.z };
}
function rivalBody(r) {
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw), lx = Math.cos(r.yaw), lz = -Math.sin(r.yaw);
  return { kind: 'rival', r, fx, fz, lx, lz, hl: BRZ_BOX.hl, hw: BRZ_BOX.hw, m: BRZ_BOX.m, I: BRZ_BOX.I,
    cx: r.px + fx * BRZ_BOX.off, cz: r.pz + fz * BRZ_BOX.off,
    vx: fx * r.v + lx * r.latV, vz: fz * r.v + lz * r.latV, w: r.wobV, ox: r.px, oz: r.pz };
}
// separating-axis test for two oriented boxes; returns { n (A<-B), depth } or null
function sat(A, B) {
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
function applyImpulse(b, jx, jz, px, pz, sign) {
  jx *= sign; jz *= sign;
  const ox = px - b.ox, oz = pz - b.oz, dw = (oz * jx - ox * jz) / b.I;
  if (b.kind === 'player') {
    const vx = b.vx + jx / b.m, vz = b.vz + jz / b.m;
    car.vx = vx * b.fx + vz * b.fz; car.vy = vx * b.lx + vz * b.lz; car.r += dw;
    for (const w of car.w) w.omega = car.vx / car.S.wheelR;   // tyres follow the jolt
  } else {
    const r = b.r;
    r.v = Math.max(0, r.v + (jx * b.fx + jz * b.fz) / b.m);
    r.latV += (jx * b.lx + jz * b.lz) / b.m;
    r.wobV += dw * 0.6;
  }
}
function moveBody(b, dx, dz) {
  if (b.kind === 'player') { car.pos.x += dx; car.pos.z += dz; }
  else { b.r.s += dx * b.fx + dz * b.fz; b.r.off += dx * b.lx + dz * b.lz; }
}
function resolve(A, B) {
  const c = sat(A, B); if (!c) return 0;
  const { nx, nz, depth } = c;
  // push apart in proportion to mass
  const tm = A.m + B.m;
  moveBody(A, nx * depth * B.m / tm, nz * depth * B.m / tm);
  moveBody(B, -nx * depth * A.m / tm, -nz * depth * A.m / tm);
  const [px, pz] = contactPoint(A, B);
  const va = (b) => { const ox = px - b.ox, oz = pz - b.oz; return [b.vx + b.w * oz, b.vz - b.w * ox]; };
  const [vax, vaz] = va(A), [vbx, vbz] = va(B);
  const rvx = vax - vbx, rvz = vaz - vbz, vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const crossN = (b) => { const ox = px - b.ox, oz = pz - b.oz; return oz * nx - ox * nz; };
  const k = 1 / A.m + 1 / B.m + crossN(A) ** 2 / A.I + crossN(B) ** 2 / B.I;
  const e = vn < -1 ? 0.15 : 0, j = -(1 + e) * vn / k;     // no bounce when just leaning on each other
  // friction along the contact (sideswipes drag each other)
  let tx = rvx - vn * nx, tz = rvz - vn * nz; const tl = Math.hypot(tx, tz);
  let jt = 0; if (tl > 1e-3) { tx /= tl; tz /= tl; jt = Math.min(0.35 * j, tl / k); }
  const Jx = j * nx - jt * tx, Jz = j * nz - jt * tz;
  applyImpulse(A, Jx, Jz, px, pz, 1);
  applyImpulse(B, Jx, Jz, px, pz, -1);
  return -vn;
}
function collideCars() {
  if (!carCollisions) return 0;
  let hit = 0;
  for (const r of rivals) {
    if (r.px === undefined || Math.hypot(r.px - car.pos.x, r.pz - car.pos.z) > 6) continue;
    hit = Math.max(hit, resolve(playerBody(), rivalBody(r)));
  }
  for (let a = 0; a < rivals.length; a++) for (let b = a + 1; b < rivals.length; b++) {
    const ra = rivals[a], rb = rivals[b];
    if (ra.px === undefined || Math.hypot(ra.px - rb.px, ra.pz - rb.pz) > 6) continue;
    resolve(rivalBody(ra), rivalBody(rb));
  }
  return hit;
}

// demo-lap driver racecraft: follow a slower car, pull out to the free side, pass, rejoin the line
function autopilotTraffic(dt) {
  const pS = playerLineS();
  let gap = 1e9, other = null;
  for (const r of rivals) { const g = r.s - pS; if (g > -3 && g < gap) { gap = g; other = r; } }
  let biasT = 0; autoDriver.speedCap = Infinity;
  if (other && gap < 35 && carCollisions) {
    const alpha = line.alpha ? line.alpha[Math.floor(lineIdx(pS))] : 0;
    const side = other.off > 0 ? -2.1 : 2.1;
    biasT = Math.max(-2.25, Math.min(2.25, alpha + other.off + side)) - alpha;
    // still lined up behind it: hang back until there's room
    if (gap < 10 && Math.abs(autoDriver.e - other.off) < 1.9) autoDriver.speedCap = Math.max(0, other.v - 0.5);
  }
  autoDriver.bias += Math.max(-1.6 * dt, Math.min(1.6 * dt, biasT - autoDriver.bias));
}

function position() {
  const me = race.finished ?? car.proj.s;
  let pos = 1;
  for (const r of rivals) {
    if (race.finished != null) { if (r.done != null && r.done < race.finished) pos++; }
    else if (r.ts > car.proj.s) pos++;
  }
  void me; return pos;
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  input.poll();

  if (input.pressed('KeyC')) camMode = (camMode + 1) % 4;
  if (input.pressed('KeyL')) {
    line.setMode((line.mode + 1) % LINE_MODES.length);
    try { localStorage.setItem('hr-line', String(line.mode)); } catch { }
    flash(['Racing line off', 'Racing line: full', 'Racing line: braking zones only'][line.mode]);
  }
  if (input.pressed('KeyK')) { carCollisions = !carCollisions; try { localStorage.setItem('hr-collide', carCollisions ? '1' : '0'); } catch { } flash(carCollisions ? 'Car collisions ON' : 'Car collisions OFF (ghost mode)'); }
  if (input.pressed('KeyP')) { autopilot = !autopilot; autoDriver.i = Math.floor(line.index(car.proj)); flash(autopilot ? 'Autopilot: driving the racing line (P to take over)' : 'You have control'); }
  if (input.pressed('KeyE')) car.shift(1);
  if (input.pressed('KeyQ')) car.shift(-1);
  if (input.pressed('KeyT')) { car.auto = !car.auto; flash(car.auto ? 'Automatic shifting' : 'Manual shifting (E up / Q down)'); }
  if (input.pressed('KeyR') && race.phase === 'racing') respawn();
  if (input.pressed('Enter') && race.phase === 'finished') reset();
  if (input.pressed('KeyM')) engine.toggle();
  if (input.pressed('KeyO')) { quality = (quality + 1) % 3; localStorage.setItem('hr-quality', quality); location.reload(); }

  race.t += dt;
  const controls = race.phase === 'countdown' ? { steer: 0, throttle: input.state.throttle, brake: 0, handbrake: false, hold: true }
    : (window.__auto || (autopilot ? (autopilotTraffic(dt), autoDriver.drive(car)) : input.state));
  if (race.phase === 'countdown') {
    const n = Math.ceil(-race.t);
    $('count').textContent = n > 0 ? n : 'GO!';
    $('count').style.opacity = n > 0 || race.t < 0.8 ? 1 : 0;
    if (race.t >= 0) { race.phase = 'racing'; race.t = 0; }
  } else if (race.t > 0.8) $('count').style.opacity = 0;

  car.update(dt, race.phase === 'finished' ? { steer: 0, throttle: 0, brake: car.vx > 1 ? 0.5 : 0, handbrake: car.vx <= 1 } : controls);
  for (const e of car.events.splice(0)) {
    if (e === 'bov') engine.event('bov', car.boost);
    if (e === 'upshift' && car.load > 0.8 && car.rpm > 5500) engine.event('bang');
  }
  const impact = car.collide();
  if (impact > 4) { engine.thud(Math.min(1, impact / 20)); if (impact > 12) flash('Crash!'); }
  car.sync();

  // race progress
  if (race.phase === 'racing') {
    const s = car.proj.s;
    if (s < race.lastS - 15 && car.vx > 3) race.wrong += dt; else race.wrong = Math.max(0, race.wrong - dt);
    race.lastS = Math.max(race.lastS, s);
    if (car.proj.d > 120) respawn();
    if (car.pos.y < waterY - 1.2) { flash('Splash!'); respawn(); }
    const ghostOK = car.proj.d < 40;
    while (race.next < checkpoints.length && s >= checkpoints[race.next] && ghostOK) {
      const t = race.t + (race.penalty || 0);
      race.splits.push(t);
      const ref = best?.splits?.[race.next];
      flash(`Checkpoint ${race.next + 1}/${checkpoints.length}  ${fmt(t)}` + (ref != null ? `  ${t <= ref ? '−' : '+'}${Math.abs(t - ref).toFixed(2)}` : ''));
      race.next++;
    }
    if (race.next >= checkpoints.length && s >= track.length - 6 && ghostOK) {
      race.phase = 'finished';
      race.finished = race.t + (race.penalty || 0);
      const pos = position();
      const isBest = !best || race.finished < best.time;
      if (isBest) { best = { time: race.finished, splits: race.splits, rec: race.rec }; try { localStorage.setItem('hr-best', JSON.stringify(best)); } catch { } }
      $('result').hidden = false;
      $('result-time').textContent = fmt(race.finished);
      $('result-pos').textContent = ['1st', '2nd', '3rd', '4th'][pos - 1] + ' place';
      $('result-best').textContent = isBest ? 'New best time!' : `Best ${fmt(best.time)}`;
    }
    // record ghost at 10 Hz
    if (race.rec.length < race.t * 10) race.rec.push([+car.pos.x.toFixed(2), +car.pos.y.toFixed(2), +car.pos.z.toFixed(2), +car.yaw.toFixed(3)]);
  }
  updateRivals(dt);
  const contact = collideCars();
  if (contact > 0) { car.sync(); if (contact > 1.5) engine.thud(Math.min(1, contact / 12)); if (contact > 6) flash('Contact!'); }

  // ghost replay
  ghostMesh.visible = !!best?.rec?.length && race.phase !== 'countdown';
  if (ghostMesh.visible) {
    const f = Math.max(0, race.t * 10), i = Math.min(Math.floor(f), best.rec.length - 2), u = Math.min(1, f - i);
    const a = best.rec[i], b = best.rec[i + 1] || a;
    ghostMesh.position.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    ghostMesh.rotation.set(0, a[3] + (b[3] - a[3]) * u, 0);
  }

  // racing line colours from progress along it and current speed
  line.update(car.proj, Math.max(car.vx, 0));

  // streaming
  terrain.update(car.pos.x, car.pos.z);
  forest.update(car.pos.x, car.pos.z, quality > 0);

  // camera
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const spd = car.speed();
  const u = car.mesh.userData;
  const inside = camMode >= 2;
  u.materials.glass.opacity = camMode === 2 ? 0.1 : 0.86;
  if (inside) {
    // rigidly mounted to the body, so the view can never end up inside the car; the driver's head
    // only takes half of the body's pitch/roll (neck stabilisation)
    car.mesh.updateMatrixWorld(true);
    (camMode === 2 ? u.eye : u.hoodCam).getWorldPosition(camera.position);
    const k = camMode === 2 ? 0.5 : 1;
    camQ.setFromRotationMatrix(car.mesh.matrixWorld);
    camE.set(-car.bodyPitch * k - 0.035, Math.PI, -car.bodyRoll * k, 'YXZ');
    camera.quaternion.copy(camQ).multiply(camQ2.setFromEuler(camE));
    camera.fov = camMode === 2 ? 66 : 68;
  } else {
    const back = camMode === 0 ? 6.8 : 11, up = camMode === 0 ? 2.2 : 4.2;
    // fixed distance behind the car at any speed; only the heading is smoothed
    if (firstFrame || camWasInside) { camYaw = car.yaw; firstFrame = false; }
    let dy = car.yaw - camYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    camYaw += dy * (1 - Math.exp(-dt * 8));
    const cx = Math.sin(camYaw), cz = Math.cos(camYaw);
    camPos.set(car.pos.x - cx * back, 0, car.pos.z - cz * back);
    camPos.y = Math.max(car.pos.y + up, terrain.heightAt(camPos.x, camPos.z) + 1.2);
    camera.position.copy(camPos);
    camLook.set(car.pos.x + cx * 3, car.pos.y + 1.1, car.pos.z + cz * 3);
    camera.lookAt(camLook);
    camera.fov = 62;
  }
  camWasInside = inside;
  camera.updateProjectionMatrix();

  sunLight.position.set(car.pos.x + sun.x * 200, car.pos.y + sun.y * 200, car.pos.z + sun.z * 200);
  sunLight.target.position.copy(car.pos);
  water.material.normalMap.offset.set(clock.elapsedTime * 0.004, clock.elapsedTime * 0.0025);
  sky.position.copy(camera.position);

  // HUD
  const mph = Math.abs(car.vx) * 2.237;
  $('speed').textContent = Math.round(mph);
  $('gear').textContent = car.gear === -1 ? 'R' : car.gear === 0 ? 'N' : car.gear;
  $('rpm').style.width = `${Math.min(100, car.rpm / 75)}%`;
  $('rpmbar').classList.toggle('shift', car.rpm > 6300);
  $('rpmval').textContent = Math.round(car.rpm / 10) * 10;
  $('boost').textContent = `${(car.boost * 20 - (1 - car.load) * 8).toFixed(0)} psi`;
  $('abs').style.opacity = car.absActive ? 1 : 0.15;
  $('mode').textContent = (autopilot ? 'AUTOPILOT' : car.auto ? 'AUTO' : 'MANUAL') + (carCollisions ? '' : ' · GHOST');
  gaugeT += dt;
  if (camMode === 2 && gaugeT > 0.05) { gaugeT = 0; drawGauges(u.gauges, car.rpm, mph, $('gear').textContent, car.boost * 20); }
  $('time').textContent = fmt(race.phase === 'countdown' ? 0 : (race.finished ?? race.t + (race.penalty || 0)));
  $('dist').textContent = `${(Math.min(car.proj.s, track.length) / 1609.34).toFixed(2)} / ${(track.length / 1609.34).toFixed(2)} mi`;
  $('pos').textContent = `${position()}/${rivals.length + 1}`;
  $('cp').textContent = `CP ${race.next}/${checkpoints.length}`;
  $('best').textContent = best ? `Best ${fmt(best.time)}` : '';
  $('wrong').style.opacity = race.wrong > 1.2 ? 1 : 0;
  $('surface').textContent = car.surface === 'road' ? '' : car.surface.toUpperCase();
  if (flashT > 0) { flashT -= dt; if (flashT <= 0) $('flash').style.opacity = 0; }
  drawMinimap();

  engine.update(car, camMode === 2);
  if (window.__cam) { camera.position.copy(window.__cam.p); camera.lookAt(window.__cam.t); camera.fov = 62; camera.updateProjectionMatrix(); }
  if (camMode === 2 && (mirrorTick = (mirrorTick + 1) % 2) === 0) renderMirror();   // mirror refreshes at half rate
  renderer.render(scene, camera);
}

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

reset();
window.__g = { car, terrain, track, forest, scene, renderer, camera, engine, rivals, line, setCam: (m) => { camMode = m; }, setCollisions: (on) => { carCollisions = on; },
  overlap: () => Math.max(0, ...rivals.filter(r => r.px !== undefined).map(r => sat(playerBody(), rivalBody(r))?.depth || 0)) };
// warm up streaming around the start so the first frame isn't empty
for (let k = 0; k < 40; k++) { terrain.update(car.pos.x, car.pos.z); forest.update(car.pos.x, car.pos.z, quality > 0); }
$('loading').hidden = true;
$('quality').textContent = ['Low', 'Medium', 'High'][quality];
addEventListener('keydown', () => engine.start(), { once: true });
addEventListener('pointerdown', () => engine.start(), { once: true });
frame();
