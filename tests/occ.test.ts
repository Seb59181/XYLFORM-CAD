/**
 * Test d'intégration du noyau B-rep : plaque − cylindre (perçage traversant).
 * Lent (chargement du WASM OpenCascade ≈ 50 Mo) : exécuté à part avec `npm run test:occ`.
 */
import { describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import type { OpenCascadeInstance } from 'opencascade.js';
import { subtractBRep, tessellate } from '../src/core/geometry/BooleanSubtract';
import { exportStlBinary } from '../src/io/exporters/StlExporter';

describe.skipIf(!process.env.OCC)('Soustraction B-rep (OpenCascade.js)', () => {
  it('plaque 40×40×10 percée d’un trou Ø10 : solide valide et maillage étanche', async () => {
    const oc = (await initOpenCascade()) as OpenCascadeInstance;
    const plate = new oc.BRepPrimAPI_MakeBox_2(40, 40, 10).Shape();
    const axis = new oc.gp_Ax2_3(new oc.gp_Pnt_3(20, 20, -5), new oc.gp_Dir_4(0, 0, 1));
    const drill = new oc.BRepPrimAPI_MakeCylinder_3(axis, 5, 20).Shape();

    const r = subtractBRep(oc, plate, [drill]);
    expect(r.valid).toBe(true);
    expect(r.volume).toBeCloseTo(40 * 40 * 10 - Math.PI * 25 * 10, 3);

    const tess = tessellate(oc, r.shape, { linearDeflection: 0.01 });
    expect(tess.facesWithoutTriangulation).toBe(0);
    expect(tess.manifold.isWatertight).toBe(true);
    expect(tess.manifold.genus).toBe(1);
    // flèche 0,01 mm : volume maillé à 0,1 % près du volume exact
    expect(Math.abs(tess.manifold.volume - r.volume) / r.volume).toBeLessThan(1e-3);

    const { data } = exportStlBinary(tess.mesh);
    expect(data.byteLength).toBe(84 + 50 * tess.manifold.triangles);
  }, 180_000);
});
