export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len > 0.0001 ? scale(v, 1 / len) : vec3();
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function forwardFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return normalize({
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: Math.cos(yaw) * cp,
  });
}

export function rightFromYaw(yaw: number): Vec3 {
  return normalize({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) });
}
