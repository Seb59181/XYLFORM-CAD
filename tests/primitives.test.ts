/**
 * Splines refermées (tracé avec clic sur le premier point) et primitives 3D modifiables
 * dans la palette Propriétés (placement conservé après déplacement / rotation).
 */
import { describe, expect, it } from 'vitest';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { DrawingDocument, placePrimitive, type Entity } from '../src/core/document/Document';
import { closedLoop, curvePoints, entityArea, isClosedProfile, profileOf, splineFit } from '../src/core/entities/geometry';
import { rotationZ, scaling, translation } from '../src/core/math/affine';
import type { DisplayMesh, KernelRequest, SolidResult } from '../src/kernel/protocol';
import type { KernelClient } from '../src/kernel/KernelClient';

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = (x: number, y: number) => ({ x, y, z: 0 });

/** Noyau factice : enregistre les requêtes, renvoie des formes numérotées. */
function fakeKernel() {
  const reqs: KernelRequest[] = [];
  let n = 0;
  const display = { volume: 1, area: 1, bbox: { min: P(0, 0), max: P(1, 1) }, faceCount: 1, edgeCount: 1, solidCount: 1 } as unknown as DisplayMesh;
  const k = {
    status: 'ready',
    ready: Promise.resolve(),
    start: () => Promise.resolve(),
    onStatus: () => undefined,
    solid: (r: KernelRequest) => (reqs.push(r), Promise.resolve<SolidResult>({ shapeId: `s${++n}`, display, warnings: [] })),
    call: (r: KernelRequest) => (reqs.push(r), Promise.resolve(undefined)),
  };
  return { kernel: k as unknown as KernelClient, reqs };
}

describe('spline fermée', () => {
  const fit = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
  const spline = (fitPoints = fit, closed = false) => ({ type: 'SPLINE', handle: 'S', layer: '0', fitPoints, closed }) as unknown as Entity;

  it('refermée à la main (dernier point = premier) : profil fermé, lisse', () => {
    const e = spline([...fit, P(0, 0)]);
    expect(isClosedProfile(e)).toBe(true);
    expect(splineFit(e as Extract<Entity, { type: 'SPLINE' }>).fit).toHaveLength(4);
    const p = profileOf(e)!;
    expect(p.kind === 'poly' && p.closed).toBe(true);
    // même courbe que la spline fermée explicitement
    expect(curvePoints(e)).toEqual(curvePoints(spline(fit, true)));
    expect(closedLoop(e)).not.toBeNull();
    expect(entityArea(e)!).toBeGreaterThan(90);
  });

  it('spline ouverte : pas un profil fermé', () => {
    expect(isClosedProfile(spline())).toBe(false);
    expect(entityArea(spline())).toBeNull();
  });

  it('SPLINE : un clic sur le premier point ferme la spline', async () => {
    const app = new AppHost(registerAll, fakeKernel().kernel);
    app.execute('SPLINE');
    await tick();
    for (const p of [...fit, P(0, 0)]) {
      app.processor.pick(p);
      await tick();
    }
    const all = app.doc.all();
    expect(all).toHaveLength(1);
    const e = all[0] as Extract<Entity, { type: 'SPLINE' }>;
    expect(e.closed).toBe(true);
    expect(e.fitPoints).toHaveLength(4);
    expect(app.processor.isIdle).toBe(true);
  });

  it('SPLINE : option Clore', async () => {
    const app = new AppHost(registerAll, fakeKernel().kernel);
    app.execute('SPLINE');
    await tick();
    for (const p of fit.slice(0, 3)) {
      app.processor.pick(p);
      await tick();
    }
    app.processor.submit('C');
    await tick();
    const e = app.doc.all()[0] as Extract<Entity, { type: 'SPLINE' }>;
    expect(e.closed).toBe(true);
    expect(e.fitPoints).toHaveLength(3);
  });
});

describe('primitives modifiables', () => {
  it('placement : composé par les isométries, perdu par une mise à l’échelle', () => {
    const prim = { op: { op: 'cylinder' as const, center: P(0, 0), radius: 5, height: 10 } };
    const moved = placePrimitive(prim, translation({ x: 5, y: 0, z: 0 }))!;
    const turned = placePrimitive(moved, rotationZ(P(0, 0), Math.PI / 2))!;
    expect(turned.matrix![3]).toBeCloseTo(0); // (5,0) tourné de 90° → (0,5)
    expect(turned.matrix![7]).toBeCloseTo(5);
    expect(placePrimitive(prim, scaling(P(0, 0), 2))).toBeUndefined();
  });

  it('une autre opération sur la forme oublie la primitive', () => {
    const doc = new DrawingDocument();
    const h = doc.addEntity({ type: '3DSOLID', name: 'C', shapeId: 'a', display: {} as DisplayMesh, primitive: { op: { op: 'sphere', center: P(0, 0), radius: 1 } } });
    doc.replaceEntity(h, { name: 'Boule' });
    expect((doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).primitive).toBeDefined();
    doc.replaceEntity(h, { shapeId: 'b' });
    expect((doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).primitive).toBeUndefined();
  });

  it('modifier le diamètre et la hauteur reconstruit puis replace le cylindre', async () => {
    const { kernel, reqs } = fakeKernel();
    const app = new AppHost(registerAll, kernel);
    const op = { op: 'cylinder' as const, center: P(0, 0), radius: 5, height: 10 };
    const h = app.addSolid(await app.solid(undefined, op), 'Cylindre', undefined, undefined, op);
    await app.transformEntities([h], translation({ x: 7, y: 0, z: 0 }), { label: 'Déplacer' });
    reqs.length = 0;
    await app.editPrimitive(h, { ...op, radius: 10, height: 30 });
    expect(reqs[0]).toMatchObject({ op: 'cylinder', radius: 10, height: 30 });
    expect(reqs[1]).toMatchObject({ op: 'transform', matrix: translation({ x: 7, y: 0, z: 0 }) });
    const e = app.doc.get(h) as Extract<Entity, { type: '3DSOLID' }>;
    expect(e.primitive?.op).toMatchObject({ radius: 10, height: 30 });
    expect(e.name).toBe('Cylindre');
    app.doc.undo();
    expect((app.doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).primitive?.op).toMatchObject({ radius: 5 });
  });
});

describe('Mètre 3D : normale de face et épaisseur', () => {
  it('épaisseur d’une plaque (lancer de rayon sur le maillage d’affichage)', async () => {
    const { faceNormalAt, rayHit } = await import('../src/app/commands/measure');
    const { meshDisplay } = await import('../src/kernel/MeshBodies');
    const { makeBox } = await import('../src/core/mesh/IndexedMesh');
    const display = meshDisplay({ mesh: makeBox(50, 40, 6), closed: true });
    const s = { type: '3DSOLID', handle: 'A', layer: '0', name: 'P', shapeId: 'S1', display } as never;
    const top = { x: 10, y: 10, z: 6 };
    // face du dessus : celle dont un triangle porte le point
    let face = -1;
    for (let f = 0; f < display.faceCount; f++) {
      const n = faceNormalAt(s, f, top);
      if (n && n.z > 0.99) face = f;
    }
    expect(face).toBeGreaterThanOrEqual(0);
    const n = faceNormalAt(s, face, top)!;
    const t = rayHit(s, { x: top.x, y: top.y, z: top.z - 1e-7 }, { x: -n.x, y: -n.y, z: -n.z });
    expect(t).toBeCloseTo(6, 5);
  });
});
