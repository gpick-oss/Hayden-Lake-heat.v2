// Options / pause menu. Esc (or the pad's Start button) opens it and pauses the run.
// Up/Down pick a row, Left/Right change it, Enter runs an action. Mouse works too.
const ON_OFF = [[true, 'On'], [false, 'Off']];

export class Menu {
  constructor({ root, getSettings, change, action, checkpoints, sectionBest }) {
    this.root = root; this.getSettings = getSettings; this.change = change; this.action = action;
    this.cps = checkpoints; this.sectionBest = sectionBest;
    this.sel = 0; this.isOpen = false;
    root.addEventListener('click', (e) => {
      const row = e.target.closest('[data-row]'); if (!row) return;
      this.sel = Number(row.dataset.row);
      if (e.target.closest('[data-dir]')) this.step(Number(e.target.closest('[data-dir]').dataset.dir));
      else if (this.rows()[this.sel]?.action) this.activate();
      else this.step(1);
    });
  }

  rows() {
    const s = this.getSettings(), n = this.cps.length;   // cps: [0, 1000, ..., length]
    const cpName = (i) => (i === 0 ? 'Start' : i === n - 1 ? 'Finish' : `CP ${i}`);
    const rows = [
      { key: 'mode', label: 'Mode', options: [['fast', 'FAST — day, ghost cars, no traffic'], ['irl', 'IRL — night, contact, traffic, deer'], ['custom', 'Custom']] },
      { key: 'session', label: 'Session', options: [['stage', 'Full stage'], ['section', 'Section practice']] },
    ];
    if (s.session === 'section') {
      rows.push({ key: 'sectionFrom', label: 'Section from', options: Array.from({ length: n - 1 }, (_, i) => [i, `${cpName(i)}  (${(this.cps[i] / 1609.34).toFixed(2)} mi)`]) });
      rows.push({ key: 'sectionTo', label: 'Section to', options: Array.from({ length: n - 1 }, (_, i) => [i + 1, `${cpName(i + 1)}  (${(this.cps[i + 1] / 1609.34).toFixed(2)} mi)`]) });
    }
    rows.push(
      { key: 'direction', label: 'Direction', options: [['forward', 'Start → Finish'], ['reverse', 'Finish → Start']] },
      { key: 'time', label: 'Time of day', options: [['day', 'Day'], ['night', 'Night']] },
      { key: 'rivals', label: 'AI rivals', options: [['off', 'Off'], ['easy', 'Easy (leader 21:30)'], ['fast', 'Fast (leader 19:00)'], ['pro', 'Pro (leader 16:30)'], ['alien', 'Alien (leader 14:48)']] },
      { key: 'collisions', label: 'Car collisions', options: [[true, 'On'], [false, 'Off (ghost cars)']] },
      { key: 'traffic', label: 'Random traffic', options: [['off', 'Off'], ['light', 'Light'], ['normal', 'Normal'], ['heavy', 'Heavy']] },
      { key: 'deer', label: 'Deer crossings', options: ON_OFF.slice().reverse() },
      { key: 'line', label: 'Racing line', options: [[0, 'Off'], [1, 'Full'], [2, 'Braking zones only']] },
      { key: 'notes', label: 'Pace notes', options: [['off', 'Off'], ['voice', 'On screen + co-driver reads them'], ['text', 'On screen only']] },
      { key: 'cockpitFov', label: 'Cockpit field of view', options: [70, 75, 80, 82, 85, 90, 95, 100].map(v => [v, `${v}°`]) },
      { key: 'gearbox', label: 'Gearbox', options: [['auto', 'Automatic'], ['manual', 'Manual (E/Q)']] },
      { key: 'quality', label: 'Graphics quality', options: [[0, 'Low'], [1, 'Medium'], [2, 'High']] },
      { action: 'resume', label: 'Resume' },
      { action: 'restart', label: 'Restart run' },
      { action: 'notes', label: 'Open printable pace notes' },
    );
    return rows;
  }

  open() { this.isOpen = true; this.root.hidden = false; this.render(); }
  close() { this.isOpen = false; this.root.hidden = true; }
  toggle() { this.isOpen ? this.close() : this.open(); }

  step(dir) {
    const row = this.rows()[this.sel]; if (!row || row.action) return;
    const s = this.getSettings(), opts = row.options;
    let i = opts.findIndex(([v]) => v === s[row.key]); if (i < 0) i = 0;
    i = (i + dir + opts.length) % opts.length;
    this.change(row.key, opts[i][0]);
    this.render();
  }
  activate() { const row = this.rows()[this.sel]; if (row?.action) this.action(row.action); else this.step(1); this.render(); }

  key(code) {
    if (!this.isOpen) return false;
    const n = this.rows().length;
    if (code === 'ArrowUp' || code === 'KeyW') this.sel = (this.sel - 1 + n) % n;
    else if (code === 'ArrowDown' || code === 'KeyS') this.sel = (this.sel + 1) % n;
    else if (code === 'ArrowLeft' || code === 'KeyA') this.step(-1);
    else if (code === 'ArrowRight' || code === 'KeyD') this.step(1);
    else if (code === 'Enter' || code === 'Space') this.activate();
    else return false;
    this.render();
    return true;
  }

  render() {
    if (!this.isOpen) return;
    const s = this.getSettings(), rows = this.rows();
    this.sel = Math.min(this.sel, rows.length - 1);
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    let html = '<div class="menu-title">Options</div><div class="menu-rows">';
    rows.forEach((r, i) => {
      const cls = 'menu-row' + (i === this.sel ? ' sel' : '') + (r.action ? ' action' : '');
      if (r.action) { html += `<div class="${cls}" data-row="${i}">${esc(r.label)}</div>`; return; }
      const cur = r.options.find(([v]) => v === s[r.key]) || r.options[0];
      html += `<div class="${cls}" data-row="${i}"><span class="menu-label">${esc(r.label)}</span>` +
        `<span class="menu-val"><b data-dir="-1">‹</b> ${esc(cur[1])} <b data-dir="1">›</b></span></div>`;
    });
    html += '</div>';
    if (s.session === 'section') {
      const b = this.sectionBest(s.sectionFrom, s.sectionTo);
      html += `<div class="menu-foot">Best for this section: <b>${b == null ? 'none yet' : b}</b></div>`;
    }
    html += '<div class="menu-foot">↑↓ choose · ←→ change · Enter select · Esc close</div>';
    html += '<div class="menu-foot credits">Map data © OpenStreetMap contributors (ODbL) · Overture Maps Foundation · Meta &amp; WRI canopy heights (CC BY 4.0) · USGS 3DEP lidar and NAIP imagery</div>';
    this.root.innerHTML = html;
    this.root.querySelector('.menu-row.sel')?.scrollIntoView({ block: 'nearest' });
  }
}
