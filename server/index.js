import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const server = new WebSocketServer({ port });
const rooms = new Map();
const PVP_ROUND_DURATION = 180;
const PVP_SCORE_GOAL = 5;
const PVP_RESTART_DELAY = 5;
const SERVER_TICK_MS = 50;
const PROJECTILE_CONFIG = {
  laser: { speed: 150, damage: 11, ttl: 1.25, radius: 3.2 },
  missile: { speed: 78, damage: 38, ttl: 4.4, radius: 5.2 },
};
let lastTick = Date.now();

server.on('connection', (socket, request) => {
  const id = crypto.randomUUID();
  const roomId = getRoomId(request.url);
  socket.roomId = roomId;
  const room = getRoom(roomId);
  const peers = room.peers;
  peers.set(id, {
    id,
    roomId,
    name: `Pilot ${id.slice(0, 4)}`,
    position: { x: 0, y: 30, z: -85 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    score: 0,
    deaths: 0,
    updatedAt: Date.now(),
  });

  socket.send(JSON.stringify({ type: 'welcome', id, roomId }));
  broadcastState(roomId);

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    const peer = peers.get(id);
    if (!peer) return;

    if (message.type === 'playerState') {
      peer.name = sanitizeName(message.name) ?? peer.name;
      peer.position = sanitizeVec3(message.position) ?? peer.position;
      peer.velocity = sanitizeVec3(message.velocity) ?? peer.velocity;
      peer.yaw = sanitizeNumber(message.yaw, -Math.PI * 2, Math.PI * 2) ?? peer.yaw;
      peer.pitch = sanitizeNumber(message.pitch, -Math.PI / 2, Math.PI / 2) ?? peer.pitch;
      peer.updatedAt = Date.now();
      return;
    }

    if (message.type === 'playerAction') {
      handleAction(roomId, id, message.action);
    }
  });

  socket.on('close', () => {
    peers.delete(id);
    if (peers.size === 0) rooms.delete(roomId);
    broadcastState(roomId);
  });
});

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  for (const roomId of rooms.keys()) {
    updateRoomRound(roomId);
    updateRoomProjectiles(roomId, dt);
    broadcastState(roomId);
  }
}, SERVER_TICK_MS);
setInterval(removeStalePeers, 2000);

console.log(`DronePvP WebSocket server listening on ws://localhost:${port}`);

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      peers: new Map(),
      projectiles: new Map(),
      round: createRound(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  updateRoomRound(roomId, 0);
  const peers = room.peers;
  const payload = JSON.stringify({
    type: 'snapshot',
    roomId,
    peers: [...peers.values()],
    projectiles: [...room.projectiles.values()].map((projectile) => ({
      id: projectile.id,
      ownerId: projectile.ownerId,
      kind: projectile.kind,
      position: projectile.position,
      velocity: projectile.velocity,
      ttl: projectile.ttl,
      targetId: projectile.targetId,
    })),
    scoreboard: [...peers.values()]
      .map((peer) => ({ id: peer.id, name: peer.name, score: peer.score, deaths: peer.deaths }))
      .sort((a, b) => b.score - a.score || a.deaths - b.deaths),
    round: getRoundSnapshot(room),
    sentAt: Date.now(),
  });

  for (const client of server.clients) {
    if (client.readyState === client.OPEN && client.roomId === roomId) client.send(payload);
  }
}

function removeStalePeers() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    for (const [id, peer] of room.peers) {
      if (now - peer.updatedAt > 10000) room.peers.delete(id);
    }
    if (room.peers.size === 0) rooms.delete(roomId);
  }
}

function handleAction(roomId, ownerId, action) {
  if (!action || action.type !== 'fire') return;
  const room = rooms.get(roomId);
  if (!room || room.round.phase !== 'playing') return;
  const peers = room.peers;
  const owner = peers.get(ownerId);
  if (!owner) return;

  const origin = sanitizeVec3(action.position);
  const direction = normalize(sanitizeVec3(action.direction));
  if (!origin || !direction) return;

  if (action.kind === 'laser') {
    broadcastCombat(roomId, [{
      id: `net-muzzle-${Date.now()}-${ownerId}`,
      kind: 'muzzle',
      position: origin,
      color: 0x7cffb2,
      scale: 0.9,
    }]);
    spawnProjectile(room, ownerId, 'laser', origin, direction);
  }

  if (action.kind === 'missile') {
    const targetId = typeof action.targetPeerId === 'string' ? action.targetPeerId : undefined;
    if (!targetId || targetId === ownerId || !peers.has(targetId)) return;
    spawnProjectile(room, ownerId, 'missile', origin, direction, targetId);
  }
}

