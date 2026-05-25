import {
  add,
  clamp,
  distance,
  dot,
  forwardFromAngles,
  length,
  lerp,
  normalize,
  rightFromYaw,
  scale,
  sub,
  vec3,
  type Vec3,
} from './math';
import { BALANCE } from './balance';
import type { Building, CombatEvent, Drone, DroneId, HudState, InputSnapshot, NetworkAction, PowerUp, Projectile } from './types';
import type { NetworkProjectile, RemotePeer } from '../network/NetworkClient';

const PLAYER_ID = 'player';
const UP = vec3(0, 1, 0);

type RoundState = 'playing' | 'won' | 'lost';

export class GameWorld {
  readonly drones: Drone[] = [];
  readonly projectiles: Projectile[] = [];
  readonly buildings: Building[] = [];
  readonly powerUps: PowerUp[] = [];
  readonly arenaHalfSize = BALANCE.arenaHalfSize;

  private projectileSequence = 0;
  private eventSequence = 0;
  private targetId: DroneId | undefined;
  private elapsed = 0;
  private roundTime = BALANCE.roundDuration;
  private roundState: RoundState = 'playing';
  private roundEndTimer = 0;
  private playerDeaths = 0;
  private comboCount = 0;
  private comboTimer = 0;
  private comboBest = 0;
  private aceSpawned = false;
  private readonly events: CombatEvent[] = [];
  private readonly networkActions: NetworkAction[] = [];

  constructor() {
    this.buildings = createCity();
    this.powerUps = createPowerUps();
    this.drones.push(createDrone(PLAYER_ID, 'You', 'player', vec3(0, 28, -72)));

    for (let i = 0; i < BALANCE.enemyCount; i += 1) {
      const angle = (i / BALANCE.enemyCount) * Math.PI * 2;
      this.drones.push(
        createDrone(
          `enemy-${i}`,
          `Dummy ${i + 1}`,
          'enemy',
          vec3(Math.sin(angle) * 95, 25 + (i % 3) * 11, Math.cos(angle) * 95),
        ),
      );
    }
  }

  get player(): Drone {
    const player = this.drones.find((drone) => drone.id === PLAYER_ID);
    if (!player) throw new Error('Player drone missing.');
    return player;
  }

  get lockedTarget(): Drone | undefined {
    return this.drones.find((drone) => drone.id === this.targetId && drone.respawnTimer <= 0);
  }

  drainEvents(): CombatEvent[] {
    return this.events.splice(0);
  }

  drainNetworkActions(): NetworkAction[] {
    return this.networkActions.splice(0);
  }

  update(dt: number, input: InputSnapshot) {
    this.elapsed += dt;
    this.updateNetworkInterpolation(dt);
    this.updateRound(dt);
    this.updateCombo(dt);
    this.updatePowerUps(dt);
    if (this.roundState !== 'playing') {
      this.updateRespawns(dt);
      this.updateProjectiles(dt);
      return;
    }

    this.updateRespawns(dt);
    this.updatePlayer(dt, input);
    this.collectPowerUps();
    this.maybeSpawnAce();
    this.updateEnemies(dt);
    this.targetId = this.findLockTarget();
    this.updateMissileLock(dt);
    this.updateWeapons(dt, input);
    this.updateProjectiles(dt);
    this.resolveDroneBuildingCollisions();
  }

  applyRemotePeers(peers: RemotePeer[]) {
    const activeIds = new Set(peers.map((peer) => `remote-${peer.id}`));

    for (const peer of peers) {
      const id = `remote-${peer.id}`;
      let drone = this.drones.find((candidate) => candidate.id === id);
      if (!drone) {
        drone = createDrone(id, peer.name, 'remote', vec3(peer.position.x, peer.position.y, peer.position.z));
        this.drones.push(drone);
      }

      drone.name = peer.name;
      drone.targetPosition = { ...peer.position };
      drone.targetVelocity = { ...peer.velocity };
      drone.targetYaw = peer.yaw;
      drone.targetPitch = peer.pitch;
      if (distance(drone.position, drone.targetPosition) > 42) {
        drone.position = { ...drone.targetPosition };
        drone.velocity = { ...drone.targetVelocity };
        drone.yaw = drone.targetYaw;
        drone.pitch = drone.targetPitch;
      }
      drone.hp = peer.hp;
      drone.respawnTimer = 0;
    }

    for (let i = this.drones.length - 1; i >= 0; i -= 1) {
      const drone = this.drones[i];
      if (drone.team === 'remote' && !activeIds.has(drone.id)) this.drones.splice(i, 1);
    }
  }

