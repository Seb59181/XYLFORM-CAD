/**
 * Import STL / 3MF : lecture, soudure, orientation, unités ; corps maillés dans le noyau
 * (booléens manifold-3d avec des solides B-rep, coupe, déplacement, enregistrement, CONVSOLIDE).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import Module from 'manifold-3d';
import { makeBox } from '../src/core/mesh/IndexedMesh';
import { exportStlBinary } from '../src/io/exporters/StlExporter';
import { exportThreeMf } from '../src/io/exporters/ThreeMfExporter';
import { readMeshFile, readStl } from '../src/io/meshImport';
import { isMeshData, loadMeshBody, meshBoolean, meshDisplay, saveMeshBody, transformMeshBody } from '../src/kernel/MeshBodies';
import { translation } from '../src/core/math/affine';

describe('Lecture STL / 3MF', () => {
  it('STL binaire : soudé, fermé, volume', () => {
    const { data } = exportStlBinary(makeBox(20, 10, 5));
    const [o] = readMeshFile('cube.stl', data);
    expect(o!.closed).toBe(true);
    expect(o!.triangles).toBe(12);
    expect(o!.mesh.positions.length / 3).toBe(8);
    expect(meshDisplay({ mesh: o!.mesh, closed: true }).volume).toBeCloseTo(1000, 3);
  });

  it('STL texte, triangles retournés réorientés, unité en cm', () => {
    const b = makeBox(2, 2, 2);
    const facets: string[] = [];
    for (let t = 0; t < 12; t++) {
      const ids = [b.indices[3 * t]!, b.indices[3 * t + 1]!, b.indices[3 * t + 2]!];
      if (t % 3 === 0) ids.reverse(); // un triangle sur trois à l'envers
      facets.push(`facet normal 0 0 0\n outer loop\n${ids.map((i) => `  vertex ${b.positions[3 * i]} ${b.positions[3 * i + 1]} ${b.positions[3 * i + 2]}`).join('\n')}\n endloop\nendfacet`);
    }
    const text = `solid cube\n${facets.join('\n')}\nendsolid cube\n`;
    expect(readStl(strToU8(text)).indices.length).toBe(36);
    const [o] = readMeshFile('cube.stl', strToU8(text), 10);
    expect(o!.closed).toBe(true);
    expect(o!.warnings.join()).toMatch(/réorienté/);
    expect(meshDisplay({ mesh: o!.mesh, closed: true }).volume).toBeCloseTo(8000, 3); // 2 cm = 20 mm
  });

  it('STL ouvert : surface', () => {
    const b = makeBox(1, 1, 1);
    const open = { positions: b.positions, indices: b.indices.slice(0, 30) };
    const [o] = readMeshFile('ouvert.stl', exportStlBinary(open, { allowNonManifold: true }).data);
    expect(o!.closed).toBe(false);
  });

  it('3MF : plusieurs objets nommés, couleurs', () => {
    const { data } = exportThreeMf([
      { name: 'Socle', mesh: makeBox(10, 10, 2), color: '#FF0000' },
      { name: 'Pion', mesh: makeBox(2, 2, 6, 4, 4, 2), color: '#00FF00' },
    ]);
    const objs = readMeshFile('jeu.3mf', data);
    expect(objs.map((o) => o.name)).toEqual(['Socle', 'Pion']);
    expect(objs.every((o) => o.closed)).toBe(true);
    expect(objs[0]!.color).toBe('#FF0000');
    expect(meshDisplay({ mesh: objs[1]!.mesh, closed: true }).volume).toBeCloseTo(24, 3);
  });

  it('affichage : faces planes regroupées, arêtes vives', () => {
    const d = meshDisplay({ mesh: makeBox(3, 2, 1), closed: true });
    expect(d.faceCount).toBe(6);
    expect(d.edgeCount).toBe(12); // diagonales des faces non tracées
    expect(d.meshTriangles).toBe(12);
  });

  it('enregistrement dans le .sebcad et transformation', () => {
    const body = transformMeshBody({ mesh: makeBox(1, 2, 3), closed: true }, translation({ x: 5, y: 0, z: 0 }));
    const data = saveMeshBody(body);
    expect(isMeshData(data)).toBe(true);
    const back = loadMeshBody(data);
    expect(back.closed).toBe(true);
    expect(Array.from(back.mesh.positions)).toEqual(Array.from(body.mesh.positions));
    expect(Array.from(back.mesh.indices)).toEqual(Array.from(body.mesh.indices));
    expect(meshDisplay(back).bbox.min.x).toBeCloseTo(5);
  });
});

describe('Booléens maillés', () => {
  let wasm: Awaited<ReturnType<typeof Module>>;
  beforeAll(async () => {
    wasm = await Module();
    wasm.setup();
  });

  it('soustraction, union, intersection', () => {
    const a = makeBox(10, 10, 10);
    const b = makeBox(10, 10, 10, 5, 0, 0);
    const vol = (m: ReturnType<typeof meshBoolean>) => meshDisplay(m).volume;
    expect(vol(meshBoolean(wasm, 'subtract', [a], [b]))).toBeCloseTo(500, 3);
    expect(vol(meshBoolean(wasm, 'union', [a], [b]))).toBeCloseTo(1500, 3);
    expect(vol(meshBoolean(wasm, 'intersect', [a], [b]))).toBeCloseTo(500, 3);
  });
});
