import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Terrain, Forest, buildRoads, buildBuildings, loadWorld } from './world.js';
import { Track } from './track.js';
import { Car } from './wrx.js';
import { drawGauges } from './wrxModel.js';
import { buildSTI, buildBRZ, carEnvironment } from './carBuilder.js';
import { loadCarModel, fitCar } from './carModels.js';
import { RacingLine } from './racingLine.js';
import { LineDriver } from './driver.js';
import { Input } from './input.js';
import { Engine } from './audio.js';
import { loadSettings, saveSettings, changeSetting, RELOAD_KEYS, RESTART_KEYS, RIVAL_TIMES } from './settings.js';
import { Menu } from './menu.js';
import { resolve, playerBody, kinematicBody, BOXES } from './contacts.js';
import { Rivals } from './rivals.js';
import { Traffic } from './traffic.js';
import { Deer } from './deer.js';
import { Lighting, addCarLamps } from './lighting.js';
import { generateNotes, CoDriver } from './paceNotes.js';
import { CoDriverVoice } from './coDriverVoice.js';
import { buildLandmarks } from './landmarks.js';
import { inject } from '@vercel/analytics';

// Vercel Web Analytics: page views on the deployed site only (nothing loads when playing locally)
if (import.meta.env.PROD && !/^(localhost|127\.|\[::1\])/.test(location.hostname)) inject({ mode: 'production' });

const $ = (id) => document.getElementById(id);
const status = (t) => { $('loading-msg').textContent = t; };
let settings = loadSettings();
const REV = settings.direction === 'reverse';
const DIRKEY = REV ? 'rev' : 'fwd';

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const quality = settings.quality;
renderer.setPixelRatio(Math.min(devicePixelRatio, [0.75, 1, 1.5][quality]));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = quality > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 6000);
scene.fog = new THREE.Fog(new THREE.Color(0xa9bdd0), 400, [1400, 2200, 3200][quality]);

// sky + sun (late summer afternoon over the lake)
const sky = new Sky(); sky.scale.setScalar(20000); scene.add(sky);
const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(215));
sky.material.uniforms.sunPosition.value.copy(sun);
sky.material.uniforms.turbidity.value = 4; sky.material.uniforms.rayleigh.value = 1.2;
sky.material.uniforms.mieCoefficient.value = 0.004; sky.material.uniforms.mieDirectionalG.value = 0.8;
sky.material.fog = false;
const pmrem = new THREE.PMREMGenerator(renderer);
let envMap;
{
  // reflections for the lake: a painted sky-to-forest gradient (applied per material: in this three
  // version scene.environment also tints Lambert surfaces)
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#3f78c4'); gr.addColorStop(0.45, '#a8c6e4'); gr.addColorStop(0.5, '#c9d6de');
  gr.addColorStop(0.52, '#3a4a33'); gr.addColorStop(1, '#232b1f');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  envMap = pmrem.fromEquirectangular(t).texture;
}

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
// the race runs along the route in the chosen direction (the drawn road is the same either way)
const track = new Track(REV ? { ...W.route, pts: W.route.pts.slice().reverse() } : W.route);
const line = (await RacingLine.load(track, REV ? 'racing_line_rev.json' : 'racing_line.json')) || new RacingLine({ n: track.p.length,
  x: track.p.map(p => p[0]), z: track.p.map(p => p[2]), y: track.p.map(p => p[1]), s: Array.from(track.s), v: Array.from(track.vmax) }, track);