  applyRemoteProjectiles(projectiles: NetworkProjectile[]) {
    const activeIds = new Set(projectiles.map((projectile) => `remote-projectile-${projectile.id}`));

    for (const remote of projectiles) {
      const id = `remote-projectile-${remote.id}`;
      let projectile = this.projectiles.find((candidate) => candidate.id === id);
      if (!projectile) {
        projectile = {
          id,
          ownerId: `remote-${remote.ownerId}`,
          kind: remote.kind,
          position: { ...remote.position },
          velocity: { ...remote.velocity },
          targetPosition: { ...remote.position },
          targetVelocity: { ...remote.velocity },
          radius: remote.kind === 'missile' ? 1.45 : 0.7,
          damage: 0,
          ttl: 0.2,
          targetId: remote.targetId ? `remote-${remote.targetId}` : undefined,
          isRemote: true,
        };
        this.projectiles.push(projectile);
      }

      projectile.kind = remote.kind;
      projectile.targetPosition = { ...remote.position };
      projectile.targetVelocity = { ...remote.velocity };
      if (distance(projectile.position, projectile.targetPosition) > 35) {
        projectile.position = { ...projectile.targetPosition };
        projectile.velocity = { ...projectile.targetVelocity };
      }
      projectile.ttl = Math.max(remote.ttl, 0.2);
      projectile.targetId = remote.targetId ? `remote-${remote.targetId}` : undefined;
      projectile.isRemote = true;
    }

    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];
      if (projectile.isRemote && !activeIds.has(projectile.id)) this.projectiles.splice(i, 1);
    }
  }

  applyNetworkPlayerState(peer: RemotePeer | undefined) {
    if (!peer) return;
    const player = this.player;
    player.hp = peer.hp;
    if (peer.hp > 0 && player.respawnTimer > 0) {
      player.respawnTimer = 0;
      player.position = peer.position;
      player.velocity = peer.velocity;
    }
  }

  getHudState(input: InputSnapshot, networkStatus = 'NET OFF', networkScoreboard = 'PvP score -'): HudState {
    const player = this.player;
    const target = this.drones.find((drone) => drone.id === this.targetId);
    const deadEnemies = this.drones.filter((drone) => drone.team === 'enemy' && drone.respawnTimer > 0).length;

    return {
      hpRatio: player.hp / player.maxHp,
      boostRatio: player.boost,
      enemyCount: this.drones.filter((drone) => drone.team === 'enemy').length - deadEnemies,
      lockName: target ? target.name : 'No lock',
      velocity: length(player.velocity),
      score: player.score,
      scoreGoal: BALANCE.scoreGoal,
      playerDeaths: this.playerDeaths,
      deathLimit: BALANCE.deathLimit,
      roundTime: Math.max(this.roundTime, 0),
      roundStatus: this.getRoundStatus(),
      roundPhase: this.roundState,
      roundRestart: Math.max(this.roundEndTimer, 0),
      roundResultTitle: this.getRoundResultTitle(),
      roundResultSummary: this.getRoundResultSummary(),
      threatLevel: this.getThreatLevel(),
      threatLabel: this.getThreatLabel(),
      comboLabel: this.getComboLabel(),
      perkLabel: this.getPerkLabel(),
      incomingWarning: this.getIncomingWarning(),
      networkStatus,
      networkScoreboard,
      missileCooldownRatio: 1 - clamp(player.missileCooldown / BALANCE.weapons.missileCooldown, 0, 1),
      missileLockRatio: player.missileLock,
      missileStatus: this.getMissileStatus(),
      controlsLocked: input.locked,
      sensitivity: input.sensitivity,
      inputBoost: input.boost && player.boost > 0.02,
      inputFire: input.shoot,
      inputMissile: input.missile,
      respawnWarning: this.getRespawnWarning(),
      message: player.respawnTimer > 0 ? `Respawn in ${Math.ceil(player.respawnTimer)}` : input.locked ? '' : 'Click to resume controls',
    };
  }

  private updatePlayer(dt: number, input: InputSnapshot) {
    const player = this.player;
    player.hitFlash = Math.max(0, player.hitFlash - dt * 5);
    player.overdriveTimer = Math.max(0, player.overdriveTimer - dt);
    if (player.respawnTimer > 0) return;

    player.yaw -= input.yawDelta * 0.0022;
    player.pitch = clamp(player.pitch - input.pitchDelta * 0.0017, -0.82, 0.72);

    // Movement is input-driven and independent of rendering so networking can replace the local input source later.
    const forward = forwardFromAngles(player.yaw, player.pitch);
    const right = rightFromYaw(player.yaw);
    const desired = normalize(add(scale(forward, input.forward), scale(right, input.strafe)));
    const boosting = input.boost && player.boost > 0.02 && length(desired) > 0;
    const overdriveScale = player.overdriveTimer > 0 ? BALANCE.player.overdriveSpeedScale : 1;
    const accelScale = player.overdriveTimer > 0 ? BALANCE.player.overdriveAccelScale : 1;
    const maxSpeed = (boosting ? BALANCE.player.boostSpeed : BALANCE.player.maxSpeed) * overdriveScale;
    const accel = (boosting ? BALANCE.player.accel * 2.05 : BALANCE.player.accel) * accelScale;

    if (boosting) {
      const drainScale = player.overdriveTimer > 0 ? 0.48 : 1;
      player.boost = clamp(player.boost - dt * BALANCE.player.boostDrain * drainScale, 0, 1);
    } else {
      const rechargeScale = player.overdriveTimer > 0 ? 2.4 : 1;
      player.boost = clamp(player.boost + dt * BALANCE.player.boostRecharge * rechargeScale, 0, 1);
    }

    player.velocity = add(player.velocity, scale(desired, accel * dt));
    const speed = length(player.velocity);
    if (speed > maxSpeed) player.velocity = scale(normalize(player.velocity), maxSpeed);
    const drag = length(desired) > 0 ? 0.15 : 0.045;
    player.velocity = scale(player.velocity, Math.pow(drag, dt));
    player.position = add(player.position, scale(player.velocity, dt));
    this.keepInArena(player);
  }

  private updateNetworkInterpolation(dt: number) {
    const droneT = smoothingFactor(dt, 18);
    const projectileT = smoothingFactor(dt, 28);

    for (const drone of this.drones) {
      if (drone.team !== 'remote' || !drone.targetPosition) continue;
      drone.position = lerpVec3(drone.position, drone.targetPosition, droneT);
      if (drone.targetVelocity) drone.velocity = lerpVec3(drone.velocity, drone.targetVelocity, droneT);
      if (typeof drone.targetYaw === 'number') drone.yaw = lerpAngle(drone.yaw, drone.targetYaw, droneT);
      if (typeof drone.targetPitch === 'number') drone.pitch = lerpAngle(drone.pitch, drone.targetPitch, droneT);
    }

    for (const projectile of this.projectiles) {
      if (!projectile.isRemote || !projectile.targetPosition) continue;
      projectile.position = lerpVec3(projectile.position, projectile.targetPosition, projectileT);
      if (projectile.targetVelocity) projectile.velocity = lerpVec3(projectile.velocity, projectile.targetVelocity, projectileT);
    }
  }

  private updateEnemies(dt: number) {
    const player = this.player;
    const threat = this.getThreatLevel();
    for (const enemy of this.drones) {
      if (enemy.team !== 'enemy' || enemy.respawnTimer > 0) continue;
      const isAce = enemy.variant === 'ace';
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt * 5);
      enemy.evadeTimer = Math.max(0, enemy.evadeTimer - dt);

      const toPlayer = sub(player.position, enemy.position);
      const range = length(toPlayer);
      const toPlayerDir = normalize(toPlayer);
      const orbitSide = enemy.aiPhase > 0.5 ? 1 : -1;
      const orbit = normalize(cross(toPlayerDir, UP));
      const desiredRange = isAce
        ? BALANCE.enemy.desiredRangeMin + 16
        : BALANCE.enemy.desiredRangeMin + enemy.aiPhase * BALANCE.enemy.desiredRangeSpread;
      const rangePressure = clamp((range - desiredRange) / 44, -1, 1);
      const bob = Math.sin(this.elapsed * 1.8 + enemy.aiPhase * Math.PI * 2) * 0.18;
      let desired = normalize(add(add(scale(toPlayerDir, rangePressure), scale(orbit, orbitSide * 0.95)), vec3(0, bob, 0)));

      const incoming = this.findIncomingThreat(enemy);
      if (incoming) {
        enemy.evadeTimer = 0.45;
        desired = normalize(add(scale(desired, 0.35), scale(incoming, 1.35)));
      } else if (enemy.evadeTimer > 0) {
        desired = normalize(add(desired, scale(orbit, orbitSide * 0.75)));
      }

      const obstacleAvoidance = this.findObstacleAvoidance(enemy);
      if (obstacleAvoidance) {
        desired = normalize(add(scale(desired, 0.55), scale(obstacleAvoidance, 1.25)));
      }

      enemy.yaw = Math.atan2(desired.x, desired.z);
      enemy.pitch = Math.asin(clamp(desired.y, -0.75, 0.75));
      const accelScale = isAce ? BALANCE.ace.accelScale + threat * 0.18 : BALANCE.enemy.accelScale + threat * 0.12;
      enemy.velocity = add(enemy.velocity, scale(desired, BALANCE.player.accel * accelScale * dt));
      const speed = length(enemy.velocity);
      const enemyMaxSpeed = (enemy.evadeTimer > 0 ? BALANCE.enemy.evadeMaxSpeed + threat * 4 : BALANCE.enemy.baseMaxSpeed + threat * 7)
        + (isAce ? BALANCE.ace.speedBonus : 0);
      if (speed > enemyMaxSpeed) enemy.velocity = scale(normalize(enemy.velocity), enemyMaxSpeed);
      enemy.velocity = scale(enemy.velocity, Math.pow(0.24, dt));
      enemy.position = add(enemy.position, scale(enemy.velocity, dt));
      this.keepInArena(enemy);

      enemy.laserCooldown -= dt;
      enemy.missileCooldown -= dt;
      const aimAlignment = dot(forwardFromAngles(enemy.yaw, enemy.pitch), toPlayerDir);
      if (range < 125 && aimAlignment > 0.84 && enemy.laserCooldown <= 0 && player.respawnTimer <= 0) {
        const baseCooldown = isAce ? BALANCE.ace.fireCooldown : BALANCE.enemy.baseFireCooldown;
        enemy.laserCooldown = Math.max(BALANCE.enemy.minFireCooldown, baseCooldown - threat * 0.24) + Math.random() * 0.28;
        this.spawnLaser(enemy, normalize(toPlayer));
      }
      if (isAce && range < 155 && aimAlignment > 0.72 && enemy.missileCooldown <= 0 && player.respawnTimer <= 0) {
        enemy.missileCooldown = BALANCE.ace.missileCooldown + Math.random() * 0.8;
        const aim = normalize(toPlayer);
        this.projectiles.push({
          id: `projectile-${this.projectileSequence++}`,
          ownerId: enemy.id,
          kind: 'missile',
          position: add(enemy.position, scale(aim, 4)),
          velocity: scale(aim, BALANCE.weapons.missileSpeed * 0.92),
          radius: 1.45,
          damage: BALANCE.weapons.missileDamage,
          ttl: 4.2,
          targetId: player.id,
        });
        this.emitEvent('launch', enemy.position, 0xff5a3d, 1.3, 'INCOMING MISSILE', 0);
      }
    }
  }

  private updateWeapons(dt: number, input: InputSnapshot) {
    const player = this.player;
    player.laserCooldown -= dt;
    player.missileCooldown -= dt;
    if (player.respawnTimer > 0) return;

    // Weapons emit simple projectile entities; the renderer only mirrors their state.
    const aim = forwardFromAngles(player.yaw, player.pitch);
    if (input.shoot && player.laserCooldown <= 0) {
      player.laserCooldown = BALANCE.weapons.laserCooldown;
      this.spawnLaser(player, aim);
      this.networkActions.push({
        type: 'fire',
        kind: 'laser',
        position: add(player.position, scale(aim, 4.2)),
        direction: aim,
      });
    }

    if (input.missile && player.missileCooldown <= 0 && this.targetId && player.missileLock >= 1) {
      player.missileCooldown = BALANCE.weapons.missileCooldown;
      player.missileLock = 0;
      this.projectiles.push({
        id: `projectile-${this.projectileSequence++}`,
        ownerId: player.id,
        kind: 'missile',
        position: add(player.position, scale(aim, 4)),
        velocity: scale(aim, BALANCE.weapons.missileSpeed),
        radius: 1.45,
        damage: BALANCE.weapons.missileDamage,
        ttl: 4.4,
        targetId: this.targetId,
      });
      this.networkActions.push({
        type: 'fire',
        kind: 'missile',
        position: add(player.position, scale(aim, 4)),
        direction: aim,
        targetPeerId: this.targetId.startsWith('remote-') ? this.targetId.replace('remote-', '') : undefined,
      });
      this.emitEvent('launch', player.position, 0xffd166, 1.55);
    }
  }

  private updateProjectiles(dt: number) {
    for (const projectile of this.projectiles) {
      projectile.ttl -= dt;

      if (projectile.isRemote) {
        projectile.position = add(projectile.position, scale(projectile.velocity, dt));
        continue;
      }

      if (projectile.kind === 'missile' && projectile.targetId) {
        const target = this.drones.find((drone) => drone.id === projectile.targetId && drone.respawnTimer <= 0);
        if (target) {
          const desired = normalize(sub(target.position, projectile.position));
          projectile.velocity = normalize(add(scale(normalize(projectile.velocity), 0.9), scale(desired, 0.45)));
          projectile.velocity = scale(projectile.velocity, BALANCE.weapons.missileSpeed);
        }
      }

      projectile.position = add(projectile.position, scale(projectile.velocity, dt));

      for (const drone of this.drones) {
        if (drone.id === projectile.ownerId || drone.respawnTimer > 0 || drone.team === 'remote') continue;
        if (distance(projectile.position, drone.position) <= projectile.radius + drone.radius) {
          this.damageDrone(drone, projectile.damage, projectile.ownerId);
          this.emitEvent(projectile.kind === 'missile' ? 'explosion' : 'hit', projectile.position, projectile.kind === 'missile' ? 0xffd166 : 0x7cfffb, projectile.kind === 'missile' ? 2.1 : 1);
          projectile.ttl = -1;
          break;
        }
      }

      if (this.buildings.some((building) => sphereIntersectsAabb(projectile.position, projectile.radius, building))) {
        this.emitEvent('spark', projectile.position, 0x7cfffb, projectile.kind === 'missile' ? 1.7 : 0.85);
        projectile.ttl = -1;
      }
    }

    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];
      if (projectile.ttl <= 0 || Math.abs(projectile.position.x) > BALANCE.arenaHalfSize || Math.abs(projectile.position.z) > BALANCE.arenaHalfSize) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  private updateRespawns(dt: number) {
    for (const drone of this.drones) {
      if (drone.respawnTimer <= 0) continue;
      drone.respawnTimer -= dt;
      if (drone.respawnTimer <= 0) {
        drone.hp = drone.maxHp;
        drone.velocity = vec3();
        drone.boost = 1;
        drone.hitFlash = 0;
        drone.missileLock = 0;
        drone.overdriveTimer = 0;
        drone.position = drone.team === 'player' ? vec3(0, 30, -85) : randomSpawn();
      }
    }
  }

  private spawnLaser(owner: Drone, direction: Vec3) {
    const muzzlePosition = add(owner.position, scale(direction, 4.2));
    this.emitEvent('muzzle', muzzlePosition, owner.team === 'player' ? 0x7cfffb : 0xff3f8f, owner.team === 'player' ? 1.05 : 0.82);
    this.projectiles.push({
      id: `projectile-${this.projectileSequence++}`,
      ownerId: owner.id,
      kind: 'laser',
      position: muzzlePosition,
      velocity: add(owner.velocity, scale(direction, BALANCE.weapons.laserSpeed)),
      radius: 0.7,
      damage: BALANCE.weapons.laserDamage,
      ttl: 1.25,
    });
  }

  private damageDrone(drone: Drone, amount: number, ownerId: DroneId) {
    drone.hp = Math.max(0, drone.hp - amount);
    drone.hitFlash = 1;
    if (drone.hp > 0) return;

    drone.respawnTimer = drone.team === 'player'
      ? 2.2
      : drone.variant === 'ace'
        ? BALANCE.ace.respawnDelay
        : BALANCE.enemy.respawnDelay;
    drone.velocity = vec3();
    if (drone.team === 'player') this.playerDeaths += 1;
    const scoreValue = drone.variant === 'ace' ? BALANCE.ace.scoreValue : 1;
    const owner = this.drones.find((candidate) => candidate.id === ownerId);
    if (owner) owner.score += scoreValue;
    if (ownerId === PLAYER_ID && drone.team === 'enemy') this.registerPlayerKill(drone, scoreValue);
    this.emitEvent(
      'explosion',
      drone.position,
      drone.team === 'player' ? 0x52f7ff : drone.variant === 'ace' ? 0xffd166 : 0xff3f8f,
      drone.variant === 'ace' ? 4.1 : 3.2,
      drone.team === 'enemy' ? `${drone.variant === 'ace' ? 'ACE DOWN' : 'DESTROYED'} ${drone.name}` : 'YOU WERE DESTROYED',
      drone.team === 'enemy' ? scoreValue * 100 : 0,
    );
    this.checkRoundEnd();
  }

  private resolveDroneBuildingCollisions() {
    // Skyscrapers use cheap sphere-vs-AABB tests to keep the arena dense without heavy physics.
    for (const drone of this.drones) {
      if (drone.respawnTimer > 0 || drone.team === 'remote') continue;
      for (const building of this.buildings) {
        if (!sphereIntersectsAabb(drone.position, drone.radius, building)) continue;
        const away = normalize(sub(drone.position, building.position));
        drone.position = add(drone.position, scale(away, 2.2));
        drone.velocity = scale(drone.velocity, -0.16);
        drone.hp = Math.max(0, drone.hp - 0.45);
        drone.hitFlash = Math.max(drone.hitFlash, 0.35);
        this.emitEvent('spark', drone.position, drone.team === 'player' ? 0x52f7ff : 0xff3f8f, 0.7);
        if (drone.hp <= 0) {
          drone.respawnTimer = drone.team === 'player'
            ? 2.2
            : drone.variant === 'ace'
              ? BALANCE.ace.respawnDelay
              : BALANCE.enemy.respawnDelay;
          if (drone.team === 'player') this.playerDeaths += 1;
          this.emitEvent('explosion', drone.position, drone.team === 'player' ? 0x52f7ff : drone.variant === 'ace' ? 0xffd166 : 0xff3f8f, 3, drone.team === 'player' ? 'COLLISION FATAL' : `DESTROYED ${drone.name}`, drone.team === 'enemy' ? 100 : 0);
          this.checkRoundEnd();
        }
      }
    }
  }

  private emitEvent(kind: CombatEvent['kind'], position: Vec3, color: number, scaleValue: number, text?: string, scoreValue?: number) {
    this.events.push({
      id: `event-${this.eventSequence++}`,
      kind,
      position: { ...position },
      color,
      scale: scaleValue,
      text,
      scoreValue,
    });
  }

  private updateMissileLock(dt: number) {
    const player = this.player;
    if (player.respawnTimer > 0) {
      player.missileLock = 0;
      return;
    }

    if (this.targetId) {
      player.missileLock = clamp(player.missileLock + dt / BALANCE.weapons.missileLockTime, 0, 1);
    } else {
      player.missileLock = clamp(player.missileLock - dt * 2.6, 0, 1);
    }
  }

  private getMissileStatus(): string {
    const player = this.player;
    if (!this.targetId) return 'NO LOCK';
    if (player.missileCooldown > 0) return 'RELOADING';
    if (player.missileLock < 1) return 'LOCKING';
    return 'MISSILE READY';
  }

  private getRespawnWarning(): string {
    const soonest = this.drones
      .filter((drone) => drone.team === 'enemy' && drone.respawnTimer > 0 && drone.respawnTimer <= 1.6)
      .sort((a, b) => a.respawnTimer - b.respawnTimer)[0];

    return soonest ? `${soonest.name} redeploying in ${Math.ceil(soonest.respawnTimer)}` : '';
  }

  private updateCombo(dt: number) {
    if (this.comboTimer <= 0) {
      this.comboCount = 0;
      return;
    }

    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer <= 0) this.comboCount = 0;
  }

  private registerPlayerKill(drone: Drone, scoreValue: number) {
    this.comboCount = this.comboTimer > 0 ? this.comboCount + 1 : 1;
    this.comboTimer = BALANCE.comboWindow;
    this.comboBest = Math.max(this.comboBest, this.comboCount);

    const player = this.player;
    player.boost = clamp(player.boost + 0.22 + this.comboCount * 0.025, 0, 1);
    player.missileCooldown = Math.max(0, player.missileCooldown - BALANCE.powerUps.missileCooldownRefund);

    if (this.comboCount >= 2) {
      this.emitEvent('pickup', drone.position, 0xffd166, 1.15 + this.comboCount * 0.08, `COMBO x${this.comboCount}`, scoreValue * 25 * this.comboCount);
    }
  }

  private updatePowerUps(dt: number) {
    for (const powerUp of this.powerUps) {
      powerUp.spin += dt;
      if (powerUp.respawnTimer > 0) powerUp.respawnTimer = Math.max(0, powerUp.respawnTimer - dt);
    }
  }

  private collectPowerUps() {
    const player = this.player;
    if (player.respawnTimer > 0) return;

    for (const powerUp of this.powerUps) {
      if (powerUp.respawnTimer > 0) continue;
      if (distance(player.position, powerUp.position) > BALANCE.powerUps.collectDistance + player.radius) continue;

      if (powerUp.kind === 'repair') {
        player.hp = Math.min(player.maxHp, player.hp + BALANCE.powerUps.repairAmount);
        this.emitEvent('pickup', powerUp.position, 0x7cffb2, 1.45, 'REPAIR CORE', 0);
      }
      if (powerUp.kind === 'overdrive') {
        player.overdriveTimer = BALANCE.player.overdriveDuration;
        player.boost = 1;
        player.missileCooldown = Math.max(0, player.missileCooldown - BALANCE.powerUps.missileCooldownRefund);
        this.emitEvent('pickup', powerUp.position, 0x52f7ff, 1.55, 'OVERDRIVE CORE', 0);
      }
      if (powerUp.kind === 'missile') {
        player.missileCooldown = 0;
        if (this.targetId) player.missileLock = 1;
        this.emitEvent('pickup', powerUp.position, 0xffd166, 1.45, 'MISSILE CORE', 0);
      }

      powerUp.respawnTimer = BALANCE.powerUps.respawnDelay + Math.random() * 5;
    }
  }

  private maybeSpawnAce() {
    if (this.aceSpawned || this.player.score < BALANCE.ace.spawnAtScore) return;
    this.aceSpawned = true;
    const ace = createDrone('enemy-ace', 'Ace Raptor', 'enemy', randomSpawn(), 'ace');
    ace.maxHp = BALANCE.ace.maxHp;
    ace.hp = ace.maxHp;
    ace.radius = BALANCE.ace.radius;
    ace.laserCooldown = 0.4;
    ace.missileCooldown = 1.1;
    this.drones.push(ace);
    this.emitEvent('launch', ace.position, 0xffd166, 2.1, 'ACE INTERCEPTOR DEPLOYED', 0);
  }

  private getComboLabel(): string {
    if (this.comboCount >= 2 && this.comboTimer > 0) return `COMBO x${this.comboCount} - ${this.comboTimer.toFixed(1)}s`;
    if (this.comboBest >= 2) return `BEST COMBO x${this.comboBest}`;
    return 'COMBO READY';
  }

  private getPerkLabel(): string {
    const player = this.player;
    if (player.overdriveTimer > 0) return `OVERDRIVE ${Math.ceil(player.overdriveTimer)}s`;
    const activeCores = this.powerUps.filter((powerUp) => powerUp.respawnTimer <= 0).length;
    return `${activeCores} CORES ACTIVE`;
  }

  private getIncomingWarning(): string {
    const incoming = this.projectiles.filter((projectile) => projectile.kind === 'missile' && projectile.targetId === PLAYER_ID && projectile.ownerId !== PLAYER_ID).length;
    return incoming > 0 ? `${incoming} INCOMING MISSILE${incoming === 1 ? '' : 'S'}` : '';
  }

  private updateRound(dt: number) {
    if (this.roundState !== 'playing') {
      this.roundEndTimer -= dt;
      if (this.roundEndTimer <= 0) this.resetRound();
      return;
    }

    this.roundTime -= dt;
    if (this.roundTime <= 0) {
      this.finishRound(this.player.score >= BALANCE.scoreGoal ? 'won' : 'lost');
    }
  }

  private checkRoundEnd() {
    if (this.roundState !== 'playing') return;
    if (this.player.score >= BALANCE.scoreGoal) {
      this.finishRound('won');
      return;
    }
    if (this.playerDeaths >= BALANCE.deathLimit) {
      this.finishRound('lost');
    }
  }

  private finishRound(state: Exclude<RoundState, 'playing'>) {
    this.roundState = state;
    this.roundEndTimer = BALANCE.roundRestartDelay;
    this.targetId = undefined;
    this.projectiles.splice(0);
    this.emitEvent('explosion', this.player.position, state === 'won' ? 0x7cffb2 : 0xff3f8f, 2.4, state === 'won' ? 'ROUND WON' : 'ROUND LOST', 0);
  }

  private resetRound() {
    this.roundState = 'playing';
    this.roundTime = BALANCE.roundDuration;
    this.roundEndTimer = 0;
    this.playerDeaths = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboBest = 0;
    this.aceSpawned = false;
    this.targetId = undefined;
    this.projectiles.splice(0);

    for (let i = this.drones.length - 1; i >= 0; i -= 1) {
      if (this.drones[i].variant === 'ace') this.drones.splice(i, 1);
    }

    for (let i = 0; i < this.drones.length; i += 1) {
      const drone = this.drones[i];
      drone.hp = drone.maxHp;
      drone.velocity = vec3();
      drone.boost = 1;
      drone.respawnTimer = 0;
      drone.laserCooldown = 0;
      drone.missileCooldown = 0;
      drone.missileLock = 0;
      drone.overdriveTimer = 0;
      drone.score = 0;
      drone.hitFlash = 0;
      drone.evadeTimer = 0;
      drone.position = drone.team === 'player' ? vec3(0, 30, -85) : randomSpawn();
    }

    for (const powerUp of this.powerUps) powerUp.respawnTimer = 0;

    this.emitEvent('launch', this.player.position, 0x7cffb2, 1.8, 'NEW ROUND', 0);
  }

  private getRoundStatus(): string {
    if (this.roundState === 'won') return `VICTORY - restart in ${Math.ceil(this.roundEndTimer)}`;
    if (this.roundState === 'lost') return `DEFEAT - restart in ${Math.ceil(this.roundEndTimer)}`;
    return `${formatTime(this.roundTime)} - ${BALANCE.scoreGoal - this.player.score} kills to win`;
  }

  private getRoundResultTitle(): string {
    if (this.roundState === 'won') return 'VICTORY';
    if (this.roundState === 'lost') return 'DEFEAT';
    return '';
  }

  private getRoundResultSummary(): string {
    if (this.roundState === 'playing') return '';
    return `${this.player.score}/${BALANCE.scoreGoal} kills - ${this.playerDeaths}/${BALANCE.deathLimit} hulls lost`;
  }

  private getThreatLevel(): number {
    const timePressure = 1 - clamp(this.roundTime / BALANCE.roundDuration, 0, 1);
    const scorePressure = clamp(this.player.score / BALANCE.scoreGoal, 0, 1);
    const lowHullPressure = clamp(this.playerDeaths / BALANCE.deathLimit, 0, 1) * 0.35;
    return clamp(timePressure * 0.45 + scorePressure * 0.45 + lowHullPressure, 0, 1);
  }

  private getThreatLabel(): string {
    const threat = this.getThreatLevel();
    if (threat > 0.72) return 'THREAT HIGH';
    if (threat > 0.38) return 'THREAT RISING';
    return 'THREAT LOW';
  }

  private findLockTarget(): DroneId | undefined {
    const player = this.player;
    if (player.respawnTimer > 0) return undefined;

    const aim = forwardFromAngles(player.yaw, player.pitch);
    let best: Drone | undefined;
    let bestScore = 0.93;

    for (const drone of this.drones) {
      if ((drone.team !== 'enemy' && drone.team !== 'remote') || drone.respawnTimer > 0) continue;
      const toDrone = sub(drone.position, player.position);
      const range = length(toDrone);
      if (range > 135) continue;
      const alignment = dot(aim, normalize(toDrone));
      if (alignment > bestScore) {
        bestScore = alignment;
        best = drone;
      }
    }

    return best?.id;
  }

  private keepInArena(drone: Drone) {
    drone.position.x = clamp(drone.position.x, -BALANCE.arenaHalfSize, BALANCE.arenaHalfSize);
    drone.position.y = clamp(drone.position.y, 9, 112);
    drone.position.z = clamp(drone.position.z, -BALANCE.arenaHalfSize, BALANCE.arenaHalfSize);
  }

  private findIncomingThreat(enemy: Drone): Vec3 | undefined {
    for (const projectile of this.projectiles) {
      if (projectile.ownerId === enemy.id) continue;
      const toEnemy = sub(enemy.position, projectile.position);
      const projectileDir = normalize(projectile.velocity);
      const closing = dot(projectileDir, normalize(toEnemy));
      if (closing < 0.88 || length(toEnemy) > 42) continue;
      return normalize(cross(projectileDir, UP));
    }

    return undefined;
  }

  private findObstacleAvoidance(drone: Drone): Vec3 | undefined {
    const forward = normalize(drone.velocity);
    if (length(forward) < 0.01) return undefined;

    for (const building of this.buildings) {
      const toBuilding = sub(building.position, drone.position);
      const ahead = dot(forward, normalize(toBuilding));
      if (ahead < 0.62 || length(toBuilding) > 32) continue;

      const side = dot(rightFromYaw(drone.yaw), toBuilding) > 0 ? -1 : 1;
      return normalize(add(scale(rightFromYaw(drone.yaw), side), vec3(0, 0.45, 0)));
    }

    return undefined;
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function smoothingFactor(dt: number, sharpness: number): number {
  return 1 - Math.exp(-sharpness * dt);
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function createDrone(id: DroneId, name: string, team: Drone['team'], position: Vec3, variant: Drone['variant'] = 'grunt'): Drone {
  return {
    id,
    name,
    team,
    variant,
    position,
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    radius: 2.4,
    hp: 100,
    maxHp: 100,
    boost: 1,
    respawnTimer: 0,
    laserCooldown: 0,
    missileCooldown: 0,
    missileLock: 0,
    overdriveTimer: 0,
    score: 0,
    hitFlash: 0,
    aiPhase: Math.random(),
    evadeTimer: 0,
  };
}

function createCity(): Building[] {
  const buildings: Building[] = [];
  let index = 0;

  for (let x = -135; x <= 135; x += 30) {
    for (let z = -135; z <= 135; z += 30) {
      if (Math.abs(x) < 42 && Math.abs(z) < 42) continue;
      if ((x + z) % 60 === 0 && Math.abs(x) < 120) continue;
      const height = 18 + ((Math.abs(x * 17 + z * 11) % 78) | 0);
      buildings.push({
        id: `building-${index++}`,
        position: vec3(x, height / 2, z),
        size: vec3(12 + (Math.abs(z) % 12), height, 12 + (Math.abs(x) % 12)),
      });
    }
  }

  return buildings;
}

function createPowerUps(): PowerUp[] {
  const placements: Array<{ kind: PowerUp['kind']; x: number; y: number; z: number }> = [
    { kind: 'repair', x: -92, y: 38, z: -28 },
    { kind: 'repair', x: 104, y: 42, z: 64 },
    { kind: 'overdrive', x: 0, y: 74, z: 104 },
    { kind: 'overdrive', x: -118, y: 60, z: 118 },
    { kind: 'missile', x: 94, y: 56, z: -106 },
    { kind: 'missile', x: -24, y: 48, z: -132 },
  ];

  return placements.map((placement, index) => ({
    id: `power-up-${index}`,
    kind: placement.kind,
    position: vec3(placement.x, placement.y, placement.z),
    radius: BALANCE.powerUps.radius,
    respawnTimer: 0,
    spin: Math.random() * Math.PI * 2,
  }));
}

function randomSpawn(): Vec3 {
  const angle = Math.random() * Math.PI * 2;
  const radius = 70 + Math.random() * 72;
  return vec3(Math.sin(angle) * radius, 24 + Math.random() * 52, Math.cos(angle) * radius);
}

function sphereIntersectsAabb(center: Vec3, radius: number, building: Building): boolean {
  const half = scale(building.size, 0.5);
  const closest = vec3(
    clamp(center.x, building.position.x - half.x, building.position.x + half.x),
    clamp(center.y, building.position.y - half.y, building.position.y + half.y),
    clamp(center.z, building.position.z - half.z, building.position.z + half.z),
  );
  return distance(center, closest) <= radius;
}