function spawnProjectile(room, ownerId, kind, position, direction, targetId) {
  const config = PROJECTILE_CONFIG[kind];
  const id = `net-projectile-${Date.now()}-${ownerId}-${Math.random().toString(16).slice(2)}`;
  room.projectiles.set(id, {
    id,
    ownerId,
    kind,
    position,
    velocity: scale(direction, config.speed),
    ttl: config.ttl,
    radius: config.radius,
    damage: config.damage,
    targetId,
  });
}

function updateRoomProjectiles(roomId, dt) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.round.phase !== 'playing') {
    room.projectiles.clear();
    return;
  }

  for (const projectile of room.projectiles.values()) {
    projectile.ttl -= dt;
    const previous = projectile.position;

    if (projectile.kind === 'missile' && projectile.targetId) {
      const target = room.peers.get(projectile.targetId);
      if (target && target.hp > 0) {
        const desired = normalize(sub(target.position, projectile.position));
        const current = normalize(projectile.velocity);
        if (desired && current) {
          const steered = normalize(add(scale(current, 0.82), scale(desired, 0.45)));
          if (steered) projectile.velocity = scale(steered, PROJECTILE_CONFIG.missile.speed);
        }
      }
    }

    projectile.position = add(projectile.position, scale(projectile.velocity, dt));

    const hit = findProjectileHit(room.peers, projectile, previous, projectile.position);
    if (hit) {
      damagePeer(roomId, hit.id, projectile.damage, projectile.ownerId, projectile.position, projectile.kind === 'missile');
      room.projectiles.delete(projectile.id);
      continue;
    }

    if (
      projectile.ttl <= 0 ||
      Math.abs(projectile.position.x) > 190 ||
      Math.abs(projectile.position.z) > 190 ||
      projectile.position.y < 0 ||
      projectile.position.y > 130
    ) {
      room.projectiles.delete(projectile.id);
    }
  }
}

function findProjectileHit(peers, projectile, from, to) {
  let best;
  let bestT = Infinity;
  for (const peer of peers.values()) {
    if (peer.id === projectile.ownerId || peer.hp <= 0) continue;
    const t = closestSegmentT(from, to, peer.position);
    const closest = add(from, scale(sub(to, from), t));
    const miss = distance(peer.position, closest);
    if (miss <= projectile.radius && t < bestT) {
      best = peer;
      bestT = t;
    }
  }
  return best;
}

function damagePeer(roomId, targetId, amount, ownerId, impactPosition, explosive = false) {
  const room = rooms.get(roomId);
  if (!room || room.round.phase !== 'playing') return;
  const peers = room.peers;
  const target = peers.get(targetId);
  const owner = peers.get(ownerId);
  if (!target || !owner || target.hp <= 0) return;

  target.hp = Math.max(0, target.hp - amount);
  const events = [{
    id: `net-hit-${Date.now()}-${targetId}`,
    kind: explosive ? 'explosion' : 'hit',
    position: impactPosition,
    color: explosive ? 0xffd166 : 0x7cffb2,
    scale: explosive ? 1.8 : 1,
  }];

  if (target.hp <= 0) {
    owner.score += 1;
    target.deaths += 1;
    events.push({
      id: `net-kill-${Date.now()}-${targetId}`,
      kind: 'explosion',
      position: target.position,
      color: 0xff3f8f,
      scale: 3,
      text: `${owner.name} destroyed ${target.name}`,
      scoreValue: 100,
    });
    if (owner.score >= PVP_SCORE_GOAL) {
      finishRoomRound(roomId, owner.id);
    }
    setTimeout(() => {
      const latestRoom = rooms.get(roomId);
      const respawn = latestRoom?.peers.get(targetId);
      if (!respawn) return;
      respawn.hp = 100;
      respawn.position = randomSpawn();
      respawn.velocity = { x: 0, y: 0, z: 0 };
      respawn.updatedAt = Date.now();
      broadcastState(roomId);
    }, 2200);
  }

  broadcastCombat(roomId, events);
  broadcastState(roomId);
}

