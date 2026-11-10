/**
 * Segments de polyligne en arc (« renflement » DXF, code 42) :
 * bulge = tan(θ/4), θ = angle inclus signé (> 0 = sens trigonométrique de a vers b).
 */
import type { Vec3 } from '../commands/types';

export interface BulgeArc {
  center: Vec3;
  radius: number;
  /** Angle de départ (radians) et balayage signé. */
  start: number;
  sweep: number;
}

export const isArcBulge = (b: number | undefined): b is number => !!b && Math.abs(b) > 1e-9;

export function bulgeArc(a: Vec3, b: Vec3, bulge: number): BulgeArc {
  const theta = 4 * Math.atan(bulge);
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy) || 1e-12;
  const r = chord / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const nx = -dy / chord, ny = dx / chord;
  const center = { x: (a.x + b.x) / 2 + nx * h, y: (a.y + b.y) / 2 + ny * h, z: (a.z + b.z) / 2 };
  return { center, radius: Math.abs(r), start: Math.atan2(a.y - center.y, a.x - center.x), sweep: theta };
}

export function bulgePoint(a: Vec3, b: Vec3, bulge: number, t: number): Vec3 {
  if (!isArcBulge(bulge)) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  const arc = bulgeArc(a, b, bulge);
  const ang = arc.start + arc.sweep * t;
  return { x: arc.center.x + arc.radius * Math.cos(ang), y: arc.center.y + arc.radius * Math.sin(ang), z: a.z + (b.z - a.z) * t };
}

/**
 * Points d'un segment (extrémités comprises). `maxErr` > 0 borne l'écart à l'arc (flèche) :
 * les petits arcs des très longues polylignes ne sont alors pas sur-discrétisés.
 */
export function segmentPoints(a: Vec3, b: Vec3, bulge: number | undefined, perTurn = 96, maxErr = 0): Vec3[] {
  if (!isArcBulge(bulge)) return [a, b];
  const sweep = Math.abs(4 * Math.atan(bulge));
  let n = Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * perTurn));
  if (maxErr > 0) {
    const r = Math.hypot(b.x - a.x, b.y - a.y) / (2 * Math.sin(sweep / 2));
    n = r > maxErr ? Math.min(n, Math.max(2, Math.ceil(sweep / (2 * Math.acos(1 - maxErr / r))))) : 2;
  }
  return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? a : i === n ? b : bulgePoint(a, b, bulge, i / n)));
}

/** Points discrétisés d'une polyligne, avec la position (segment, t) de chaque point. */
export function polylineSamples(points: Vec3[], closed: boolean, bulges?: number[]): { pts: Vec3[]; seg: number[]; t: number[] } {
  const n = points.length;
  const pts: Vec3[] = [];
  const seg: number[] = [];
  const ts: number[] = [];
  if (!n) return { pts, seg, t: ts };
  const segs = closed && n > 2 ? n : n - 1;
  // longues polylignes (contours importés) : tolérance relative à leur taille
  let maxErr = 0;
  if (bulges && segs > 256) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
    maxErr = Math.hypot(x1 - x0, y1 - y0) * 1e-5;
  }
  pts.push(points[0]!), seg.push(0), ts.push(0);
  for (let i = 0; i < segs; i++) {
    const s = segmentPoints(points[i]!, points[(i + 1) % n]!, bulges?.[i], 96, maxErr);
    for (let k = 1; k < s.length; k++) {
      pts.push(s[k]!);
      seg.push(i);
      ts.push(k / (s.length - 1));
    }
  }
  if (segs <= 0) return { pts: [points[0]!], seg: [0], t: [0] };
  return { pts, seg, t: ts };
}

/** Renflement d'un arc de balayage signé. */
export const bulgeFromSweep = (sweep: number): number => Math.tan(sweep / 4);

/** Paramètre t ∈ [0,1] du point p (supposé sur le segment) le long du segment. */
export function segmentParam(a: Vec3, b: Vec3, bulge: number | undefined, p: Vec3): number {
  if (!isArcBulge(bulge)) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    return l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  }
  const arc = bulgeArc(a, b, bulge);
  let d = Math.atan2(p.y - arc.center.y, p.x - arc.center.x) - arc.start;
  if (arc.sweep > 0) while (d < 0) d += 2 * Math.PI;
  else while (d > 0) d -= 2 * Math.PI;
  return Math.max(0, Math.min(1, d / arc.sweep));
}

/** Sous-segment [t0, t1] : nouveau renflement (même centre, angle proportionnel). */
export function subBulge(bulge: number | undefined, t0: number, t1: number): number {
  if (!isArcBulge(bulge)) return 0;
  return Math.tan(((4 * Math.atan(bulge)) * (t1 - t0)) / 4);
}
