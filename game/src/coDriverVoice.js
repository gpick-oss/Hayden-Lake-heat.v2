// Co-driver voice: the recorded clips in public/codriver (tools/codriver.mjs) stitched into calls on
// the Web Audio clock, through a helmet-intercom filter, with the engine ducked a little while he talks.
// No dependence on the browser's speechSynthesis (silent on Linux without speech-dispatcher).
import { VOICE_TEXT } from './paceNotes.js';

const WORD_GAP = 0.02;    // between clips inside one call ("left four" | "long" | "one hundred")
const CALL_GAP = 0.1;     // a breath between calls

export class CoDriverVoice {
  constructor(engine) { this.engine = engine; this.clips = null; this.loading = null; this.failed = false; this.playing = new Set(); this.endT = 0; }

  // the AudioContext only exists after the first key/click, so loading starts on the first call after that
  ready() {
    if (this.clips) return true;
    if (!this.loading && this.engine.ready) this.loading = this.load().catch((e) => { console.warn('co-driver voice unavailable:', e); this.failed = true; });
    return false;
  }

  async load() {
    const ctx = this.engine.ctx;
    const entries = await Promise.all(Object.keys(VOICE_TEXT).map(async (k) => {
      const r = await fetch(`codriver/${k}.mp3`);
      if (!r.ok) throw new Error(`codriver/${k}.mp3: ${r.status}`);
      const buf = await ctx.decodeAudioData(await r.arrayBuffer());
      return [k, { buf, ...trim(buf) }];
    }));
    // intercom: band-limited with a presence lift, compressed so it cuts through the straight pipe
    const f = (type, freq, q, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; b.Q.value = q; b.gain.value = gain; return b; };
    const hp = f('highpass', 240, 0.7), pres = f('peaking', 2600, 0.9, 5), lp = f('lowpass', 5400, 0.7);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    this.out = ctx.createGain(); this.out.gain.value = 1.15;
    hp.connect(pres).connect(lp).connect(comp).connect(this.out).connect(this.engine.master);
    this.in = hp;
    this.clips = Object.fromEntries(entries);
  }

  // seconds of speech still queued
  backlog() { return this.clips ? Math.max(0, this.endT - this.engine.ctx.currentTime) : 0; }
  // how long a call takes to say at this rate
  length(tokens, rate = 1) { let t = 0; for (const k of tokens) if (this.clips[k]) t += this.clips[k].d / rate + WORD_GAP; return t; }

  // queue one call after whatever is already queued; returns when it finishes (AudioContext time)
  say(tokens, rate = 1) {
    const ctx = this.engine.ctx;
    let t = Math.max(ctx.currentTime + 0.02, this.endT + CALL_GAP);
    for (const k of tokens) {
      const c = this.clips[k];
      if (!c) continue;
      const src = ctx.createBufferSource();
      src.buffer = c.buf; src.playbackRate.value = rate;
      src.connect(this.in);
      src.start(t, c.a, c.d);                 // offset/duration are in buffer time; the rate shortens it
      this.playing.add(src); src.onended = () => this.playing.delete(src);
      t += c.d / rate + WORD_GAP;
    }
    this.endT = t;
    this.engine.duckUntil = t;
    return t;
  }

  stop() {
    for (const s of this.playing) { try { s.stop(); } catch { } }
    this.playing.clear(); this.endT = 0; this.engine.duckUntil = 0;
  }
}

// skip the leading/trailing near-silence (and the MP3 encoder padding) so clips butt together
function trim(buf) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, th = 0.012;     // ~ -38 dBFS
  let a = 0, b = d.length - 1;
  while (a < b && Math.abs(d[a]) < th) a++;
  while (b > a && Math.abs(d[b]) < th) b--;
  a = Math.max(0, a - Math.round(sr * 0.008)); b = Math.min(d.length, b + Math.round(sr * 0.035));
  return { a: a / sr, d: (b - a) / sr };
}
