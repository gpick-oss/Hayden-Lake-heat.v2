import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Terrain, Forest, buildRoads, buildBuildings, loadWorld } from './world.js';
import { Track } from './track.js';
import { Car } from './wrx.js';
import { drawGauges } from './wrxModel.js';
import { buildSTI, buildBRZ, carEnvironment } from './carBuilder.js';
import { loadCarModel, fitCar } from './carModels.js';
import { RacingLine, LINE_MODES } from './racingLine.js';
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
const engine = new Engine();
const CHECK_EVERY = 1000;
const checkpoints = []; for (let s = CHECK_EVERY; s < track.length - 100; s += CHECK_EVERY) checkpoints.push(s);

const rivals = [
  { name: 'Coyote', color: 0x1d4fb5, skill: 0.96 },   // WR Blue Pearl
  { name: 'Moose', color: 0x0f2a6b, skill: 0.93 },    // Galaxy Blue
  { name: 'Osprey', color: 0x2c6fd6, skill: 0.90 },   // Sapphire Blue
].map((r, k) => ({ ...r, mesh: makeBrz(r.color), s: 0, v: 0, off: 0, offT: 0, offPrev: 0, done: null, wobble: Math.random() * 10 }));
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
  rivals.forEach((r, k) => { r.s = 12 + k * 9; r.v = 0; r.done = null; r.off = r.offT = r.offPrev = (k % 2 === 0 ? 3.2 : 0); r.ts = lineToTrackS(r.s); });
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
  const pS = playerLineS(), pOff = 0;
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
      r.v += Math.max(-9.5 * dt, Math.min(Math.min(4.6, 150 / Math.max(r.v, 5)) * dt, target - r.v));
      r.v = Math.max(0, r.v);
      r.s += r.v * dt;
      if (r.s >= line.length && !r.done) r.done = race.t;
    } else if (racing) r.v = Math.max(0, r.v - 6 * dt);
    r.ts = lineToTrackS(Math.min(r.s, line.length - 0.5));
    const p = line.sample(Math.min(r.s, line.length - 0.5), r.off, tmp);
    // keep rivals off the player: slide over if overlapping
    const dx = p.x - car.pos.x, dz = p.z - car.pos.z, d = Math.hypot(dx, dz);
    let x = p.x, z = p.z;
    if (d < 2.4 && d > 0.01) { x += dx / d * (2.4 - d); z += dz / d * (2.4 - d); }
    r.mesh.position.set(x, terrain.heightAt(x, z), z);
    const steerYaw = Math.atan2((r.off - r.offPrev) / Math.max(dt, 1e-3), Math.max(r.v, 3));
    r.offPrev = r.off;
    r.mesh.rotation.set(0, Math.atan2(p.hx, p.hz) + steerYaw, 0);
    const pitch = Math.atan(terrain.heightAt(x + p.hx * 1.3, z + p.hz * 1.3) - terrain.heightAt(x - p.hx * 1.3, z - p.hz * 1.3)) / 2.6;
    r.mesh.rotateX(-pitch);
    for (const w of r.mesh.userData.wheels) w.spin.rotation.x += r.v * dt / 0.317;
  }
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
  if (input.pressed('KeyE')) car.shift(1);
  if (input.pressed('KeyQ')) car.shift(-1);
  if (input.pressed('KeyT')) { car.auto = !car.auto; flash(car.auto ? 'Automatic shifting' : 'Manual shifting (E up / Q down)'); }
  if (input.pressed('KeyR') && race.phase === 'racing') respawn();
  if (input.pressed('Enter') && race.phase === 'finished') reset();
  if (input.pressed('KeyM')) engine.toggle();
  if (input.pressed('KeyO')) { quality = (quality + 1) % 3; localStorage.setItem('hr-quality', quality); location.reload(); }

  race.t += dt;
  const controls = race.phase === 'countdown' ? { steer: 0, throttle: input.state.throttle, brake: 0, handbrake: false, hold: true } : (window.__auto || input.state);
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
  $('mode').textContent = car.auto ? 'AUTO' : 'MANUAL';
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
window.__g = { car, terrain, track, forest, scene, renderer, camera, engine, setCam: (m) => { camMode = m; } };
// warm up streaming around the start so the first frame isn't empty
for (let k = 0; k < 40; k++) { terrain.update(car.pos.x, car.pos.z); forest.update(car.pos.x, car.pos.z, quality > 0); }
$('loading').hidden = true;
$('quality').textContent = ['Low', 'Medium', 'High'][quality];
addEventListener('keydown', () => engine.start(), { once: true });
addEventListener('pointerdown', () => engine.start(), { once: true });
frame();
