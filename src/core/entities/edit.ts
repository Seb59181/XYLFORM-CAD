/**
 * Édition 2D : AJUSTER, PROLONGER, COUPURE, RACCORD, CHANFREIN, JOINDRE, DECOMPOS, DIVISER,
 * poignées, cercles tangents (TTR), parties d'entités pour les contraintes et détection des
 * contours de hachures par point interne.
 *
 * Les intersections sont analytiques pour les droites, arcs, cercles et polylignes (segments
 * droits ou en arc) ; ellipses, splines et hélices passent par leur discrétisation.
 */
import type { Vec3 } from '../commands/types';
import type { Entity, NewEntity } from '../document/Document';
import { add, dist, dot, lerp, norm, polar, scale, sub } from '../math/affine';
import { bulgeArc, bulgeFromSweep, isArcBulge, polylineSamples, segmentParam, subBulge, bulgePoint } from './bulge';
import {
  arcSweep,
  circleCircle,
  curvePoints,
  dimensionGeometry,
  dimensionLabel,
  entityBBox,
  lineCircle,
  nearestOnPolylines,
  nearestOnSegment,
  normAngle,
  pointInLoops,
  polygonArea,
  segmentIntersection,
} from './geometry';

const TAU = Math.PI * 2;
const EPS = 1e-9;

type Line = Extract<Entity, { type: 'LINE' }>;
type Arc = Extract<Entity, { type: 'ARC' }>;
type Circle = Extract<Entity, { type: 'CIRCLE' }>;
type Poly = Extract<Entity, { type: 'POLYLINE' }>;

// ---------------------------------------------------------------------------
// Éléments géométriques élémentaires
// ---------------------------------------------------------------------------

export type Element =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  /** Arc : départ et balayage signé (cercle complet : balayage 2π). */
  | { kind: 'arc'; center: Vec3; radius: number; start: number; sweep: number }
  | { kind: 'poly'; pts: Vec3[] };

export function elementsOf(e: Entity): Element[] {
  switch (e.type) {
    case 'LINE':
      return [{ kind: 'line', a: e.start, b: e.end }];
    case 'CIRCLE':
      return [{ kind: 'arc', center: e.center, radius: e.radius, start: 0, sweep: TAU }];
    case 'ARC':
      return [{ kind: 'arc', center: e.center, radius: e.radius, start: e.startAngle, sweep: arcSweep(e.startAngle, e.endAngle) }];
    case 'POLYLINE': {
      const n = e.points.length;
      const out: Element[] = [];
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        if (isArcBulge(bu)) {
          const arc = bulgeArc(a, b, bu);
          out.push({ kind: 'arc', center: arc.center, radius: arc.radius, start: arc.start, sweep: arc.sweep });
        } else out.push({ kind: 'line', a, b });
      }
      return out;
    }
    case 'ELLIPSE':
    case 'SPLINE':
    case 'HELIX':
      return curvePoints(e).map((pts) => ({ kind: 'poly', pts }));
    case 'HATCH':
      return [];
    case 'DIMENSION':
      return dimensionGeometry(e).lines.map((pts) => ({ kind: 'poly', pts }));
    default:
      return [];
  }
}

function onArc(el: Extract<Element, { kind: 'arc' }>, p: Vec3): boolean {
  if (Math.abs(el.sweep) >= TAU - 1e-12) return true;
  const a = Math.atan2(p.y - el.center.y, p.x - el.center.x);
  const d = el.sweep > 0 ? normAngle(a - el.start) : normAngle(el.start - a);
  return d <= Math.abs(el.sweep) + 1e-9;
}

function onSeg(a: Vec3, b: Vec3, p: Vec3): boolean {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-24) return false;
  const t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  return t >= -1e-9 && t <= 1 + 1e-9;
}

