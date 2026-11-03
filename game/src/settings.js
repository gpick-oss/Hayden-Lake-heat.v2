// Game settings: defaults, the two presets Gaven asked for, and persistence.
const KEY = 'hr-settings';

export const DEFAULTS = {
  mode: 'fast',            // 'fast' | 'irl' | 'custom'
  direction: 'forward',    // 'forward' (start -> finish) | 'reverse' (finish -> start)
  session: 'stage',        // 'stage' | 'section'
  sectionFrom: 0,          // checkpoint index the section starts at (0 = start line)
  sectionTo: 1,            // checkpoint index it ends at
  time: 'day',             // 'day' | 'night'
  rivals: 'fast',          // 'off' | 'easy' | 'fast' | 'pro' | 'alien'
  collisions: true,
  traffic: 'off',          // 'off' | 'light' | 'normal' | 'heavy'
  deer: false,
  line: 0,                 // 0 off, 1 full, 2 braking zones only
  notes: 'off',            // 'off' | 'text' | 'voice'
  cockpitFov: 82,
  gearbox: 'auto',         // 'auto' | 'manual'
  quality: 1,              // 0 low, 1 medium, 2 high
};

// what each preset pins down; changing one of these afterwards makes the mode "custom"
export const PRESETS = {
  fast: { time: 'day', collisions: false, traffic: 'off', rivals: 'fast', deer: false },
  irl: { time: 'night', collisions: true, traffic: 'normal', rivals: 'fast', deer: true },
};

// top rival's stage time for each AI level (the other two finish a little behind)
export const RIVAL_TIMES = { easy: 21.5 * 60, fast: 19 * 60, pro: 16.5 * 60, alien: 14.8 * 60 };

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  // carry over the separate toggles older versions stored
  try {
    if (s.line === undefined && localStorage.getItem('hr-line') != null) s.line = Number(localStorage.getItem('hr-line')) || 0;
    if (s.collisions === undefined && localStorage.getItem('hr-collide') != null) s.collisions = localStorage.getItem('hr-collide') !== '0';
    if (s.quality === undefined && localStorage.getItem('hr-quality') != null) s.quality = Number(localStorage.getItem('hr-quality')) || 0;
  } catch { }
  const out = { ...DEFAULTS, ...s };
  if (out.mode !== 'custom' && PRESETS[out.mode]) Object.assign(out, PRESETS[out.mode]);
  return out;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { }
}

// apply a change; returns the new settings object (mode flips to custom if a preset value is overridden)
export function changeSetting(s, key, value) {
  const n = { ...s, [key]: value };
  if (key === 'mode') {
    if (PRESETS[value]) Object.assign(n, PRESETS[value]);
  } else if (n.mode !== 'custom' && PRESETS[n.mode] && key in PRESETS[n.mode] && PRESETS[n.mode][key] !== value) {
    n.mode = 'custom';
  }
  if (key === 'sectionFrom' && n.sectionTo <= value) n.sectionTo = value + 1;
  if (key === 'sectionTo' && n.sectionFrom >= value) n.sectionFrom = value - 1;
  return n;
}

// settings that need a page reload (they change what gets built at load)
export const RELOAD_KEYS = new Set(['direction', 'quality']);
// settings that restart the run
export const RESTART_KEYS = new Set(['session', 'sectionFrom', 'sectionTo', 'rivals', 'traffic', 'deer', 'mode']);
