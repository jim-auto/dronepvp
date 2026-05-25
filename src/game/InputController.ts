import type { InputSnapshot } from './types';

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private keys = new Set<string>();
  private yawDelta = 0;
  private pitchDelta = 0;
  private shootHeld = false;
  private missilePressed = false;
  private sensitivity = readSensitivity();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (event) => {
      this.keys.add(event.code);
      if (!event.repeat && event.code === 'BracketLeft') this.adjustSensitivity(-0.1);
      if (!event.repeat && event.code === 'BracketRight') this.adjustSensitivity(0.1);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('mousemove', (event) => {
      if (!this.isLocked) return;
      this.yawDelta += event.movementX;
      this.pitchDelta += event.movementY;
    });
    window.addEventListener('mousedown', (event) => {
      if (event.button === 0) this.shootHeld = true;
      if (event.button === 2) this.missilePressed = true;
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 0) this.shootHeld = false;
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.isLocked) return;
      this.shootHeld = false;
      this.missilePressed = false;
    });
    window.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestPointerLock() {
    this.canvas.requestPointerLock();
  }

  consumeFrame(): InputSnapshot {
    const snapshot: InputSnapshot = {
      forward: (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0),
      strafe: (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      boost: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      shoot: this.shootHeld,
      missile: this.missilePressed,
      yawDelta: this.yawDelta * this.sensitivity,
      pitchDelta: this.pitchDelta * this.sensitivity,
      locked: this.isLocked,
      sensitivity: this.sensitivity,
    };

    this.yawDelta = 0;
    this.pitchDelta = 0;
    this.missilePressed = false;

    return snapshot;
  }

  private adjustSensitivity(delta: number) {
    this.sensitivity = clamp(this.sensitivity + delta, 0.4, 2);
    localStorage.setItem('dronepvp.mouseSensitivity', this.sensitivity.toFixed(2));
  }
}

function readSensitivity(): number {
  const stored = Number(localStorage.getItem('dronepvp.mouseSensitivity'));
  return Number.isFinite(stored) ? clamp(stored, 0.4, 2) : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
