import * as THREE from 'three';
import type { GameWorld } from '../game/GameWorld';
import { distance, forwardFromAngles, length, type Vec3 } from '../game/math';
import type { CombatEvent, Drone, InputSnapshot, PowerUp, Projectile, TargetMarker } from '../game/types';

type Effect = {
  object: THREE.Object3D;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

export class DroneRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: GameWorld;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(72, 1, 0.1, 900);
  private readonly droneMeshes = new Map<string, THREE.Object3D>();
  private readonly projectileMeshes = new Map<string, THREE.Object3D>();
  private readonly powerUpMeshes = new Map<string, THREE.Object3D>();
  private readonly speedLines = new THREE.Group();
  private readonly clockOffset = Math.random() * 1000;
  private readonly effects: Effect[] = [];
  private readonly damageSmokeTimers = new Map<string, number>();
  private cameraShake = 0;

  constructor(canvas: HTMLCanvasElement, world: GameWorld) {
    this.canvas = canvas;
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.setClearColor(0x05070d);

    this.scene.fog = new THREE.FogExp2(0x05070d, 0.009);
    this.setupLighting();
    this.createCity();
    this.createArena();
    this.createSpeedLines();
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  render(dt: number, input: InputSnapshot, events: CombatEvent[]) {
    this.syncDrones(dt);
    this.syncProjectiles();
    this.syncPowerUps(dt);
    this.spawnCombatEffects(events);
    this.updateEffects(dt);
    this.updateCamera(dt, input);
    this.animateSpeedLines(input);
    this.renderer.render(this.scene, this.camera);
  }

  getTargetMarker(): TargetMarker | undefined {
    const target = this.world.lockedTarget;
    if (!target) return undefined;

    const projected = toThree(target.position);
    projected.project(this.camera);

    const visible = projected.z > -1 && projected.z < 1;
    const x = ((projected.x + 1) / 2) * this.canvas.clientWidth;
    const y = ((-projected.y + 1) / 2) * this.canvas.clientHeight;
    const margin = 24;

    return {
      x: THREE.MathUtils.clamp(x, margin, this.canvas.clientWidth - margin),
      y: THREE.MathUtils.clamp(y, margin, this.canvas.clientHeight - margin),
      distance: distance(this.world.player.position, target.position),
      hpRatio: target.hp / target.maxHp,
      visible,
    };
  }

  private setupLighting() {
    this.scene.add(new THREE.HemisphereLight(0x5ff3ff, 0x08080d, 1.5));
    const sun = new THREE.DirectionalLight(0xff4ead, 1.25);
    sun.position.set(-60, 120, -40);
    this.scene.add(sun);
  }

  private createCity() {
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b1322,
      roughness: 0.72,
      metalness: 0.25,
      emissive: 0x07111a,
    });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x24dfff, transparent: true, opacity: 0.28 });

    for (const building of this.world.buildings) {
      const geometry = new THREE.BoxGeometry(building.size.x, building.size.y, building.size.z);
      const mesh = new THREE.Mesh(geometry, bodyMaterial);
      mesh.position.copy(toThree(building.position));
      this.scene.add(mesh);

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
      edges.position.copy(mesh.position);
      this.scene.add(edges);
    }

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(this.world.arenaHalfSize * 2.3, this.world.arenaHalfSize * 2.3, 18, 18),
      new THREE.MeshStandardMaterial({
        color: 0x07101b,
        roughness: 0.85,
        metalness: 0.15,
        emissive: 0x03070c,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(this.world.arenaHalfSize * 2.2, 44, 0xff3f9d, 0x1ec8ff);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.28;
    this.scene.add(grid);
  }

  private createArena() {
    const size = this.world.arenaHalfSize * 2;
    const geometry = new THREE.BoxGeometry(size, 110, size);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xff3f9d, transparent: true, opacity: 0.34 }),
    );
    edges.position.y = 55;
    this.scene.add(edges);
  }

  private createSpeedLines() {
    const material = new THREE.LineBasicMaterial({ color: 0x8df7ff, transparent: true, opacity: 0.0 });
    for (let i = 0; i < 44; i += 1) {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -12)]);
      const line = new THREE.Line(geometry, material.clone());
      line.position.set((Math.random() - 0.5) * 36, (Math.random() - 0.5) * 22, -18 - Math.random() * 46);
      this.speedLines.add(line);
    }
    this.camera.add(this.speedLines);
    this.scene.add(this.camera);
  }

  private syncDrones(dt: number) {
    const activeIds = new Set(this.world.drones.map((drone) => drone.id));

    for (const drone of this.world.drones) {
      let mesh = this.droneMeshes.get(drone.id);
      if (!mesh) {
        mesh = createDroneMesh(drone);
        this.droneMeshes.set(drone.id, mesh);
        this.scene.add(mesh);
      }
      mesh.visible = drone.respawnTimer <= 0;
      mesh.position.copy(toThree(drone.position));
      mesh.rotation.set(-drone.pitch, drone.yaw, 0);
      applyDroneHitFlash(mesh, drone.hitFlash);
      this.updateDamageSmoke(drone, dt);
    }

    for (const [id, mesh] of this.droneMeshes) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.droneMeshes.delete(id);
        this.damageSmokeTimers.delete(id);
      }
    }
  }

  private updateDamageSmoke(drone: Drone, dt: number) {
    const hpRatio = drone.hp / drone.maxHp;
    if (drone.respawnTimer > 0 || hpRatio > 0.36) {
      this.damageSmokeTimers.delete(drone.id);
      return;
    }

    const next = (this.damageSmokeTimers.get(drone.id) ?? 0) - dt;
    if (next > 0) {
      this.damageSmokeTimers.set(drone.id, next);
      return;
    }

    const jitter = new THREE.Vector3((Math.random() - 0.5) * 2.6, Math.random() * 1.4, (Math.random() - 0.5) * 2.6);
    const event: CombatEvent = {
      id: `smoke-${drone.id}-${performance.now()}`,
      kind: 'smoke',
      position: {
        x: drone.position.x + jitter.x,
        y: drone.position.y + jitter.y,
        z: drone.position.z + jitter.z,
      },
      color: drone.team === 'player' ? 0x52f7ff : 0xff3f8f,
      scale: 0.9 + (1 - hpRatio) * 1.2,
    };
    const effect = createCombatEffect(event);
    this.effects.push(effect);
    this.scene.add(effect.object);
    this.damageSmokeTimers.set(drone.id, 0.1 + hpRatio * 0.22);
  }

  private syncProjectiles() {
    const activeIds = new Set(this.world.projectiles.map((projectile) => projectile.id));

    for (const projectile of this.world.projectiles) {
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        mesh = createProjectileMesh(projectile);
        this.projectileMeshes.set(projectile.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.copy(toThree(projectile.position));
      const velocity = toThree(projectile.velocity).normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), velocity);
    }

    for (const [id, mesh] of this.projectileMeshes) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.projectileMeshes.delete(id);
      }
    }
  }

  private syncPowerUps(dt: number) {
    const activeIds = new Set(this.world.powerUps.map((powerUp) => powerUp.id));

    for (const powerUp of this.world.powerUps) {
      let mesh = this.powerUpMeshes.get(powerUp.id);
      if (!mesh) {
        mesh = createPowerUpMesh(powerUp);
        this.powerUpMeshes.set(powerUp.id, mesh);
        this.scene.add(mesh);
      }

      mesh.visible = powerUp.respawnTimer <= 0;
      mesh.position.copy(toThree(powerUp.position));
      mesh.rotation.y += dt * 1.7;
      mesh.rotation.z = Math.sin(powerUp.spin * 1.8) * 0.28;
      const pulse = 1 + Math.sin(powerUp.spin * 4) * 0.07;
      mesh.scale.setScalar(pulse);
    }

    for (const [id, mesh] of this.powerUpMeshes) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.powerUpMeshes.delete(id);
      }
    }
  }

  private updateCamera(dt: number, input: InputSnapshot) {
    const player = this.world.player;
    const forward = forwardFromAngles(player.yaw, player.pitch);
    const speed = length(player.velocity);
    const cameraDistance = input.boost ? 19 : 15;
    const cameraHeight = input.boost ? 5.2 : 4.2;
    const desiredPosition = toThree({
      x: player.position.x - forward.x * cameraDistance,
      y: player.position.y - forward.y * 8 + cameraHeight,
      z: player.position.z - forward.z * cameraDistance,
    });
    const smoothing = 1 - Math.pow(0.0008, dt);
    this.camera.position.lerp(desiredPosition, smoothing);
    this.camera.lookAt(toThree({
      x: player.position.x + forward.x * 28,
      y: player.position.y + forward.y * 18,
      z: player.position.z + forward.z * 28,
    }));
    this.cameraShake = Math.max(0, this.cameraShake - dt * 7);
    if (this.cameraShake > 0) {
      const shake = this.cameraShake * 0.55;
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake;
    }
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 72 + Math.min(speed * 0.23, 18), 1 - Math.pow(0.02, dt));
    this.camera.updateProjectionMatrix();
  }

  private spawnCombatEffects(events: CombatEvent[]) {
    for (const event of events) {
      const effect = createCombatEffect(event);
      this.effects.push(effect);
      this.scene.add(effect.object);

      const distanceToPlayer = distance(this.world.player.position, event.position);
      if (distanceToPlayer < 60) {
        this.cameraShake = Math.max(this.cameraShake, event.kind === 'explosion' ? 1.35 : 0.42);
      }
    }
  }

  private updateEffects(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      effect.life -= dt;
      effect.object.position.addScaledVector(effect.velocity, dt);
      effect.object.scale.multiplyScalar(1 + dt * 2.5);

      const alpha = Math.max(effect.life / effect.maxLife, 0);
      effect.object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          const material = child.material;
          if (Array.isArray(material)) return;
          material.opacity = alpha;
        }
      });

      if (effect.life <= 0) {
        this.scene.remove(effect.object);
        this.effects.splice(i, 1);
      }
    }
  }

  private animateSpeedLines(input: InputSnapshot) {
    const playerSpeed = length(this.world.player.velocity);
    const opacity = Math.min(input.boost ? 0.85 : playerSpeed / 130, 0.85);
    const t = performance.now() * 0.001 + this.clockOffset;

    this.speedLines.children.forEach((line, index) => {
      const material = (line as THREE.Line).material as THREE.LineBasicMaterial;
      material.opacity = opacity;
      line.position.z += 1.0 + playerSpeed * 0.045;
      if (line.position.z > -6) {
        line.position.z = -58 - Math.random() * 28;
        line.position.x = (Math.random() - 0.5) * 42;
        line.position.y = (Math.random() - 0.5) * 26;
      }
      line.rotation.z = Math.sin(t + index) * 0.08;
    });
  }

  private resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

