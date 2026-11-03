import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Real car models (glTF) dropped into public/models/<name>/scene.gltf or public/models/<name>.glb.
// fitCar() orients and scales a model to the physics car, finds its wheels so they can spin and
// steer, recolours the paint, and adds the camera anchors the game expects.

const ZF = 1.06, ZR = -1.56, CG = 0.52;

export async function loadCarModel(name) {
  const loader = new GLTFLoader();
  for (const url of [`models/${name}/scene.gltf`, `models/${name}.glb`]) {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok || (head.headers.get('content-type') || '').includes('text/html')) continue;
      const gltf = await loader.loadAsync(url);
      return gltf.scene;
    } catch (e) { console.warn('model', url, e); }
  }
  return null;
}

// spec: { length, color, paint (RegExp to force paint material), flip, envMap, interior }
export function fitCar(proto, spec) {
  const src = proto.clone(true);
  // own materials per instance so paint colours don't leak between cars
  src.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
  const holder = new THREE.Group(); holder.add(src);
  holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(src);
  let size = box.getSize(new THREE.Vector3());
  // length along z
  if (size.x > size.z) { src.rotation.y = Math.PI / 2; holder.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(src); size = box.getSize(new THREE.Vector3()); }
  // front = away from the roof peak (the cabin sits behind the middle on these cars)
  const top = box.max.y - size.y * 0.08, ctr = box.getCenter(new THREE.Vector3());
  let zs = 0, n = 0;
  const v = new THREE.Vector3();
  src.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 7) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); if (v.y > top) { zs += v.z; n++; } }
  });
  const roofZ = n ? zs / n : ctr.z;
  if ((roofZ > ctr.z) !== !!spec.flip) src.rotation.y += Math.PI;
  holder.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(src); size = box.getSize(new THREE.Vector3());
  const k = spec.length / size.z;
  src.scale.multiplyScalar(k);
  holder.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(src);
  ctr.copy(box.getCenter(new THREE.Vector3()));
  src.position.x -= ctr.x; src.position.z -= ctr.z; src.position.y -= box.min.y;
  holder.updateMatrixWorld(true);

  // wheels: small meshes low down at the four corners
  const corners = [[], [], [], []]; // FL FR RL RR (x>0 = left)
  const meshes = []; src.traverse(o => { if (o.isMesh) meshes.push(o); });
  const mb = new THREE.Box3(), mc = new THREE.Vector3(), ms = new THREE.Vector3();
  for (const m of meshes) {
    mb.setFromObject(m); mb.getCenter(mc); mb.getSize(ms);
    if (Math.max(ms.x, ms.y, ms.z) > 0.9 || mc.y > 0.6 || Math.abs(mc.x) < 0.4 || ms.y < 0.15) continue;
    const front = mc.z > 0;
    corners[(front ? 0 : 2) + (mc.x > 0 ? 0 : 1)].push({ m, c: mc.clone(), size: ms.y });
  }
  const found = corners.every(c => c.length);
  // shift the model so its axles sit where the physics expects them
  let dz = 0, wheelCenters = null;
  if (found) {
    wheelCenters = corners.map(list => { const big = list.reduce((a, b) => (b.size > a.size ? b : a)); return big.c; });
    const zf = (wheelCenters[0].z + wheelCenters[1].z) / 2, zr = (wheelCenters[2].z + wheelCenters[3].z) / 2;
    dz = (ZF + ZR) / 2 - (zf + zr) / 2;
    src.position.z += dz; holder.updateMatrixWorld(true);
    wheelCenters.forEach(c => { c.z += dz; });
  }

  // assemble the rig: root > body (sprung, pivots at CG height) + 4 wheel pivots
  const root = new THREE.Group();
  const body = new THREE.Group(); body.position.y = CG; root.add(body);
  const shell = new THREE.Group(); shell.position.y = -CG; body.add(shell);
  root.add(holder); root.updateMatrixWorld(true);
  const wheels = [];
  if (found) {
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group(); pivot.position.copy(wheelCenters[i]); root.add(pivot);
      const spin = new THREE.Group(); pivot.add(spin);
      root.updateMatrixWorld(true);
      for (const { m } of corners[i]) (/calip/i.test(m.name) ? pivot : spin).attach(m);
      wheels.push({ pivot, spin });
    }
  } else {
    for (let i = 0; i < 4; i++) { const pivot = new THREE.Group(); const spin = new THREE.Group(); pivot.add(spin); root.add(pivot); wheels.push({ pivot, spin }); }
  }
  shell.attach(holder);

  // paint: named paint material, else the opaque material covering the most area up high
  const area = new Map();
  for (const m of meshes) {
    if (wheels.some(w => w.spin.children.includes(m))) continue;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (mat.transparent || mat.opacity < 0.9) continue;
      const b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3());
      area.set(mat, (area.get(mat) || 0) + (s.x * s.z + s.x * s.y + s.y * s.z) * (b.max.y > 0.7 ? 1 : 0.3));
    }
  }
  let paints = [...area.keys()].filter(m => (spec.paint || /paint|body|carpaint|exterior|color/i).test(m.name));
  if (!paints.length && area.size) paints = [[...area.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  for (const p of paints) {
    p.color?.set(spec.color); if (p.map && spec.recolorTexture !== false) p.map = null;
    if ('metalness' in p) { p.metalness = 0.45; p.roughness = 0.28; }
    if ('clearcoat' in p) { p.clearcoat = 1; p.clearcoatRoughness = 0.03; }
  }
  // wheels: darken the rims and paint the brake calipers, if the model names them
  const wheelMats = new Set();
  for (const w of wheels) w.spin.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) wheelMats.add(m); });
  for (const w of wheels) w.pivot.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) if (/calip|brake/i.test(m.name + o.name)) m.userData.caliper = true; });
  for (const m of wheelMats) {
    if (m.userData.caliper || /calip|brake/i.test(m.name)) { if (spec.caliperColor != null) { m.color?.set(spec.caliperColor); m.map = null; } continue; }
    if (/tire|tyre|rubber/i.test(m.name)) continue;
    if (spec.rimColor != null && /rim|wheel|alloy|spoke/i.test(m.name)) { m.color?.set(spec.rimColor); m.map = null; }
  }
  const glass = [];
  for (const m of meshes) for (const mat of [m.material].flat()) {
    if (spec.envMap && 'envMap' in mat && mat.isMeshStandardMaterial) { mat.envMap = spec.envMap; mat.envMapIntensity = 0.9; }
    if (mat.transparent || /glass|window/i.test(mat.name)) { glass.push(mat); mat.userData.baseOpacity = mat.opacity; }
    m.castShadow = true; m.receiveShadow = true;
  }
  // camera anchors (driver on the left, x > 0)
  const eye = new THREE.Object3D(); eye.position.set(0.37, spec.eyeY ?? 1.2, spec.eyeZ ?? -0.66); shell.add(eye);
  const hoodCam = new THREE.Object3D(); hoodCam.position.set(0, spec.hoodY ?? 1.0, spec.hoodZ ?? 1.12); shell.add(hoodCam);
  const mirror = new THREE.Object3D(); mirror.position.set(0, spec.mirrorY ?? 1.35, spec.mirrorZ ?? -0.36); shell.add(mirror);

  root.userData = { body, wheels, eye, hoodCam, mirror, gauges: null, steeringWheel: null, glass, wheelsFound: found,
    materials: { glass: { set opacity(v) { for (const g of glass) g.opacity = Math.min(g.userData.baseOpacity, v); } } } };
  return root;
}
