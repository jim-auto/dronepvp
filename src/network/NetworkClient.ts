import type { CombatEvent, Drone, NetworkAction } from '../game/types';

export type RemotePeer = {
  id: string;
  roomId?: string;
  name: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  hp: number;
  score?: number;
  deaths?: number;
};

export type ScoreEntry = {
  id: string;
  name: string;
  score: number;
  deaths: number;
};

export type PvpRoundState = {
  phase: 'playing' | 'ended';
  timeRemaining: number;
  restartIn: number;
  scoreGoal: number;
  winnerId?: string;
  winnerName?: string;
};

export type NetworkProjectile = {
  id: string;
  ownerId: string;
  kind: 'laser' | 'missile';
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  ttl: number;
  targetId?: string;
};

type ServerMessage =
  | { type: 'welcome'; id: string; roomId: string }
  | { type: 'snapshot'; roomId: string; peers: RemotePeer[]; projectiles?: NetworkProjectile[]; scoreboard: ScoreEntry[]; round?: PvpRoundState; sentAt: number }
  | { type: 'combat'; roomId: string; events: CombatEvent[] };

export class NetworkClient {
  private socket?: WebSocket;
  private clientId = '';
  private roomId = 'lobby';
  private status: 'offline' | 'connecting' | 'online' = 'offline';
  private peers: RemotePeer[] = [];
  private projectiles: NetworkProjectile[] = [];
  private scoreboard: ScoreEntry[] = [];
  private round?: PvpRoundState;
  private combatEvents: CombatEvent[] = [];
  private sendAccumulator = 0;

  constructor(private readonly url?: string) {
    if (url) this.connect();
  }

  getStatusLabel(): string {
    if (!this.url) return 'NET OFF';
    if (this.status === 'online') return `ROOM ${this.roomId} - ${Math.max(this.peers.length - 1, 0)} ONLINE`;
    if (this.status === 'connecting') return 'NET CONNECTING';
    return 'NET OFFLINE';
  }

  getRemotePeers(): RemotePeer[] {
    return this.peers.filter((peer) => peer.id !== this.clientId);
  }

  getLocalPeer(): RemotePeer | undefined {
    return this.peers.find((peer) => peer.id === this.clientId);
  }

  getRemoteProjectiles(): NetworkProjectile[] {
    return this.projectiles.filter((projectile) => projectile.ownerId !== this.clientId);
  }

  getScoreboardLabel(): string {
    if (!this.scoreboard.length) return 'PvP score -';
    return this.scoreboard
      .slice(0, 3)
      .map((entry) => `${entry.name} ${entry.score}/${entry.deaths}`)
      .join(' | ');
  }

  getRoundStatusLabel(): string | undefined {
    if (!this.round) return undefined;
    if (this.round.phase === 'ended') {
      return `${this.round.winnerName ?? 'Draw'} - next ${Math.ceil(this.round.restartIn)}`;
    }
    return `PvP ${formatTime(this.round.timeRemaining)} - first to ${this.round.scoreGoal}`;
  }

  getRoundResult(): { phase: 'playing' | 'won' | 'lost'; title: string; summary: string; restartIn: number } | undefined {
    if (!this.round || this.round.phase === 'playing') return undefined;
    const won = this.round.winnerId === this.clientId;
    const draw = !this.round.winnerId;
    return {
      phase: draw ? 'lost' : won ? 'won' : 'lost',
      title: draw ? 'PVP DRAW' : won ? 'PVP VICTORY' : 'PVP DEFEAT',
      summary: this.getScoreboardLabel(),
      restartIn: this.round.restartIn,
    };
  }

  drainCombatEvents(): CombatEvent[] {
    return this.combatEvents.splice(0);
  }

  update(dt: number, player: Drone) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / 20) return;
    this.sendAccumulator = 0;

    this.socket.send(JSON.stringify({
      type: 'playerState',
      name: 'Pilot',
      position: player.position,
      velocity: player.velocity,
      yaw: player.yaw,
      pitch: player.pitch,
      hp: player.hp,
    }));
  }

  sendAction(action: NetworkAction) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'playerAction',
      action,
    }));
  }

  private connect() {
    if (!this.url) return;
    this.status = 'connecting';
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this.status = 'online';
    });
    this.socket.addEventListener('close', () => {
      this.status = 'offline';
      window.setTimeout(() => this.connect(), 1500);
    });
    this.socket.addEventListener('error', () => {
      this.status = 'offline';
    });
    this.socket.addEventListener('message', (event) => {
      const message = parseMessage(event.data);
      if (!message) return;
      if (message.type === 'welcome') {
        this.clientId = message.id;
        this.roomId = message.roomId;
      }
      if (message.type === 'snapshot') {
        this.roomId = message.roomId;
        this.peers = message.peers;
        this.projectiles = message.projectiles ?? [];
        this.scoreboard = message.scoreboard;
        this.round = message.round;
      }
      if (message.type === 'combat') this.combatEvents.push(...message.events);
    });
  }
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export function getNetworkUrl(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('server');
  const room = getRoomId();
  if (explicit) return withRoom(explicit, room);
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return withRoom('ws://localhost:8787', room);
  }
  return undefined;
}

export function getRoomId(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get('room') ?? 'lobby').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'lobby';
}

function withRoom(url: string, room: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('room', room);
  return parsed.toString();
}

function parseMessage(data: unknown): ServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    return undefined;
  }
}