function createDroneMesh(drone: Drone): THREE.Object3D {
  const group = new THREE.Group();
  const isAce = drone.variant === 'ace';
  const color = drone.team === 'player' ? 0x52f7ff : drone.team === 'remote' ? 0x7cffb2 : isAce ? 0xffd166 : 0xff3f8f;
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(isAce ? 1.65 : 1.25, isAce ? 5.4 : 4.4, isAce ? 5 : 4),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.65, emissive: color, emissiveIntensity: isAce ? 0.32 : 0.18 }),
  );
  body.rotation.x = Math.PI / 2;
  body.userData.baseEmissive = isAce ? 0.32 : 0.18;
  group.add(body);

  const wingGeometry = new THREE.BoxGeometry(isAce ? 7.4 : 5.6, isAce ? 0.24 : 0.18, isAce ? 0.82 : 0.65);
  const wingMaterial = new THREE.MeshStandardMaterial({ color: 0xdffbff, roughness: 0.4, metalness: 0.45, emissive: color, emissiveIntensity: 0.12 });
  const wing = new THREE.Mesh(wingGeometry, wingMaterial);
  wing.userData.baseEmissive = 0.12;
  group.add(wing);

  if (isAce) {
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(2.7, 0.08, 6, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending }),
    );
    crown.rotation.x = Math.PI / 2;
    group.add(crown);
  }

  const glow = new THREE.PointLight(color, isAce ? 2.6 : 1.6, isAce ? 28 : 18);
  glow.position.set(0, 0, -1.2);
  group.add(glow);

  return group;
}

