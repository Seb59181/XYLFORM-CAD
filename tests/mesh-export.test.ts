import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import Module from 'manifold-3d';
import { makeBox, mergeMeshes, signedVolume, type IndexedMesh } from '../src/core/mesh/IndexedMesh';
import { cleanMesh } from '../src/core/mesh/MeshCleaner';
import { checkManifold, NonManifoldError, repairOrientation } from '../src/core/mesh/ManifoldCheck';
import { exportStlBinary } from '../src/io/exporters/StlExporter';
import { exportThreeMf } from '../src/io/exporters/ThreeMfExporter';
import { subtractMesh } from '../src/core/geometry/BooleanSubtract';

/** Version « soupe de triangles » (sommets non partagés), comme en sortie de tessellation par face. */
function explode(m: IndexedMesh): IndexedMesh {
  const positions = new Float64Array(m.indices.length * 3);
  m.indices.forEach((v, i) => positions.set(m.positions.subarray(3 * v, 3 * v + 3), 3 * i));
  return { positions, indices: Uint32Array.from(m.indices, (_, i) => i) };
}

function flipTriangle(m: IndexedMesh, t: number): IndexedMesh {
  const indices = new Uint32Array(m.indices);
  [indices[3 * t + 1], indices[3 * t + 2]] = [indices[3 * t + 2]!, indices[3 * t + 1]!];
  return { positions: m.positions, indices };
}

function invert(m: IndexedMesh): IndexedMesh {
  let r = m;
  for (let t = 0; t < m.indices.length / 3; t++) r = flipTriangle(r, t);
  return r;
}

describe('ManifoldCheck', () => {
  it('cube fermé : étanche, genre 0, volume correct', () => {
    const r = checkManifold(makeBox(10, 20, 30));
    expect(r).toMatchObject({ isWatertight: true, boundaryEdges: 0, shells: 1, eulerCharacteristic: 2, genus: 0 });
    expect(r.volume).toBeCloseTo(6000);
  });

  it('détecte un trou', () => {
    const box = makeBox(1, 1, 1);
    const holed = { positions: box.positions, indices: box.indices.slice(0, -3) };
    const r = checkManifold(holed);
    expect(r.isManifold).toBe(false);
    expect(r.boundaryEdges).toBe(3);
  });

  it('détecte une arête non-manifold (trois faces sur une arête)', () => {
    const a = makeBox(1, 1, 1);
    const b = makeBox(1, 1, 1, 1, 1, 0); // touche a uniquement par une arête verticale
    const { mesh } = cleanMesh(mergeMeshes([a, b]));
    const r = checkManifold(mesh);
    expect(r.nonManifoldEdges).toBeGreaterThan(0);
    expect(r.isWatertight).toBe(false);
  });

  it('répare une normale inversée et un solide entièrement retourné', () => {
    const one = repairOrientation(flipTriangle(makeBox(2, 2, 2), 5));
    expect(one.flippedTriangles).toBe(1);
    expect(checkManifold(one.mesh).isWatertight).toBe(true);

    const all = repairOrientation(invert(makeBox(2, 2, 2)));
    expect(signedVolume(all.mesh)).toBeCloseTo(8);
  });

  it('oriente correctement une cavité interne (coques imbriquées)', () => {
    const outer = makeBox(10, 10, 10);
    const cavity = makeBox(4, 4, 4, 3, 3, 3); // mal orientée : normales vers l'extérieur
    const fixed = repairOrientation(mergeMeshes([outer, cavity]));
    const r = checkManifold(fixed.mesh);
    expect(r.shells).toBe(2);
    expect(r.volume).toBeCloseTo(1000 - 64);
  });
});

describe('MeshCleaner', () => {
  it('ressoude une soupe de triangles en maillage étanche', () => {
    const soup = explode(makeBox(5, 5, 5));
    expect(checkManifold(soup).isManifold).toBe(false);
    const { mesh, report } = cleanMesh(soup);
    expect(report.weldedVertices).toBe(36 - 8);
    expect(checkManifold(mesh).isWatertight).toBe(true);
  });

  it('supprime triangles dégénérés et doubles parois', () => {
    const box = makeBox(1, 1, 1);
    const extra = new Uint32Array([...box.indices, 0, 0, 1, 0, 1, 2, 0, 2, 1]);
    // 0,1,2 est l'opposé de la face 0,2,1 → double paroi ; 0,0,1 dégénéré
    const { report } = cleanMesh({ positions: box.positions, indices: extra });
    expect(report.degenerateTriangles).toBe(1);
    expect(report.internalWallTriangles).toBe(2);
    expect(report.duplicateTriangles).toBe(1);
  });
});

describe('Exports', () => {
  it('STL binaire : taille, en-tête, unités converties en mm, normales', () => {
    const { data, prepared } = exportStlBinary(makeBox(1, 2, 3), { sourceUnit: 'cm' });
    expect(data.byteLength).toBe(84 + 50 * 12);
    expect(new TextDecoder().decode(data.subarray(0, 5))).not.toBe('solid');
    const view = new DataView(data.buffer);
    expect(view.getUint32(80, true)).toBe(12);
    expect(prepared.manifold.volume).toBeCloseTo(6000); // 1×2×3 cm³ = 6000 mm³
    // première facette : face du bas → normale -Z
    expect(view.getFloat32(84 + 8, true)).toBeCloseTo(-1);
  });

  it('STL : refuse un maillage ouvert, sauf si autorisé', () => {
    const box = makeBox(1, 1, 1);
    const holed = { positions: box.positions, indices: box.indices.slice(0, -3) };
    expect(() => exportStlBinary(holed)).toThrow(NonManifoldError);
    const { prepared } = exportStlBinary(holed, { allowNonManifold: true });
    expect(prepared.warnings[0]).toMatch(/non étanche/);
  });

  it('STL : corrige automatiquement les normales inversées', () => {
    const { prepared } = exportStlBinary(invert(makeBox(1, 1, 1)));
    expect(prepared.flippedTriangles).toBe(12);
    expect(prepared.manifold.isWatertight).toBe(true);
    expect(prepared.manifold.volume).toBeCloseTo(1);
  });

  it('3MF : paquet OPC valide, unité mm, objets nommés et colorés', () => {
    const { data } = exportThreeMf(
      [
        { name: 'Boîtier', mesh: makeBox(10, 10, 5), color: '#C8A050' },
        { name: 'Couvercle <v2>', mesh: makeBox(10, 10, 1), transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 20, 0, 0] },
      ],
      { title: 'Test', creationDate: '2026-10-25' },
    );
    const files = unzipSync(data);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(files['3D/3dmodel.model']!);
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('displaycolor="#C8A050FF"');
    expect(xml).toContain('name="Couvercle &lt;v2&gt;"');
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 20 0 0"');
    expect(xml.match(/<triangle /g)).toHaveLength(24);
    expect(xml.match(/<vertex /g)).toHaveLength(16);
    expect(strFromU8(files['_rels/.rels']!)).toContain('/3D/3dmodel.model');
  });
});

describe('Soustraction maillée (manifold-3d)', () => {
  it('perce une boîte et produit un solide étanche', async () => {
    const wasm = await Module();
    wasm.setup();
    const plate = makeBox(20, 20, 5);
    const pocket = makeBox(6, 6, 10, 7, 7, -2); // traversant
    const r = subtractMesh(wasm, plate, [pocket]);
    expect(r.volume).toBeCloseTo(20 * 20 * 5 - 6 * 6 * 5, 3);
    expect(r.manifold.isWatertight).toBe(true);
    expect(r.manifold.genus).toBe(1); // un trou traversant = genre 1
  });
});