function polySegments(pts: Vec3[]): Element[] {
  const out: Element[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push({ kind: 'line', a: pts[i]!, b: pts[i + 1]! });
  return out;
}

/** Intersections de deux éléments ; `extendP` traite `p` comme infini (droite / cercle complet). */
export function intersectElements(p: Element, q: Element, extendP = false): Vec3[] {
  if (p.kind === 'poly') return polySegments(p.pts).flatMap((s) => intersectElements(s, q, false));
  if (q.kind === 'poly') return polySegments(q.pts).flatMap((s) => intersectElements(p, s, extendP));
  if (p.kind === 'line' && q.kind === 'line') {
    const x = segmentIntersection(p.a, p.b, q.a, q.b, true);
    if (!x) return [];
    return (extendP || onSeg(p.a, p.b, x)) && onSeg(q.a, q.b, x) ? [x] : [];
  }
  if (p.kind === 'line' && q.kind === 'arc')
    return lineCircle(p.a, p.b, q.center, q.radius).filter((x) => (extendP || onSeg(p.a, p.b, x)) && onArc(q, x));
  if (p.kind === 'arc' && q.kind === 'line')
    return lineCircle(q.a, q.b, p.center, p.radius).filter((x) => onSeg(q.a, q.b, x) && (extendP || onArc(p, x)));
  if (p.kind === 'arc' && q.kind === 'arc')
    return circleCircle(p.center, p.radius, q.center, q.radius).filter((x) => (extendP || onArc(p, x)) && onArc(q, x));
  return [];
}

/** Toutes les intersections de `e` avec les autres entités (z de `e`). */
export function intersectionsWith(e: Entity, others: Entity[], extend = false): Vec3[] {
  const mine = elementsOf(e);
  const out: Vec3[] = [];
  for (const o of others) {
    if (o.handle === e.handle) continue;
    for (const q of elementsOf(o)) for (const p of mine) out.push(...intersectElements(p, q, extend));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paramétrage le long d'une entité
// ---------------------------------------------------------------------------

/** Paramètre de `p` : LINE t∈[0,1], ARC angle depuis le départ, CIRCLE angle, POLYLINE segment + t. */
export function paramOf(e: Entity, p: Vec3): number {
  switch (e.type) {
    case 'LINE':
      return segmentParam(e.start, e.end, 0, p);
    case 'ARC':
      return normAngle(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle);
    case 'CIRCLE':
      return normAngle(Math.atan2(p.y - e.center.y, p.x - e.center.x));
    case 'POLYLINE': {
      const n = e.points.length;
      let best = { d: Infinity, s: 0 };
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        const t = segmentParam(a, b, bu, p);
        const q = bulgePoint(a, b, bu ?? 0, t);
        const d = dist(p, q);
        if (d < best.d) best = { d, s: i + t };
      }
      return best.s;
    }
    default:
      return 0;
  }
}

export function pointAt(e: Entity, s: number): Vec3 {
  switch (e.type) {
    case 'LINE':
      return lerp(e.start, e.end, s);
    case 'ARC':
      return polar(e.center, e.radius, e.startAngle + s);
    case 'CIRCLE':
      return polar(e.center, e.radius, s);
    case 'POLYLINE': {
      const n = e.points.length;
      const segs = e.closed ? n : n - 1;
      const i = Math.min(Math.floor(s), segs - 1);
      const t = s - i;
      return bulgePoint(e.points[i]!, e.points[(i + 1) % n]!, e.bulges?.[i] ?? 0, t);
    }
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

function paramEnd(e: Entity): number {
  if (e.type === 'LINE') return 1;
  if (e.type === 'ARC') return arcSweep(e.startAngle, e.endAngle);
  if (e.type === 'CIRCLE') return TAU;
  if (e.type === 'POLYLINE') return e.closed ? e.points.length : e.points.length - 1;
  return 0;
}

const periodic = (e: Entity) => e.type === 'CIRCLE' || (e.type === 'POLYLINE' && e.closed);

/** Morceau de l'entité entre deux paramètres (s0 < s1, ou à cheval sur l'origine si périodique). */
export function pieceBetween(e: Entity, s0: number, s1: number): NewEntity | null {
  const base = { layer: e.layer, color: e.color };
  switch (e.type) {
    case 'LINE': {
      const a = pointAt(e, s0), b = pointAt(e, s1);
      return dist(a, b) < EPS ? null : { ...base, type: 'LINE', start: a, end: b };
    }
    case 'ARC': {
      if (s1 - s0 < 1e-9) return null;
      return { ...base, type: 'ARC', center: e.center, radius: e.radius, startAngle: normAngle(e.startAngle + s0), endAngle: normAngle(e.startAngle + s1) };
    }
    case 'CIRCLE': {
      let span = s1 - s0;
      if (span <= 0) span += TAU;
      if (span < 1e-9) return null;
      return { ...base, type: 'ARC', center: e.center, radius: e.radius, startAngle: normAngle(s0), endAngle: normAngle(s0 + span) };
    }
    case 'POLYLINE':
      return subPolyline(e, s0, s1);
    default:
      return null;
  }
}

function subPolyline(e: Poly, s0: number, s1: number): NewEntity | null {
  const n = e.points.length;
  const segs = e.closed ? n : n - 1;
  let end = s1;
  if (e.closed && end <= s0) end += segs;
  if (end - s0 < 1e-9) return null;
  const pts: Vec3[] = [];
  const bulges: number[] = [];
  let s = s0;
  while (s < end - 1e-9) {
    const i = Math.floor(s + 1e-12) % segs;
    const segStart = Math.floor(s + 1e-12);
    const t0 = s - segStart;
    const t1 = Math.min(1, end - segStart);
    const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i] ?? 0;
    pts.push(bulgePoint(a, b, bu, t0));
    bulges.push(subBulge(bu, t0, t1));
    s = segStart + t1;
    if (t1 >= 1 - 1e-12) s = segStart + 1;
  }
  const last = Math.floor(end - 1e-12);
  const li = last % segs;
  pts.push(bulgePoint(e.points[li]!, e.points[(li + 1) % n]!, e.bulges?.[li] ?? 0, end - last));
  if (pts.length < 2) return null;
  bulges.push(0);
  return { layer: e.layer, color: e.color, type: 'POLYLINE', points: pts, closed: false, bulges: bulges.some(isArcBulge) ? bulges : undefined };
}

// ---------------------------------------------------------------------------
// AJUSTER / COUPURE / PROLONGER
// ---------------------------------------------------------------------------

export const TRIMMABLE = new Set<Entity['type']>(['LINE', 'ARC', 'CIRCLE', 'POLYLINE']);

/**
 * AJUSTER (mode rapide) : supprime la portion de `e` désignée en `pick`, délimitée par les
 * intersections avec `cutters`. Renvoie les morceaux restants (tableau vide = supprimer).
 */
export function trimEntity(e: Entity, pick: Vec3, cutters: Entity[]): NewEntity[] | null {
  if (!TRIMMABLE.has(e.type)) return null;
  const sp = paramOf(e, pick);
  const end = paramEnd(e);
  const params = dedupeParams(intersectionsWith(e, cutters).map((p) => paramOf(e, p)), end, periodic(e));
  if (periodic(e)) {
    if (params.length < 2) return params.length === 0 ? [] : null;
    const lo = [...params].reverse().find((s) => s < sp) ?? params[params.length - 1]!;
    const hi = params.find((s) => s > sp) ?? params[0]!;
    const piece = pieceBetween(e, hi, lo);
    return piece ? [piece] : [];
  }
  const lo = [...params].reverse().find((s) => s < sp - 1e-9 && s > 1e-9);
  const hi = params.find((s) => s > sp + 1e-9 && s < end - 1e-9);
  if (lo === undefined && hi === undefined) return [];
  const out: NewEntity[] = [];
  if (lo !== undefined) {
    const p = pieceBetween(e, 0, lo);
    if (p) out.push(p);
  }
  if (hi !== undefined) {
    const p = pieceBetween(e, hi, end);
    if (p) out.push(p);
  }
  return out;
}

function dedupeParams(ps: number[], end: number, isPeriodic: boolean): number[] {
  const sorted = ps.map((s) => (isPeriodic ? ((s % end) + end) % end : s)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of sorted) if (!out.length || s - out[out.length - 1]! > 1e-7) out.push(s);
  return out;
}

/** COUPURE entre deux points (identiques = coupure au point). */
export function breakEntity(e: Entity, p1: Vec3, p2: Vec3): NewEntity[] | null {
  if (!TRIMMABLE.has(e.type)) return null;
  let s1 = paramOf(e, p1), s2 = paramOf(e, p2);
  const end = paramEnd(e);
  if (periodic(e)) {
    if (Math.abs(s1 - s2) < 1e-9) {
      if (e.type === 'CIRCLE') return null; // un cercle ne se coupe pas en un point
      const p = pieceBetween(e, s1, s1 + end - 1e-9);
      return p ? [p] : null;
    }
    // portion supprimée de s1 vers s2 (sens trigo pour un cercle)
    const p = pieceBetween(e, s2, s1);
    return p ? [p] : [];
  }
  if (s1 > s2) [s1, s2] = [s2, s1];
  const out: NewEntity[] = [];
  const a = pieceBetween(e, 0, s1);
  const b = pieceBetween(e, s2, end);
  if (a) out.push(a);
  if (b) out.push(b);
  return out;
}

/** PROLONGER : l'extrémité la plus proche de `pick` jusqu'à la première frontière rencontrée. */
export function extendEntity(e: Entity, pick: Vec3, boundaries: Entity[]): Partial<NewEntity> | null {
  if (e.type === 'LINE') {
    const atEnd = dist(pick, e.end) < dist(pick, e.start);
    const hits = intersectionsWith(e, boundaries, true).map((p) => ({ p, t: segmentParam(e.start, e.end, 0, p), raw: rawParam(e.start, e.end, p) }));
    const cands = hits.filter((h) => (atEnd ? h.raw > 1 + 1e-9 : h.raw < -1e-9)).sort((a, b) => (atEnd ? a.raw - b.raw : b.raw - a.raw));
    const h = cands[0];
    if (!h) return null;
    return atEnd ? { end: { ...h.p, z: e.end.z } } : { start: { ...h.p, z: e.start.z } };
  }
  if (e.type === 'ARC') {
    const sa = polar(e.center, e.radius, e.startAngle), ea = polar(e.center, e.radius, e.endAngle);
    const atEnd = dist(pick, ea) < dist(pick, sa);
    const full: Element = { kind: 'arc', center: e.center, radius: e.radius, start: 0, sweep: TAU };
    const hits: number[] = [];
    for (const o of boundaries) {
      if (o.handle === e.handle) continue;
      for (const q of elementsOf(o)) for (const x of intersectElements(full, q)) hits.push(Math.atan2(x.y - e.center.y, x.x - e.center.x));
    }
    const sweep = arcSweep(e.startAngle, e.endAngle);
    const outside = hits
      .map((a) => (atEnd ? normAngle(a - e.endAngle) : normAngle(e.startAngle - a)))
      .filter((d) => d > 1e-9 && d < TAU - sweep - 1e-9)
      .sort((a, b) => a - b);
    const d = outside[0];
    if (d === undefined) return null;
    return atEnd ? { endAngle: normAngle(e.endAngle + d) } : { startAngle: normAngle(e.startAngle - d) };
  }
  if (e.type === 'POLYLINE' && !e.closed && e.points.length >= 2) {
    const n = e.points.length;
    const atEnd = dist(pick, e.points[n - 1]!) < dist(pick, e.points[0]!);
    const i = atEnd ? n - 2 : 0;
    if (isArcBulge(e.bulges?.[i])) return null;
    const a = e.points[i]!, b = e.points[i + 1]!;
    const fake: Line = { type: 'LINE', handle: e.handle, layer: e.layer, start: a, end: b };
    const patch = extendEntity(fake, atEnd ? b : a, boundaries) as { start?: Vec3; end?: Vec3 } | null;
    if (!patch) return null;
    const pts = [...e.points];
    if (atEnd && patch.end) pts[n - 1] = patch.end;
    if (!atEnd && patch.start) pts[0] = patch.start;
    return { points: pts };
  }
  return null;
}

function rawParam(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  return l2 < 1e-24 ? 0 : ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
}

// ---------------------------------------------------------------------------
// RACCORD / CHANFREIN entre deux lignes
// ---------------------------------------------------------------------------

interface CornerSolve {
  x: Vec3;
  u1: Vec3;
  u2: Vec3;
  /** Extrémité conservée de chaque ligne (côté opposé au coin). */
  far1: Vec3;
  far2: Vec3;
}

function corner(l1: Line, p1: Vec3, l2: Line, p2: Vec3): CornerSolve | null {
  const x = segmentIntersection(l1.start, l1.end, l2.start, l2.end, true);
  if (!x) return null;
  // partie conservée de chaque ligne : celle du côté du point désigné par rapport au coin
  const side = (l: Line, p: Vec3) => {
    const q = nearestOnSegment(p, l.start, l.end).point;
    const farthest = dist(l.start, x) > dist(l.end, x) ? l.start : l.end;
    let keep = farthest;
    if (dist(q, x) > 1e-9) {
      const sameSide = [l.start, l.end].filter((e) => dot(sub(e, x), sub(q, x)) > 0);
      keep = sameSide.sort((a, b) => dist(b, x) - dist(a, x))[0] ?? farthest;
    }
    return { u: norm(sub(keep, x)), far: keep };
  };
  const s1 = side(l1, p1), s2 = side(l2, p2);
  return { x, u1: s1.u, u2: s2.u, far1: s1.far, far2: s2.far };
}

export interface FilletResult {
  line1: Partial<NewEntity>;
  line2: Partial<NewEntity>;
  arc?: NewEntity;
  segment?: NewEntity;
}

export function filletLines(l1: Line, p1: Vec3, l2: Line, p2: Vec3, r: number): FilletResult | string {
  const c = corner(l1, p1, l2, p2);
  if (!c) return 'Les lignes sont parallèles.';
  const cosPhi = Math.max(-1, Math.min(1, dot(c.u1, c.u2)));
  const phi = Math.acos(cosPhi);
  if (phi < 1e-6 || Math.PI - phi < 1e-6) return 'Les lignes sont colinéaires.';
  if (r < 1e-12) return { line1: { start: c.far1, end: c.x }, line2: { start: c.far2, end: c.x } };
  const t = r / Math.tan(phi / 2);
  if (t > dist(c.far1, c.x) + 1e-9 || t > dist(c.far2, c.x) + 1e-9) return 'Rayon trop grand.';
  const t1 = add(c.x, scale(c.u1, t)), t2 = add(c.x, scale(c.u2, t));
  const bis = norm(add(c.u1, c.u2));
  const center = add(c.x, scale(bis, r / Math.sin(phi / 2)));
  let a1 = Math.atan2(t1.y - center.y, t1.x - center.x), a2 = Math.atan2(t2.y - center.y, t2.x - center.x);
  if (normAngle(a2 - a1) > Math.PI) [a1, a2] = [a2, a1];
  return {
    line1: { start: c.far1, end: t1 },
    line2: { start: c.far2, end: t2 },
    arc: { type: 'ARC', center: { ...center, z: c.x.z }, radius: r, startAngle: normAngle(a1), endAngle: normAngle(a2), layer: l1.layer },
  };
}

export function chamferLines(l1: Line, p1: Vec3, l2: Line, p2: Vec3, d1: number, d2: number): FilletResult | string {
  const c = corner(l1, p1, l2, p2);
  if (!c) return 'Les lignes sont parallèles.';
  if (d1 < 1e-12 && d2 < 1e-12) return { line1: { start: c.far1, end: c.x }, line2: { start: c.far2, end: c.x } };
  if (d1 > dist(c.far1, c.x) + 1e-9 || d2 > dist(c.far2, c.x) + 1e-9) return 'Distance de chanfrein trop grande.';
  const t1 = add(c.x, scale(c.u1, d1)), t2 = add(c.x, scale(c.u2, d2));
  return { line1: { start: c.far1, end: t1 }, line2: { start: c.far2, end: t2 }, segment: { type: 'LINE', start: t1, end: t2, layer: l1.layer } };
}

/** RACCORD / CHANFREIN option Polyligne : traite tous les sommets entre segments droits. */
export function filletPolyline(e: Poly, r: number, chamfer?: { d1: number; d2: number }): { points: Vec3[]; bulges: number[]; count: number } {
  const n = e.points.length;
  const segs = e.closed ? n : n - 1;
  const pts: Vec3[] = [];
  const bulges: number[] = [];
  let count = 0;
  const isStraight = (i: number) => !isArcBulge(e.bulges?.[((i % segs) + segs) % segs]);
  for (let i = 0; i < n; i++) {
    const prevSeg = i - 1, nextSeg = i;
    const interior = e.closed || (i > 0 && i < n - 1);
    const p = e.points[i]!;
    if (!interior || !isStraight(prevSeg) || !isStraight(nextSeg)) {
      pts.push(p);
      bulges.push(e.bulges?.[i] ?? 0);
      continue;
    }
    const a = e.points[(i - 1 + n) % n]!, b = e.points[(i + 1) % n]!;
    const u1 = norm(sub(a, p)), u2 = norm(sub(b, p));
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
    if (phi < 1e-6 || Math.PI - phi < 1e-6) {
      pts.push(p);
      bulges.push(0);
      continue;
    }
    const t1d = chamfer ? chamfer.d1 : r / Math.tan(phi / 2);
    const t2d = chamfer ? chamfer.d2 : t1d;
    if (t1d > dist(a, p) / (e.closed || i - 1 > 0 ? 2 : 1) + 1e-9 || t2d > dist(b, p) / (e.closed || i + 1 < n - 1 ? 2 : 1) + 1e-9) {
      pts.push(p);
      bulges.push(0);
      continue;
    }
    const t1 = add(p, scale(u1, t1d)), t2 = add(p, scale(u2, t2d));
    // virage à gauche (a→p→b) = arc trigonométrique
    const turn = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
    pts.push(t1, t2);
    bulges.push(chamfer ? 0 : bulgeFromSweep(Math.sign(turn) * (Math.PI - phi)), 0);
    count++;
  }
  return { points: pts, bulges, count };
}

// ---------------------------------------------------------------------------
// JOINDRE / DECOMPOS / DIVISER
// ---------------------------------------------------------------------------

interface Chain {
  pts: Vec3[];
  bulges: number[];
}

function asChain(e: Entity): Chain | null {
  switch (e.type) {
    case 'LINE':
      return { pts: [e.start, e.end], bulges: [0, 0] };
    case 'ARC': {
      const sweep = arcSweep(e.startAngle, e.endAngle);
      return { pts: [polar(e.center, e.radius, e.startAngle), polar(e.center, e.radius, e.endAngle)], bulges: [bulgeFromSweep(sweep), 0] };
    }
    case 'POLYLINE':
      if (e.closed) return null;
      return { pts: [...e.points], bulges: e.points.map((_, i) => e.bulges?.[i] ?? 0) };
    default:
      return null;
  }
}

function reverseChain(c: Chain): Chain {
  const pts = [...c.pts].reverse();
  const segs = c.pts.length - 1;
  const bulges = Array.from({ length: segs }, (_, i) => -(c.bulges[segs - 1 - i] ?? 0));
  bulges.push(0);
  return { pts, bulges };
}

/** JOINDRE : enchaîne lignes, arcs et polylignes ouvertes dont les extrémités coïncident. */
export function joinEntities(es: Entity[], tol = 1e-6): { result: NewEntity[]; consumed: string[] } {
  const items = es.map((e) => ({ e, c: asChain(e) })).filter((x): x is { e: Entity; c: Chain } => !!x.c);
  const used = new Set<number>();
  const result: NewEntity[] = [];
  const consumed: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = items[i]!.c;
    const members = [items[i]!.e];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < items.length; j++) {
        if (used.has(j)) continue;
        const c = items[j]!.c;
        const head = chain.pts[0]!, tail = chain.pts[chain.pts.length - 1]!;
        const cs = c.pts[0]!, ce = c.pts[c.pts.length - 1]!;
        let next: Chain | null = null;
        let atTail = true;
        if (dist(tail, cs) < tol) next = c;
        else if (dist(tail, ce) < tol) next = reverseChain(c);
        else if (dist(head, ce) < tol) (next = c), (atTail = false);
        else if (dist(head, cs) < tol) (next = reverseChain(c)), (atTail = false);
        if (!next) continue;
        if (atTail) chain = { pts: [...chain.pts, ...next.pts.slice(1)], bulges: [...chain.bulges.slice(0, -1), ...next.bulges] };
        else chain = { pts: [...next.pts, ...chain.pts.slice(1)], bulges: [...next.bulges.slice(0, -1), ...chain.bulges] };
        used.add(j);
        members.push(items[j]!.e);
        grew = true;
      }
    }
    if (members.length < 2) continue;
    let closed = false;
    if (chain.pts.length > 3 && dist(chain.pts[0]!, chain.pts[chain.pts.length - 1]!) < tol) {
      closed = true;
      chain.pts.pop();
    }
    const first = members[0]!;
    result.push({
      type: 'POLYLINE',
      points: chain.pts,
      closed,
      bulges: chain.bulges.some(isArcBulge) ? chain.bulges.slice(0, chain.pts.length) : undefined,
      layer: first.layer,
      color: first.color,
    });
    consumed.push(...members.map((m) => m.handle));
  }
  return { result, consumed };
}

