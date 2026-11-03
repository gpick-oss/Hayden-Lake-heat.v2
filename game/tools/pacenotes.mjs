// Printable pace notes for both directions.
//   cd game && node tools/pacenotes.mjs
// writes public/pacenotes/{forward,reverse}.html (opened from the in-game menu) and
// ../pacenotes/{forward,reverse}.pdf via headless Chromium.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Track } from '../src/track.js';
import { generateNotes, glyph } from '../src/paceNotes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORLD = path.join(here, '../public/world');
const OUT_HTML = path.join(here, '../public/pacenotes');
const OUT_PDF = path.join(here, '../../pacenotes');
fs.mkdirSync(OUT_HTML, { recursive: true }); fs.mkdirSync(OUT_PDF, { recursive: true });

const LEGEND = [
  [{ type: 'grade', dir: 'R', g: 6, mods: [], caution: 0 }, '6', 'fastest grade (just lift)'],
  [{ type: 'grade', dir: 'R', g: 4, mods: [], caution: 0 }, '4', 'medium'],
  [{ type: 'grade', dir: 'R', g: 1, mods: [], caution: 0 }, '1', 'slowest grade'],
  [{ type: 'HP', dir: 'L', mods: [], caution: 0 }, 'HP', 'hairpin / switchback'],
  [{ type: 'SQ', dir: 'R', mods: [], caution: 0 }, 'SQ', 'square (~90°, short)'],
  [{ type: 'K', dir: 'L', mods: [], caution: 0 }, 'K', 'kink — flat out'],
  [{ type: 'grade', dir: 'R', g: 4, mods: ['long'], caution: 0 }, 'long', 'bar over the arrow; two bars = very long'],
  [{ type: 'grade', dir: 'R', g: 4, mods: ['tightens'], caution: 0 }, '<', 'tightens'],
  [{ type: 'grade', dir: 'R', g: 4, mods: ['opens'], caution: 0 }, '>', 'opens'],
  [{ type: 'grade', dir: 'R', g: 4, mods: [], caution: 2 }, '! / !!', 'caution / big caution'],
  [{ type: 'hazard', hazard: 'crest', mods: [] }, '/\\', 'crest (over /\\ = corner on a crest)'],
  [{ type: 'hazard', hazard: 'dip', mods: [] }, '\\/', 'dip'],
  [{ type: 'hazard', hazard: 'bump', mods: [] }, '~', 'bump'],
];

function page(dir, notes, length) {
  const title = dir === 'forward' ? 'Start → Finish (north end to south end)' : 'Finish → Start (south end to north end)';
  const mi = (m) => (m / 1609.34).toFixed(2);
  let rows = '', cp = -1;
  for (const [k, n] of notes.entries()) {
    const sec = Math.floor(n.s / 1000);
    if (sec !== cp) {
      cp = sec;
      const a = sec === 0 ? 'Start' : `CP ${sec}`, b = (sec + 1) * 1000 >= length ? 'Finish' : `CP ${sec + 1}`;
      rows += `<tr class="sec"><td colspan="5">Section ${sec + 1}: ${a} → ${b} &nbsp;·&nbsp; ${mi(sec * 1000)}–${mi(Math.min(length, (sec + 1) * 1000))} mi</td></tr>`;
    }
    rows += `<tr><td class="num">${k + 1}</td><td class="dist">${mi(n.s)}</td><td class="sym">${glyph(n, 44)}</td><td class="short">${esc(n.text)}</td><td class="say">${esc(n.words)}</td></tr>`;
  }
  const legend = LEGEND.map(([nt, sym, what]) => `<div class="leg">${glyph(nt, 34)}<b>${esc(sym)}</b><span>${what}</span></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hayden Lake Run pace notes — ${dir}</title><style>
  @page { size: letter; margin: 12mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; margin: 0; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: #444; }
  .legend { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 14px; border: 1px solid #bbb; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; font-size: 11px; }
  .leg { display: flex; align-items: center; gap: 6px; } .leg b { min-width: 34px; }
  .read { font-size: 11px; color: #333; margin: 0 0 10px; line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { border-bottom: 1px solid #ddd; padding: 2px 6px; vertical-align: middle; }
  tr { break-inside: avoid; }
  tr.sec td { background: #111; color: #fff; font-weight: 700; padding: 5px 8px; border: none; break-after: avoid; }
  td.num { color: #888; width: 26px; text-align: right; } td.dist { width: 52px; font-variant-numeric: tabular-nums; color: #555; }
  td.sym { width: 48px; } td.sym svg { display: block; }
  td.short { font-family: 'Courier New', monospace; font-weight: 700; font-size: 14px; white-space: nowrap; }
  td.say { color: #444; font-size: 11px; }
  @media screen { body { max-width: 900px; margin: 0 auto; } }
</style></head><body>
<h1>Hayden Lake Run — E Hayden Lake Rd pace notes</h1>
<h2>${title} · ${mi(length)} mi · ${notes.length} calls · generated from the lidar-matched road and the car's verified racing line</h2>
<p class="read">Read each line as: <b>corner</b> (direction + grade), <b>modifiers</b>, then the <b>distance to the next call</b> in metres
(<b>+</b> = "into", the next corner follows straight away). Grades come from what the corner allows on grip, 6 fastest to 1 slowest.
Sections match the in-game checkpoints, so you can learn and practise the stage a chunk at a time.</p>
<div class="legend">${legend}</div>
<table>${rows}</table></body></html>`;
}
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

for (const dir of ['forward', 'reverse']) {
  const route = JSON.parse(fs.readFileSync(path.join(WORLD, 'route.json')));
  if (dir === 'reverse') route.pts = route.pts.slice().reverse();
  const track = new Track(route);
  const line = JSON.parse(fs.readFileSync(path.join(WORLD, dir === 'reverse' ? 'racing_line_rev.json' : 'racing_line.json')));
  const notes = generateNotes(track, line);
  const html = page(dir, notes, track.length);
  const file = path.join(OUT_HTML, `${dir}.html`);
  fs.writeFileSync(file, html);
  const pdf = path.join(OUT_PDF, `hayden-lake-pace-notes-${dir}.pdf`);
  execFileSync('/usr/bin/chromium', ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, `file://${file}`], { stdio: 'ignore' });
  console.log(`${dir}: ${notes.length} notes -> ${path.relative(path.join(here, '../..'), file)}, ${path.relative(path.join(here, '../..'), pdf)}`);
}
