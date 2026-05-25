import { AudioDirector } from './AudioDirector';

export class AudioSettingsPanel {
  private readonly muteButton: HTMLButtonElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly volumeValue: HTMLSpanElement;

  constructor(private readonly root: HTMLDivElement, private readonly audio: AudioDirector) {
    this.root.innerHTML = `
      <button type="button" data-audio-mute aria-label="Toggle audio"></button>
      <input type="range" min="0" max="100" step="1" data-audio-volume aria-label="Audio volume" />
      <span data-audio-value></span>
    `;

    this.muteButton = this.query('[data-audio-mute]');
    this.volumeSlider = this.query('[data-audio-volume]');
    this.volumeValue = this.query('[data-audio-value]');

    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.addEventListener('click', (event) => event.stopPropagation());

    this.muteButton.addEventListener('click', () => {
      this.audio.toggleMuted();
      this.sync();
    });

    this.volumeSlider.addEventListener('input', () => {
      const volume = Number(this.volumeSlider.value) / 100;
      this.audio.setVolume(volume);
      if (volume > 0 && this.audio.getSettings().muted) this.audio.setMuted(false);
      this.sync();
    });

    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      if (event.code === 'KeyM') {
        this.audio.toggleMuted();
        this.sync();
      }
      if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
        this.adjustVolume(-0.08);
      }
      if (event.code === 'Equal' || event.code === 'NumpadAdd') {
        this.adjustVolume(0.08);
      }
    });

    this.setVisible(true);
    this.sync();
  }

  setVisible(visible: boolean) {
    this.root.classList.toggle('visible', visible);
  }

  private adjustVolume(delta: number) {
    const settings = this.audio.getSettings();
    const next = clamp(settings.volume + delta, 0, 1);
    this.audio.setVolume(next);
    if (next > 0 && settings.muted) this.audio.setMuted(false);
    this.sync();
  }

  private sync() {
    const settings = this.audio.getSettings();
    const percent = Math.round(settings.volume * 100);
    this.root.classList.toggle('muted', settings.muted);
    this.muteButton.textContent = settings.muted ? 'MUTED' : 'SOUND';
    this.volumeSlider.value = String(percent);
    this.volumeValue.textContent = `${percent}%`;
  }

  private query<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Audio setting element missing: ${selector}`);
    return element;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
