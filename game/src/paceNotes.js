// Rally pace notes generated from the road itself (and the verified racing-line speeds).
//
// Grades: 1 (slowest) .. 6 (fastest) from the speed the line takes the apex at; HP = hairpin
// (switchback), SQ = square (~90 degrees, short), K = kink (flat-out flick).
// Modifiers: long / very long, tightens (<), opens (>), over crest, dip, bump, caution (! / !!),
// "into" when the next corner follows almost immediately, otherwise the distance to it.
const KMH = 3.6;

function grade(vApex) {
  const k = vApex * KMH;
  return k < 40 ? 1 : k < 52 ? 2 : k < 64 ? 3 : k < 78 ? 4 : k < 95 ? 5 : 6;
}
function niceDist(d) {
  if (d < 20) return 'into';
  const steps = [20, 30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 1000];
  let best = steps[0]; for (const s of steps) if (Math.abs(s - d) < Math.abs(best - d)) best = s;
  return d > 1000 ? String(Math.round(d / 100) * 100) : String(best);
}
const WORD = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
const NUMWORD = (n) => ({ into: 'into', 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 100: 'one hundred', 120: 'one twenty', 150: 'one fifty', 200: 'two hundred', 250: 'two fifty', 300: 'three hundred', 350: 'three fifty', 400: 'four hundred', 500: 'five hundred', 600: 'six hundred', 700: 'seven hundred', 800: 'eight hundred', 1000: 'one thousand' }[n] || n);

