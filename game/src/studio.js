// Dev-only page to inspect the procedural cars: /studio.html?car=sti&view=photo
import * as THREE from 'three';
import { buildSTI, buildBRZ, buildCivilian, carEnvironment } from './carBuilder.js';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = true; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xa8bfd3);
const env = carEnvironment(renderer);
scene.add(new THREE.HemisphereLight(0xe3e9ee, 0x3b4a2c, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6); sun.position.set(-6, 9, 5); sun.castShadow = true;
sun.shadow.mapSize.setScalar(2048); Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
for (const z of [-0.12, 0.12]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(40, 0.1), new THREE.MeshBasicMaterial({ color: 0xd9a821 })); l.rotation.x = -Math.PI / 2; l.position.set(0, 0.002, -2.6 + z); l.rotation.z = 0.0; scene.add(l); }
const kind = q.get('car') || 'sti';
const car = kind === 'brz' ? buildBRZ(Number(q.get('color') || 0x1d4fb5), { envMap: env, interior: true })
  : ['sedan', 'suv', 'pickup'].includes(kind) ? buildCivilian(kind, Number(q.get('color') || 0xbfc3c7), { envMap: env })
  : buildSTI(Number(q.get('color') || 0x07080a), { envMap: env });
scene.add(car);
car.traverse(o => { if (o.isMesh) o.castShadow = true; });
const cam = new THREE.PerspectiveCamera(Number(q.get('fov') || 32), innerWidth / innerHeight, 0.03, 200);
const views = {
  photo: [[5.8, 3.4, 4.6], [0, 0.55, -0.3]], front: [[0, 1.1, 7.5], [0, 0.6, 0]], rear: [[0, 1.4, -8], [0, 0.7, 0]],
  side: [[8.5, 0.9, -0.25], [0, 0.65, -0.25]], rear34: [[-5.5, 2.4, -6], [0, 0.6, -0.4]], top: [[0.01, 12, 0], [0, 0, 0]],
  wheel: [[2.2, 0.45, 1.4], [0.7, 0.33, 1.06]], cockpit: null,
};
const v = views[q.get('view') || 'photo'];
if (v) { cam.position.set(...v[0]); cam.lookAt(new THREE.Vector3(...v[1])); }
else { car.updateMatrixWorld(true); car.userData.eye.getWorldPosition(cam.position); cam.rotation.set(-0.06, Math.PI, 0); cam.fov = 72; cam.updateProjectionMatrix(); car.userData.materials.glass.opacity = 0.1; }
renderer.render(scene, cam);
window.__ready = true;
