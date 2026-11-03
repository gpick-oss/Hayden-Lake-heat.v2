// EJ25 boxer through unequal-length headers, turbo, and a straight pipe, synthesised per sample.
//
// The rumble: firing order 1-3-2-4 is evenly spaced (180 deg), but the unequal-length headers make
// the exhaust pulses reach the collector in uneven pairs, so the exhaust has a strong half-order
// "burble". Those pulses then ring a ~2.7 m open pipe (no muffler) and get clipped by the pressure
// wave into the raspy straight-pipe tone. Turbo whistle, an atmospheric blow-off valve on lift-off,
// and overrun pops (tuned) sit on top.

const TAU = Math.PI * 2;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  bandpass(f, q) {
    const w = TAU * f / sampleRate, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - al) / a0;
  }
  lowpass(f, q) {
    const w = TAU * f / sampleRate, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  highpass(f, q) {
    const w = TAU * f / sampleRate, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}

class Boxer extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 850, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, automationRate: 'k-rate' },
      { name: 'interior', defaultValue: 0, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.theta = 0;
    // collector arrival angles (crank deg) for cylinders 1,3,2,4: paired, not evenly spaced
    this.ev = [0, 222, 360, 576];
    this.amp = [1.0, 0.74, 0.93, 0.8];
    this.nextEv = 0;
    this.pulses = [];
    this.comb = new Float32Array(8192); this.ci = 0; this.combLp = 0;
    this.comb2 = new Float32Array(8192); this.ci2 = 0; this.comb2Lp = 0;
    this.lp = 0; this.hpPrev = 0; this.hpOut = 0; this.int1 = 0; this.int2 = 0; this.dc = 0; this.dcOut = 0;
    this.boom = new Biquad(); this.boom.bandpass(88, 1.4);
    this.mid = new Biquad(); this.mid.bandpass(420, 1.1);
    this.induct = new Biquad(); this.induct.bandpass(650, 2.0);
    // blow-off valve: piston crack ("chu") + vented charge air hiss ("pssshh") whose pitch falls with pressure
    this.bovCrack = new Biquad(); this.bovCrack.bandpass(1100, 1.8);
    this.bovHp = new Biquad(); this.bovHp.highpass(1800, 0.7);
    this.bovRes = new Biquad(); this.bovRes.bandpass(5000, 1.6);
    this.bovRes2 = new Biquad(); this.bovRes2.bandpass(2600, 2.4);
    this.bov = 0; this.bovT = 9; this.bovTau = 0.3;
    this.spoolF = new Biquad(); this.spoolF.bandpass(3200, 2.2);
    this.popF = new Biquad(); this.popF.lowpass(3200, 0.8);
    this.wPhase = 0;
    this.popEnv = 0; this.thump = 0; this.thumpPh = 0; this.overrun = 0; this.lastLoad = 0;
    this.seed = 22222;
    this.port.onmessage = (e) => {
      const m = e.data;
      // more boost in the pipes = louder and longer vent
      if (m.type === 'bov') { const k = Math.min(1, m.strength); this.bov = 0.45 + 0.75 * k; this.bovT = 0; this.bovTau = 0.16 + 0.34 * k; }
      if (m.type === 'bang') this.pop(1.6);
    };
  }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647 * 2 - 1; }
  pop(k) { this.popEnv = Math.max(this.popEnv, k); this.thump = Math.max(this.thump, k * 0.8); this.thumpPh = 0; }

  process(_in, outputs, P) {
    const out = outputs[0][0];
    const rpm = Math.max(300, P.rpm[0]), load = P.load[0], boost = P.boost[0], cut = P.cut[0] > 0.5, interior = P.interior[0];
    const sr = sampleRate;
    const degPerSample = rpm / 60 * 360 / sr;
    // pipe: ~2.7 m turbo-back straight pipe, open end (inverting reflection)
    const D = Math.round(2 * 2.7 / 343 * sr), D2 = Math.round(2 * 1.15 / 343 * sr);
    const shapeFc = 700 + 2200 * load + rpm * 0.15;
    const lpA = Math.exp(-TAU * shapeFc / sr);
    const drive = 1.4 + 3.2 * load + boost * 0.8;
    const intA = Math.exp(-TAU * (16000 - 14200 * interior) / sr);
    const hpA = Math.exp(-TAU * 1800 / sr);
    // overrun: tuned map keeps a little fuel on decel -> crackles while revs are up
    if (this.lastLoad > 0.4 && load < 0.05 && rpm > 3000) this.overrun = 1.6;
    this.lastLoad = load;
    const blockT = out.length / sr;
    this.overrun = Math.max(0, this.overrun - blockT * (load > 0.1 ? 8 : 0.9));
    this.mid.bandpass(260 + rpm * 0.06, 1.2);
    // vent pitch sweeps down as the charge pressure bleeds off
    const bovOn = this.bovT < this.bovTau * 7;
    if (bovOn) { const pr = Math.exp(-this.bovT / this.bovTau); this.bovRes.bandpass(2800 + 3600 * pr, 1.6); this.bovRes2.bandpass(1700 + 1300 * pr, 2.4); }

    for (let n = 0; n < out.length; n++) {
      // --- crank & firing events
      const prev = this.theta;
      this.theta += degPerSample;
      if (this.theta >= 720) this.theta -= 720;
      const e = this.ev[this.nextEv];
      const crossed = this.nextEv === 0 ? (this.theta < prev) : (prev < e && this.theta >= e);
      if (crossed) {
        const cyl = this.nextEv;
        this.nextEv = (this.nextEv + 1) % 4;
        const fire = !cut || this.rnd() > 0.65;
        if (fire) {
          const a = (0.28 + 0.72 * load + 0.15 * rpm / 7000) * this.amp[cyl] * (1 + 0.06 * this.rnd());
          this.pulses.push({ t: 0, a, tau: (0.00045 + 0.0004 * (1 - load)) * sr, nz: 0.35 + 0.5 * load });
        } else if (this.rnd() > 0.3) this.pop(0.9);            // limiter: unburnt fuel lights in the pipe
        if (this.overrun > 0 && load < 0.05 && rpm > 2600 && this.rnd() > 0.55 - 0.25 * Math.min(1, this.overrun)) this.pop(0.35 + 0.6 * Math.random() * Math.min(1, this.overrun));
      }

      // --- exhaust pulse excitation
      let exc = 0;
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const p = this.pulses[k], x = p.t / p.tau;
        exc += p.a * (x * Math.exp(1 - x) + p.nz * this.rnd() * Math.exp(-x * 0.5));
        if (++p.t > p.tau * 12) this.pulses.splice(k, 1);
      }
      // pops: sharp broadband crack + low thump
      if (this.popEnv > 0.001) { exc += this.popF.step(this.rnd()) * this.popEnv * 3.2; this.popEnv *= 0.9965; }
      let thump = 0;
      if (this.thump > 0.001) { this.thumpPh += TAU * 62 / sr; thump = Math.sin(this.thumpPh) * this.thump; this.thump *= 0.9988; }

      // --- pipe
      this.lp = (1 - lpA) * exc + lpA * this.lp;
      const d1 = this.comb[(this.ci - D + 8192) & 8191];
      this.combLp += 0.42 * (d1 - this.combLp);
      const pipe = this.lp - 0.58 * this.combLp;
      this.comb[this.ci] = pipe; this.ci = (this.ci + 1) & 8191;
      const d2 = this.comb2[(this.ci2 - D2 + 8192) & 8191];
      this.comb2Lp += 0.5 * (d2 - this.comb2Lp);
      const pipe2 = pipe - 0.35 * this.comb2Lp;
      this.comb2[this.ci2] = pipe2; this.ci2 = (this.ci2 + 1) & 8191;

      let sig = pipe2 * 0.9 + this.boom.step(pipe2) * 2.4 + this.mid.step(pipe2) * 0.8 + thump;
      // straight-pipe rasp: the pressure wave clips
      const sat = Math.tanh(sig * drive);
      this.hpOut = hpA * (this.hpOut + sat - this.hpPrev); this.hpPrev = sat;
      let o = sat * 0.75 + this.hpOut * (0.25 + 0.45 * load);

      // --- induction
      o += this.induct.step(this.rnd()) * (0.05 + 0.14 * load) * (0.6 + 0.4 * Math.min(1, exc * 2));

      // --- cabin: muffled, less hiss
      this.int1 = (1 - intA) * o + intA * this.int1;
      this.int2 = (1 - intA) * this.int1 + intA * this.int2;

      // --- turbo (mixed after the cabin filter: it sits right behind the firewall, you hear it inside)
      // whistle rises with shaft speed; a second partial and a slow wobble keep it from sounding like a test tone
      const wf = 1700 + 7400 * boost;
      this.wPhase += TAU * wf / sr; if (this.wPhase > TAU) this.wPhase -= TAU;
      this.w2Phase = (this.w2Phase || 0) + TAU * wf * 1.51 / sr; if (this.w2Phase > TAU) this.w2Phase -= TAU;
      const wob = 1 + 0.12 * Math.sin(this.wPhase * 0.0021);
      let turbo = (Math.sin(this.wPhase) + 0.35 * Math.sin(this.w2Phase)) * 0.3 * boost * (0.4 + 0.6 * load) * wob;
      // spool: rushing air through the compressor, louder as boost builds
      turbo += this.spoolF.step(this.rnd()) * 0.5 * boost * (0.3 + 0.7 * load);
      // blow-off valve: throttle snaps shut at boost, the piston cracks open and dumps the charge to air
      if (bovOn) {
        const t = this.bovT, z = this.rnd();
        const crack = Math.exp(-t / 0.018) * (1 - Math.exp(-t / 0.0015));
        const hiss = (1 - Math.exp(-t / 0.006)) * Math.exp(-t / this.bovTau) * (1 + 0.15 * this.rnd());
        const air = this.bovHp.step(z);
        turbo += this.bov * (this.bovCrack.step(z) * crack * 3.2 + (air * 0.55 + this.bovRes.step(air) * 2.2 + this.bovRes2.step(air) * 1.1) * hiss);
        this.bovT += 1 / sr;
      }
      const mix = this.int2 + turbo * (1 - 0.2 * interior);
      // DC block + soft limiter
      this.dcOut = mix - this.dc + 0.995 * this.dcOut; this.dc = mix;
      out[n] = Math.tanh(this.dcOut * 0.9) * 0.8;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('boxer-engine', Boxer);
