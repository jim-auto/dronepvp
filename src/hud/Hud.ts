import type { CombatEvent, HudState, TargetMarker } from '../game/types';

type FeedItem = {
  id: string;
  text: string;
  scoreValue: number;
  ttl: number;
};

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly hpFill: HTMLSpanElement;
  private readonly boostFill: HTMLSpanElement;
  private readonly missileFill: HTMLSpanElement;
  private readonly lockFill: HTMLSpanElement;
  private readonly target: HTMLDivElement;
  private readonly enemies: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly speed: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly markerHp: HTMLSpanElement;
  private readonly markerDistance: HTMLDivElement;
  private readonly missileStatus: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private readonly respawnWarning: HTMLDivElement;
  private readonly roundStatus: HTMLDivElement;
  private readonly roundScore: HTMLDivElement;
  private readonly roundDeaths: HTMLDivElement;
  private readonly threat: HTMLDivElement;
  private readonly combo: HTMLDivElement;
  private readonly perk: HTMLDivElement;
  private readonly network: HTMLDivElement;
  private readonly networkScoreboard: HTMLDivElement;
  private readonly incomingWarning: HTMLDivElement;
  private readonly screenFlash: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly resultTitle: HTMLDivElement;
  private readonly resultSummary: HTMLDivElement;
  private readonly resultRestart: HTMLDivElement;
  private readonly pausePanel: HTMLDivElement;
  private readonly inputBoost: HTMLDivElement;
  private readonly inputFire: HTMLDivElement;
  private readonly inputMissile: HTMLDivElement;
  private readonly sensitivity: HTMLDivElement;
  private readonly feedItems: FeedItem[] = [];
  private screenFlashTtl = 0;
  private screenFlashTone: 'win' | 'loss' = 'win';

  constructor(root: HTMLDivElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="reticle"></div>
      <div class="target">
        <div data-target></div>
        <div data-enemies></div>
        <div data-score></div>
      </div>
      <div class="round-panel">
        <div data-round-status></div>
        <div data-round-score></div>
        <div data-round-deaths></div>
        <div data-threat></div>
        <div data-combo></div>
        <div data-perk></div>
        <div data-network></div>
        <div data-network-scoreboard></div>
      </div>
      <div class="event-feed" data-feed></div>
      <div class="respawn-warning" data-respawn-warning></div>
      <div class="incoming-warning" data-incoming-warning></div>
      <div class="screen-flash" data-screen-flash></div>
      <div class="result-panel" data-result>
        <div data-result-title></div>
        <div data-result-summary></div>
        <div data-result-restart></div>
      </div>
      <div class="pause-panel" data-pause>
        <div>CONTROL LINK PAUSED</div>
        <div>Click to resume flight</div>
      </div>
      <div class="target-marker" data-marker>
        <div class="target-box"></div>
        <div class="target-hp"><span data-marker-hp></span></div>
        <div class="target-distance" data-marker-distance></div>
      </div>
      <div class="status">
        <div class="readout">HP</div>
        <div class="bar hp"><span data-hp></span></div>
        <div class="readout" data-speed></div>
        <div class="bar boost"><span data-boost></span></div>
        <div class="readout" data-missile-status></div>
        <div class="weapon-row">
          <div class="bar missile"><span data-missile></span></div>
          <div class="bar lock"><span data-lock></span></div>
        </div>
        <div class="input-row">
          <span data-input-boost>BOOST</span>
          <span data-input-fire>LASER</span>
          <span data-input-missile>MISSILE</span>
        </div>
        <div class="readout" data-sensitivity></div>
      </div>
      <div class="message" data-message></div>
    `;

    this.hpFill = this.query('[data-hp]');
    this.boostFill = this.query('[data-boost]');
    this.missileFill = this.query('[data-missile]');
    this.lockFill = this.query('[data-lock]');
    this.target = this.query('[data-target]');
    this.enemies = this.query('[data-enemies]');
    this.score = this.query('[data-score]');
    this.speed = this.query('[data-speed]');
    this.message = this.query('[data-message]');
    this.marker = this.query('[data-marker]');
    this.markerHp = this.query('[data-marker-hp]');
    this.markerDistance = this.query('[data-marker-distance]');
    this.missileStatus = this.query('[data-missile-status]');
    this.feed = this.query('[data-feed]');
    this.respawnWarning = this.query('[data-respawn-warning]');
    this.roundStatus = this.query('[data-round-status]');
    this.roundScore = this.query('[data-round-score]');
    this.roundDeaths = this.query('[data-round-deaths]');
    this.threat = this.query('[data-threat]');
    this.combo = this.query('[data-combo]');
    this.perk = this.query('[data-perk]');
    this.network = this.query('[data-network]');
    this.networkScoreboard = this.query('[data-network-scoreboard]');
    this.incomingWarning = this.query('[data-incoming-warning]');
    this.screenFlash = this.query('[data-screen-flash]');
    this.result = this.query('[data-result]');
    this.resultTitle = this.query('[data-result-title]');
    this.resultSummary = this.query('[data-result-summary]');
    this.resultRestart = this.query('[data-result-restart]');
    this.pausePanel = this.query('[data-pause]');
    this.inputBoost = this.query('[data-input-boost]');
    this.inputFire = this.query('[data-input-fire]');
    this.inputMissile = this.query('[data-input-missile]');
    this.sensitivity = this.query('[data-sensitivity]');
  }

  pushEvents(events: CombatEvent[]) {
    for (const event of events) {
      if (!event.text) continue;
      this.feedItems.unshift({
        id: event.id,
        text: event.text,
        scoreValue: event.scoreValue ?? 0,
        ttl: 2.2,
      });
      if (event.text === 'ROUND WON' || event.text === 'NEW ROUND') {
        this.screenFlashTtl = 0.5;
        this.screenFlashTone = 'win';
      }
      if (event.text === 'ROUND LOST' || event.text === 'YOU WERE DESTROYED' || event.text === 'COLLISION FATAL') {
        this.screenFlashTtl = 0.45;
        this.screenFlashTone = 'loss';
      }
    }

    this.feedItems.splice(4);
  }

  render(state: HudState, marker: TargetMarker | undefined, dt: number) {
    this.hpFill.style.width = `${Math.round(state.hpRatio * 100)}%`;
    this.boostFill.style.width = `${Math.round(state.boostRatio * 100)}%`;
    this.missileFill.style.width = `${Math.round(state.missileCooldownRatio * 100)}%`;
    this.lockFill.style.width = `${Math.round(state.missileLockRatio * 100)}%`;
    this.target.textContent = state.lockName;
    this.enemies.textContent = `${state.enemyCount} hostile drones active`;
    this.score.textContent = `score ${state.score}/${state.scoreGoal}`;
    this.roundStatus.textContent = state.roundStatus;
    this.roundScore.textContent = `kills ${state.score}/${state.scoreGoal}`;
    this.roundDeaths.textContent = `hulls ${state.deathLimit - state.playerDeaths}/${state.deathLimit}`;
    this.threat.textContent = state.threatLabel;
    this.threat.style.opacity = `${0.62 + state.threatLevel * 0.38}`;
    this.combo.textContent = state.comboLabel;
    this.perk.textContent = state.perkLabel;
    this.network.textContent = state.networkStatus;
    this.networkScoreboard.textContent = state.networkScoreboard;
    this.speed.textContent = `BOOST · ${Math.round(state.velocity)} m/s`;
    this.missileStatus.textContent = state.missileStatus;
    this.inputBoost.classList.toggle('active', state.inputBoost);
    this.inputFire.classList.toggle('active', state.inputFire);
    this.inputMissile.classList.toggle('active', state.inputMissile);
    this.sensitivity.textContent = `MOUSE ${state.sensitivity.toFixed(1)}x  [ / ]`;
    this.pausePanel.classList.toggle('visible', !state.controlsLocked && state.roundPhase === 'playing');
    this.message.textContent = state.message;
    this.respawnWarning.textContent = state.respawnWarning;
    this.incomingWarning.textContent = state.incomingWarning;
    this.incomingWarning.classList.toggle('visible', state.incomingWarning.length > 0);
    this.renderScreenFlash(dt);
    this.renderFeed(dt);
    this.renderResult(state);
    this.renderTargetMarker(marker);
    this.marker.classList.toggle('locked', state.missileLockRatio >= 1);
  }

  private renderFeed(dt: number) {
    for (let i = this.feedItems.length - 1; i >= 0; i -= 1) {
      this.feedItems[i].ttl -= dt;
      if (this.feedItems[i].ttl <= 0) this.feedItems.splice(i, 1);
    }

    this.feed.innerHTML = this.feedItems
      .map((item) => `<div class="feed-item">${item.text}${item.scoreValue > 0 ? `<span>+${item.scoreValue}</span>` : ''}</div>`)
      .join('');
  }

  private renderScreenFlash(dt: number) {
    this.screenFlashTtl = Math.max(0, this.screenFlashTtl - dt);
    this.screenFlash.classList.toggle('loss', this.screenFlashTone === 'loss');
    this.screenFlash.style.opacity = `${Math.min(this.screenFlashTtl * 1.7, 0.55)}`;
  }

  private renderResult(state: HudState) {
    const showing = state.roundPhase !== 'playing';
    this.result.classList.toggle('visible', showing);
    if (!showing) return;

    this.result.classList.toggle('loss', state.roundPhase === 'lost');
    this.resultTitle.textContent = state.roundResultTitle;
    this.resultSummary.textContent = state.roundResultSummary;
    this.resultRestart.textContent = `Next round in ${Math.ceil(state.roundRestart)}`;
  }

  private renderTargetMarker(marker?: TargetMarker) {
    if (!marker) {
      this.marker.classList.remove('visible', 'offscreen');
      return;
    }

    this.marker.classList.add('visible');
    this.marker.classList.toggle('offscreen', !marker.visible);
    this.marker.style.transform = `translate(${Math.round(marker.x)}px, ${Math.round(marker.y)}px)`;
    this.markerHp.style.width = `${Math.round(marker.hpRatio * 100)}%`;
    this.markerDistance.textContent = `${Math.round(marker.distance)} m`;
  }

  private query<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`HUD element missing: ${selector}`);
    return element;
  }
}
