/**
 * Tôlerie : contour de base, reculs, longueur développée, mise à plat ; construction du
 * solide par le noyau (OCC=1).
 */
import { describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { bendAllowance, flatPattern, setback, sheetLayout, sheetVolume, signedArea, unfoldPoint, type SheetMetalDef } from '../src/core/geometry/sheetmetal';

const rect = (w: number, h: number, cw = false) => {
  const p = [
    { x: 0, y: 0, z: 0 },
    { x: w, y: 0, z: 0 },
    { x: w, y: h, z: 0 },
    { x: 0, y: h, z: 0 },
  ];
  return cw ? p.reverse() : p;
};

const tray = (inside = true): SheetMetalDef => ({
  points: rect(100, 60),
  thickness: 2,
  radius: 2,
  k: 0.44,
  inside,
  flanges: [0, 1, 2, 3].map((edge) => ({ edge, angle: 90, length: 20, up: true })),
});

describe('tôlerie : géométrie', () => {
  it('recul et longueur développée (formules usuelles)', () => {
    expect(setback({ thickness: 2, radius: 2 }, 90)).toBeCloseTo(4);
    expect(bendAllowance({ thickness: 2, radius: 2, k: 0.5 }, 90)).toBeCloseTo((Math.PI / 2) * 3);
  });

  it('position intérieure : le contour reste l’encombrement extérieur', () => {
    const L = sheetLayout(tray());
    expect(L.base.map((p) => [Math.round(p.x * 1e9) / 1e9, Math.round(p.y * 1e9) / 1e9])).toEqual([
      [4, 4],
      [96, 4],
      [96, 56],
      [4, 56],
    ]);
    expect(L.flanges.every((f) => Math.abs(f.straight - 16) < 1e-9)).toBe(true);
    const out = sheetLayout(tray(false));
    expect(out.base[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('contour en sens horaire : mêmes arêtes, normales vers l’extérieur', () => {
    const def: SheetMetalDef = { ...tray(), points: rect(100, 60, true), flanges: [{ edge: 0, angle: 90, length: 20, up: true }] };
    const L = sheetLayout(def);
    expect(signedArea(L.base)).toBeGreaterThan(0);
    // arête 0 du contour horaire : (0,60) → (100,60), normale vers +y
    expect(L.flanges[0]!.n.y).toBeCloseTo(1);
  });

  it('mise à plat : longueur développée = côtés extérieurs − déductions de pli', () => {
    const def = tray();
    const fp = flatPattern(def);
    const xs = fp.outline.map((p) => p.x), ys = fp.outline.map((p) => p.y);
    const BD = 2 * setback(def, 90) - bendAllowance(def, 90);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + 2 * 20 - 2 * BD - 2 * 4 + 2 * 4, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(60 + 40 - 2 * BD, 6);
    expect(fp.outline.length).toBe(12); // croix
    expect(fp.bends.length).toBe(4);
    expect(fp.bends[0]!.label).toBe('HAUT 90° Ri 2');
  });

  it('report d’un point du bord sur le développé', () => {
    const def = tray();
    const L = sheetLayout(def);
    // milieu du bord avant (y < 0 côté extérieur), à mi-hauteur de la partie droite
    const p = unfoldPoint(def, L, { x: 50, y: 1, z: 2 + 2 + 8 });
    const f0 = L.flanges.find((f) => f.n.y < -0.5)!;
    expect(p!.x).toBeCloseTo(50);
    expect(p!.y).toBeCloseTo(4 - f0.ba - 8, 6);
    expect(unfoldPoint(def, L, { x: 50, y: 30, z: 1 })).toMatchObject({ x: 50, y: 30 });
  });

  it('erreurs claires', () => {
    expect(() => sheetLayout({ ...tray(), flanges: [{ edge: 0, angle: 90, length: 3, up: true }] })).toThrow(/trop court/);
    expect(() => sheetLayout({ ...tray(), flanges: [{ edge: 0, angle: 170, length: 30, up: true }] })).toThrow(/150/);
  });
});

describe.skipIf(!process.env.OCC)('tôlerie : solide (noyau)', () => {
  it('bac à 4 bords : volume exact, un seul solide, plis vers le bas aussi', async () => {
    const k = new OccKernel(await initOpenCascade());
    const def = tray();
    const r = k.sheetMetal(def);
    expect(r.display.solidCount).toBe(1);
    expect(r.display.volume).toBeCloseTo(sheetVolume(def), 1);
    expect(r.display.bbox.min).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(0, 6) });
    expect(r.display.bbox.max.z).toBeCloseTo(20, 6);
    const down = { ...def, flanges: [{ edge: 1, angle: 45, length: 15, up: false }] };
    const d = k.sheetMetal(down);
    expect(d.display.volume).toBeCloseTo(sheetVolume(down), 1);
    expect(d.display.bbox.min.z).toBeLessThan(-5);
    // arête vive extérieure sur le contour, bord incliné de 45° vers l'extérieur
    expect(d.display.bbox.max.x).toBeCloseTo(100 + 15 * Math.SQRT1_2, 4);
  }, 60_000);
});