/** DECOMPOS : polyligne → lignes et arcs ; cote → lignes et texte ; hachures → contours. */
export function explodeEntity(e: Entity): NewEntity[] | null {
  const base = { layer: e.layer, color: e.color };
  switch (e.type) {
    case 'POLYLINE': {
      const n = e.points.length;
      const out: NewEntity[] = [];
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        if (isArcBulge(bu)) {
          const arc = bulgeArc(a, b, bu);
          const s = arc.sweep > 0 ? arc.start : arc.start + arc.sweep;
          out.push({ ...base, type: 'ARC', center: arc.center, radius: arc.radius, startAngle: normAngle(s), endAngle: normAngle(s + Math.abs(arc.sweep)) });
        } else if (dist(a, b) > EPS) out.push({ ...base, type: 'LINE', start: a, end: b });
      }
      return out;
    }
    case 'DIMENSION': {
      const g = dimensionGeometry(e);
      const out: NewEntity[] = [];
      const h = e.textHeight ?? 2.5;
      const lab = dimensionLabel(e, h);
      for (const l of [...g.lines, ...lab.lines]) for (let i = 0; i + 1 < l.length; i++) out.push({ ...base, type: 'LINE', start: l[i]!, end: l[i + 1]! });
      for (const t of lab.texts) out.push({ ...base, type: 'TEXT', position: t.at, height: t.height, text: t.text, rotation: lab.angle, align: 'center' });
      for (const f of g.fills) out.push({ ...base, type: 'HATCH', boundaries: [f.slice(0, 3)], pattern: 'SOLID', scale: 1, angle: 0 });
      return out;
    }
    case 'HATCH':
      return e.boundaries.map((b) => ({ ...base, type: 'POLYLINE', points: b, closed: true }));
    default:
      return null;
  }
}

