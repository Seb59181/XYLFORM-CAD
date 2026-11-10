/**
 * Tests d'intégration du noyau B-rep (toutes les opérations exposées à l'interface).
 * Lents (chargement du WASM) : `npm run test:occ`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { checkManifold } from '../src/core/mesh/ManifoldCheck';
import { faceInfo } from '../src/core/geometry/faces';
import type { SolidResult } from '../src/kernel/protocol';
import { entityArea, isClosedProfile, profileOf } from '../src/core/entities/geometry';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { run } from '../src/kernel/dispatch';
import type { KernelClient } from '../src/kernel/KernelClient';
import type { KernelRequest } from '../src/kernel/protocol';
import { translation } from '../src/core/math/affine';
import { makeBox } from '../src/core/mesh/IndexedMesh';
import type { Entity } from '../src/core/document/Document';

const O = { x: 0, y: 0, z: 0 };
let k: OccKernel;

function watertight(k: OccKernel, r: SolidResult) {
  const [mesh] = k.exportMesh([r.shapeId], 0.05, 1);
  return checkManifold(mesh!);
}

describe.skipIf(!process.env.OCC)('OccKernel', () => {
  beforeAll(async () => {
    k = new OccKernel(await initOpenCascade());
  }, 120_000);

  it('polyligne refermée à la main (dernier point = premier) : solide plein', () => {
    const pts = [O, { x: 20, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }, { x: 10, y: 5, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }];
    const e = { type: 'POLYLINE', handle: 'A', layer: '0', points: pts, closed: false } as unknown as Entity;
    expect(isClosedProfile(e)).toBe(true);
    const p = profileOf(e)!;
    expect(p.kind === 'poly' && p.closed && p.points.length === 5).toBe(true);
    const s = k.extrude(p, 10, 0);
    expect(s.display.volume).toBeCloseTo(150 * 10, 4);
    expect(watertight(k, s).isManifold).toBe(true);
  });

  it('spline refermée à la main : extrusion en solide plein', () => {
    const fit = [O, { x: 20, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, O];
    const e = { type: 'SPLINE', handle: 'S', layer: '0', fitPoints: fit, closed: false } as unknown as Entity;
    expect(isClosedProfile(e)).toBe(true);
    const s = k.extrude(profileOf(e)!, 5, 0);
    expect(s.display.solidCount).toBe(1);
    expect(Math.abs(s.display.volume / (entityArea(e)! * 5) - 1)).toBeLessThan(0.01);
    expect(watertight(k, s).isManifold).toBe(true);
  });

  it('spline dont un point est sorti du plan : aplanie si l’écart est petit, message clair sinon', () => {
    const base = [O, { x: 60, y: 0, z: 0 }, { x: 70, y: 40, z: 0 }, { x: 30, y: 60, z: 0 }, { x: -10, y: 30, z: 0 }];
    const mk = (dz: number) =>
      ({ type: 'SPLINE', handle: 'S', layer: '0', fitPoints: base.map((p, i) => (i >= 3 ? { ...p, z: dz } : p)), closed: true }) as unknown as Entity;
    const s = k.extrude(profileOf(mk(0.2))!, 10, 0);
    expect(s.display.solidCount).toBe(1);
    expect(s.warnings.join()).toMatch(/aplani/);
    expect(() => k.extrude(profileOf(mk(-30))!, 10, 0)).toThrow(/Profil non plan : le point/);
  });

  it('primitive modifiée dans Propriétés : nouvelles cotes, même placement', async () => {
    const kernel = {
      status: 'ready',
      ready: Promise.resolve(),
      start: () => Promise.resolve(),
      onStatus: () => undefined,
      solid: (r: KernelRequest) => Promise.resolve(run(k, r)),
      call: (r: KernelRequest) => Promise.resolve(run(k, r)),
    } as unknown as KernelClient;
    const app = new AppHost(registerAll, kernel);
    const op = { op: 'cylinder' as const, center: O, radius: 5, height: 10 };
    const h = app.addSolid(await app.solid(undefined, op), 'Cylindre', undefined, undefined, op);
    await app.transformEntities([h], translation({ x: 100, y: 0, z: 0 }), { label: 'Déplacer' });
    await app.editPrimitive(h, { ...op, radius: 10, height: 30 });
    const e = app.doc.get(h) as Extract<Entity, { type: '3DSOLID' }>;
    expect(e.display.volume).toBeCloseTo(Math.PI * 100 * 30, 3);
    expect(e.display.bbox.min.x).toBeCloseTo(90, 3);
    expect(e.display.bbox.max.z).toBeCloseTo(30, 3);
  });

  it('primitives : volumes exacts et maillages étanches', () => {
    const box = k.box({ x: 10, y: 10, z: 0 }, { x: -10, y: 20, z: 5 });
    expect(box.display.volume).toBeCloseTo(1000, 6);
    expect(box.display.faceCount).toBe(6);
    expect(box.display.edgeCount).toBe(12);
    expect(k.cylinder(O, 5, 10).display.volume).toBeCloseTo(Math.PI * 250, 4);
    expect(k.cylinder(O, 5, -10).display.bbox.min.z).toBeCloseTo(-10);
    expect(k.cone(O, 5, 0, 9).display.volume).toBeCloseTo((Math.PI * 25 * 9) / 3, 4);
    expect(k.cone(O, 5, 2, 9).display.volume).toBeCloseTo((Math.PI * 9 * (25 + 10 + 4)) / 3, 4);
    expect(k.sphere(O, 3).display.volume).toBeCloseTo((4 / 3) * Math.PI * 27, 4);
    const torus = k.torus(O, 10, 2);
    expect(torus.display.volume).toBeCloseTo(2 * Math.PI * Math.PI * 10 * 4, 3);
    expect(watertight(k, torus).genus).toBe(1);
    const pyr = k.pyramid(O, 4, Math.SQRT2 * 5, 0, 12, Math.PI / 4);
    expect(pyr.display.volume).toBeCloseTo((100 * 12) / 3, 4);
  });

  it('extrusion droite et avec dépouille (cercle et polyligne)', () => {
    const sq = { kind: 'poly' as const, points: [O, { x: 20, y: 0, z: 0 }, { x: 20, y: 20, z: 0 }, { x: 0, y: 20, z: 0 }], closed: true };
    expect(k.extrude(sq, 10, 0).display.volume).toBeCloseTo(4000, 4);
    const tapered = k.extrude(sq, 10, 10);
    const t = 10 * Math.tan((10 * Math.PI) / 180);
    const top = 20 - 2 * t;
    expect(tapered.display.volume).toBeCloseTo((10 / 3) * (400 + top * top + 20 * top), 2);
    // sens inverse du polygone : même résultat
    const rev = k.extrude({ ...sq, points: [...sq.points].reverse() }, 10, 10);
    expect(rev.display.volume).toBeCloseTo(tapered.display.volume, 4);
    const cone = k.extrude({ kind: 'circle', center: O, radius: 10 }, 10, 20);
    const r2 = 10 - 10 * Math.tan((20 * Math.PI) / 180);
    expect(cone.display.volume).toBeCloseTo((Math.PI * 10 * (100 + 10 * r2 + r2 * r2)) / 3, 2);
    expect(() => k.extrude({ kind: 'circle', center: O, radius: 1 }, 10, 45)).toThrow(/referme/);
  });

  it('révolution partielle et complète', () => {
    const rect = { kind: 'poly' as const, points: [{ x: 10, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, { x: 12, y: 5, z: 0 }, { x: 10, y: 5, z: 0 }], closed: true };
    const full = k.revolve(rect, O, { x: 0, y: 1, z: 0 }, 360, 0);
    expect(full.display.volume).toBeCloseTo(Math.PI * (144 - 100) * 5, 3);
    const half = k.revolve(rect, O, { x: 0, y: 1, z: 0 }, 180, 30);
    expect(half.display.volume).toBeCloseTo((Math.PI * (144 - 100) * 5) / 2, 3);
  });

  it('hélice + balayage : ressort étanche', { timeout: 30_000 }, () => {
    const helix = { kind: 'helix' as const, center: O, baseRadius: 10, topRadius: 10, height: 30, turns: 5, ccw: true };
    const spring = k.sweep({ kind: 'circle', center: O, radius: 1 }, helix, true);
    const len = 5 * Math.hypot(2 * Math.PI * 10, 6);
    expect(spring.display.volume).toBeCloseTo(Math.PI * len, 0);
    expect(watertight(k, spring).isWatertight).toBe(true);
    // hélice conique, sens horaire
    const conical = k.sweep({ kind: 'circle', center: O, radius: 0.8 }, { ...helix, topRadius: 4, ccw: false }, true);
    expect(conical.display.volume).toBeGreaterThan(0);
  });

  it('balayage le long d’une polyligne à angle droit', () => {
    const path = { kind: 'poly' as const, points: [O, { x: 0, y: 0, z: 30 }, { x: 30, y: 0, z: 30 }], closed: false };
    const pipe = k.sweep({ kind: 'circle', center: O, radius: 2 }, path, true);
    expect(pipe.display.volume).toBeGreaterThan(Math.PI * 4 * 55);
    expect(watertight(k, pipe).isWatertight).toBe(true);
  });

  it('lissage cercle → carré', () => {
    const loft = k.loft(
      [
        { kind: 'circle', center: O, radius: 10 },
        { kind: 'poly', points: [{ x: -5, y: -5, z: 20 }, { x: 5, y: -5, z: 20 }, { x: 5, y: 5, z: 20 }, { x: -5, y: 5, z: 20 }], closed: true },
      ],
      false,
    );
    expect(loft.display.volume).toBeGreaterThan(100 * 20);
    expect(loft.display.volume).toBeLessThan(Math.PI * 100 * 20);
  });

  it('booléens : union, soustraction, intersection', () => {
    const a = k.box(O, { x: 20, y: 20, z: 10 });
    const b = k.box({ x: 10, y: 10, z: 0 }, { x: 20, y: 20, z: 10 });
    expect(k.boolean('union', [a.shapeId, b.shapeId], []).display.volume).toBeCloseTo(4000 + 4000 - 1000, 4);
    expect(k.boolean('subtract', [a.shapeId], [b.shapeId]).display.volume).toBeCloseTo(3000, 4);
    expect(k.boolean('intersect', [a.shapeId, b.shapeId], []).display.volume).toBeCloseTo(1000, 4);
    const far = k.box({ x: 100, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(() => k.boolean('intersect', [a.shapeId, far.shapeId], [])).toThrow(/recoupent/);
    // l'union de faces affleurantes fusionne les faces coplanaires
    const c = k.box({ x: 20, y: 0, z: 0 }, { x: 20, y: 20, z: 10 });
    expect(k.boolean('union', [a.shapeId, c.shapeId], []).display.faceCount).toBe(6);
  });

  it('congé, chanfrein et coque', { timeout: 60_000 }, () => {
    const box = k.box(O, { x: 20, y: 20, z: 20 });
    const all = k.fillet(box.shapeId, 'all', 2);
    expect(all.display.volume).toBeLessThan(8000);
    expect(watertight(k, all).isWatertight).toBe(true);
    const one = k.fillet(box.shapeId, [0], 3);
    expect(one.display.volume).toBeCloseTo(8000 - (9 - (Math.PI * 9) / 4) * 20, 3);
    const ch = k.chamfer(box.shapeId, [0], 2);
    expect(ch.display.volume).toBeCloseTo(8000 - 2 * 20, 3);
    expect(() => k.fillet(box.shapeId, 'all', 15)).toThrow(/Congé impossible/);

    // coque ouverte : face du haut retirée (identifiée par sa position)
    const top = topFace(box);
    const shell = k.shell(box.shapeId, [top], 2);
    expect(shell.display.volume).toBeCloseTo(8000 - 16 * 16 * 18, 2);
    // coque fermée (évidement)
    const hollow = k.shell(box.shapeId, [], 2);
    expect(hollow.display.volume).toBeCloseTo(8000 - 16 * 16 * 16, 2);
    expect(watertight(k, hollow).shells).toBe(2);
  });

  it('appuyer/tirer sur une face plane', { timeout: 60_000 }, () => {
    const box = k.box(O, { x: 20, y: 20, z: 20 });
    const top = topFace(box);
    const info = faceInfo(box.display, top)!;
    expect(info.planar).toBe(true);
    expect(info.normal.z).toBeCloseTo(1, 6);
    expect(info.area).toBeCloseTo(400, 3);
    expect(info.boundary).toHaveLength(1);
    const pulled = k.pressPull(box.shapeId, top, 5);
    expect(pulled.display.volume).toBeCloseTo(10000, 3);
    expect(pulled.display.bbox.max.z).toBeCloseTo(25, 6);
    expect(pulled.display.faceCount).toBe(6);
    const pushed = k.pressPull(box.shapeId, top, -5);
    expect(pushed.display.volume).toBeCloseTo(6000, 3);
    expect(watertight(k, pushed).isWatertight).toBe(true);
    // face latérale +X
    const side = Array.from({ length: box.display.faceCount }, (_, f) => f).find((f) => faceInfo(box.display, f)!.normal.x > 0.99)!;
    expect(k.pressPull(box.shapeId, side, 3).display.bbox.max.x).toBeCloseTo(23, 6);
    expect(() => k.pressPull(box.shapeId, top, -25)).toThrow(/traverse/);
    // cylindre : disque du haut plan, face latérale non plane
    const cyl = k.cylinder(O, 5, 10);
    const faces = Array.from({ length: cyl.display.faceCount }, (_, f) => faceInfo(cyl.display, f)!);
    const disk = faces.findIndex((f) => f.planar && f.normal.z > 0.99);
    const lateral = faces.findIndex((f) => !f.planar);
    expect(disk).toBeGreaterThanOrEqual(0);
    expect(lateral).toBeGreaterThanOrEqual(0);
    expect(k.pressPull(cyl.shapeId, disk, 2).display.volume).toBeCloseTo(Math.PI * 25 * 12, 3);
    expect(() => k.pressPull(cyl.shapeId, lateral, 2)).toThrow(/face plane/);
  });

  it('transformations (déplacement, rotation, miroir)', () => {
    const box = k.box(O, { x: 10, y: 5, z: 2 });
    const moved = k.transform(box.shapeId, [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(moved.display.bbox.min.x).toBeCloseTo(100);
    const mirrored = k.transform(box.shapeId, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(mirrored.display.bbox.max.x).toBeCloseTo(0);
    expect(mirrored.display.volume).toBeCloseTo(100, 6);
  });

  it('STEP et BREP : aller-retour', () => {
    const cyl = k.cylinder(O, 4, 8);
    const step = k.exportStep([cyl.shapeId]);
    expect(new TextDecoder().decode(step.subarray(0, 13))).toBe('ISO-10303-21;');
    const [back] = k.importStep(step);
    expect(back!.display.volume).toBeCloseTo(cyl.display.volume, 4);
    const brep = k.saveBrep(cyl.shapeId);
    expect(k.loadBrep(brep).display.volume).toBeCloseTo(cyl.display.volume, 6);
  });

  it('surfaces : extrusion ouverte, surface plane, carreau, épaississement', () => {
    const wall = k.extrude({ kind: 'poly', points: [O, { x: 20, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }], closed: false }, 15, 0, true);
    expect(wall.display.solidCount).toBe(0);
    expect(wall.display.area).toBeCloseTo((20 + 10) * 15, 4);
    const plate = k.planeSurface({ kind: 'circle', center: O, radius: 5 });
    expect(plate.display.area).toBeCloseTo(Math.PI * 25, 4);
    const solid = k.thicken(plate.shapeId, 2);
    expect(solid.display.solidCount).toBe(1);
    expect(solid.display.volume).toBeCloseTo(Math.PI * 25 * 2, 3);
    const rev = k.revolve({ kind: 'poly', points: [{ x: 5, y: 0, z: 0 }, { x: 8, y: 0, z: 10 }], closed: false }, O, { x: 0, y: 0, z: 1 }, 360, 0, true);
    expect(rev.display.solidCount).toBe(0);
    // carreau sur quatre arêtes gauches
    const q = [O, { x: 10, y: 0, z: 2 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 3 }];
    const edges = q.map((p, i) => ({ kind: 'poly' as const, points: [p, q[(i + 1) % 4]!], closed: false }));
    const patch = k.patch(edges);
    expect(patch.display.faceCount).toBe(1);
    expect(patch.display.area).toBeGreaterThan(100);
  });

  it('coupe par un plan et vérification', () => {
    const box = k.box(O, { x: 10, y: 10, z: 10 });
    const halves = k.slice(box.shapeId, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 1 }, 'both');
    expect(halves.length).toBe(2);
    expect(halves.map((h) => h.display.volume).sort((a, b) => a - b)[0]).toBeCloseTo(400, 4);
    const top = k.slice(box.shapeId, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 1 }, 'positive');
    expect(top.length).toBe(1);
    expect(top[0]!.display.volume).toBeCloseTo(600, 4);
    const rep = k.check(box.shapeId);
    expect(rep).toMatchObject({ valid: true, solids: 1, faces: 6, edges: 12, freeEdges: 0 });
    const open = k.check(k.planeSurface({ kind: 'circle', center: O, radius: 5 }).shapeId);
    expect(open.freeEdges).toBe(1);
  });

  it('polyligne à arcs (rectangle arrondi), cylindre incliné, congé variable', { timeout: 60_000 }, () => {
    // rectangle 20×10 aux coins arrondis R2 : renflement tan(90°/4)
    const b = Math.tan(Math.PI / 8);
    const pts = [
      { x: 2, y: 0, z: 0 }, { x: 18, y: 0, z: 0 }, { x: 20, y: 2, z: 0 }, { x: 20, y: 8, z: 0 },
      { x: 18, y: 10, z: 0 }, { x: 2, y: 10, z: 0 }, { x: 0, y: 8, z: 0 }, { x: 0, y: 2, z: 0 },
    ];
    const plate = k.extrude({ kind: 'poly', points: pts, closed: true, bulges: [0, b, 0, b, 0, b, 0, b] }, 3, 0);
    expect(plate.display.volume).toBeCloseTo((200 - (4 - Math.PI) * 4) * 3, 3);
    expect(plate.display.faceCount).toBe(10);
    const tilted = k.cylinder(O, 2, 10, { x: 1, y: 0, z: 0 });
    expect(tilted.display.bbox.max.x).toBeCloseTo(10, 4);
    expect(tilted.display.volume).toBeCloseTo(Math.PI * 40, 3);
    const box = k.box(O, { x: 20, y: 20, z: 20 });
    const varFillet = k.fillet(box.shapeId, [0], 1, 4);
    expect(varFillet.display.volume).toBeLessThan(8000);
    expect(varFillet.display.faceCount).toBe(7);
  });
});

/** Index de la face dont tous les triangles sont en z = max. */
function topFace(r: SolidResult): number {
  const d = r.display;
  const zmax = d.bbox.max.z;
  for (let f = 0; f < d.faceCount; f++) {
    let ok = true, seen = false;
    for (let t = 0; t < d.faceIds.length; t++) {
      if (d.faceIds[t] !== f) continue;
      seen = true;
      for (let k = 0; k < 3; k++) if (Math.abs(d.positions[3 * d.indices[3 * t + k]! + 2]! - zmax) > 1e-6) ok = false;
    }
    if (seen && ok) return f;
  }
  throw new Error('face du haut introuvable');
}