// track: Track (p[i] = [x, y, z] every 2 m, s[i]); line: racing line { x, z, v } on the same stations.
// A corner's grade comes from what it allows (the racing line's radius through it at the car's grip),
// not from the speed you happen to be doing (so the launch or a braking zone doesn't skew it).
const GRIP = 10.5;   // usable lateral accel (m/s^2), from the physics envelope
export function generateNotes(track, line) {
  const P = track.p, S = track.s, n = P.length, vLine = line.v;
  // the racing line's own curvature -> the speed each spot allows on grip alone
  const hl = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1); hl[i] = Math.atan2(line.x[b] - line.x[a], line.z[b] - line.z[a]); }
  for (let i = 1; i < n; i++) { let d = hl[i] - hl[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); hl[i] = hl[i - 1] + d; }
  const kl = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 4, 0), b = Math.min(i + 4, n - 1); kl[i] = Math.abs(hl[b] - hl[a]) / Math.max(S[b] - S[a], 1e-3); }
  const klS = smooth(kl, 3);
  const vGrip = Float64Array.from(klS, (kk) => Math.min(60, Math.sqrt(GRIP / Math.max(kk, 1e-5))));
  // heading and curvature (+ = left), lightly smoothed
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1); h[i] = Math.atan2(P[b][0] - P[a][0], P[b][2] - P[a][2]); }
  for (let i = 1; i < n; i++) { let d = h[i] - h[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); h[i] = h[i - 1] + d; }
  const kRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 5, 0), b = Math.min(i + 5, n - 1); kRaw[i] = (h[b] - h[a]) / Math.max(S[b] - S[a], 1e-3); }
  const k = smooth(kRaw, 4);
  // vertical: slope and curvature of the road profile (- = crest)
  const y = smooth(Float64Array.from(P, p => p[1]), 3);
  const kv = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(i - 6, 0), b = Math.min(i + 6, n - 1), m = i; const s1 = (y[m] - y[a]) / Math.max(S[m] - S[a], 1), s2 = (y[b] - y[m]) / Math.max(S[b] - S[m], 1); kv[i] = (s2 - s1) / Math.max((S[b] - S[a]) / 2, 1); }
  const kvs = smooth(kv, 3);

  // corners: |k| above 1/250 m with hysteresis, same-direction pieces merged across short gaps
  const corners = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(k[i]) < 1 / 220) { i++; continue; }
    const sign = Math.sign(k[i]); let j = i;
    while (j < n - 1 && Math.sign(k[j + 1]) === sign && Math.abs(k[j + 1]) > 1 / 350) j++;
    corners.push({ a: i, b: j, sign });
    i = j + 1;
  }
  for (let c = corners.length - 2; c >= 0; c--) {
    const A = corners[c], B = corners[c + 1];
    if (A.sign === B.sign && S[B.a] - S[A.b] < 20) { A.b = B.b; corners.splice(c + 1, 1); }
  }
  const notes = [];
  for (const C of corners) {
    const angle = Math.abs(h[C.b] - h[C.a]) * 180 / Math.PI;
    if (angle < 14) continue;
    let ap = C.a, kmax = 0; for (let q = C.a; q <= C.b; q++) if (Math.abs(k[q]) > kmax) { kmax = Math.abs(k[q]); ap = q; }
    const R = 1 / Math.max(kmax, 1e-6), len = S[C.b] - S[C.a];
    let vApex = Infinity; for (let q = C.a; q <= C.b; q++) vApex = Math.min(vApex, vGrip[q]);
    let vBefore = 0; for (let q = C.a; q >= 0 && S[C.a] - S[q] < 200; q--) vBefore = Math.max(vBefore, vLine[q]);
    const dir = C.sign > 0 ? 'L' : 'R';
    let type = 'grade', g = grade(vApex);
    if (angle >= 135 && R < 22) type = 'HP';
    else if (angle >= 70 && angle <= 115 && R < 18 && len < 32) type = 'SQ';
    else if (angle < 30 && vApex * KMH >= 108) type = 'K';
    const mods = [];
    if (type !== 'HP' && type !== 'K') { if (len > 160) mods.push('vlong'); else if (len > 80 || angle > 110) mods.push('long'); }
    const third = Math.max(1, Math.floor((C.b - C.a) / 3));
    const k1 = avgAbs(k, C.a, C.a + third), k3 = avgAbs(k, C.b - third, C.b);
    if (type !== 'HP' && type !== 'SQ' && len > 25) { if (k3 > 1.45 * k1) mods.push('tightens'); else if (k1 > 1.45 * k3) mods.push('opens'); }
    let crest = 0, dip = 0; for (let q = C.a; q <= C.b; q++) { crest = Math.min(crest, kvs[q]); dip = Math.max(dip, kvs[q]); }
    if (crest < -0.006) mods.push('crest'); else if (dip > 0.01) mods.push('dip');
    const drop = vApex / Math.max(vBefore, 1);
    const caution = vBefore < 20 ? 0 : drop < 0.45 ? 2 : drop < 0.6 ? 1 : 0;
    notes.push({ s: S[C.a], sEnd: S[C.b], i: C.a, dir, type, g, angle, R, len, vApex, mods, caution });
  }
  // crests / dips / bumps on the straights between corners
  const inCorner = new Uint8Array(n); for (const c of notes) for (let q = c.i; q < n && S[q] <= c.sEnd; q++) inCorner[q] = 1;
  let q = 0;
  while (q < n) {
    if (inCorner[q] || Math.abs(kvs[q]) < 0.008) { q++; continue; }
    const sg = Math.sign(kvs[q]); let r = q; while (r < n - 1 && Math.sign(kvs[r + 1]) === sg && Math.abs(kvs[r + 1]) > 0.004 && !inCorner[r + 1]) r++;
    const len = S[r] - S[q], v = vLine[q];
    const kind = sg < 0 ? (v * v * Math.abs(kvs[q]) > 0.75 * 9.81 ? 'jump' : len < 18 ? 'bump' : 'crest') : 'dip';
    notes.push({ s: S[q], sEnd: S[r], i: q, type: 'hazard', hazard: kind, mods: [], caution: kind === 'jump' ? 1 : 0, vApex: v });
    q = r + 1;
  }
  notes.sort((a, b) => a.s - b.s);
  // distances to the next call
  for (let c = 0; c < notes.length; c++) {
    const nx = notes[c + 1];
    notes[c].next = nx ? niceDist(nx.s - notes[c].sEnd) : 'finish';
    notes[c].text = shorthand(notes[c]);
    notes[c].words = spoken(notes[c]);
  }
  return notes;
}

function smooth(a, sig) {
  const r = Math.ceil(sig * 2.5), w = []; for (let k = -r; k <= r; k++) w.push(Math.exp(-k * k / (2 * sig * sig)));
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { let s = 0, t = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j < 0 || j >= a.length) continue; s += a[j] * w[k + r]; t += w[k + r]; } o[i] = s / t; }
  return o;
}
function avgAbs(a, i, j) { let s = 0, c = 0; for (let q = i; q <= j; q++) { s += Math.abs(a[q]); c++; } return s / Math.max(c, 1); }