function broadcastCombat(roomId, events) {
  const payload = JSON.stringify({ type: 'combat', roomId, events });
  for (const client of server.clients) {
    if (client.readyState === client.OPEN && client.roomId === roomId) client.send(payload);
  }
}

function createRound() {
  return {
    phase: 'playing',
    startedAt: Date.now(),
    endsAt: Date.now() + PVP_ROUND_DURATION * 1000,
    winnerId: undefined,
    restartAt: undefined,
  };
}

function updateRoomRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.round.phase === 'playing' && Date.now() >= room.round.endsAt) {
    const winner = getLeadingPeer(room.peers);
    finishRoomRound(roomId, winner?.id);
    return;
  }

  if (room.round.phase === 'ended' && room.round.restartAt && Date.now() >= room.round.restartAt) {
    resetRoomRound(roomId);
  }
}

function finishRoomRound(roomId, winnerId) {
  const room = rooms.get(roomId);
  if (!room || room.round.phase === 'ended') return;

  room.round.phase = 'ended';
  room.round.winnerId = winnerId;
  room.round.restartAt = Date.now() + PVP_RESTART_DELAY * 1000;
  room.projectiles.clear();

  const winner = winnerId ? room.peers.get(winnerId) : undefined;
  broadcastCombat(roomId, [{
    id: `pvp-round-${Date.now()}-${roomId}`,
    kind: 'explosion',
    position: winner?.position ?? { x: 0, y: 30, z: 0 },
    color: winner ? 0x7cffb2 : 0xffd166,
    scale: 2.5,
    text: winner ? `${winner.name} wins PvP round` : 'PvP round draw',
    scoreValue: 0,
  }]);
}

function resetRoomRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.round = createRound();
  room.projectiles.clear();
  for (const peer of room.peers.values()) {
    peer.score = 0;
    peer.deaths = 0;
    peer.hp = 100;
    peer.position = randomSpawn();
    peer.velocity = { x: 0, y: 0, z: 0 };
    peer.updatedAt = Date.now();
  }

  broadcastCombat(roomId, [{
    id: `pvp-new-round-${Date.now()}-${roomId}`,
    kind: 'launch',
    position: { x: 0, y: 30, z: 0 },
    color: 0x7cffb2,
    scale: 1.8,
    text: 'PvP ROUND START',
    scoreValue: 0,
  }]);
  broadcastState(roomId);
}

function getRoundSnapshot(room) {
  const winner = room.round.winnerId ? room.peers.get(room.round.winnerId) : undefined;
  return {
    phase: room.round.phase,
    timeRemaining: room.round.phase === 'playing'
      ? Math.max(0, (room.round.endsAt - Date.now()) / 1000)
      : 0,
    restartIn: room.round.restartAt ? Math.max(0, (room.round.restartAt - Date.now()) / 1000) : 0,
    scoreGoal: PVP_SCORE_GOAL,
    winnerId: room.round.winnerId,
    winnerName: winner?.name,
  };
}

function getLeadingPeer(peers) {
  return [...peers.values()].sort((a, b) => b.score - a.score || a.deaths - b.deaths)[0];
}

function sanitizeName(value) {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, 24);
}

function getRoomId(url) {
  try {
    const parsed = new URL(url ?? '/', 'ws://localhost');
    const room = parsed.searchParams.get('room') ?? 'lobby';
    return room.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'lobby';
  } catch {
    return 'lobby';
  }
}

function sanitizeVec3(value) {
  if (!value || typeof value !== 'object') return undefined;
  const x = sanitizeNumber(value.x, -1000, 1000);
  const y = sanitizeNumber(value.y, -1000, 1000);
  const z = sanitizeNumber(value.z, -1000, 1000);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
}

function sanitizeNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function normalize(v) {
  if (!v) return undefined;
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 0.0001) return undefined;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function closestSegmentT(a, b, point) {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < 0.0001) return 0;
  return Math.max(0, Math.min(1, dot(sub(point, a), ab) / denom));
}

function randomSpawn() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 70 + Math.random() * 72;
  return {
    x: Math.sin(angle) * radius,
    y: 24 + Math.random() * 52,
    z: Math.cos(angle) * radius,
  };
}
