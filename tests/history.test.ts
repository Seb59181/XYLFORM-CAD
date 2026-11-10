/**
 * Historique paramétrique et assistant de perçage : étapes, cotes modifiables, expressions,
 * reconstruction par le noyau (OCC=1).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { run } from '../src/kernel/dispatch';
import type { KernelClient } from '../src/kernel/KernelClient';
import type { KernelRequest } from '../src/kernel/protocol';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { featureId, placeHistory, type Entity, type Feature } from '../src/core/document/Document';
import { holeProfile, standardHole } from '../src/core/geometry/holes';
import { editFeatureParam, featureAt, featureParams, flattenHistory, refreshExpressions, replaceAt, setFeatureParam, toggleFeature } from '../src/app/history';
import { translation } from '../src/core/math/affine';

type Solid = Extract<Entity, { type: '3DSOLID' }>;
const O = { x: 0, y: 0, z: 0 };
const box = (x = 60): Feature => ({ kind: 'create', op: { op: 'box', corner: O, size: { x, y: 40, z: 10 } }, id: featureId(), name: 'Boîte' });

describe('perçages normalisés', () => {
  it('tableau ISO : passage, lamage, fraisure, avant-trou', () => {
    expect(standardHole('simple', 'M6').diameter).toBe(6.6);
    const cb = standardHole('counterbore', 'M8', 20);
    expect([cb.diameter, cb.cbDiameter, cb.cbDepth, cb.depth]).toEqual([9, 15, 9, 20]);
    expect(standardHole('countersink', 'M4').csDiameter).toBe(9);
    expect(standardHole('tapped', 'M10').diameter).toBe(8.5);
    // jeu d'impression par côté : seulement avec filetage réel ; l'avant-trou grandit de 2 × jeu
    expect(standardHole('tapped', 'M10', 0, false, 0.2).gap).toBeUndefined();
    const j = standardHole('tapped', 'M10', 0, true, 0.2);
    expect(j.diameter).toBeCloseTo(8.9);
    expect(j.gap).toBe(0.2);
    expect(j.clearance).toBeUndefined();
    expect(standardHole('insert', 'M3').diameter).toBe(4);
    expect(() => standardHole('insert', 'M20')).toThrow();
  });

  it('demi-profil : débouchant sans pointe, borgne avec pointe à 118°', () => {
    const t = holeProfile(standardHole('simple', 'M6'), 100);
    expect(t[t.length - 1]).toEqual([0, 100]);
    const b = holeProfile(standardHole('simple', 'M6', 10), 100);
    expect(b[b.length - 1]![1]).toBeCloseTo(10 + 3.3 / Math.tan((59 * Math.PI) / 180), 6);
    // fraisure à 45° : rayon 6,5 en surface, rejoint le perçage à 6,5 − 3,3 de profondeur
    const cs = holeProfile(standardHole('countersink', 'M6'), 50, 0.5);
    expect(cs[2]).toEqual([3.3, 6.5 - 3.3]);
  });
});

describe('historique : étapes et cotes', () => {
  const tool: Feature[] = [{ kind: 'create', op: { op: 'cylinder', center: O, radius: 5, height: 10 }, id: 't1', name: 'Cylindre' }];
  const h: Feature[] = [box(), { kind: 'boolean', bool: 'subtract', tools: [tool], id: 'b1', name: 'Soustraction' }];

  it('chemins imbriqués (outils des booléens)', () => {
    expect(flattenHistory(h).map((s) => s.path)).toEqual([[0], [1], [1, 0, 0]]);
    expect(featureAt(h, [1, 0, 0])?.id).toBe('t1');
    const g = replaceAt(h, [1, 0, 0], setFeatureParam(featureAt(h, [1, 0, 0])!, 'D', 20));
    expect((featureAt(g, [1, 0, 0]) as { op: { radius: number } }).op.radius).toBe(10);
    expect((featureAt(h, [1, 0, 0]) as { op: { radius: number } }).op.radius).toBe(5); // copie
  });

  it('cotes : le sens des hauteurs négatives est conservé', () => {
    const f: Feature = { kind: 'create', op: { op: 'box', corner: O, size: { x: -10, y: 5, z: -3 } }, id: 'x', name: 'Boîte' };
    expect(featureParams(f).map((p) => p.value)).toEqual([10, 5, 3]);
    expect((setFeatureParam(f, 'H', 7) as { op: { size: { z: number } } }).op.size.z).toBe(-7);
  });

  it('perçage : changer la taille reprend les cotes normalisées', () => {
    const f: Feature = { kind: 'hole', spec: standardHole('counterbore', 'M6'), at: [O], normal: { x: 0, y: 0, z: 1 }, id: 'h', name: 'Trou lamé' };
    const g = setFeatureParam(f, 'size', 'M10') as Extract<Feature, { kind: 'hole' }>;
    expect([g.spec.diameter, g.spec.cbDiameter]).toEqual([11, 18]);
    const t = setFeatureParam(g, 'type', 'tapped') as Extract<Feature, { kind: 'hole' }>;
    expect([t.spec.diameter, t.name]).toEqual([8.5, 'Trou taraudé']);
  });

  it('expressions : réévaluées avec les paramètres utilisateur', () => {
    const f = { ...box(), exprs: { L: 'ep*2' } } as Feature;
    const next = refreshExpressions([f], [], { ep: '35' });
    expect((next![0] as { op: { size: { x: number } } }).op.size.x).toBe(70);
    expect(refreshExpressions(next!, [], { ep: '35' })).toBeNull();
  });

  it('déplacements successifs fusionnés en une étape', () => {
    const a = placeHistory([box()], translation({ x: 5, y: 0, z: 0 }))!;
    const b = placeHistory(a, translation({ x: 0, y: 3, z: 0 }))!;
    expect(b.length).toBe(2);
    expect(b[1]!.kind === 'transform' && [b[1]!.matrix[3], b[1]!.matrix[7]]).toEqual([5, 3]);
  });
});

describe.skipIf(!process.env.OCC)('historique : reconstruction (noyau)', () => {
  let app: AppHost;
  beforeAll(async () => {
    const k = new OccKernel(await initOpenCascade());
    const kernel = {
      status: 'ready',
      busy: 0,
      ready: Promise.resolve(),
      start: () => Promise.resolve(),
      onStatus: () => undefined,
      onProgress: () => undefined,
      solid: (r: KernelRequest) => Promise.resolve(run(k, r)),
      call: (r: KernelRequest) => Promise.resolve(run(k, r)),
    } as unknown as KernelClient;
    app = new AppHost(registerAll, kernel);
  }, 60_000);

  it('boîte + perçage + congé : modifier la boîte rejoue tout', async () => {
    const h0 = [box()];
    const h = app.addSolid(await app.replay(h0), 'Boîte', undefined, undefined, h0);
    const hole: Feature = { kind: 'hole', spec: standardHole('simple', 'M6'), at: [{ x: 15, y: 20, z: 10 }, { x: 45, y: 20, z: 10 }], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Trou' };
    await app.applyStep(h, hole, 'Perçage');
    const s1 = app.doc.get(h) as Solid;
    expect(s1.display.volume).toBeCloseTo(24000 - 2 * Math.PI * 3.3 * 3.3 * 10, 1);
    await app.transformEntities([h], translation({ x: 100, y: 0, z: 0 }), { label: 'Déplacer' });
    await editFeatureParam(app, h, [0], 'L', '80');
    const s2 = app.doc.get(h) as Solid;
    expect(s2.display.volume).toBeCloseTo(32000 - 2 * Math.PI * 3.3 * 3.3 * 10, 1);
    expect(s2.display.bbox.max.x).toBeCloseTo(180, 3);
    expect(s2.history!.map((f) => f.kind)).toEqual(['create', 'hole', 'transform']);
    // perçage supprimé puis rétabli
    await toggleFeature(app, h, [1]);
    expect((app.doc.get(h) as Solid).display.volume).toBeCloseTo(32000, 1);
    app.doc.undo();
    expect((app.doc.get(h) as Solid).display.volume).toBeCloseTo(s2.display.volume, 6);
  });

  it('pièce à filetage réel : aperçu cosmétique, filet exact recalculé pour l’export', async () => {
    const { insertPart, PARTS, defaultValues } = await import('../src/app/parts');
    app.settings.threadMode = 'export';
    const def = PARTS.find((p) => p.id === 'vis-h')!;
    const v = { ...def.applySize!('M6', defaultValues(def)), L: 12, thread: 'reel' };
    const [h] = await insertPart(app, undefined, def, v, 'Z', { x: 50, y: 0, z: 0 });
    const s = app.doc.get(h!) as Solid;
    expect(s.history![0]!.kind).toBe('part');
    expect(s.threadsReal).toBeUndefined();
    const ex = await app.exactShapes([s]);
    expect(ex.ids[0]).not.toBe(s.shapeId);
    const exact = await app.kernel.call<{ volume: number; bbox: { min: { x: number } } }>({ op: 'display', shapeId: ex.ids[0]! });
    // même pièce, même place ; le filet hélicoïdal n'a pas le volume des stries
    expect(exact.bbox.min.x).toBeGreaterThan(40);
    expect(Math.abs(exact.volume - s.display.volume)).toBeGreaterThan(0.01);
    expect(Math.abs(exact.volume - s.display.volume) / s.display.volume).toBeLessThan(0.05);
    ex.release();
    // FILETAGEREEL rend le corps exact : plus rien à recalculer à l'export
    const r = await app.replay(s.history!, undefined, undefined, true);
    app.doc.replaceEntity(h!, { shapeId: r.shapeId, display: r.display, threadsReal: true });
    const ex2 = await app.exactShapes([app.doc.get(h!) as Solid]);
    expect(ex2.ids[0]).toBe(r.shapeId);
  }, 300_000);

  it('lamé et taraudé (filetage réel) borgnes', async () => {
    const h0 = [box()];
    const h = app.addSolid(await app.replay(h0), 'Boîte', undefined, undefined, h0);
    const cb: Feature = { kind: 'hole', spec: standardHole('counterbore', 'M6'), at: [{ x: 15, y: 20, z: 10 }], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Lamé' };
    await app.applyStep(h, cb, 'Perçage');
    const v1 = (app.doc.get(h) as Solid).display.volume;
    expect(24000 - v1).toBeCloseTo(Math.PI * 3.3 * 3.3 * 10 + Math.PI * (5.5 * 5.5 - 3.3 * 3.3) * 6.8, 1);
    const tp: Feature = { kind: 'hole', spec: standardHole('tapped', 'M8', 8, true), at: [{ x: 45, y: 20, z: 10 }], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Taraudé' };
    await app.applyStep(h, tp, 'Perçage');
    const s = app.doc.get(h) as Solid;
    const removed = v1 - s.display.volume;
    // entre l'avant-trou seul et un trou au Ø nominal
    expect(removed).toBeGreaterThan(Math.PI * 3.4 * 3.4 * 8);
    expect(removed).toBeLessThan(Math.PI * 4 * 4 * 9);
    expect(s.display.solidCount).toBe(1);
  }, 120_000);
});
