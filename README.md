# DronePvP

Browser-based 3D drone combat game built with Vite, TypeScript, and Three.js.

DronePvP is a fast arcade dogfighting prototype set in a neon low-poly city arena. It currently runs as a single-player PvP-style combat arena with enemy drones, collectible combat cores, lock-on missiles, combo scoring, rounds, an ace interceptor phase, and GitHub Pages deployment support.

## Play Locally

```bash
npm install
npm run dev
```

Open the local Vite URL, usually:

```text
http://localhost:5173
```

## Local Multiplayer Server

Start the WebSocket relay server in a second terminal:

```bash
npm run server
```

The local dev client connects automatically to:

```text
ws://localhost:8787
```

Open two browser tabs at `http://localhost:5173/?room=test`, click to deploy in each tab, and each player will appear as a green remote drone in the other tab.

For a deployed GitHub Pages client, pass a hosted WebSocket server URL:

```text
https://yourname.github.io/dronepvp/?server=wss://your-server.example.com
```

Rooms are selected with `room`:

```text
https://yourname.github.io/dronepvp/?room=duel-1&server=wss://your-server.example.com
```

Current multiplayer scope:

- Sends local player transform and HP at 20 Hz.
- Receives remote player snapshots.
- Renders remote players as green drones.
- Separates players by room ID.
- Relays laser and missile fire actions.
- Simulates PvP laser and missile projectiles on the server.
- Broadcasts server projectile snapshots for remote projectile rendering.
- Smooths remote drones and server projectiles with client-side interpolation.
- Applies server-side projectile hit detection, peer damage, and respawn.
- Tracks server-side PvP score and deaths per room.
- Owns PvP round timer, score goal, winner, and restart countdown on the server.
- Broadcasts remote hit, explosion, and kill feed events.
- Shows network status in the HUD.

Current limitation: AI enemies and the single-player arena round still run locally. The PvP round state and PvP projectiles are server-owned when connected.

## Build

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Controls

- WASD: move
- Mouse: aim
- Shift: boost
- Left click: laser
- Right click: lock-on missile
- M: mute / unmute audio
- `-` / `+`: lower / raise audio volume
- Esc: release pointer lock
- Click canvas: resume controls
- `[` / `]`: lower / raise mouse sensitivity

Mouse sensitivity and audio settings are saved in `localStorage`.

## Game Rules

- Score 10 kills to win the round.
- Losing 5 hulls causes defeat.
- Round duration is 3 minutes.
- Chain kills within the combo window to earn boost and missile cooldown rewards.
- Fly through cores to repair, trigger overdrive, or reload missiles.
- The ace interceptor deploys once you build momentum and is worth 2 kills.
- Rounds restart automatically after the result countdown.
- Threat level rises as time passes, score increases, and hulls are lost.

## Current Features

- Third-person high-speed drone movement
- Boost with speed-line and FOV effects
- Laser shooting with muzzle flashes
- Lock-on missiles with charge and reload HUD
- Enemy drones with orbiting, evasion, and obstacle avoidance
- Mid-round ace interceptor with stronger hull, faster movement, and homing missiles
- Collectible repair, overdrive, and missile cores
- Combo streak rewards for fast consecutive kills
- Low-poly cyberpunk city arena
- Building and projectile collision
- HP, respawn, target marker, score, threat, and round HUD
- Damage smoke, hit flashes, explosions, screen flashes, and combat feed
- Procedural WebAudio SFX for lasers, missiles, impacts, explosions, pickups, combos, and warnings
- Persistent mute and volume controls
- HUD punch animations for kill feed and incoming missile alerts
- Result panel and automatic round restart
- Optional WebSocket position sync for remote players
- Client-side interpolation for remote players and PvP projectiles
- GitHub Pages deploy workflow

## Tuning

Most gameplay numbers are centralized in:

```text
src/game/balance.ts
```

Useful values to tune:

- `enemyCount`
- `roundDuration`
- `scoreGoal`
- `deathLimit`
- `comboWindow`
- `player.maxSpeed`
- `player.boostSpeed`
- `player.overdriveDuration`
- `enemy.baseMaxSpeed`
- `enemy.baseFireCooldown`
- `ace.spawnAtScore`
- `powerUps.respawnDelay`
- `weapons.laserDamage`
- `weapons.missileDamage`

## Architecture

- `src/game`: game state, input, math, balance, combat logic
- `src/network`: WebSocket client and remote peer snapshots
- `src/rendering`: Three.js scene, camera, meshes, effects
- `src/hud`: DOM HUD rendering
- `src/main.ts`: bootstrapping and frame loop
- `server`: lightweight WebSocket relay for local or hosted multiplayer tests

Game logic is kept separate from Three.js rendering so future networking or multiplayer synchronization can replace local-only state more easily.

## GitHub Pages

The Vite config uses:

```ts
base: './'
```

This makes the built assets work on GitHub Pages project sites.

Deployment workflow:

```text
.github/workflows/deploy.yml
```

To deploy:

1. Push to the `main` branch.
2. In GitHub repository settings, enable Pages.
3. Set Pages source to GitHub Actions.
4. The workflow builds `dist` and publishes it.
