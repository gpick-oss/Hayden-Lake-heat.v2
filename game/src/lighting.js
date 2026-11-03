import * as THREE from 'three';

// Day / night. Night: starry sky with a dim moon, short black fog, the STI's real headlights (spot
// lights, H for high beams), glowing head/tail lights on every other car and lit house windows.
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.8)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); return glowTex;
}

// glowing lamp sprites for a car (front white pair, rear red pair), children of the sprung body
export function addCarLamps(mesh, { front, rear, x, y, yRear }) {
  const holder = mesh.userData.body?.children[0] || mesh;          // the body "shell" sits at ground level
  const lamps = [];
  const mk = (color, size, px, py, pz) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    s.scale.setScalar(size); s.position.set(px, py, pz); s.visible = false; holder.add(s); lamps.push(s); return s;
  };
  for (const sg of [1, -1]) { mk(0xfff6e0, 1.4, sg * x, y, front); mk(0xff2a1a, 0.7, sg * x, yRear ?? y, rear); }
  mesh.userData.lamps = lamps;
  return lamps;
}

export class Lighting {
  constructor({ scene, renderer, sky, hemi, sun, water, fog, quality }) {
    Object.assign(this, { scene, renderer, sky, hemi, sun, water, fog, quality });
    this.mode = 'day';
    this.day = { hemiI: hemi.intensity, hemiC: hemi.color.clone(), hemiG: hemi.groundColor.clone(), sunI: sun.intensity, sunC: sun.color.clone(),
      fogC: fog.color.clone(), fogN: fog.near, fogF: fog.far, exposure: renderer.toneMappingExposure, shadows: sun.castShadow,
      waterC: water.material.color.clone(), waterE: water.material.envMapIntensity };
    // stars + moon, drawn at "infinity" around the camera
    const n = 1800, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random(), v = Math.random() * 0.95, th = 2 * Math.PI * u, ph = Math.acos(1 - v);   // upper hemisphere
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * 4500; pos[i * 3 + 1] = Math.cos(ph) * 4500; pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 4500;
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85, depthWrite: false }));
    this.stars.visible = false; scene.add(this.stars);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xe9eeff, fog: false, depthWrite: false, transparent: true }));
    this.moon.scale.setScalar(260); this.moon.visible = false; scene.add(this.moon);
    this.moonDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(120));
    this.lampSets = [];          // other cars' glow sprites
    this.windows = null;         // house window material swapper
    this.high = false;
  }

  // the player's headlights: two spot lights on the body, aimed down the road
  attachHeadlights(mesh, tail) {
    const holder = mesh.userData.body?.children[0] || mesh;
    this.heads = [];
    for (const sx of [0.62, -0.62]) {
      const l = new THREE.SpotLight(0xfff1dc, 0, 0, 0.42, 0.55, 2);
      l.position.set(sx, 0.72, 2.0);
      const t = new THREE.Object3D(); t.position.set(sx * 1.4, -0.6, 32); holder.add(t);
      l.target = t; l.castShadow = false; holder.add(l); this.heads.push(l);
    }
    this.tailMats = tail;          // { tail, tailLit } materials to brighten at night / under braking
  }
  registerLamps(mesh) { if (mesh.userData.lamps) this.lampSets.push(mesh.userData.lamps); }
  setWindows(fn) { this.windows = fn; }
  setReflectors(fn) { this.reflectors = fn; }

  setHigh(on) { this.high = on; this.applyBeams(); }
  applyBeams() {
    if (!this.heads) return;
    const night = this.mode === 'night';
    for (const l of this.heads) {
      l.intensity = night ? (this.high ? 9000 : 3200) : 0;
      l.angle = this.high ? 0.5 : 0.4;
      l.target.position.y = this.high ? -0.2 : -0.6; l.target.position.z = this.high ? 60 : 32;
    }
  }

  set(mode) {
    this.mode = mode;
    const night = mode === 'night', d = this.day;
    this.sky.visible = !night;
    this.scene.background = night ? new THREE.Color(0x05080f) : null;
    this.stars.visible = this.moon.visible = night;
    this.hemi.intensity = night ? 0.22 : d.hemiI;
    this.hemi.color.copy(night ? new THREE.Color(0x30405e) : d.hemiC);
    this.hemi.groundColor.copy(night ? new THREE.Color(0x0b0d0a) : d.hemiG);
    this.sun.intensity = night ? 0.22 : d.sunI;
    this.sun.color.copy(night ? new THREE.Color(0x9fb4ff) : d.sunC);
    this.sun.castShadow = night ? false : d.shadows;
    this.fog.color.copy(night ? new THREE.Color(0x05080f) : d.fogC);
    this.fog.near = night ? 40 : d.fogN; this.fog.far = night ? 620 : d.fogF;
    this.renderer.toneMappingExposure = night ? 0.85 : d.exposure;
    this.water.material.color.copy(night ? new THREE.Color(0x060b12) : d.waterC);
    this.water.material.envMapIntensity = night ? 0.25 : d.waterE;
    for (const set of this.lampSets) for (const s of set) s.visible = night;
    if (this.tailMats) this.tailMats.tail.emissive.setHex(night ? 0x7a0008 : 0x2a0003);
    if (this.windows) this.windows(night);
    if (this.reflectors) this.reflectors(night);
    this.applyBeams();
  }

  update(camera, carPos, braking) {
    if (this.mode === 'night') {
      this.stars.position.copy(camera.position);
      this.moon.position.copy(camera.position).addScaledVector(this.moonDir, 4000);
      this.sun.position.copy(carPos).addScaledVector(this.moonDir, 200);
      if (this.tailMats) this.tailMats.tail.emissive.setHex(braking ? 0xff1a1a : 0x7a0008);
    } else if (this.tailMats) this.tailMats.tail.emissive.setHex(braking ? 0xc01010 : 0x2a0003);
  }
}