scene.add(line.mesh);
line.setMode(settings.line);
// line distance <-> track distance (both are sampled on the same 2 m route stations)
const lineIdx = (sl) => { let lo = 0, hi = line.n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (line.s[m] <= sl) lo = m; else hi = m; } return lo + Math.max(0, Math.min(1, (sl - line.s[lo]) / ((line.s[lo + 1] - line.s[lo]) || 1))); };
const lineToTrackS = (sl) => { const f = Math.min(lineIdx(sl), track.p.length - 1.001), i = Math.floor(f); return track.s[i] + (f - i) * (track.s[i + 1] - track.s[i]); };
const trackIdx = (ts) => { let lo = 0, hi = track.s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track.s[m] <= ts) lo = m; else hi = m; } return lo + Math.max(0, Math.min(1, (ts - track.s[lo]) / ((track.s[lo + 1] - track.s[lo]) || 1))); };
const trackToLineS = (ts) => { const f = Math.min(trackIdx(ts), line.n - 1.001), i = Math.floor(f); return line.s[i] + (f - i) * (line.s[i + 1] - line.s[i]); };
status('Paving roads…');
scene.add(buildRoads(W.route, W.roads, terrain));
status('Building houses…');
const blds = buildBuildings(W.blds); scene.add(blds.mesh);
status('Planting trees…');
const forest = new Forest(W.treeBuf, terrain); scene.add(forest.group);
const waterY = W.meta.water_y;
status('Signs, rails and gates…');
const landmarks = await buildLandmarks(terrain);
if (landmarks) scene.add(landmarks.group);
const colliders = blds.colliders.concat(landmarks ? landmarks.colliders : []);

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

// ---------------------------------------------------------------- cars
const world = { terrain, track, forest, buildings: colliders, waterY };
status('Loading cars…');
const [stiProto, brzProto] = await Promise.all([loadCarModel('sti'), loadCarModel('brz')]);
const STI_BLACK = 0x07080a;
const carEnv = carEnvironment(renderer);
// 2018+ WRX STI sedan in Crystal Black Silica; real model if public/models/sti exists, else procedural
const makeSti = (color, interior = true) => stiProto
  ? fitCar(stiProto, { length: 4.595, color, envMap: carEnv, rimColor: 0x26282c, caliperColor: 0xf2c200 })
  : buildSTI(color, { envMap: carEnv, interior });
const makeBrz = (color) => {
  const m = brzProto ? fitCar(brzProto, { length: 4.24, color, envMap: carEnv, eyeY: 1.05, hoodY: 0.93 }) : buildBRZ(color, { envMap: carEnv });
  addCarLamps(m, { front: 1.93, rear: -2.12, x: 0.6, y: 0.68, yRear: 0.86 });
  return m;
};
const car = new Car(world, STI_BLACK, makeSti(STI_BLACK)); scene.add(car.mesh);
car.auto = settings.gearbox !== 'manual';

const lighting = new Lighting({ scene, renderer, sky, hemi, sun: sunLight, water, fog: scene.fog, quality });
lighting.attachHeadlights(car.mesh, car.mesh.userData.materials);
lighting.setWindows(blds.windows.setNight);
if (landmarks) lighting.setReflectors?.(landmarks.setNight);

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

const rivals = new Rivals({ line, terrain, scene, makeMesh: makeBrz, lineIdx, lineToTrackS });
for (const r of rivals.list) lighting.registerLamps(r.mesh);
const traffic = new Traffic({ scene, track, terrain, envMap: carEnv, lighting });
const deer = new Deer({ scene, track, terrain });
const input = new Input();
const autoDriver = new LineDriver(line, { kUs: line.kUs ?? 0.0007 });   // demo lap (P)
let autopilot = false;
const engine = new Engine();
const notes = generateNotes(track, line);
const coDriver = new CoDriver(notes, $('notes'), new CoDriverVoice(engine));

// checkpoints every km; cps = [start, CP1, CP2, ..., finish]
const cps = [0]; for (let s = 1000; s < track.length - 100; s += 1000) cps.push(s); cps.push(track.length);

const ghostMesh = makeSti(0xffffff, false);
ghostMesh.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; o.material.depthWrite = false; } o.castShadow = false; });
scene.add(ghostMesh);

