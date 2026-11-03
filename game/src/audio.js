// Engine (AudioWorklet boxer synth) plus tyre, wind, gravel and impact sounds.
export class Engine {
  constructor() { this.ctx = null; this.on = true; this.ready = false; }
  async start() {
    if (this.ctx) return;
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain(); this.master.gain.value = 0.55; this.master.connect(ctx.destination);
    await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(ctx, 'boxer-engine', { outputChannelCount: [2] });
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0.9;
    this.node.connect(this.engGain).connect(this.master);
    this.p = Object.fromEntries(['rpm', 'load', 'boost', 'cut', 'interior'].map(k => [k, this.node.parameters.get(k)]));

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    const chain = (type, f, q) => { const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; noise.connect(fl).connect(g).connect(this.master); return { fl, g }; };
    this.squeal = chain('bandpass', 1100, 7);   // race tyres at the limit: a low howl rather than a shriek
    this.gravel = chain('lowpass', 600, 0.7);
    this.wind = chain('bandpass', 500, 0.5);
    this.road = chain('lowpass', 180, 0.7);
    this.ready = true;
  }
  toggle() { this.on = !this.on; if (this.master) this.master.gain.value = this.on ? 0.55 : 0; }
  event(type, strength = 1) { if (this.ready) this.node.port.postMessage({ type, strength }); }
  update(car, interior) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, sp = car.speed();
    this.p.rpm.setTargetAtTime(car.rpm, t, 0.01);
    this.p.load.setTargetAtTime(car.load, t, 0.02);
    this.p.boost.setTargetAtTime(car.boost, t, 0.03);
    this.p.cut.setValueAtTime(car.cut ? 1 : 0, t);
    this.p.interior.setTargetAtTime(interior ? 1 : 0, t, 0.05);
    this.engGain.gain.setTargetAtTime(interior ? 0.75 : 0.95, t, 0.1);
    const onRoad = car.surface === 'road';
    this.squeal.g.gain.setTargetAtTime(onRoad ? Math.min(0.22, car.slip * 0.35) : 0, t, 0.05);
    this.squeal.fl.frequency.setTargetAtTime(900 + car.slip * 500, t, 0.1);
    this.gravel.g.gain.setTargetAtTime(onRoad ? 0 : Math.min(0.45, sp / 25), t, 0.08);
    this.wind.g.gain.setTargetAtTime(Math.min(0.25, (sp / 60) ** 2) * (interior ? 0.5 : 1), t, 0.2);
    this.wind.fl.frequency.setTargetAtTime(300 + sp * 12, t, 0.2);
    this.road.g.gain.setTargetAtTime(Math.min(0.12, sp / 300), t, 0.2);
  }
  thud(k) {
    if (!this.ready) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    const g = this.ctx.createGain(); const t = this.ctx.currentTime;
    g.gain.setValueAtTime(k * 1.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.5);
  }
}
