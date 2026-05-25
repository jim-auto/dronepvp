import './style.css';
import { GameWorld } from './game/GameWorld';
import { InputController } from './game/InputController';
import { Hud } from './hud/Hud';
import { DroneRenderer } from './rendering/DroneRenderer';
import { getNetworkUrl, NetworkClient } from './network/NetworkClient';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const hudRoot = document.querySelector<HTMLDivElement>('#hud');
const startScreen = document.querySelector<HTMLDivElement>('#start-screen');

if (!canvas || !hudRoot || !startScreen) {
  throw new Error('DronePvP boot failed: missing DOM mount points.');
}

const input = new InputController(canvas);
const world = new GameWorld();
const renderer = new DroneRenderer(canvas, world);
const hud = new Hud(hudRoot);
const network = new NetworkClient(getNetworkUrl());
const startOverlay = startScreen;
let started = false;

function startGame() {
  started = true;
  lastTime = performance.now();
  startOverlay.classList.add('hidden');
  input.requestPointerLock();
}

startOverlay.addEventListener('click', startGame);
canvas.addEventListener('click', () => {
  if (!input.isLocked) input.requestPointerLock();
});

let lastTime = performance.now();

function frame(now: number) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  const snapshot = input.consumeFrame();
  if (started) {
    world.update(dt, snapshot);
    for (const action of world.drainNetworkActions()) {
      network.sendAction(action);
    }
    network.update(dt, world.player);
    world.applyNetworkPlayerState(network.getLocalPeer());
    world.applyRemotePeers(network.getRemotePeers());
    world.applyRemoteProjectiles(network.getRemoteProjectiles());
  }
  const events = [...world.drainEvents(), ...network.drainCombatEvents()];
  hud.pushEvents(events);
  renderer.render(dt, snapshot, events);
  const hudState = world.getHudState(snapshot, network.getStatusLabel(), network.getScoreboardLabel());
  const pvpRoundStatus = network.getRoundStatusLabel();
  const pvpRoundResult = network.getRoundResult();
  if (pvpRoundStatus) {
    hudState.roundStatus = pvpRoundStatus;
  }
  if (pvpRoundResult) {
    hudState.roundPhase = pvpRoundResult.phase;
    hudState.roundResultTitle = pvpRoundResult.title;
    hudState.roundResultSummary = pvpRoundResult.summary;
    hudState.roundRestart = pvpRoundResult.restartIn;
  } else if (pvpRoundStatus) {
    hudState.roundPhase = 'playing';
  }
  hud.render(hudState, renderer.getTargetMarker(), dt);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