// ---------------------------------------------------------------- bests
const fmt = (t) => { if (t == null || !isFinite(t)) return '--:--.--'; const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
// v2: the road was re-matched to the real pavement, so older bests/ghosts don't line up any more
const bestKey = () => settings.session === 'section' ? `hr2-sec-${DIRKEY}-${settings.sectionFrom}-${settings.sectionTo}` : `hr2-best-${DIRKEY}`;
const readBest = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
let best = readBest(bestKey());

// ---------------------------------------------------------------- settings / menu
function applySettings(changed) {
  lighting.set(settings.time); deer.setNight(settings.time === 'night');
  line.setMode(settings.line);
  coDriver.setMode(settings.notes);
  car.auto = settings.gearbox !== 'manual';
  traffic.setDensity(settings.traffic);
  deer.setEnabled(settings.deer);
  const rivalsOn = settings.rivals !== 'off' && settings.session === 'stage';
  if (rivalsOn && (!changed || changed === 'rivals' || changed === 'mode' || changed === 'session')) rivals.calibrate(RIVAL_TIMES[settings.rivals]);
  rivals.setActive(rivalsOn);
}
const menu = new Menu({
  root: $('menu'), getSettings: () => settings, checkpoints: cps,
  sectionBest: (a, b) => { const r = readBest(`hr2-sec-${DIRKEY}-${a}-${b}`); return r ? fmt(r.time) : null; },
  change: (key, value) => {
    settings = changeSetting(settings, key, value); saveSettings(settings);
    if (RELOAD_KEYS.has(key)) { location.reload(); return; }
    applySettings(key);
    if (RESTART_KEYS.has(key)) reset();
  },
  action: (a) => {
    if (a === 'resume') menu.close();
    if (a === 'restart') { reset(); menu.close(); }
    if (a === 'notes') window.open(`pacenotes/${REV ? 'reverse' : 'forward'}.html`, '_blank');
  },
});

// ---------------------------------------------------------------- race / session
let race;
function laneOffset(p, off) { return { x: p.x + p.hz * off, z: p.z - p.hx * off }; }
function sessionRange() {
  if (settings.session !== 'section') return [0, track.length];
  const a = Math.min(settings.sectionFrom, cps.length - 2), b = Math.max(a + 1, Math.min(settings.sectionTo, cps.length - 1));
  return [cps[a], cps[b]];
}
function placeOnLine(s, speed) {
  const p = track.at(s), lane = laneOffset(p, -1.6);
  car.place(lane.x, lane.z, Math.atan2(p.hx, p.hz));
  if (speed > 0) {
    car.vx = speed; for (const w of car.w) w.omega = speed / car.S.wheelR;
    car.gear = speed < 11 ? 1 : speed < 19 ? 2 : speed < 28 ? 3 : speed < 38 ? 4 : 5;
    car.engW = speed / car.S.wheelR * car.ratio();
  }
}
function reset() {
  best = readBest(bestKey());
  const [sA, sB] = sessionRange();
  const rolling = sA > 0;
  const s0 = rolling ? Math.max(0, sA - 230) : 0;
  placeOnLine(s0, 0);
  rivals.reset();
  race = { phase: 'countdown', t: -3.5, sA, sB, rolling, s0, timing: !rolling, splits: [], rec: [], finished: null, lastS: s0, wrong: 0,
    next: cps.findIndex(c => c > sA + 1), penalty: 0 };
  traffic.reset(s0);
  deer.plan(s0, sB);
  coDriver.reset(s0);
  autoDriver.i = 0;
  $('result').hidden = true;
  $('section').textContent = settings.session === 'section' ? sectionName() : '';
  // checkpoint boards for this direction (and the section's start/finish when practising one)
  if (landmarks) {
    const n = cps.length, mi = (m) => `${(m / 1609.34).toFixed(2)} mi`;
    const boards = new Map();
    for (let i = 1; i < n - 1; i++) boards.set(Math.round(cps[i]), { s: cps[i], label: `CP ${i}`, sub: mi(cps[i]) });
    // a practice section's own start/finish replace the CP board standing there
    if (settings.session === 'section' && sA > 0) boards.set(Math.round(sA), { s: sA, label: 'START', sub: `section · ${mi(sA)}` });
    if (settings.session === 'section' && sB < track.length - 1) boards.set(Math.round(sB), { s: sB, label: 'FINISH', sub: `section · ${mi(sB)}` });
    landmarks.setCheckpoints(track, [...boards.values()]);
  }
}
function sectionName() {
  const n = cps.length, nm = (i) => (i === 0 ? 'Start' : i === n - 1 ? 'Finish' : `CP ${i}`);
  return `Section practice: ${nm(settings.sectionFrom)} → ${nm(Math.min(settings.sectionTo, n - 1))}`;
}
function respawn() {
  const s = Math.max(0, car.proj.s - 5);
  placeOnLine(s, 0);
  race.penalty += 2;
  flash('Reset +2s');
}
let flashT = 0;
function flash(t) { $('flash').textContent = t; $('flash').style.opacity = 1; flashT = 1.6; }

// ---------------------------------------------------------------- HUD
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
  const fin = track.at(race.sB); dot(fin.x, fin.z, '#fff', 4);
  for (const c of traffic.cars) dot(c.px, c.pz, '#c8c8c8', 2.5);
  if (rivals.enabled) for (const r of rivals.list) dot(r.mesh.position.x, r.mesh.position.z, '#' + r.color.toString(16).padStart(6, '0'), 4);
  dot(car.pos.x, car.pos.z, '#ff2a2a', 6);
}
function position() {
  if (!rivals.enabled) return null;
  let pos = 1;
  for (const r of rivals.list) {
    if (race.finished != null) { if (r.done != null && r.done < race.finished) pos++; }
    else if (r.ts > car.proj.s) pos++;
  }
  return pos;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camMode = 0, firstFrame = true, camWasInside = false, gaugeT = 0, camYaw = 0;
const camQ = new THREE.Quaternion(), camQ2 = new THREE.Quaternion(), camE = new THREE.Euler();

const playerAbs = () => -car.proj.lat;                     // lateral from the centreline, left +
function obstaclesForRivals() {
  const out = [{ s: trackToLineS(car.proj.s), abs: playerAbs(), v: Math.max(car.vx, 0) }];
  for (const c of traffic.list()) out.push({ s: trackToLineS(c.s), abs: c.abs, v: Math.abs(c.v), oncoming: c.oncoming });
  return out;
}
function autopilotTraffic(dt) {
  // the demo driver follows slower cars, pulls out to the free side to pass, keeps right for oncoming traffic
  const pS = trackToLineS(car.proj.s);
  let gap = 1e9, other = null, oncoming = false;
  const cands = [];
  if (rivals.enabled) for (const r of rivals.list) cands.push({ s: r.s, abs: rivals.absAt(r.s) + r.off, v: r.v });
  for (const c of traffic.list()) cands.push({ s: trackToLineS(c.s), abs: c.abs, v: Math.abs(c.v), oncoming: c.oncoming });
  for (const o of cands) { const g = o.s - pS; if (o.oncoming) { if (g > -5 && g < 160) oncoming = true; continue; } if (g > -3 && g < gap) { gap = g; other = o; } }
  const alpha = rivals.absAt(pS);
  let biasT = 0; autoDriver.speedCap = Infinity;
  if (settings.collisions) {
    if (oncoming) biasT = Math.min(0, -0.9 - alpha);
    if (other && gap < 35) {
      const side = oncoming ? -2.1 : (other.abs > 0 ? -2.1 : 2.1);
      biasT = Math.max(-2.25, Math.min(2.25, other.abs + side)) - alpha;
      if (gap < 10 && Math.abs(alpha + autoDriver.e - other.abs) < 1.9) autoDriver.speedCap = Math.max(0, other.v - 0.5);
    }
  }
  autoDriver.bias += Math.max(-1.6 * dt, Math.min(1.6 * dt, biasT - autoDriver.bias));
}
function collideCars() {
  if (!settings.collisions) return 0;
  let hit = 0;
  const pB = () => playerBody(car), near = (x, z) => Math.hypot(x - car.pos.x, z - car.pos.z) < 7;
  for (const b of rivals.bodies()) if (near(b.ox, b.oz)) hit = Math.max(hit, resolve(pB(), b));
  for (const c of traffic.cars) if (near(c.px, c.pz)) hit = Math.max(hit, resolve(pB(), kinematicBody(c, BOXES[c.kind])));
  const rb = rivals.bodies();
  for (let a = 0; a < rb.length; a++) for (let b = a + 1; b < rb.length; b++) if (Math.hypot(rb[a].ox - rb[b].ox, rb[a].oz - rb[b].oz) < 7) resolve(rb[a], rb[b]);
  if (rivals.enabled) for (const r of rivals.list) for (const c of traffic.cars)
    if (Math.hypot(r.px - c.px, r.pz - c.pz) < 7) resolve(kinematicBody(r, BOXES.brz), kinematicBody(c, BOXES[c.kind]));
  return hit;
}

function finishRun() {
  race.phase = 'finished';
  race.finished = race.t + race.penalty;
  const key = bestKey(), prev = readBest(key);
  const isBest = !prev || race.finished < prev.time;
  if (isBest) { best = { time: race.finished, splits: race.splits, rec: race.rec }; try { localStorage.setItem(key, JSON.stringify(best)); } catch { } }
  const pos = position();
  $('result').hidden = false;
  $('result-time').textContent = fmt(race.finished);
  $('result-pos').textContent = settings.session === 'section' ? sectionName() : pos ? ['1st', '2nd', '3rd', '4th'][pos - 1] + ' place' : 'Stage complete';
  $('result-best').textContent = isBest ? (prev ? `New best! (${(prev.time - race.finished).toFixed(2)} s faster)` : 'New best time!') : `Best ${fmt(prev.time)}  (+${(race.finished - prev.time).toFixed(2)} s)`;
  if (rivals.enabled) {
    const lines = rivals.list.map(r => `${r.name} ${r.done != null ? fmt(r.done) : 'still running'}`).join(' · ');
    $('result-rivals').textContent = lines;
  } else $('result-rivals').textContent = '';
}

function pressed(...codes) { return codes.some(c => input.pressed(c)); }

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  input.poll();

  // menu: Esc (keydown listener below) / pad Start; while open the run is paused and the pad drives it
  if (pressed('PadStart')) toggleMenu();
  if (menu.isOpen) {
    for (const [pad, key] of [['PadUp', 'ArrowUp'], ['PadDown', 'ArrowDown'], ['PadLeft', 'ArrowLeft'], ['PadRight', 'ArrowRight'], ['PadA', 'Enter']]) if (input.pressed(pad)) menu.key(key);
    renderer.render(scene, camera);
    return;
  }

  if (pressed('KeyC', 'PadB')) camMode = (camMode + 1) % 4;
  if (pressed('KeyL', 'PadUp')) { settings = changeSetting(settings, 'line', (settings.line + 1) % 3); saveSettings(settings); line.setMode(settings.line); flash(['Racing line off', 'Racing line: full', 'Racing line: braking zones only'][settings.line]); }
  if (pressed('KeyK', 'PadDown')) { settings = changeSetting(settings, 'collisions', !settings.collisions); saveSettings(settings); flash(settings.collisions ? 'Car collisions ON' : 'Car collisions OFF (ghost cars)'); }
  if (pressed('KeyN')) { settings = changeSetting(settings, 'time', settings.time === 'night' ? 'day' : 'night'); saveSettings(settings); applySettings('time'); }
  if (pressed('KeyV')) {
    const order = ['off', 'voice', 'text'], next = order[(order.indexOf(settings.notes) + 1) % 3];
    settings = changeSetting(settings, 'notes', next); saveSettings(settings); coDriver.setMode(next);
    flash({ off: 'Pace notes off', voice: 'Pace notes: co-driver reading', text: 'Pace notes: on screen only' }[next]);
  }
  if (pressed('KeyH')) { lighting.setHigh(!lighting.high); if (settings.time === 'night') flash(lighting.high ? 'High beams' : 'Low beams'); }
  if (pressed('KeyP')) { autopilot = !autopilot; autoDriver.i = Math.floor(line.index(car.proj)); flash(autopilot ? 'Autopilot: driving the racing line (P to take over)' : 'You have control'); }
  if (pressed('KeyE')) car.shift(1);
  if (pressed('KeyQ')) car.shift(-1);
  if (pressed('KeyT', 'PadBack')) { settings = changeSetting(settings, 'gearbox', car.auto ? 'manual' : 'auto'); saveSettings(settings); car.auto = settings.gearbox !== 'manual'; flash(car.auto ? 'Automatic shifting' : 'Manual shifting (E up / Q down)'); }
  if (pressed('KeyR', 'PadY') && race.phase === 'racing') respawn();
  if (pressed('Enter', 'PadA') && race.phase === 'finished') reset();
  if (pressed('Backspace')) reset();
  if (pressed('KeyM')) engine.toggle();

  race.t += dt;
  const holding = race.phase === 'countdown';
  const controls = holding ? { steer: 0, throttle: input.state.throttle, brake: 0, handbrake: false, hold: true }
    : (window.__auto || (autopilot ? (autopilotTraffic(dt), autoDriver.drive(car)) : input.state));
  if (holding) {
    const n = Math.ceil(-race.t);
    $('count').textContent = n > 0 ? n : 'GO!';
    $('count').style.opacity = n > 0 || race.t < 0.8 ? 1 : 0;
    if (race.t >= 0) {
      race.phase = 'racing'; race.t = 0;
      if (race.rolling) placeOnLine(race.s0, Math.max(8, line.sample(trackToLineS(race.s0), 0, {}).v * 0.85));
    }
  } else if (race.t > 0.8) $('count').style.opacity = 0;

  let ctl = controls;
  if (race.phase === 'finished') {
    // past the line: follow the road while braking to a stop
    autoDriver.speedCap = 0; autoDriver.bias = 0;
    ctl = { ...autoDriver.drive(car), throttle: 0, brake: car.vx > 1 ? 0.5 : 0, handbrake: car.vx <= 1 };
    autoDriver.speedCap = Infinity;
  }
  car.update(dt, ctl);
  for (const e of car.events.splice(0)) {
    if (e === 'bov') engine.event('bov', car.boost);
    if (e === 'upshift' && car.load > 0.8 && car.rpm > 5500) engine.event('bang');
  }
  const impact = car.collide();
  if (impact > 4) { engine.thud(Math.min(1, impact / 20)); if (impact > 12) flash('Crash!'); }

  // run progress
  if (race.phase === 'racing') {
    const s = car.proj.s;
    if (!race.timing && s >= race.sA) { race.timing = true; race.t = 0; race.rec = []; flash('Timing started'); }
    if (s < race.lastS - 15 && car.vx > 3) race.wrong += dt; else race.wrong = Math.max(0, race.wrong - dt);
    race.lastS = Math.max(race.lastS, s);
    if (car.proj.d > 120) respawn();
    if (car.pos.y < waterY - 1.2) { flash('Splash!'); respawn(); }
    const ok = car.proj.d < 40;
    if (race.timing) {
      while (race.next > 0 && race.next < cps.length - 1 && cps[race.next] < race.sB && s >= cps[race.next] && ok) {
        const t = race.t + race.penalty;
        race.splits.push(t);
        const ref = best?.splits?.[race.splits.length - 1];
        flash(`CP ${race.next}  ${fmt(t)}` + (ref != null ? `  ${t <= ref ? '−' : '+'}${Math.abs(t - ref).toFixed(2)}` : ''));
        race.next++;
      }
      if (s >= race.sB - 6 && ok) finishRun();
      if (race.phase === 'racing' && race.rec.length < race.t * 10) race.rec.push([+car.pos.x.toFixed(2), +car.pos.y.toFixed(2), +car.pos.z.toFixed(2), +car.yaw.toFixed(3)]);
    }
  }

  const racing = race.phase === 'racing' || race.phase === 'finished';
  rivals.update(dt, { racing, raceT: race.t, clockT: clock.elapsedTime, obstacles: obstaclesForRivals(), collisions: settings.collisions });
  const others = settings.collisions ? [{ s: car.proj.s, abs: playerAbs(), v: car.vx }].concat(rivals.enabled ? rivals.list.map(r => ({ s: r.ts, abs: rivals.absAt(r.s) + r.off, v: r.v })) : []) : [];
  traffic.update(dt, { playerS: car.proj.s, others, racing });
  const deerHit = deer.update(dt, { playerS: car.proj.s, playerV: Math.max(car.vx, 0), car, playerBody: () => playerBody(car), collisions: settings.collisions });
  if (deerHit > 1) { engine.thud(Math.min(1, deerHit / 15)); flash('Deer strike!'); }
  const contact = collideCars();
  if (contact > 1.5) { engine.thud(Math.min(1, contact / 12)); if (contact > 6) flash('Contact!'); }
  car.sync();

  // ghost replay
  ghostMesh.visible = !!best?.rec?.length && race.timing && race.phase !== 'countdown';
  if (ghostMesh.visible) {
    const f = Math.max(0, race.t * 10), i = Math.min(Math.floor(f), best.rec.length - 2), u = Math.min(1, f - i);
    const a = best.rec[Math.max(0, i)], b = best.rec[i + 1] || a;
    ghostMesh.position.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    ghostMesh.rotation.set(0, a[3] + (b[3] - a[3]) * u, 0);
  }

  line.update(car.proj, Math.max(car.vx, 0));
  coDriver.update(car.proj.s, Math.max(car.vx, 0));
  terrain.update(car.pos.x, car.pos.z);
  forest.update(car.pos.x, car.pos.z, quality > 0 && settings.time === 'day');

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
    camera.fov = camMode === 2 ? settings.cockpitFov : 70;
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
  lighting.update(camera, car.pos, controls.brake > 0.05 && race.phase === 'racing');
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
  $('mode').textContent = (autopilot ? 'AUTOPILOT' : car.auto ? 'AUTO' : 'MANUAL') + (settings.collisions ? '' : ' · GHOST') + (settings.mode !== 'custom' ? ` · ${settings.mode.toUpperCase()}` : '');
  gaugeT += dt;
  if (camMode === 2 && gaugeT > 0.05) { gaugeT = 0; drawGauges(u.gauges, car.rpm, mph, $('gear').textContent, car.boost * 20); }
  $('time').textContent = fmt(!race.timing || race.phase === 'countdown' ? 0 : (race.finished ?? race.t + race.penalty));
  $('dist').textContent = `${(Math.min(car.proj.s, track.length) / 1609.34).toFixed(2)} / ${(track.length / 1609.34).toFixed(2)} mi` + (REV ? ' (reverse)' : '');
  const pos = position();
  $('pos').textContent = pos ? `${pos}/${rivals.list.length + 1}` : '';
  const cpTotal = cps.filter(c => c > race.sA && c < race.sB).length;
  $('cp').textContent = cpTotal ? `CP ${Math.max(0, race.splits.length)}/${cpTotal}` : '';
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

function toggleMenu() { menu.toggle(); engine.pause?.(menu.isOpen); if (menu.isOpen) coDriver.hush(); }
// menu keys are event-driven so quick taps and key-repeat all count
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { toggleMenu(); e.preventDefault(); return; }
  if (menu.isOpen && menu.key(e.code)) e.preventDefault();
});
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

applySettings();
reset();
window.__g = { car, terrain, track, forest, scene, renderer, camera, engine, rivals, traffic, deer, line, notes, coDriver, menu, lighting, landmarks,
  get settings() { return settings; }, setCam: (m) => { camMode = m; }, setCollisions: (on) => { settings = changeSetting(settings, 'collisions', on); },
  set: (k, v) => menu.change(k, v), race: () => race };
// warm up streaming around the start so the first frame isn't empty
for (let k = 0; k < 40; k++) { terrain.update(car.pos.x, car.pos.z); forest.update(car.pos.x, car.pos.z, quality > 0); }
$('loading').hidden = true;
addEventListener('keydown', () => engine.start(), { once: true });
addEventListener('pointerdown', () => engine.start(), { once: true });
frame();
