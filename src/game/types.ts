import type { Vec3 } from './math';

export type DroneId = string;

export type Drone = {
  id: DroneId;
  name: string;
  team: 'player' | 'enemy' | 'remote';
  position: Vec3;
  velocity: Vec3;
  targetPosition?: Vec3;
  targetVelocity?: Vec3;
  targetYaw?: number;
  targetPitch?: number;
  yaw: number;
  pitch: number;
  radius: number;
  hp: number;
  maxHp: number;
  boost: number;
  respawnTimer: number;
  laserCooldown: number;
  missileCooldown: number;
  missileLock: number;
  score: number;
  hitFlash: number;
  aiPhase: number;
  evadeTimer: number;
};

export type Projectile = {
  id: string;
  ownerId: DroneId;
  kind: 'laser' | 'missile';
  position: Vec3;
  velocity: Vec3;
  targetPosition?: Vec3;
  targetVelocity?: Vec3;
  radius: number;
  damage: number;
  ttl: number;
  targetId?: DroneId;
  isRemote?: boolean;
};

export type Building = {
  id: string;
  position: Vec3;
  size: Vec3;
};

export type InputSnapshot = {
  forward: number;
  strafe: number;
  boost: boolean;
  shoot: boolean;
  missile: boolean;
  yawDelta: number;
  pitchDelta: number;
  locked: boolean;
  sensitivity: number;
};

export type HudState = {
  hpRatio: number;
  boostRatio: number;
  enemyCount: number;
  lockName: string;
  velocity: number;
  score: number;
  scoreGoal: number;
  playerDeaths: number;
  deathLimit: number;
  roundTime: number;
  roundStatus: string;
  roundPhase: 'playing' | 'won' | 'lost';
  roundRestart: number;
  roundResultTitle: string;
  roundResultSummary: string;
  threatLevel: number;
  threatLabel: string;
  networkStatus: string;
  networkScoreboard: string;
  missileCooldownRatio: number;
  missileLockRatio: number;
  missileStatus: string;
  controlsLocked: boolean;
  sensitivity: number;
  inputBoost: boolean;
  inputFire: boolean;
  inputMissile: boolean;
  respawnWarning: string;
  message: string;
};

export type TargetMarker = {
  x: number;
  y: number;
  distance: number;
  hpRatio: number;
  visible: boolean;
};

export type CombatEvent = {
  id: string;
  kind: 'hit' | 'explosion' | 'spark' | 'launch' | 'muzzle' | 'smoke';
  position: Vec3;
  color: number;
  scale: number;
  text?: string;
  scoreValue?: number;
};

export type NetworkAction = {
  type: 'fire';
  kind: 'laser' | 'missile';
  position: Vec3;
  direction: Vec3;
  targetPeerId?: string;
};
