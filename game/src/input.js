// Keyboard (arrows / WASD, space = handbrake) and gamepad (standard mapping).
export class Input {
  constructor() {
    this.keys = new Set(); this.prev = new Set(); this.edge = new Set();
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, analog: false };
    this.kSteer = 0;
    addEventListener('keydown', (e) => { if (!e.repeat) this.edge.add(e.code); this.keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  pressed(code) { return this.pressedNow.has(code); }
  poll() {
    this.pressedNow = this.edge; this.edge = new Set();
    const k = (...c) => c.some(x => this.keys.has(x));
    const left = k('ArrowLeft', 'KeyA'), right = k('ArrowRight', 'KeyD');
    const s = this.state;
    s.steer = (left ? 1 : 0) - (right ? 1 : 0);
    s.throttle = k('ArrowUp', 'KeyW') ? 1 : 0;
    s.brake = k('ArrowDown', 'KeyS') ? 1 : 0;
    s.handbrake = k('Space');
    s.analog = false;
    const pad = navigator.getGamepads?.().find(p => p && p.connected);
    if (pad) {
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.08) { s.steer = -Math.sign(ax) * ((Math.abs(ax) - 0.08) / 0.92) ** 1.4; s.analog = true; }
      const rt = pad.buttons[7]?.value || 0, lt = pad.buttons[6]?.value || 0;
      if (rt > 0.05) s.throttle = rt;
      if (lt > 0.05) s.brake = lt;
      if (pad.buttons[0]?.pressed || pad.buttons[2]?.pressed) s.handbrake = true;
      const b = (i, code) => { const on = pad.buttons[i]?.pressed; if (on && !this.prev.has(code)) this.pressedNow.add(code); on ? this.prev.add(code) : this.prev.delete(code); };
      b(3, 'KeyR'); b(1, 'KeyC'); b(9, 'Enter'); b(5, 'KeyE'); b(4, 'KeyQ'); b(8, 'KeyT'); b(12, 'KeyL'); b(13, 'KeyK');
    }
  }
}