function applyDroneHitFlash(mesh: THREE.Object3D, flash: number) {
  mesh.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    material.emissiveIntensity = (child.userData.baseEmissive ?? 0.1) + flash * 1.15;
  });
}

function createProjectileMesh(projectile: Projectile): THREE.Object3D {
  const color = projectile.kind === 'laser' ? 0x7cfffb : 0xffd166;
  const length = projectile.kind === 'laser' ? 6 : 3.2;
  const group = new THREE.Group();
  const geometry = new THREE.CylinderGeometry(projectile.radius * 0.24, projectile.radius * 0.24, length, 8);
  const material = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  const light = new THREE.PointLight(color, 1.7, 15);
  group.add(mesh, light);
  return group;
}

function createPowerUpMesh(powerUp: PowerUp): THREE.Object3D {
  const group = new THREE.Group();
  const color = powerUp.kind === 'repair' ? 0x7cffb2 : powerUp.kind === 'overdrive' ? 0x52f7ff : 0xffd166;
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(powerUp.radius * 0.42, 1), material.clone());
  group.add(core);

  const ringA = new THREE.Mesh(new THREE.TorusGeometry(powerUp.radius * 0.72, 0.045 * powerUp.radius, 6, 32), material.clone());
  ringA.rotation.x = Math.PI / 2;
  group.add(ringA);

  const ringB = new THREE.Mesh(new THREE.TorusGeometry(powerUp.radius * 0.52, 0.035 * powerUp.radius, 6, 28), material.clone());
  ringB.rotation.y = Math.PI / 2;
  group.add(ringB);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(powerUp.radius * 0.1, powerUp.radius * 0.34, 16, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  beacon.position.y = -7;
  group.add(beacon);

  group.add(new THREE.PointLight(color, 2.2, 36));
  return group;
}

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function createCombatEffect(event: CombatEvent): Effect {
  const group = new THREE.Group();
  group.position.copy(toThree(event.position));

  const color = new THREE.Color(event.color);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  if (event.kind === 'explosion') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2 * event.scale, 0.08 * event.scale, 6, 28), material.clone());
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    for (let i = 0; i < 10; i += 1) {
      const shard = new THREE.Mesh(new THREE.TetrahedronGeometry(0.55 * event.scale), material.clone());
      shard.position.set((Math.random() - 0.5) * event.scale, (Math.random() - 0.5) * event.scale, (Math.random() - 0.5) * event.scale);
      group.add(shard);
    }
  } else if (event.kind === 'launch') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35 * event.scale, 0.05 * event.scale, 6, 24), material.clone());
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    for (let i = 0; i < 6; i += 1) {
      const plume = new THREE.Mesh(new THREE.ConeGeometry(0.22 * event.scale, 2.8 * event.scale, 6), material.clone());
      plume.rotation.set(Math.PI / 2 + Math.random() * 0.4, Math.random() * Math.PI, Math.random() * Math.PI);
      plume.position.set((Math.random() - 0.5) * event.scale, (Math.random() - 0.5) * event.scale, (Math.random() - 0.5) * event.scale);
      group.add(plume);
    }
  } else if (event.kind === 'muzzle') {
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1.15 * event.scale, 8, 8), material.clone());
    group.add(flash);

    const flare = new THREE.Mesh(new THREE.RingGeometry(0.5 * event.scale, 2.1 * event.scale, 8), material.clone());
    flare.rotation.x = Math.PI / 2;
    group.add(flare);
  } else if (event.kind === 'pickup') {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85 * event.scale, 1), material.clone());
    group.add(core);

    for (let i = 0; i < 3; i += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry((1.2 + i * 0.42) * event.scale, 0.04 * event.scale, 6, 28), material.clone());
      ring.rotation.set(Math.PI / 2, Math.random() * Math.PI, Math.random() * Math.PI);
      group.add(ring);
    }
  } else if (event.kind === 'smoke') {
    const smokeMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < 3; i += 1) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry((0.45 + Math.random() * 0.35) * event.scale, 1), smokeMaterial.clone());
      puff.position.set((Math.random() - 0.5) * event.scale, Math.random() * event.scale, (Math.random() - 0.5) * event.scale);
      group.add(puff);
    }
  } else {
    const sparkCount = event.kind === 'spark' ? 5 : 8;
    for (let i = 0; i < sparkCount; i += 1) {
      const spark = new THREE.Mesh(new THREE.BoxGeometry(0.15 * event.scale, 0.15 * event.scale, 2.2 * event.scale), material.clone());
      spark.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      group.add(spark);
    }
  }

  const light = new THREE.PointLight(event.color, event.kind === 'explosion' ? 4 : event.kind === 'muzzle' ? 2.2 : 1.6, event.kind === 'explosion' ? 36 : 14);
  group.add(light);

  const life = getEffectLife(event.kind);
  return {
    object: group,
    velocity: event.kind === 'smoke'
      ? new THREE.Vector3((Math.random() - 0.5) * 1.4, 2 + Math.random() * 2, (Math.random() - 0.5) * 1.4)
      : new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4),
    life,
    maxLife: life,
  };
}

function getEffectLife(kind: CombatEvent['kind']): number {
  if (kind === 'explosion') return 0.55;
  if (kind === 'launch') return 0.34;
  if (kind === 'muzzle') return 0.12;
  if (kind === 'pickup') return 0.42;
  if (kind === 'smoke') return 0.72;
  return 0.22;
}