/** DIVISER : points régulièrement espacés le long de l'entité (n segments → n−1 points). */
export function dividePoints(e: Entity, n: number): Vec3[] {
  if (n < 2) return [];
  if (e.type === 'CIRCLE') return Array.from({ length: n }, (_, i) => polar(e.center, e.radius, (TAU * i) / n));
  if (e.type === 'ARC') {
    const sw = arcSweep(e.startAngle, e.endAngle);
    return Array.from({ length: n - 1 }, (_, i) => polar(e.center, e.radius, e.startAngle + (sw * (i + 1)) / n));
  }
  if (e.type === 'LINE') return Array.from({ length: n - 1 }, (_, i) => lerp(e.start, e.end, (i + 1) / n));
  const pts = curvePoints(e)[0];
  if (!pts || pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const total = cum[cum.length - 1]!;
  const closed = (e.type === 'POLYLINE' || e.type === 'SPLINE') && e.closed;
  const count = closed ? n : n - 1;
  const out: Vec3[] = [];
  let j = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * (closed ? k : k + 1)) / n;
    while (j < cum.length - 1 && cum[j]! < target) j++;
    const seg = cum[j]! - cum[j - 1]! || 1;
    out.push(lerp(pts[j - 1]!, pts[j]!, (target - cum[j - 1]!) / seg));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poignées
// ---------------------------------------------------------------------------

export interface Grip {
  point: Vec3;
  /** Nouvelle géométrie quand la poignée est amenée en `p`. */
  apply(p: Vec3): Partial<NewEntity>;
}

export function gripsOf(e: Entity): Grip[] {
  const move = (pts: Vec3[], k: number) => (p: Vec3) => pts.map((q, i) => (i === k ? p : q));
  switch (e.type) {
    case 'LINE': {
      const m = lerp(e.start, e.end, 0.5);
      return [
        { point: e.start, apply: (p) => ({ start: p }) },
        { point: e.end, apply: (p) => ({ end: p }) },
        { point: m, apply: (p) => ({ start: add(e.start, sub(p, m)), end: add(e.end, sub(p, m)) }) },
      ];
    }
    case 'CIRCLE':
      return [
        { point: e.center, apply: (p) => ({ center: p }) },
        ...[0, 1, 2, 3].map((i) => ({ point: polar(e.center, e.radius, (i * Math.PI) / 2), apply: (p: Vec3) => ({ radius: Math.max(1e-6, dist(p, e.center)) }) })),
      ];
    case 'ARC': {
      const sw = arcSweep(e.startAngle, e.endAngle);
      const sp = polar(e.center, e.radius, e.startAngle), ep = polar(e.center, e.radius, e.endAngle), mp = polar(e.center, e.radius, e.startAngle + sw / 2);
      return [
        { point: e.center, apply: (p) => ({ center: p }) },
        { point: sp, apply: (p) => ({ startAngle: normAngle(Math.atan2(p.y - e.center.y, p.x - e.center.x)) }) },
        { point: ep, apply: (p) => ({ endAngle: normAngle(Math.atan2(p.y - e.center.y, p.x - e.center.x)) }) },
        { point: mp, apply: (p) => ({ radius: Math.max(1e-6, dist(p, e.center)) }) },
      ];
    }
    case 'POLYLINE': {
      const grips: Grip[] = e.points.map((q, k) => ({ point: q, apply: (p: Vec3) => ({ points: move(e.points, k)(p) }) }));
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i] ?? 0;
        const m = bulgePoint(a, b, bu, 0.5);
        if (isArcBulge(bu)) {
          // milieu d'arc : change la courbure (arc passant par le point)
          grips.push({
            point: m,
            apply: (p) => {
              const half = dist(a, b) / 2 || 1;
              const u = norm(sub(b, a));
              const s = (p.x - (a.x + b.x) / 2) * u.y - (p.y - (a.y + b.y) / 2) * u.x;
              const bulges = e.points.map((_, k) => e.bulges?.[k] ?? 0);
              bulges[i] = s / half;
              return { bulges };
            },
          });
        } else
          grips.push({
            point: m,
            apply: (p) => {
              const d = sub(p, m);
              const pts = [...e.points];
              pts[i] = add(a, d);
              pts[(i + 1) % n] = add(b, d);
              return { points: pts };
            },
          });
      }
      return grips;
    }
    case 'ELLIPSE': {
      const minor = { x: -e.majorAxis.y * e.ratio, y: e.majorAxis.x * e.ratio, z: 0 };
      const majLen = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      return [
        { point: e.center, apply: (p) => ({ center: p }) },
        { point: add(e.center, e.majorAxis), apply: (p) => ({ majorAxis: sub(p, e.center) }) },
        { point: sub(e.center, e.majorAxis), apply: (p) => ({ majorAxis: sub(e.center, p) }) },
        { point: add(e.center, minor), apply: (p) => ({ ratio: Math.min(1, Math.max(1e-3, dist(p, e.center) / majLen)) }) },
      ];
    }
    case 'SPLINE':
      return e.fitPoints.map((q, k) => ({ point: q, apply: (p: Vec3) => ({ fitPoints: move(e.fitPoints, k)(p) }) }));
    case 'POINT':
      return [{ point: e.position, apply: (p) => ({ position: p }) }];
    case 'TEXT':
    case 'UNDERLAY':
      return [{ point: e.position, apply: (p) => ({ position: p }) }];
    case 'DIMENSION':
      if (e.dimType === 'leader')
        return [
          { point: e.p1, apply: (p) => ({ p1: p }) },
          { point: e.p2, apply: (p) => ({ p2: p, offsetPoint: p }) },
        ];
      return [
        { point: e.p1, apply: (p) => ({ p1: p }) },
        { point: e.p2, apply: (p) => ({ p2: p }) },
        { point: dimensionGeometry(e).textPos, apply: (p) => ({ offsetPoint: p }) },
        ...(e.center && e.dimType !== 'ordinate' ? [{ point: e.center, apply: (p: Vec3) => ({ center: p }) }] : []),
      ];
    case 'HELIX':
      return [{ point: e.center, apply: (p) => ({ center: p }) }, { point: polar(e.center, e.baseRadius, 0), apply: (p) => ({ baseRadius: Math.max(1e-6, dist(p, e.center)) }) }];
    case 'HATCH':
      return e.boundaries.flatMap((b, bi) =>
        b.map((q, k) => ({ point: q, apply: (p: Vec3) => ({ boundaries: e.boundaries.map((bb, j) => (j === bi ? move(bb, k)(p) : bb)) }) })),
      );
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Cercle tangent à deux objets (CERCLE option Ttr)
// ---------------------------------------------------------------------------

export function tangentTangentRadius(e1: Entity, p1: Vec3, e2: Entity, p2: Vec3, r: number): { center: Vec3; radius: number } | null {
  type Prim = { kind: 'line'; a: Vec3; b: Vec3 } | { kind: 'circle'; c: Vec3; r: number };
  const prim = (e: Entity, p: Vec3): Prim | null => {
    if (e.type === 'LINE') return { kind: 'line', a: e.start, b: e.end };
    if (e.type === 'CIRCLE' || e.type === 'ARC') return { kind: 'circle', c: e.center, r: e.radius };
    if (e.type === 'POLYLINE') {
      const s = paramOf(e, p);
      const n = e.points.length;
      const i = Math.min(Math.floor(s), (e.closed ? n : n - 1) - 1);
      const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
      if (isArcBulge(bu)) {
        const arc = bulgeArc(a, b, bu);
        return { kind: 'circle', c: arc.center, r: arc.radius };
      }
      return { kind: 'line', a, b };
    }
    return null;
  };
  const A = prim(e1, p1), B = prim(e2, p2);
  if (!A || !B) return null;
  // lieux des centres : droites décalées de ±r, cercles concentriques de rayon R ± r
  const loci = (P: Prim): Prim[] => {
    if (P.kind === 'line') {
      const u = norm(sub(P.b, P.a));
      const n = { x: -u.y, y: u.x, z: 0 };
      return [1, -1].map((s) => ({ kind: 'line' as const, a: add(P.a, scale(n, s * r)), b: add(P.b, scale(n, s * r)) }));
    }
    const out: Prim[] = [{ kind: 'circle', c: P.c, r: P.r + r }];
    if (Math.abs(P.r - r) > 1e-9) out.push({ kind: 'circle', c: P.c, r: Math.abs(P.r - r) });
    return out;
  };
  const meet = (a: Prim, b: Prim): Vec3[] => {
    if (a.kind === 'line' && b.kind === 'line') {
      const x = segmentIntersection(a.a, a.b, b.a, b.b, true);
      return x ? [x] : [];
    }
    if (a.kind === 'line' && b.kind === 'circle') return lineCircle(a.a, a.b, b.c, b.r);
    if (a.kind === 'circle' && b.kind === 'line') return lineCircle(b.a, b.b, a.c, a.r);
    if (a.kind === 'circle' && b.kind === 'circle') return circleCircle(a.c, a.r, b.c, b.r);
    return [];
  };
  const touch = (P: Prim, c: Vec3): Vec3 => (P.kind === 'line' ? projectOnLine(c, P.a, P.b) : add(P.c, scale(norm(sub(c, P.c)), P.r)));
  let best: { c: Vec3; score: number } | null = null;
  for (const la of loci(A))
    for (const lb of loci(B))
      for (const c of meet(la, lb)) {
        const score = dist(touch(A, c), p1) + dist(touch(B, c), p2);
        if (!best || score < best.score) best = { c, score };
      }
  return best ? { center: { ...best.c, z: p1.z }, radius: r } : null;
}

function projectOnLine(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y || 1e-24;
  const t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  return add(a, scale(ab, t));
}

// ---------------------------------------------------------------------------
// Parties d'entités (contraintes)
// ---------------------------------------------------------------------------

export type PartWant = 'point' | 'line' | 'circle' | 'any';

/** Partie de `e` la plus proche de `p` pour une contrainte (`start`, `v:2`, `seg:1`, `circle`…). */
export function partAt(e: Entity, p: Vec3, want: PartWant): string | null {
  const nearest = (cands: [string, Vec3][]) => cands.sort((a, b) => dist(a[1], p) - dist(b[1], p))[0]?.[0] ?? null;
  switch (want) {
    case 'point':
      if (e.type === 'LINE') return nearest([['start', e.start], ['end', e.end]]);
      if (e.type === 'ARC') return nearest([['start', polar(e.center, e.radius, e.startAngle)], ['end', polar(e.center, e.radius, e.endAngle)], ['center', e.center]]);
      if (e.type === 'CIRCLE' || e.type === 'ELLIPSE') return 'center';
      if (e.type === 'POLYLINE') return nearest(e.points.map((q, i) => [`v:${i}`, q] as [string, Vec3]));
      if (e.type === 'POINT') return 'point';
      return null;
    case 'line':
      if (e.type === 'LINE') return 'line';
      if (e.type === 'POLYLINE') {
        const s = paramOf(e, p);
        const i = Math.min(Math.floor(s), (e.closed ? e.points.length : e.points.length - 1) - 1);
        return isArcBulge(e.bulges?.[i]) ? null : `seg:${i}`;
      }
      return null;
    case 'circle':
      return e.type === 'CIRCLE' || e.type === 'ARC' ? 'circle' : null;
    case 'any':
      return partAt(e, p, 'circle') ?? partAt(e, p, 'line') ?? partAt(e, p, 'point');
  }
}

/** Position d'une partie (affichage des pictogrammes de contraintes). */
export function partPosition(e: Entity, part: string): Vec3 | null {
  switch (part) {
    case 'start':
      return e.type === 'LINE' ? e.start : e.type === 'ARC' ? polar(e.center, e.radius, e.startAngle) : null;
    case 'end':
      return e.type === 'LINE' ? e.end : e.type === 'ARC' ? polar(e.center, e.radius, e.endAngle) : null;
    case 'center':
      return e.type === 'CIRCLE' || e.type === 'ARC' || e.type === 'ELLIPSE' ? e.center : null;
    case 'circle':
      return e.type === 'CIRCLE' ? polar(e.center, e.radius, Math.PI / 4) : e.type === 'ARC' ? polar(e.center, e.radius, e.startAngle + arcSweep(e.startAngle, e.endAngle) / 2) : null;
    case 'line':
      return e.type === 'LINE' ? lerp(e.start, e.end, 0.5) : null;
    case 'point':
      return e.type === 'POINT' ? e.position : null;
  }
  if (e.type === 'POLYLINE') {
    const [k, idx] = part.split(':');
    const i = Number(idx);
    if (k === 'v') return e.points[i] ?? null;
    if (k === 'seg') return e.points[i] && e.points[(i + 1) % e.points.length] ? lerp(e.points[i]!, e.points[(i + 1) % e.points.length]!, 0.5) : null;
  }
  return null;
}

/** Segment (a, b) d'une partie « ligne » (cotes pilotées). */
export function partSegment(e: Entity, part: string): [Vec3, Vec3] | null {
  if (e.type === 'LINE' && part === 'line') return [e.start, e.end];
  if (e.type === 'POLYLINE' && part.startsWith('seg:')) {
    const i = Number(part.slice(4));
    const a = e.points[i], b = e.points[(i + 1) % e.points.length];
    return a && b ? [a, b] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HACHURES : détection du contour autour d'un point interne
// ---------------------------------------------------------------------------

interface HalfEdge {
  from: number;
  to: number;
  angle: number;
  twin: number;
  next: number;
  visited: boolean;
}

/**
 * Contour fermé le plus petit entourant `p`, plus les îlots qu'il contient (règle pair-impair).
 * Arrangement plan des courbes : découpe aux intersections, puis parcours des faces.
 */
export function detectBoundary(p: Vec3, entities: Entity[]): Vec3[][] | null {
  const curveTypes = new Set<Entity['type']>(['LINE', 'ARC', 'CIRCLE', 'POLYLINE', 'ELLIPSE', 'SPLINE']);
  const curves = entities.filter((e) => curveTypes.has(e.type));
  // candidats : boîtes contenant le point, et ce qui les touche
  const boxes = curves.map((e) => ({ e, b: entityBBox(e) })).filter((x) => x.b);
  // un contour entourant p coupe forcément l'horizontale et la verticale passant par p
  const containing = boxes.filter((x) => (x.b!.min.y <= p.y && x.b!.max.y >= p.y) || (x.b!.min.x <= p.x && x.b!.max.x >= p.x));
  if (!containing.length) return null;
  const zone = containing.reduce(
    (acc, x) => ({ minx: Math.min(acc.minx, x.b!.min.x), miny: Math.min(acc.miny, x.b!.min.y), maxx: Math.max(acc.maxx, x.b!.max.x), maxy: Math.max(acc.maxy, x.b!.max.y) }),
    { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity },
  );
  const cand = boxes.filter((x) => x.b!.max.x >= zone.minx && x.b!.min.x <= zone.maxx && x.b!.max.y >= zone.miny && x.b!.min.y <= zone.maxy).map((x) => x.e).slice(0, 400);

  // segments discrétisés (arcs : 96 segments par tour)
  const segs: [Vec3, Vec3][] = [];
  for (const e of cand) {
    for (const el of elementsOf(e)) {
      if (el.kind === 'line') segs.push([el.a, el.b]);
      else {
        let pts: Vec3[];
        if (el.kind === 'arc') {
          const k = Math.max(8, Math.ceil((Math.abs(el.sweep) / TAU) * 96));
          pts = Array.from({ length: k + 1 }, (_, i) => polar(el.center, el.radius, el.start + (el.sweep * i) / k));
        } else pts = el.pts;
        for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i]!, pts[i + 1]!]);
      }
    }
  }
  if (segs.length > 20000) return null;
  const extent = Math.max(zone.maxx - zone.minx, zone.maxy - zone.miny, 1);
  const tol = extent * 1e-7;

  // découpe aux intersections
  const cuts: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]!;
    const minx = Math.min(a.x, b.x) - tol, maxx = Math.max(a.x, b.x) + tol, miny = Math.min(a.y, b.y) - tol, maxy = Math.max(a.y, b.y) + tol;
    for (let j = i + 1; j < segs.length; j++) {
      const [c, d] = segs[j]!;
      if (Math.max(c.x, d.x) < minx || Math.min(c.x, d.x) > maxx || Math.max(c.y, d.y) < miny || Math.min(c.y, d.y) > maxy) continue;
      const x = segmentIntersection(a, b, c, d);
      if (!x) continue;
      cuts[i]!.push(rawParam(a, b, x));
      cuts[j]!.push(rawParam(c, d, x));
    }
  }

  // sommets fusionnés
  const keyOf = (q: Vec3) => `${Math.round(q.x / tol)},${Math.round(q.y / tol)}`;
  const vIndex = new Map<string, number>();
  const verts: Vec3[] = [];
  const vid = (q: Vec3) => {
    const k = keyOf(q);
    let i = vIndex.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push(q);
      vIndex.set(k, i);
    }
    return i;
  };
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i]!.map((t) => Math.max(0, Math.min(1, t))))].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const u = vid(lerp(a, b, ts[k]!)), v = vid(lerp(a, b, ts[k + 1]!));
      if (u === v) continue;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push([u, v]);
    }
  });

  // demi-arêtes
  const hes: HalfEdge[] = [];
  const outgoing: number[][] = verts.map(() => []);
  for (const [u, v] of edges) {
    const a = verts[u]!, b = verts[v]!;
    const i = hes.length;
    hes.push({ from: u, to: v, angle: Math.atan2(b.y - a.y, b.x - a.x), twin: i + 1, next: -1, visited: false });
    hes.push({ from: v, to: u, angle: Math.atan2(a.y - b.y, a.x - b.x), twin: i, next: -1, visited: false });
    outgoing[u]!.push(i);
    outgoing[v]!.push(i + 1);
  }
  for (const list of outgoing) list.sort((x, y) => hes[x]!.angle - hes[y]!.angle);
  const position = new Map<number, number>();
  outgoing.forEach((list) => list.forEach((h, k) => position.set(h, k)));
  for (let h = 0; h < hes.length; h++) {
    const twin = hes[h]!.twin;
    const v = hes[h]!.to;
    const list = outgoing[v]!;
    const k = position.get(twin)!;
    hes[h]!.next = list[(k - 1 + list.length) % list.length]!;
  }

  // composantes connexes (pour les îlots)
  const comp = new Int32Array(verts.length).fill(-1);
  let nComp = 0;
  for (let s = 0; s < verts.length; s++) {
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = nComp;
    while (stack.length) {
      const v = stack.pop()!;
      for (const h of outgoing[v]!) {
        const w = hes[h]!.to;
        if (comp[w] === -1) (comp[w] = nComp), stack.push(w);
      }
    }
    nComp++;
  }

  // faces
  const faces: { loop: Vec3[]; area: number; comp: number }[] = [];
  for (let h = 0; h < hes.length; h++) {
    if (hes[h]!.visited) continue;
    const loop: Vec3[] = [];
    let cur = h;
    let guard = 0;
    while (!hes[cur]!.visited && guard++ < hes.length + 1) {
      hes[cur]!.visited = true;
      loop.push(verts[hes[cur]!.from]!);
      cur = hes[cur]!.next;
    }
    if (loop.length >= 3) faces.push({ loop, area: polygonArea(loop), comp: comp[hes[h]!.from]! });
  }
  const inside = faces.filter((f) => f.area > tol * tol && pointInLoops(p, [f.loop])).sort((a, b) => a.area - b.area);
  const outer = inside[0];
  if (!outer) return null;
  const z = p.z;
  const loops = [outer.loop];
  for (const f of faces) {
    if (f.area >= 0 || f.comp === outer.comp) continue;
    if (pointInLoops(f.loop[0]!, [outer.loop]) && !pointInLoops(p, [f.loop])) loops.push(f.loop);
  }
  return loops.map((l) => simplifyLoop(l).map((q) => ({ x: q.x, y: q.y, z })));
}

/** Supprime les sommets alignés (contours plus légers). */
function simplifyLoop(loop: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n]!, b = loop[i]!, c = loop[(i + 1) % n]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const l = dist(a, b) * dist(b, c);
    if (l > 0 && Math.abs(cr) / l < 1e-9 && dot(sub(b, a), sub(c, b)) > 0) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : loop;
}

/** Contours d'objets fermés sélectionnés (le plus grand = extérieur, les autres = îlots). */
export function loopsFromClosed(closed: Vec3[][]): Vec3[][] {
  return [...closed].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}

/** Point le plus proche sur l'entité (accrochage Proche, sélection). */
export function nearestOn(e: Entity, p: Vec3): Vec3 | null {
  const polys = curvePoints(e);
  if (e.type === 'CIRCLE') return add(e.center, scale(norm(sub(p, e.center)), e.radius));
  return nearestOnPolylines(polys, p)?.point ?? null;
}

export { polylineSamples };