// shorthand as written in a notebook: "L4 long < 100", "HP R ! into", "/\ crest 50"
export function shorthand(nt) {
  const parts = [];
  if (nt.type === 'hazard') parts.push({ crest: '/\\ crest', jump: '/\\ JUMP', bump: '~ bump', dip: '\\/ dip' }[nt.hazard]);
  else if (nt.type === 'HP') parts.push(`HP ${nt.dir}`);
  else if (nt.type === 'SQ') parts.push(`SQ ${nt.dir}`);
  else if (nt.type === 'K') parts.push(`K${nt.dir}`);
  else parts.push(`${nt.dir}${nt.g}`);
  for (const m of nt.mods) parts.push({ long: 'long', vlong: 'v.long', tightens: '<', opens: '>', crest: 'over /\\', dip: 'in \\/' }[m]);
  if (nt.caution) parts.push('!'.repeat(nt.caution));
  parts.push(nt.next === 'into' ? '+' : nt.next === 'finish' ? '| finish' : nt.next);
  return parts.join(' ');
}

// what the co-driver says
export function spoken(nt) {
  const w = [];
  if (nt.caution === 2) w.push('caution');
  if (nt.type === 'hazard') w.push({ crest: 'crest', jump: 'jump', bump: 'bump', dip: 'dip' }[nt.hazard]);
  else if (nt.type === 'HP') w.push(`hairpin ${nt.dir === 'L' ? 'left' : 'right'}`);
  else if (nt.type === 'SQ') w.push(`square ${nt.dir === 'L' ? 'left' : 'right'}`);
  else if (nt.type === 'K') w.push(`kink ${nt.dir === 'L' ? 'left' : 'right'}`);
  else w.push(`${nt.dir === 'L' ? 'left' : 'right'} ${WORD[nt.g]}`);
  for (const m of nt.mods) w.push({ long: 'long', vlong: 'very long', tightens: 'tightens', opens: 'opens', crest: 'over crest', dip: 'dip' }[m]);
  if (nt.caution === 1) w.push('caution');
  if (nt.next !== 'finish') w.push(NUMWORD(nt.next));
  return w.join(' ');
}

// The co-driver's recorded vocabulary: every call is stitched from these clips, the way rally games
// cut a co-driver's session into samples. Key -> what gets recorded (public/codriver/<key>.mp3,
// made by tools/codriver.mjs). Calls carry their own intonation, so "left four" is one clip, not two.
const LONGDIST = { 1100: 'eleven hundred', 1200: 'twelve hundred', 1300: 'thirteen hundred', 1400: 'fourteen hundred', 1500: 'fifteen hundred', 1600: 'sixteen hundred', 1700: 'seventeen hundred', 1800: 'eighteen hundred', 1900: 'nineteen hundred', 2000: 'two thousand' };
export const VOICE_TEXT = (() => {
  const v = {};
  for (const [d, side] of [['L', 'left'], ['R', 'right']]) {
    for (let g = 1; g <= 6; g++) v[`${d}${g}`] = `${side} ${WORD[g]}`;
    v[`HP${d}`] = `hairpin ${side}`; v[`SQ${d}`] = `square ${side}`; v[`K${d}`] = `kink ${side}`;
  }
  Object.assign(v, { crest: 'crest', jump: 'jump', bump: 'bump', dip: 'dip', long: 'long', vlong: 'very long', tightens: 'tightens',
    opens: 'opens', overcrest: 'over crest', caution: 'caution', into: 'into', finish: 'to finish' });
  for (const n of [20, 30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 1000]) v[`d${n}`] = NUMWORD(n);
  for (const [n, w] of Object.entries(LONGDIST)) v[`d${n}`] = w;
  return v;
})();
// the clips for one note, in the order spoken() says them
export function voiceTokens(nt) {
  const t = [];
  if (nt.caution === 2) t.push('caution');
  if (nt.type === 'hazard') t.push(nt.hazard);
  else if (nt.type === 'HP' || nt.type === 'SQ' || nt.type === 'K') t.push(`${nt.type}${nt.dir}`);
  else t.push(`${nt.dir}${nt.g}`);
  for (const m of nt.mods) t.push(m === 'crest' ? 'overcrest' : m);
  if (nt.caution === 1) t.push('caution');
  if (nt.next === 'finish') t.push('finish');
  else if (nt.next === 'into') t.push('into');
  else { const d = Number(nt.next); t.push(`d${d > 2000 ? 2000 : d}`); }
  return t;
}

