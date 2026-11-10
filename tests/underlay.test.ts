import { describe, expect, it } from 'vitest';
import { DrawingDocument, type Entity, type UnderlayDef } from '../src/core/document/Document';
import { snapPoints, transformEntity, underlayFrame, underlayMatrix } from '../src/core/entities/geometry';
import { boundsOf, fadeColor, underlayEntities, unitScale, uniqueUnderlayName } from '../src/core/entities/underlay';
import { apply, mirrorLine, rotationZ, scaling } from '../src/core/math/affine';

type Underlay = Extract<Entity, { type: 'UNDERLAY' }>;
const P = (x: number, y: number) => ({ x, y, z: 0 });
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

const def: UnderlayDef = {
  id: 'U1',
  name: 'plan',
  kind: 'dxf',
  fileName: 'plan.dxf',
  loaded: true,
  fade: 50,
  monochrome: false,
  loadedAt: 0,
  entities: [
    { type: 'LINE', start: P(0, 0), end: P(10, 0), layer: 'Murs' },
    { type: 'CIRCLE', center: P(5, 5), radius: 2, layer: 'Mobilier' },
  ],
  layers: [
    { name: 'Murs', color: '#ff0000', visible: true },
    { name: 'Mobilier', color: '#00ff00', visible: false },
  ],
  bounds: { min: P(0, 0), max: P(10, 7) },
};

const inst = (patch: Partial<Underlay> = {}): Underlay => ({ type: 'UNDERLAY', handle: 'A0', layer: '0', ref: 'U1', position: P(100, 50), scale: 2, rotation: Math.PI / 2, bounds: def.bounds, ...patch });

describe('Fonds de plan', () => {
  it('place le contenu par insertion, échelle et rotation', () => {
    const e = inst();
    const m = underlayMatrix(e);
    close(apply(m, P(10, 0)), P(100, 70));
    const ents = underlayEntities(e, def);
    // calque « Mobilier » masqué dans la définition
    expect(ents).toHaveLength(1);
    const line = ents[0] as Extract<Entity, { type: 'LINE' }>;
    close(line.start, P(100, 50));
    close(line.end, P(100, 70));
    expect(line.color).toBe('#ff0000');
    expect(underlayFrame(e)).toHaveLength(5);
    expect(snapPoints(e)).toEqual([{ kind: 'INS', point: P(100, 50) }]);
  });

  it('suit les transformations (rotation, échelle, miroir)', () => {
    const e = inst({ rotation: 0, scale: 1, position: P(0, 0) });
    const r = { ...e, ...transformEntity(e, rotationZ(P(0, 0), Math.PI / 2)) } as Underlay;
    expect(r.rotation).toBeCloseTo(Math.PI / 2);
    const s = { ...e, ...transformEntity(e, scaling(P(0, 0), 3)) } as Underlay;
    expect(s.scale).toBeCloseTo(3);
    const mir = { ...e, ...transformEntity(e, mirrorLine(P(0, 0), P(0, 1))) } as Underlay;
    expect(mir.mirrored).toBe(true);
    // le point local (10,0) passe de l'autre côté de l'axe Y
    close(apply(underlayMatrix(mir), P(10, 0)), P(-10, 0));
    close(apply(underlayMatrix(mir), P(0, 7)), P(0, 7));
  });

  it('convertit les unités et estompe les couleurs', () => {
    expect(unitScale(6, 4)).toBe(1000); // m → mm
    expect(unitScale(4, 5)).toBeCloseTo(0.1); // mm → cm
    expect(unitScale(0, 4)).toBe(1);
    expect(fadeColor('#ffffff', 0, false)).toBe('#ffffff');
    expect(fadeColor('#ffffff', 100, false)).not.toBe('#212830'); // plafonné à 90 %
    expect(fadeColor('#ff0000', 0, true)).toMatch(/^#([0-9a-f]{2})\1\1$/);
    expect(uniqueUnderlayName('plan', ['Plan', 'plan (2)'])).toBe('plan (3)');
    expect(boundsOf(def.entities!)).toEqual({ min: P(0, 0), max: P(10, 7) });
  });

  it('attache, annule et détache dans le document', () => {
    const doc = new DrawingDocument();
    doc.transaction('Attacher', () => {
      doc.setUnderlayDef(def);
      doc.addEntity({ type: 'UNDERLAY', ref: 'U1', position: P(0, 0), scale: 1, rotation: 0, bounds: def.bounds });
    });
    expect(doc.underlayInstances('U1')).toHaveLength(1);
    doc.updateUnderlayDef('U1', { fade: 70 });
    expect(doc.underlays.U1!.fade).toBe(70);
    doc.undo();
    expect(doc.underlays.U1!.fade).toBe(50);
    doc.removeUnderlayDef('U1');
    expect(doc.underlays.U1).toBeUndefined();
    expect(doc.size).toBe(0);
    doc.undo();
    expect(doc.underlays.U1).toBeDefined();
    expect(doc.size).toBe(1);
  });
});
