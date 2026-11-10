import { describe, expect, it } from 'vitest';
import type { Entity } from '../src/core/document/Document';
import {
  breakEntity,
  chamferLines,
  detectBoundary,
  dividePoints,
  explodeEntity,
  extendEntity,
  filletLines,
  filletPolyline,
  joinEntities,
  tangentTangentRadius,
  trimEntity,
} from '../src/core/entities/edit';
import { entityArea, entityLength, offsetEntity } from '../src/core/entities/geometry';

const P = (x: number, y: number) => ({ x, y, z: 0 });
let h = 0x100;
const ent = <T extends Omit<Entity, 'handle' | 'layer'>>(e: T) => ({ ...e, handle: (h++).toString(16), layer: '0' }) as unknown as Entity;
const line = (a: [number, number], b: [number, number]) => ent({ type: 'LINE', start: P(...a), end: P(...b) });

describe('édition 2D', () => {
  it('AJUSTER une ligne entre deux sécantes', () => {
    const l = line([0, 0], [10, 0]);
    const c1 = line([3, -5], [3, 5]);
    const c2 = line([7, -5], [7, 5]);
    const res = trimEntity(l, P(5, 0), [c1, c2])!;
    expect(res).toHaveLength(2);
    expect(res.map((r) => entityLength(r as Entity)).sort()).toEqual([3, 3]);
    // extrémité désignée : un seul morceau conservé
    const end = trimEntity(l, P(9, 0), [c1, c2])!;
    expect(end).toHaveLength(1);
    expect(entityLength(end[0] as Entity)).toBeCloseTo(7);
  });

  it('AJUSTER un cercle → arc', () => {
    const c = ent({ type: 'CIRCLE', center: P(0, 0), radius: 5 });
    const cut = line([0, -10], [0, 10]);
    const res = trimEntity(c, P(5, 0), [cut])!;
    expect(res).toHaveLength(1);
    const arc = res[0] as Extract<Entity, { type: 'ARC' }>;
    expect(arc.type).toBe('ARC');
    expect(entityLength(arc as Entity)).toBeCloseTo(Math.PI * 5, 6);
    // l'arc conservé est du côté gauche (x < 0)
    expect(Math.cos((arc.startAngle + arc.endAngle) / 2 + (arc.endAngle < arc.startAngle ? Math.PI : 0))).toBeLessThan(0);
  });

  it('AJUSTER une polyligne à arcs conserve les arcs', () => {
    const b = Math.tan(Math.PI / 8);
    const pl = ent({ type: 'POLYLINE', points: [P(0, 0), P(10, 0), P(12, 2), P(12, 10)], closed: false, bulges: [0, b, 0, 0] });
    const cut = line([5, -5], [5, 5]);
    const res = trimEntity(pl, P(1, 0), [cut])!;
    expect(res).toHaveLength(1);
    const piece = res[0] as Extract<Entity, { type: 'POLYLINE' }>;
    expect(piece.points[0]).toMatchObject({ x: 5, y: 0 });
    expect(piece.bulges?.[1]).toBeCloseTo(b, 9);
    expect(entityLength(piece as Entity)).toBeCloseTo(5 + Math.PI + 8, 5);
  });

  it('COUPURE et PROLONGER', () => {
    const l = line([0, 0], [10, 0]);
    const parts = breakEntity(l, P(2, 0), P(6, 0))!;
    expect(parts.map((p) => entityLength(p as Entity))).toEqual([2, 4]);
    const wall = line([15, -5], [15, 5]);
    const ext = extendEntity(l, P(9, 0), [wall]) as { end: { x: number } };
    expect(ext.end.x).toBeCloseTo(15);
    const arc = ent({ type: 'ARC', center: P(0, 0), radius: 5, startAngle: 0, endAngle: Math.PI / 4 });
    const ext2 = extendEntity(arc, P(3.5, 3.5), [line([-10, 5 * Math.sin(1)], [10, 5 * Math.sin(1)])]) as { endAngle: number };
    expect(ext2.endAngle).toBeCloseTo(1, 6);
  });

  it('RACCORD et CHANFREIN de deux lignes', () => {
    const a = line([0, 0], [10, 0]) as Extract<Entity, { type: 'LINE' }>;
    const b = line([12, 2], [12, 10]) as Extract<Entity, { type: 'LINE' }>;
    const f = filletLines(a, P(2, 0), b, P(12, 8), 3);
    if (typeof f === 'string') throw new Error(f);
    expect(f.line1).toMatchObject({ start: P(0, 0), end: { x: 9, y: 0 } });
    expect((f.line2 as { end: { y: number } }).end.y).toBeCloseTo(3);
    expect(f.arc).toMatchObject({ type: 'ARC', radius: 3, center: { x: 9, y: 3 } });
    const c = chamferLines(a, P(2, 0), b, P(12, 8), 2, 2);
    if (typeof c === 'string') throw new Error(c);
    expect(entityLength(c.segment as Entity)).toBeCloseTo(2 * Math.SQRT2);
    expect(typeof filletLines(a, P(1, 0), b, P(12, 9), 50)).toBe('string');
  });

  it('RACCORD de polyligne (rectangle → coins arrondis) et décalage exact', () => {
    const rect = ent({ type: 'POLYLINE', points: [P(0, 0), P(20, 0), P(20, 10), P(0, 10)], closed: true }) as Extract<Entity, { type: 'POLYLINE' }>;
    const r = filletPolyline(rect, 2);
    expect(r.count).toBe(4);
    const rounded = { ...rect, points: r.points, bulges: r.bulges } as Entity;
    expect(entityArea(rounded)!).toBeCloseTo(200 - (4 - Math.PI) * 4, 2);
    const off = offsetEntity(rounded, 1, P(10, 5)) as { points: { x: number; y: number }[]; bulges: number[] };
    const inner = { ...rect, points: off.points, bulges: off.bulges } as Entity;
    // décalage intérieur de 1 : rectangle 18×8 aux coins R1
    expect(entityArea(inner)!).toBeCloseTo(144 - (4 - Math.PI) * 1, 2);
  });

  it('JOINDRE lignes et arc en polyligne fermée, puis DECOMPOS', () => {
    const parts = [
      line([0, 0], [10, 0]),
      ent({ type: 'ARC', center: P(10, 5), radius: 5, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 }),
      line([10, 10], [0, 10]),
      line([0, 0], [0, 10]),
    ];
    const { result, consumed } = joinEntities(parts);
    expect(consumed).toHaveLength(4);
    expect(result).toHaveLength(1);
    const pl = result[0] as Extract<Entity, { type: 'POLYLINE' }>;
    expect(pl.closed).toBe(true);
    expect(entityArea({ ...pl, handle: 'X', layer: '0' } as Entity)!).toBeCloseTo(100 + (Math.PI * 25) / 2, 2);
    const back = explodeEntity({ ...pl, handle: 'X', layer: '0' } as Entity)!;
    expect(back.map((e) => e.type).sort()).toEqual(['ARC', 'LINE', 'LINE', 'LINE']);
  });

  it('DIVISER et TTR', () => {
    expect(dividePoints(line([0, 0], [10, 0]), 5).map((p) => p.x)).toEqual([2, 4, 6, 8]);
    const a = line([0, 0], [20, 0]);
    const b = line([0, 0], [0, 20]);
    const c = tangentTangentRadius(a, P(10, 0), b, P(0, 10), 3)!;
    expect(c.center.x).toBeCloseTo(3);
    expect(c.center.y).toBeCloseTo(3);
    const k = ent({ type: 'CIRCLE', center: P(20, 0), radius: 5 });
    const t = tangentTangentRadius(a, P(10, 0.1), k, P(16, 3), 2)!;
    expect(Math.abs(t.center.y)).toBeCloseTo(2);
    expect(Math.hypot(t.center.x - 20, t.center.y)).toBeCloseTo(7);
  });

  it('HACHURES : contour par point interne avec îlot', () => {
    const ents = [
      line([0, 0], [10, 0]),
      line([10, 0], [10, 10]),
      line([10, 10], [0, 10]),
      line([0, 10], [0, 0]),
      line([5, -3], [5, 13]), // coupe le carré en deux
      ent({ type: 'CIRCLE', center: P(2.5, 5), radius: 1 }), // îlot dans la moitié gauche
    ];
    const loops = detectBoundary(P(1, 1), ents)!;
    expect(loops).toHaveLength(2);
    const area = (l: { x: number; y: number }[]) => Math.abs(l.reduce((s, p, i) => s + p.x * l[(i + 1) % l.length]!.y - l[(i + 1) % l.length]!.x * p.y, 0) / 2);
    expect(area(loops[0]!)).toBeCloseTo(50, 6);
    expect(area(loops[1]!)).toBeCloseTo(Math.PI, 1);
    const right = detectBoundary(P(8, 8), ents)!;
    expect(right).toHaveLength(1);
    expect(detectBoundary(P(20, 20), ents)).toBeNull();
  });
});