// the symbol: a curved arrow whose sharpness follows the grade, with the number inside, plus small
// marks for the modifiers. Returns an SVG string (used by the printable notes and the HUD).
export function glyph(nt, size = 64) {
  const s = size, cx = s / 2, stroke = Math.max(2.5, s / 18);
  let path, label = '';
  const mirror = nt.dir === 'L' ? 1 : -1;
  if (nt.type === 'hazard') {
    const shapes = { crest: `M ${s * 0.15} ${s * 0.65} L ${cx} ${s * 0.3} L ${s * 0.85} ${s * 0.65}`, jump: `M ${s * 0.15} ${s * 0.7} L ${cx} ${s * 0.25} L ${s * 0.85} ${s * 0.7} M ${cx - 6} ${s * 0.15} L ${cx} ${s * 0.05} L ${cx + 6} ${s * 0.15}`,
      bump: `M ${s * 0.1} ${s * 0.6} Q ${s * 0.3} ${s * 0.3} ${cx} ${s * 0.6} Q ${s * 0.7} ${s * 0.3} ${s * 0.9} ${s * 0.6}`, dip: `M ${s * 0.15} ${s * 0.35} L ${cx} ${s * 0.7} L ${s * 0.85} ${s * 0.35}` };
    return `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}"><path d="${shapes[nt.hazard]}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  // arrow from bottom centre turning by an angle that grows as the grade gets tighter
  const turn = nt.type === 'HP' ? 180 : nt.type === 'SQ' ? 90 : nt.type === 'K' ? 20 : [0, 150, 120, 95, 70, 50, 32][nt.g];
  const r = s * (nt.type === 'HP' ? 0.18 : nt.type === 'SQ' ? 0.05 : 0.12 + (nt.g || 6) * 0.06);
  const x0 = cx, y0 = s * 0.92, up = s * (nt.type === 'HP' ? 0.32 : 0.28);
  const a = turn * Math.PI / 180;
  const ccx = x0 - mirror * r, ccy = y0 - up;                         // centre of the turning arc
  const ex = ccx + mirror * r * Math.cos(a), ey = ccy - r * Math.sin(a);
  const large = turn > 180 ? 1 : 0, sweep = nt.dir === 'L' ? 0 : 1;
  path = `M ${x0} ${y0} L ${x0} ${ccy} A ${r} ${r} 0 ${large} ${sweep} ${ex} ${ey}`;
  // arrow head along the exit tangent
  const tx = -mirror * Math.sin(a), ty = -Math.cos(a), hl = s * 0.13;
  const hx1 = ex - tx * hl + ty * hl * 0.6 * mirror, hy1 = ey - ty * hl - tx * hl * 0.6 * mirror;
  const hx2 = ex - tx * hl - ty * hl * 0.6 * mirror, hy2 = ey - ty * hl + tx * hl * 0.6 * mirror;
  label = nt.type === 'HP' ? 'HP' : nt.type === 'SQ' ? 'SQ' : nt.type === 'K' ? 'K' : String(nt.g);
  const marks = [];
  if (nt.mods.includes('long') || nt.mods.includes('vlong')) marks.push(`<line x1="${s * 0.12}" y1="${s * 0.08}" x2="${s * 0.88}" y2="${s * 0.08}" stroke="currentColor" stroke-width="${stroke * 0.7}"/>`);
  if (nt.mods.includes('vlong')) marks.push(`<line x1="${s * 0.12}" y1="${s * 0.15}" x2="${s * 0.88}" y2="${s * 0.15}" stroke="currentColor" stroke-width="${stroke * 0.7}"/>`);
  if (nt.mods.includes('tightens')) marks.push(`<text x="${s * 0.05}" y="${s * 0.55}" font-size="${s * 0.3}" font-weight="700" fill="currentColor">&lt;</text>`);
  if (nt.mods.includes('opens')) marks.push(`<text x="${s * 0.05}" y="${s * 0.55}" font-size="${s * 0.3}" font-weight="700" fill="currentColor">&gt;</text>`);
  if (nt.mods.includes('crest')) marks.push(`<path d="M ${s * 0.62} ${s * 0.98} L ${s * 0.78} ${s * 0.84} L ${s * 0.94} ${s * 0.98}" fill="none" stroke="currentColor" stroke-width="${stroke * 0.7}"/>`);
  if (nt.caution) marks.push(`<text x="${s * 0.8}" y="${s * 0.5}" font-size="${s * 0.34}" font-weight="900" fill="#d22">${'!'.repeat(nt.caution)}</text>`);
  const lx = nt.dir === 'L' ? s * 0.72 : s * 0.28;
  return `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round"/>` +
    `<path d="M ${hx1} ${hy1} L ${ex} ${ey} L ${hx2} ${hy2}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="${lx}" y="${s * 0.86}" text-anchor="middle" font-size="${s * (label.length > 1 ? 0.24 : 0.34)}" font-weight="800" fill="currentColor">${label}</text>${marks.join('')}</svg>`;
}

// in-game co-driver: shows the next calls and (optionally) reads them out ahead of time.
// voice: a CoDriverVoice (recorded clips); without one, or if its clips fail to load, the browser's
// speechSynthesis reads the words instead.
const LEAD_S = 3.4;        // start reading a call this many seconds before the car reaches it
const MAX_QUEUE = 1.1;     // never queue more than this much speech ahead, so calls can't lag the road
export class CoDriver {
  constructor(notes, el, voice = null) { this.notes = notes; this.el = el; this.voice = voice; this.mode = 'off'; this.idx = 0; this.spokenUpTo = -1; this.said = []; }
  setMode(m) { this.mode = m; this.el.hidden = m === 'off'; if (m !== 'voice') this.hush(); }
  reset(s) {
    this.hush();
    this.idx = 0; while (this.idx < this.notes.length && this.notes[this.idx].s < s) this.idx++;
    this.spokenUpTo = this.idx - 1; this.lastHtml = '';
  }
  // stop talking (menu opened, restart); calls cut off mid-sentence get read again afterwards
  hush() {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (this.voice?.clips) {
      const now = this.voice.engine.ctx.currentTime, cut = this.said.find(c => c.end > now);
      if (cut) this.spokenUpTo = Math.min(this.spokenUpTo, cut.q - 1);
      this.voice.stop();
    }
    this.said = [];
  }
  update(s, v) {
    if (this.mode === 'off') return;
    while (this.idx < this.notes.length && this.notes[this.idx].sEnd < s - 5) this.idx++;
    const up = this.notes.slice(this.idx, this.idx + 3);
    const html = up.map((nt, k) => `<div class="note${k ? ' later' : ''}">${glyph(nt, k ? 40 : 56)}<span>${nt.text}</span></div>`).join('');
    if (html !== this.lastHtml) { this.el.innerHTML = html; this.lastHtml = html; }
    if (this.mode !== 'voice') return;
    if (this.voice && !this.voice.failed) { if (this.voice.ready()) this.speakClips(s, v); }
    else this.speakSynth(s, v);
  }
  speakClips(s, v) {
    const V = this.voice, lead = Math.max(80, v * LEAD_S), now = V.engine.ctx.currentTime;
    this.said = this.said.filter(c => c.end > now);
    while (V.backlog() < MAX_QUEUE) {
      let q = Math.max(this.idx, this.spokenUpTo + 1);
      // a call for a corner the car is already into (or about to be) is no use: skip it
      while (q < this.notes.length && this.notes[q].s < s + v * 0.7) q++;
      if (q >= this.notes.length || this.notes[q].s - s > lead) break;
      const nt = this.notes[q], tokens = voiceTokens(nt);
      // talk faster when the call would otherwise finish late (dense sections at speed)
      const spare = (nt.s - s) / Math.max(v, 1) - V.backlog() - V.length(tokens);
      const rate = v < 5 ? 1 : 1 + 0.16 * Math.min(1, Math.max(0, (1.6 - spare) / 1.2));
      this.said.push({ q, end: V.say(tokens, rate) });
      this.spokenUpTo = q;
    }
  }
  speakSynth(s, v) {
    if (typeof speechSynthesis === 'undefined') return;
    const lead = Math.max(70, v * 3.2);
    for (let q = Math.max(this.idx, this.spokenUpTo + 1); q < this.notes.length && this.notes[q].s - s < lead; q++) {
      const u = new SpeechSynthesisUtterance(this.notes[q].words); u.rate = 1.25; u.pitch = 1.0;
      speechSynthesis.speak(u); this.spokenUpTo = q;
    }
  }
}