describe.skipIf(!process.env.OCC)('Corps maillés (STL/3MF importés)', () => {
  let km: OccKernel;
  beforeAll(async () => {
    km = new OccKernel(await initOpenCascade());
    const mf = await (await import('manifold-3d')).default();
    mf.setup();
    km.manifold = mf;
  }, 120_000);

  const cube = () => {
    const b = makeBox(20, 20, 20);
    return km.meshBody(b.positions, b.indices, true);
  };

  it('perçage d’un corps maillé par un cylindre B-rep, puis coupe et déplacement', () => {
    const m = cube();
    expect(m.display.meshTriangles).toBe(12);
    const c = km.cylinder({ x: 10, y: 10, z: -5 }, 4, 30);
    const r = km.boolean('subtract', [m.shapeId], [c.shapeId]);
    expect(r.display.meshTriangles).toBeGreaterThan(12);
    expect(r.display.volume).toBeCloseTo(8000 - Math.PI * 16 * 20, -1);
    const [half] = km.slice(r.shapeId, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 }, 'positive');
    expect(half!.display.volume).toBeCloseTo(r.display.volume / 2, 0);
    const moved = km.transform(half!.shapeId, translation({ x: 100, y: 0, z: 0 }));
    expect(moved.display.bbox.min.x).toBeCloseTo(100, 5);
    expect(km.check(moved.shapeId).freeEdges).toBe(0);
  });

  it('raccord refusé avec un message clair, CONVSOLIDE puis raccord', () => {
    const m = cube();
    expect(() => km.fillet(m.shapeId, 'all', 1)).toThrow(/CONVSOLIDE/);
    const s = km.convertToSolid(m.shapeId, true);
    expect(s.display.meshTriangles).toBeUndefined();
    expect(s.display.faceCount).toBe(6);
    expect(s.display.volume).toBeCloseTo(8000, 3);
    const f = km.fillet(s.shapeId, 'all', 2);
    expect(f.display.volume).toBeLessThan(8000);
  });

  it('enregistrement .sebcad et export STEP', () => {
    const m = cube();
    const back = km.loadBrep(km.saveBrep(m.shapeId));
    expect(back.display.meshTriangles).toBe(12);
    expect(km.exportStep([back.shapeId]).length).toBeGreaterThan(500);
    expect(km.exportMesh([back.shapeId], 0.1, 5)[0]!.indices.length).toBe(36);
  });
});

