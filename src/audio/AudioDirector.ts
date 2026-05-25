import type { CombatEvent, HudState, InputSnapshot } from '../game/types';

type OscillatorShape = OscillatorType;

const VOLUME_KEY = 'dronepvp.audioVolume';
const MUTED_KEY = 'dronepvp.audioMuted';
const DEFAULT_VOLUME = 0.72;

export type AudioSettings = {
  volume: number;
  muted: boolean;
};

export class AudioDirector {
  private context?: AudioContext;
  private master?: GainNode;
  private noiseBuffer?: AudioBuffer;
  private volume = readVolume();
  private muted = readMuted();
  private lastMissileStatus = '';
  private lastIncoming = '';
  private lastBoostPulseAt = 0;
  private lastWarningAt = 0;

  async resume() {
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === 'suspended') await context.resume();
    this.playStartup();
  }

  getSettings(): AudioSettings {
    return {
      volume: this.volume,
      muted: this.muted,
    };
  }

  setVolume(volume: number) {
    this.volume = clamp(volume, 0, 1);
    localStorage.setItem(VOLUME_KEY, this.volume.toFixed(2));
    this.applyMasterGain();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    this.applyMasterGain();
  }

  toggleMuted() {
    this.setMuted(!this.muted);
  }

  pushEvents(events: CombatEvent[]) {
    if (!this.isLive()) return;

    for (const event of events) {
      if (event.kind === 'muzzle') this.playLaser(event.color);
      if (event.kind === 'hit') this.playHit(event.scale);
      if (event.kind === 'spark') this.playSpark();
      if (event.kind === 'launch') this.playLaunch(event.text);
      if (event.kind === 'explosion') this.playExplosion(event.scale, event.text);
      if (event.kind === 'pickup') this.playPickup(event.text);
    }
  }

  update(state: HudState, input: InputSnapshot) {
    if (!this.isLive()) return;
    const context = this.context;
    if (!context) return;

    if (state.missileStatus !== this.lastMissileStatus) {
      if (state.missileStatus === 'LOCKING') this.playLockStart();
      if (state.missileStatus === 'MISSILE READY') this.playLockReady();
      this.lastMissileStatus = state.missileStatus;
    }

    if (state.incomingWarning && (state.incomingWarning !== this.lastIncoming || context.currentTime > this.lastWarningAt + 0.62)) {
      this.playIncoming();
      this.lastIncoming = state.incomingWarning;
      this.lastWarningAt = context.currentTime;
    }
    if (!state.incomingWarning) this.lastIncoming = '';

    if (input.boost && state.boostRatio > 0.02 && context.currentTime > this.lastBoostPulseAt + 0.14) {
      this.playBoostPulse(state.velocity);
      this.lastBoostPulseAt = context.currentTime;
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;

    const context = new AudioContext({ latencyHint: 'interactive' });
    const master = context.createGain();
    master.gain.value = this.getOutputGain();
    master.connect(context.destination);

    this.context = context;
    this.master = master;
    this.noiseBuffer = createNoiseBuffer(context);
    return context;
  }

  private applyMasterGain() {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.linearRampToValueAtTime(this.getOutputGain(), context.currentTime + 0.05);
  }

  private getOutputGain(): number {
    return this.muted ? 0 : this.volume * 0.58;
  }

  private isLive(): boolean {
    return this.context?.state === 'running' && !!this.master;
  }

  private playStartup() {
    this.playTone(220, 520, 0.12, 'triangle', 0.08);
    this.playTone(440, 880, 0.16, 'sine', 0.06, 0.04);
  }

  private playLaser(color: number) {
    const friendly = color === 0x7cfffb;
    this.playTone(friendly ? 880 : 520, friendly ? 260 : 180, 0.09, 'sawtooth', friendly ? 0.045 : 0.032, 0.004);
    this.playNoise(0.045, friendly ? 0.025 : 0.018, 2400, 'highpass');
  }

  private playHit(scale: number) {
    this.playNoise(0.08, 0.05 * Math.min(scale, 1.6), 1800, 'bandpass');
    this.playTone(170, 90, 0.08, 'square', 0.035);
  }

  private playSpark() {
    this.playNoise(0.07, 0.035, 3600, 'highpass');
  }

  private playLaunch(text?: string) {
    const incoming = text === 'INCOMING MISSILE';
    this.playTone(incoming ? 170 : 210, incoming ? 60 : 120, 0.18, 'sawtooth', incoming ? 0.075 : 0.055);
    this.playNoise(0.16, incoming ? 0.055 : 0.04, incoming ? 900 : 1200, 'lowpass');
    if (text === 'ACE INTERCEPTOR DEPLOYED') {
      this.playTone(95, 190, 0.42, 'sawtooth', 0.08, 0.02);
      this.playTone(285, 570, 0.42, 'triangle', 0.05, 0.04);
    }
  }

  private playExplosion(scale: number, text?: string) {
    const amount = Math.min(scale / 3, 1.4);
    this.playTone(92, 34, 0.34, 'sine', 0.12 * amount, 0.006);
    this.playNoise(0.42, 0.11 * amount, 520, 'lowpass');
    if (text?.startsWith('ACE DOWN')) this.playPickup('COMBO x3');
    if (text === 'YOU WERE DESTROYED' || text === 'COLLISION FATAL' || text === 'ROUND LOST') {
      this.playTone(320, 80, 0.52, 'sawtooth', 0.08, 0.02);
    }
    if (text === 'ROUND WON') {
      this.playVictory();
    }
  }

  private playPickup(text?: string) {
    const comboMatch = text?.match(/^COMBO x(\d+)/);
    if (comboMatch) {
      const combo = Number(comboMatch[1]);
      const base = 440 + combo * 35;
      this.playTone(base, base * 1.5, 0.12, 'triangle', 0.06);
      this.playTone(base * 1.25, base * 2, 0.16, 'sine', 0.045, 0.03);
      return;
    }

    if (text === 'OVERDRIVE CORE') {
      this.playTone(260, 740, 0.24, 'sawtooth', 0.075);
      this.playTone(520, 1040, 0.24, 'triangle', 0.045, 0.04);
      return;
    }

    if (text === 'REPAIR CORE') {
      this.playTone(330, 660, 0.16, 'sine', 0.06);
      this.playTone(495, 880, 0.16, 'triangle', 0.04, 0.03);
      return;
    }

    if (text === 'MISSILE CORE') {
      this.playTone(190, 570, 0.14, 'square', 0.05);
      this.playTone(570, 760, 0.11, 'triangle', 0.035, 0.04);
      return;
    }

    this.playTone(360, 720, 0.14, 'triangle', 0.05);
  }

  private playLockStart() {
    this.playTone(440, 550, 0.08, 'sine', 0.028);
  }

  private playLockReady() {
    this.playTone(680, 680, 0.08, 'square', 0.045);
    this.playTone(1020, 1020, 0.1, 'sine', 0.035, 0.04);
  }

  private playIncoming() {
    this.playTone(760, 460, 0.12, 'square', 0.075);
    this.playTone(380, 230, 0.12, 'sawtooth', 0.05, 0.02);
  }

  private playBoostPulse(velocity: number) {
    const speedScale = Math.min(velocity / 110, 1);
    this.playNoise(0.08, 0.018 + speedScale * 0.016, 260 + speedScale * 460, 'lowpass');
  }

  private playVictory() {
    this.playTone(392, 392, 0.1, 'triangle', 0.055);
    this.playTone(523, 523, 0.12, 'triangle', 0.055, 0.12);
    this.playTone(784, 784, 0.18, 'triangle', 0.06, 0.26);
  }

  private playTone(startFrequency: number, endFrequency: number, duration: number, type: OscillatorShape, gainValue: number, delay = 0) {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + delay;
    const end = start + duration;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), end);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  private playNoise(duration: number, gainValue: number, frequency: number, filterType: BiquadFilterType) {
    const context = this.context;
    const master = this.master;
    const noiseBuffer = this.noiseBuffer;
    if (!context || !master || !noiseBuffer) return;

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const start = context.currentTime;
    const end = start + duration;

    source.buffer = noiseBuffer;
    source.playbackRate.value = 0.75 + Math.random() * 0.5;
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = filterType === 'bandpass' ? 8 : 0.8;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(end + 0.02);
  }
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 1;
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  return buffer;
}

function readVolume(): number {
  const stored = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(stored) ? clamp(stored, 0, 1) : DEFAULT_VOLUME;
}

function readMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
