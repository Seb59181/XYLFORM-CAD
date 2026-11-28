import { describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { writeIfc, stepReal, stepString, type IfcElementInput } from '../src/io/ifc/IfcWriter';
import { readIfc, decodeStep } from '../src/io/ifc/IfcReader';
import { classify, classFromText, ifcGuid, isIfcGuid } from '../src/core/bim';

/** Cube de côté s posé en (x, y, z) : 8 sommets, 12 triangles (normales sortantes). */
function cube(s: number, x = 0, y = 0, z = 0) {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(x + (i & 1 ? s : 0), y + (i & 2 ? s : 0), z + (i & 4 ? s : 0));
  const f = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions: new Float64Array(p), indices: new Uint32Array(f) };
}

const elements = (): IfcElementInput[] => [
  { name: 'Mur nord', cls: 'IfcWall', layer: 'Murs', color: '#c0a080', material: 'Béton', box: { origin: { x: 1000, y: 0, z: 0 }, xAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, size: { x: 4000, y: 200, z: 2500 } }, volume: 4000 * 200 * 2500, size: { length: 4000, width: 200, height: 2500 } },
  { name: 'Bloc é', cls: 'IfcBuildingElementProxy', layer: '0', color: '#ff0000', mesh: cube(500, 100, 200, 300), volume: 125e6, area: 1.5e6, size: { length: 500, width: 500, height: 500 } },
  { name: 'Poteau', cls: 'IfcColumn', layer: 'Structure', color: '#999999', box: { origin: { x: 3000, y: 3000, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, size: { x: 300, y: 300, z: 2800 }, radius: 150 }, size: { length: 300, width: 300, height: 2800 } },
  { name: 'Porte', cls: 'IfcDoor', layer: 'Menuiseries', color: '#8a5a2b', mesh: cube(900, 5000, 0, 0), size: { length: 900, width: 900, height: 900 } },
];

async function api() {
  const a = new IfcAPI();
  await a.Init(undefined, true);
  return a;
}

describe('IFC', () => {
  it('écrit les réels et chaînes STEP', () => {
    expect(stepReal(1)).toBe('1.');
    expect(stepReal(-0.5)).toBe('-0.5');
    expect(stepReal(1e-7)).toBe('1.E-07');
    expect(stepString("l'été")).toBe("'l''\\X2\\00E9\\X0\\t\\X2\\00E9\\X0\\'");
    expect(decodeStep("l'\\X2\\00E9\\X0\\t\\X2\\00E9\\X0\\")).toBe("l'été");
  });

  it('identifiants IFC', () => {
    const g = ifcGuid();
    expect(isIfcGuid(g)).toBe(true);
    expect(g).toHaveLength(22);
  });

  it('classe les solides', () => {
    expect(classFromText('Solide 3')).toBeUndefined();
    expect(classFromText('Murs extérieurs')).toBe('IfcWall');
    expect(classFromText('POTEAUX')).toBe('IfcColumn');
    expect(classify({ size: { a: 5000, b: 200, h: 2500 }, fill: 1 })).toBe('IfcWall');
    expect(classify({ size: { a: 5000, b: 4000, h: 200 }, fill: 1 })).toBe('IfcSlab');
    expect(classify({ size: { a: 300, b: 300, h: 2800 }, fill: 1 })).toBe('IfcColumn');
    expect(classify({ size: { a: 5000, b: 200, h: 400 }, fill: 1 })).toBe('IfcBeam');
    expect(classify({ size: { a: 50, b: 40, h: 30 }, fill: 1 })).toBe('IfcBuildingElementProxy');
    expect(classify({ cls: 'IfcRoof', name: 'Mur', size: { a: 1, b: 1, h: 1 }, fill: 1 })).toBe('IfcRoof');
  });

  for (const schema of ['IFC4', 'IFC2X3'] as const) {
    it(`aller-retour ${schema}`, async () => {
      const text = writeIfc({ schema, fileName: 'essai.ifc', project: 'Projet', site: 'Terrain', building: 'Maison', storey: 'RDC', application: 'Xylform CAD', version: '1.7.0', elements: elements() });
      const a = await api();
      const r = readIfc(a, new TextEncoder().encode(text));
      a.Dispose();
      expect(r.schema).toBe(schema);
      expect(r.project).toBe('Projet');
      expect(r.elements).toHaveLength(4);
      const byName = new Map(r.elements.map((e) => [e.name, e]));
      const box = (e: { positions: Float64Array }) => {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < e.positions.length; i++) {
          lo[i % 3] = Math.min(lo[i % 3]!, e.positions[i]!);
          hi[i % 3] = Math.max(hi[i % 3]!, e.positions[i]!);
        }
        return { lo, hi };
      };
      const wall = byName.get('Mur nord')!;
      expect(wall.type).toBe('IFCWALL');
      expect(wall.material).toBe('Béton');
      expect(wall.storey).toBe('RDC');
      const wb = box(wall);
      // boîte de 4000 × 200 × 2500 tournée de 90° : X de 800 à 1000, Y de 0 à 4000
      expect(wb.lo[0]).toBeCloseTo(800, 1);
      expect(wb.hi[0]).toBeCloseTo(1000, 1);
      expect(wb.lo[1]).toBeCloseTo(0, 1);
      expect(wb.hi[1]).toBeCloseTo(4000, 1);
      expect(wb.hi[2]).toBeCloseTo(2500, 1);
      const bloc = byName.get('Bloc é')!;
      const bb = box(bloc);
      expect(bb.lo).toEqual([100, 200, 300].map((v) => expect.closeTo(v, 1)));
      expect(bb.hi).toEqual([600, 700, 800].map((v) => expect.closeTo(v, 1)));
      expect(bloc.color).toBe('#ff0000');
      expect(byName.get('Porte')!.type).toBe('IFCDOOR');
      // poteau rond : disque de rayon 150 centré en (3000, 3000), de 0 à 2800
      const pb = box(byName.get('Poteau')!);
      expect(pb.lo).toEqual([2850, 2850, 0].map((v) => expect.closeTo(v, -1)));
      expect(pb.hi).toEqual([3150, 3150, 2800].map((v) => expect.closeTo(v, -1)));
    });
  }
});