describe.skipIf(!process.env.OCC)('Texte 3D', () => {
  let kt: OccKernel;
  beforeAll(async () => {
    kt = new OccKernel(await initOpenCascade());
  }, 120_000);

  it('lettres à trous (« Aéro 8 ») extrudées puis gravées dans une plaque', async () => {
    const { loadFont, textRegions, regionsSize } = await import('../src/core/geometry/text3d');
    const font = await loadFont('sans');
    const regions = textRegions(font, 'Aéro 8', 10);
    expect(regionsSize(regions).h).toBeGreaterThan(10); // accent au-dessus des majuscules
    const to3 = (p: [number, number]) => ({ x: p[0] + 30, y: p[1] + 15, z: 5 });
    const t0 = Date.now();
    const letters = kt.extrudeRegions(regions.map((r) => ({ outer: r.outer.map(to3), holes: r.holes.map((h) => h.map(to3)) })), { x: 0, y: 0, z: -1 });
    expect(letters.display.solidCount).toBeGreaterThanOrEqual(5);
    expect(letters.display.volume).toBeGreaterThan(20);
    const plate = kt.box({ x: 0, y: 0, z: 0 }, { x: 60, y: 30, z: 5 });
    const engraved = kt.boolean('subtract', [plate.shapeId], [letters.shapeId]);
    expect(engraved.display.solidCount).toBe(1);
    expect(engraved.display.volume).toBeCloseTo(9000 - letters.display.volume, 1);
    expect(watertight(kt, engraved).isWatertight).toBe(true);
    console.log('texte 3D', Date.now() - t0, 'ms');
  }, 120_000);
});
