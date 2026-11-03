// Where does the rendered terrain poke through the road? Compares the terrain triangles (exactly as
// world.js triangulates the 2 m chunks) with the asphalt ribbon and the gravel-shoulder ribbon.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Terrain } from '../src/world.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(here, '../public/world');
const ab = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(fs.readFileSync(path.join(W, 'meta.json')));
const route = JSON.parse(fs.readFileSync(path.join(W, 'route.json')));
const T = new Terrain(ab(path.join(W, 'terrain.bin')), meta.lake);

// height of the rendered surface: quads split a-d-b / b-d-e (a=top-left, b=top-right, d=bottom-left)
function meshHeight(x, z) {
  const lx = x - T.ex, lz = z - T.ez, i = Math.floor(lx / T.chunk), j = Math.floor(lz / T.chunk);
  const f = T.fineH.get(j * T.nx + i);
  if (!f) return T.heightAt(x, z);
  const u = (lx - i * T.chunk) / T.fine, v = (lz - j * T.chunk) / T.fine, c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r, n = T.fn;
  const A = f[r * n + c], B = f[r * n + c + 1], D = f[(r + 1) * n + c], E = f[(r + 1) * n + c + 1];
  return fu + fv <= 1 ? A + (B - A) * fu + (D - A) * fv : E + (D - E) * (1 - fu) + (B - E) * (1 - fv);
}
const P = route.pts, half = route.w / 2;
const bad = []; const zones = {};
let worst = 0, cnt = 0, total = 0;
for (let i = 1; i < P.length - 1; i++) {
  const a = P[i - 1], b = P[i + 1]; let dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz); dx /= L; dz /= L;
  const ribbon = P[i][1] - 0.08;
  let m = -9;
  for (let d = -(half + 1.2); d <= half + 1.2; d += 0.3) {
    const x = P[i][0] + dz * d, z = P[i][2] - dx * d, e = meshHeight(x, z) - ribbon;
    m = Math.max(m, e);
    const band = Math.abs(d) < 1.5 ? 'centre' : Math.abs(d) <= half ? 'lane edge' : 'shoulder';
    if (e > 0.02) zones[band] = (zones[band] || 0) + 1;
    // is it the profile (grade) or the cross-section? compare with a flat-terrain prediction
  }
  total++;
  if (m > 0.0) { cnt++; bad.push([i * 2, m]); }
  worst = Math.max(worst, m);
}
console.log(`stations ${total}, terrain above the road surface at ${cnt} (${(100 * cnt / total).toFixed(1)}%), worst +${worst.toFixed(2)} m`);
const hist = [0.02, 0.05, 0.1, 0.2, 0.5, 1].map(t => `>${t} m: ${bad.filter(x => x[1] > t).length}`);
console.log(hist.join('  '));
console.log('samples >2 cm by zone:', JSON.stringify(zones));
bad.sort((a, b) => b[1] - a[1]);
console.log('worst spots (m along road, metres above):', bad.slice(0, 12).map(([s, m]) => `${s}:${m.toFixed(2)}`).join(' '));
