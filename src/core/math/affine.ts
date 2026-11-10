/**
 * Transformations affines 3D au format du noyau : matrice 3×4 ligne par ligne
 * [a11 a12 a13 tx, a21 a22 a23 ty, a31 a32 a33 tz]. Rotation + échelle uniforme + symétries.
 */
import type { Vec3 } from '../commands/types';
import type { Affine } from '../../kernel/protocol';

export type { Affine };

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function translation(d: Vec3): Affine {
  return [1, 0, 0, d.x, 0, 1, 0, d.y, 0, 0, 1, d.z];
}

/** Rotation d'angle `a` (radians, sens trigonométrique) autour de l'axe Z passant par `c`. */
export function rotationZ(c: Vec3, a: number): Affine {
  const cos = Math.cos(a), sin = Math.sin(a);
  return [cos, -sin, 0, c.x - cos * c.x + sin * c.y, sin, cos, 0, c.y - sin * c.x - cos * c.y, 0, 0, 1, 0];
}

/** Symétrie par rapport à la droite (p1, p2) du plan XY (plan vertical contenant la droite). */
export function mirrorLine(p1: Vec3, p2: Vec3): Affine {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) throw new Error('Les deux points de l’axe de symétrie sont confondus.');
  const ux = dx / l, uy = dy / l;
  const a = 2 * ux * ux - 1, b = 2 * ux * uy, d = 2 * uy * uy - 1;
  return [a, b, 0, p1.x - a * p1.x - b * p1.y, b, d, 0, p1.y - b * p1.x - d * p1.y, 0, 0, 1, 0];
}

/** Rotation d'angle `a` (radians, sens direct) autour de l'axe passant par `c` de direction `u`. */
export function rotationAxis(c: Vec3, u: Vec3, a: number): Affine {
  const l = Math.hypot(u.x, u.y, u.z) || 1;
  const x = u.x / l, y = u.y / l, z = u.z / l;
  const co = Math.cos(a), si = Math.sin(a), t = 1 - co;
  const r = [
    t * x * x + co, t * x * y - si * z, t * x * z + si * y,
    t * x * y + si * z, t * y * y + co, t * y * z - si * x,
    t * x * z - si * y, t * y * z + si * x, t * z * z + co,
  ];
  const tx = c.x - (r[0]! * c.x + r[1]! * c.y + r[2]! * c.z);
  const ty = c.y - (r[3]! * c.x + r[4]! * c.y + r[5]! * c.z);
  const tz = c.z - (r[6]! * c.x + r[7]! * c.y + r[8]! * c.z);
  return [r[0]!, r[1]!, r[2]!, tx, r[3]!, r[4]!, r[5]!, ty, r[6]!, r[7]!, r[8]!, tz];
}

export function scaling(c: Vec3, s: number): Affine {
  return [s, 0, 0, c.x * (1 - s), 0, s, 0, c.y * (1 - s), 0, 0, s, c.z * (1 - s)];
}

export function apply(m: Affine, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  };
}

export function applyVector(m: Affine, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[4] * v.x + m[5] * v.y + m[6] * v.z,
    z: m[8] * v.x + m[9] * v.y + m[10] * v.z,
  };
}

/** Facteur d'échelle uniforme (racine cubique du déterminant, en valeur absolue). */
export function scaleFactor(m: Affine): number {
  return Math.cbrt(Math.abs(determinant(m)));
}

export function determinant(m: Affine): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Composition : applique `b` puis `a`. */
export function multiply(a: Affine, b: Affine): Affine {
  const r = new Array<number>(12) as Affine;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] = a[i * 4]! * b[j]! + a[i * 4 + 1]! * b[4 + j]! + a[i * 4 + 2]! * b[8 + j]! + (j === 3 ? a[i * 4 + 3]! : 0);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Petits outils vectoriels partagés
// ---------------------------------------------------------------------------

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export const norm = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
export const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const angleXY = (from: Vec3, to: Vec3): number => Math.atan2(to.y - from.y, to.x - from.x);
export const polar = (c: Vec3, r: number, a: number): Vec3 => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: c.z });

/** Isométrie (rotation, symétrie, translation) : la matrice ne change aucune dimension. */
export function isIsometry(m: Affine, tol = 1e-9): boolean {
  const c = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = i; j < 3; j++) {
      const d = c[i]![0]! * c[j]![0]! + c[i]![1]! * c[j]![1]! + c[i]![2]! * c[j]![2]!;
      if (Math.abs(d - (i === j ? 1 : 0)) > tol) return false;
    }
  return true;
}
