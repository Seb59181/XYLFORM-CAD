import { describe, expect, it } from 'vitest';
import { DrawingDocument, type Entity } from '../src/core/document/Document';
import { evaluateParameters, measure, solveConstraints } from '../src/core/constraints/Solver';
import type { Constraint } from '../src/core/constraints/types';

const P = (x: number, y: number) => ({ x, y, z: 0 });

function setup() {
  const doc = new DrawingDocument();
  const get = (h: string) => doc.get(h);
  const solve = (edited?: string[]) => {
    const r = solveConstraints(get, doc.constraints, { edited: edited ? new Set(edited) : undefined });
    doc.patchFromSolver(r.patches);
    return r;
  };
  return { doc, get, solve };
}

const line = (e: Entity | undefined) => e as Extract<Entity, { type: 'LINE' }>;
const circle = (e: Entity | undefined) => e as Extract<Entity, { type: 'CIRCLE' }>;

describe('solveur de contraintes', () => {
  it('horizontal et vertical', () => {
    const { doc, get, solve } = setup();
    const a = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(10, 2) });
    const b = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(1, 8) });
    doc.addConstraint({ type: 'horizontal', refs: [{ handle: a, part: 'line' }] });
    doc.addConstraint({ type: 'vertical', refs: [{ handle: b, part: 'line' }] });
    const r = solve();
    expect(r.ok).toBe(true);
    const la = line(get(a)), lb = line(get(b));
    expect(la.end.y - la.start.y).toBeCloseTo(0, 6);
    expect(lb.end.x - lb.start.x).toBeCloseTo(0, 6);
  });

  it('coïncident + perpendiculaire + cote pilotée avec expression', () => {
    const { doc, get, solve } = setup();
    const a = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(40, 0) });
    const b = doc.addEntity({ type: 'LINE', start: P(41, 1), end: P(45, 30) });
    doc.addConstraint({ type: 'fix', refs: [{ handle: a, part: 'start' }], at: P(0, 0) });
    doc.addConstraint({ type: 'horizontal', refs: [{ handle: a, part: 'line' }] });
    doc.addConstraint({ type: 'coincident', refs: [{ handle: a, part: 'end' }, { handle: b, part: 'start' }] });
    doc.addConstraint({ type: 'perpendicular', refs: [{ handle: a, part: 'line' }, { handle: b, part: 'line' }] });
    doc.addConstraint({ type: 'distance', refs: [{ handle: a, part: 'line' }], name: 'largeur', expression: '50' });
    doc.addConstraint({ type: 'distance', refs: [{ handle: b, part: 'line' }], name: 'hauteur', expression: 'largeur/2' });
    const r = solve();
    expect(r.ok).toBe(true);
    const la = line(get(a)), lb = line(get(b));
    expect(la.start.x).toBeCloseTo(0, 6);
    expect(la.end.x).toBeCloseTo(50, 5);
    expect(lb.start.x).toBeCloseTo(50, 5);
    expect(Math.abs(lb.end.y - lb.start.y)).toBeCloseTo(25, 5);
    expect(lb.end.x).toBeCloseTo(50, 5);

    // changement de la cote maîtresse : la cote dépendante suit
    const dim = doc.constraints.find((c) => c.type === 'distance' && c.name === 'largeur')!;
    doc.updateConstraint(dim.id, { expression: '80' });
    expect(solve().ok).toBe(true);
    expect(line(get(a)).end.x).toBeCloseTo(80, 5);
    expect(Math.abs(line(get(b)).end.y - line(get(b)).start.y)).toBeCloseTo(40, 5);
  });

  it('tangence ligne/cercle, concentrique, rayon et égalité', () => {
    const { doc, get, solve } = setup();
    const l = doc.addEntity({ type: 'LINE', start: P(-20, 12), end: P(20, 12) });
    const c1 = doc.addEntity({ type: 'CIRCLE', center: P(0, 0), radius: 10 });
    const c2 = doc.addEntity({ type: 'CIRCLE', center: P(1, 1), radius: 4 });
    const c3 = doc.addEntity({ type: 'CIRCLE', center: P(30, 0), radius: 7 });
    doc.addConstraint({ type: 'tangent', refs: [{ handle: l, part: 'line' }, { handle: c1, part: 'circle' }] });
    doc.addConstraint({ type: 'concentric', refs: [{ handle: c1, part: 'circle' }, { handle: c2, part: 'circle' }] });
    doc.addConstraint({ type: 'radius', refs: [{ handle: c2, part: 'circle' }], name: 'rad1', expression: '3' });
    doc.addConstraint({ type: 'equal', refs: [{ handle: c2, part: 'circle' }, { handle: c3, part: 'circle' }] });
    const r = solve([l]);
    expect(r.ok).toBe(true);
    const ln = line(get(l)), k1 = circle(get(c1)), k2 = circle(get(c2)), k3 = circle(get(c3));
    // la ligne (modifiée) n'a pas bougé : c'est le cercle qui s'adapte
    expect(ln.start.y).toBeCloseTo(12, 3);
    const dx = ln.end.x - ln.start.x, dy = ln.end.y - ln.start.y;
    const d = Math.abs(dx * (k1.center.y - ln.start.y) - dy * (k1.center.x - ln.start.x)) / Math.hypot(dx, dy);
    expect(d).toBeCloseTo(k1.radius, 6);
    expect(k2.center.x).toBeCloseTo(k1.center.x, 6);
    expect(k2.radius).toBeCloseTo(3, 6);
    expect(k3.radius).toBeCloseTo(3, 6);
  });

  it('angle entre deux lignes et degrés de liberté', () => {
    const { doc, get, solve } = setup();
    const a = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(10, 0) });
    const b = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(10, 3) });
    doc.addConstraint({ type: 'angle', refs: [{ handle: a, part: 'line' }, { handle: b, part: 'line' }], name: 'ang1', expression: '30' });
    const r = solve([a]);
    expect(r.ok).toBe(true);
    const la = line(get(a)), lb = line(get(b));
    const ang = Math.atan2(lb.end.y - lb.start.y, lb.end.x - lb.start.x) - Math.atan2(la.end.y - la.start.y, la.end.x - la.start.x);
    expect((ang * 180) / Math.PI).toBeCloseTo(30, 4);
    expect(r.dof).toBe(7);
  });

  it('détecte les contraintes conflictuelles', () => {
    const { doc, solve } = setup();
    const a = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(10, 1) });
    doc.addConstraint({ type: 'horizontal', refs: [{ handle: a, part: 'line' }] });
    doc.addConstraint({ type: 'vertical', refs: [{ handle: a, part: 'line' }] });
    doc.addConstraint({ type: 'distance', refs: [{ handle: a, part: 'line' }], name: 'd1', expression: '10' });
    const r = solve();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/conflictuelles/);
  });

  it('paramètres : dépendances et références circulaires', () => {
    const cs = [
      { id: 'C1', type: 'distance', refs: [], name: 'a', expression: 'b*2' },
      { id: 'C2', type: 'distance', refs: [], name: 'b', expression: '5+1' },
    ] as Constraint[];
    expect(evaluateParameters(cs).get('a')).toBe(12);
    const cyc = [
      { id: 'C1', type: 'distance', refs: [], name: 'a', expression: 'b' },
      { id: 'C2', type: 'distance', refs: [], name: 'b', expression: 'a' },
    ] as Constraint[];
    expect(() => evaluateParameters(cyc)).toThrow(/circulaire/);
  });

  it('mesure la valeur courante d\'une cote', () => {
    const { doc, get } = setup();
    const c = doc.addEntity({ type: 'CIRCLE', center: P(0, 0), radius: 12.5 });
    const l = doc.addEntity({ type: 'LINE', start: P(0, 0), end: P(3, 4) });
    expect(measure(get, { type: 'diameter', refs: [{ handle: c, part: 'circle' }], name: 'x', expression: '0' })).toBeCloseTo(25);
    expect(measure(get, { type: 'distance', refs: [{ handle: l, part: 'line' }], name: 'x', expression: '0' })).toBeCloseTo(5);
  });
});
