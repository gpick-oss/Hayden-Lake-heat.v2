// Synthesised engine, tyre squeal and impact sounds (no audio files needed).
export class Engine {
  constructor() { this.ctx = null; this.on = true; }
  start() {
    if (this.ctx) return;
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(ctx.destination);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 2;
    this.filt = filt;
    this.eg = ctx.createGain(); this.eg.gain.value = 0.2;
    filt.connect(this.eg).connect(this.master);
    this.oscs = [[1, 'sawtooth', 0.5], [0.5, 'square', 0.35], [2, 'triangle', 0.15]].map(([mul, type, g]) => {
      const o = ctx.createOscillator(); o.type = type; const gg = ctx.createGain(); gg.gain.value = g;
      o.connect(gg).connect(filt); o.start(); return { o, mul };
    });
    // noise source for tyres/gravel
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    this.squealF = ctx.createBiquadFilter(); this.squealF.type = 'bandpass'; this.squealF.frequency.value = 1400; this.squealF.Q.value = 6;
    this.squealG = ctx.createGain(); this.squealG.gain.value = 0;
    this.gravelF = ctx.createBiquadFilter(); this.gravelF.type = 'lowpass'; this.gravelF.frequency.value = 500;
    this.gravelG = ctx.createGain(); this.gravelG.gain.value = 0;
    noise.connect(this.squealF).connect(this.squealG).connect(this.master);
    noise.connect(this.gravelF).connect(this.gravelG).connect(this.master);
    noise.start();
    this.noiseBuf = buf;
  }
  toggle() { this.on = !this.on; if (this.master) this.master.gain.value = this.on ? 0.35 : 0; }
  update(rpm, throttle, slip, surface, speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = rpm / 60 * 2; // 4-cyl: two firings per rev
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.03);
    this.filt.frequency.setTargetAtTime(500 + rpm * 0.25 + throttle * 900, t, 0.05);
    this.eg.gain.setTargetAtTime(0.12 + throttle * 0.18, t, 0.05);
    const sq = surface === 'road' ? Math.max(0, slip - 0.12) * 1.4 : 0;
    this.squealG.gain.setTargetAtTime(Math.min(0.35, sq) * Math.min(1, speed / 6), t, 0.05);
    this.gravelG.gain.setTargetAtTime(surface !== 'road' ? Math.min(0.5, speed / 30) : 0, t, 0.08);
  }
  thud(k) {
    if (!this.ctx) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    const g = this.ctx.createGain(); const t = this.ctx.currentTime;
    g.gain.setValueAtTime(k * 1.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.5);
  }
}
