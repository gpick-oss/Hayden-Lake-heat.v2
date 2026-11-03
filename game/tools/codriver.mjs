// Record the co-driver's vocabulary with Piper (offline neural TTS) into public/codriver/<key>.mp3.
//   cd game && node tools/codriver.mjs            (only missing clips)
//   cd game && node tools/codriver.mjs --all      (re-record everything)
// PIPER / PIPER_VOICE override the binary and voice model (default: the JB OS install, British "alan").
// Silence is trimmed here and again in the game, so clips butt up against each other when stitched.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { VOICE_TEXT } from '../src/paceNotes.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '../public/codriver');
const PIPER = process.env.PIPER || path.join(os.homedir(), '.local/share/jb/piper-venv/bin/piper');
const VOICE = process.env.PIPER_VOICE || path.join(os.homedir(), '.local/share/jb/voices/en_GB-alan-medium.onnx');
const LENGTH_SCALE = '0.74';   // co-drivers talk fast; below ~0.7 Piper starts swallowing consonants
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codriver-'));

const all = process.argv.includes('--all');
const todo = Object.entries(VOICE_TEXT).filter(([k]) => all || !fs.existsSync(path.join(OUT, `${k}.mp3`)));
// trim both ends at -42 dB, then a touch of compression + peak level so every clip sits at the same loudness
const AF = 'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.01,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.03,areverse,' +
  'acompressor=threshold=-18dB:ratio=3:attack=5:release=60,alimiter=limit=0.89:level=disabled';

async function one([key, text]) {
  const wav = path.join(tmp, `${key}.wav`);
  const p = run(PIPER, ['-m', VOICE, '--length-scale', LENGTH_SCALE, '-f', wav]);
  p.child.stdin.end(text + '\n');
  await p;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', AF, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', path.join(OUT, `${key}.mp3`)]);
  console.log(`${key.padEnd(10)} ${text}`);
}
// a few at a time: each Piper run loads the model, so it's mostly CPU-bound startup
const queue = todo.slice();
await Promise.all(Array.from({ length: Math.min(4, os.cpus().length) }, async () => { while (queue.length) await one(queue.shift()); }));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${todo.length} clip(s) recorded -> public/codriver/ (${Object.keys(VOICE_TEXT).length} in the vocabulary)`);
