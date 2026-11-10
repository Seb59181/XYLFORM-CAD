/**
 * Mise en plan : nettoyage des projections, axes, mise en page, types de ligne, PDF ;
 * projection à lignes cachées par le noyau (OCC=1).
 */
import { describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { autoScale, axisCurves, cleanProjection, extentOf, gridCell, layoutViews, project, usableArea, VIEWS, yDirOf } from '../src/app/drawing';
import { dashPolys, linetypeFromDxf, patternOf } from '../src/core/linetypes';
import { pdfTextWidth, writePdf } from '../src/io/pdf';
import { writeDxf } from '../src/io/dxf';
import { loadProject, saveProject } from '../src/io/project';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import type { KernelClient } from '../src/kernel/KernelClient';

describe('mise en plan : géométrie', () => {
  it('repères des vues : directe, y vers le haut', () => {
    for (const k of ['front', 'left', 'right', 'back'] as const) expect(yDirOf(VIEWS[k].dir, VIEWS[k].xDir)).toMatchObject({ z: 1 });
    expect(yDirOf(VIEWS.top.dir, VIEWS.top.xDir)).toMatchObject({ y: 1 });
    expect(project({ x: 5, y: 0, z: 7 }, VIEWS.front.dir, VIEWS.front.xDir)).toEqual([5, 7]);
    expect(yDirOf(VIEWS.iso.dir, VIEWS.iso.xDir).z).toBeGreaterThan(0.5);
  });

  it('projection européenne : dessus sous la face, gauche à droite ; américaine inversée', () => {
    expect(gridCell('top', true)).toEqual([0, -1]);
    expect(gridCell('left', true)).toEqual([1, 0]);
    expect(gridCell('top', false)).toEqual([0, 1]);
    expect(gridCell('right', false)).toEqual([1, 0]);
  });

  it('arêtes cachées confondues avec une arête visible : supprimées ou raccourcies', () => {
    const r = cleanProjection({
      visible: [
        { k: 'line', a: [0, 0], b: [10, 0] },
        { k: 'line', a: [0, 0], b: [10, 0] },
        { k: 'arc', c: [5, 5], r: 2, a0: 0, a1: 0, full: true },
      ],
      hidden: [
        { k: 'line', a: [10, 0], b: [0, 0] },
        { k: 'line', a: [-5, 0], b: [15, 0] },
        { k: 'arc', c: [5, 5], r: 2, a0: 0, a1: 0, full: true },
        { k: 'poly', pts: [[0, 3], [5, 3], [10, 3]] },
      ],
      smooth: [],
    });
    expect(r.visible.length).toBe(2);
    const lines = r.hidden.filter((c) => c.k === 'line');
    // le segment [-5,15] perd sa partie [0,10] ; la polyligne droite devient une ligne
    const onAxis = lines.filter((c) => c.k === 'line' && c.a[1] === 0).map((c) => (c.k === 'line' ? [Math.min(c.a[0], c.b[0]), Math.max(c.a[0], c.b[0])] : []));
    expect(onAxis.sort((x, y) => x[0]! - y[0]!)).toEqual([[-5, 0], [10, 15]]);
    expect(r.hidden.some((c) => c.k === 'arc')).toBe(false);
    expect(lines.some((c) => c.k === 'line' && c.a[1] === 3)).toBe(true);
  });

  it('axes : un trait par axe, marques de centre', () => {
    const cyl = [
      { c: { x: 20, y: 25, z: 0 }, d: { x: 0, y: 0, z: 1 }, r: 6, t0: -1, t1: 0 },
      { c: { x: 20, y: 25, z: 0 }, d: { x: 0, y: 0, z: 1 }, r: 6, t0: 20, t1: 29 },
    ];
    const front = axisCurves(cyl, VIEWS.front.dir, VIEWS.front.xDir, 3);
    expect(front.length).toBe(1);
    const l = front[0]!;
    expect(l.k === 'line' && [Math.min(l.a[1], l.b[1]), Math.max(l.a[1], l.b[1])]).toEqual([-4, 32]);
    expect(axisCurves(cyl, VIEWS.top.dir, VIEWS.top.xDir, 3).length).toBe(2); // croix
  });

  it('mise en page en grille et échelle automatique', () => {
    const g = (w: number, h: number) => ({ visible: [], hidden: [], smooth: [], axes: [], extent: { min: [0, 0] as [number, number], max: [w, h] as [number, number] } });
    const laid = layoutViews(
      [
        { kind: 'front', geom: g(80, 20) },
        { kind: 'top', geom: g(80, 50) },
        { kind: 'left', geom: g(50, 20) },
      ],
      true,
      10,
      [0, 0],
    );
    const at = Object.fromEntries(laid.map((v) => [v.kind, v.at]));
    expect(at.top!.x).toBeCloseTo(at.front!.x); // même colonne
    expect(at.left!.y).toBeCloseTo(at.front!.y); // même rangée
    expect(at.top!.y + 50).toBeLessThan(at.front!.y); // dessus sous la face
    expect(at.left!.x).toBeGreaterThan(at.front!.x + 80);
    const area = usableArea('A4', true);
    expect(autoScale(80, 50, [20, 20], area)).toBe(0.5); // 2:1
    expect(autoScale(800, 500, [20, 20], area)).toBe(5); // 1:5
    expect(extentOf([{ k: 'arc', c: [0, 0], r: 2, a0: 0, a1: 0, full: true }])).toEqual({ min: [-2, -2], max: [2, 2] });
  });
});

describe('types de ligne', () => {
  it('tirets à l’échelle, motif continu d’un segment à l’autre', () => {
    const d = dashPolys([[{ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }]], patternOf('HIDDEN', 1));
    expect(d.length).toBe(2); // 3 trait, 1,5 vide, 3 trait, 1,5 vide
    expect(d[0]![1]!.x).toBeCloseTo(3);
    expect(d[1]![0]!.x).toBeCloseTo(4.5);
    expect(patternOf('HIDDEN', 2)).toEqual([6, -3]);
    expect(dashPolys([[{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]], [3, -1.5]).length).toBe(1); // trop court : plein
    expect(linetypeFromDxf('HIDDEN2')).toBe('HIDDEN');
    expect(linetypeFromDxf('ACAD_ISO04W100')).toBe('CENTER');
    expect(linetypeFromDxf('Continuous')).toBeUndefined();
  });

  it('DXF : table LTYPE et type de ligne du calque', () => {
    const t = writeDxf([], [{ name: 'MEP-Cachées', color: '#9aa6b5', lineweight: 0.25, linetype: 'HIDDEN', visible: true, frozen: false, locked: false }], 4, 2);
    expect(t).toMatch(/LTYPE\s+2\s+HIDDEN/);
    expect(t).toMatch(/MEP-Cachées[\s\S]*?\n\s*6\s*\nHIDDEN/);
    expect(t).toMatch(/\$LTSCALE\s+40\s+2/);
  });
});

describe('fichier .sebcad', () => {
  it('feuilles de mise en plan et types de ligne conservés, annulables', async () => {
    const kernel = { status: 'idle', busy: 0, ready: Promise.resolve(), start: () => Promise.resolve(), onStatus: () => undefined, onProgress: () => undefined } as unknown as KernelClient;
    const app = new AppHost(registerAll, kernel);
    app.doc.addLayer('MEP-Cachées', '#9aa6b5');
    app.doc.updateLayer('MEP-Cachées', { linetype: 'HIDDEN' });
    const h = app.doc.addEntity({ type: 'LINE', layer: 'MEP-Cachées', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } });
    app.doc.putSheet({ id: 'F1', name: 'Mise en plan F1', format: 'A3', landscape: true, k: 2, origin: { x: 0, y: 0, z: 0 }, title: 'Essai', frame: [], views: [{ id: 'F1.front', name: 'Face', sources: [], dir: VIEWS.front.dir, xDir: VIEWS.front.xDir, at: { x: 5, y: 5, z: 0 }, hidden: true, smooth: false, axes: true, handles: [h] }] });
    expect(app.doc.sheets.length).toBe(1);
    app.doc.undo();
    expect(app.doc.sheets.length).toBe(0);
    app.doc.redo();
    const data = await saveProject(app);
    const app2 = new AppHost(registerAll, kernel);
    await loadProject(app2, data, 'essai.xcad');
    expect(app2.doc.sheets[0]).toMatchObject({ id: 'F1', k: 2, title: 'Essai' });
    expect(app2.doc.layer('MEP-Cachées')?.linetype).toBe('HIDDEN');
    expect(app2.doc.nextSheetId()).toBe('F2');
  });
});

describe('PDF', () => {
  it('structure valide (table xref exacte), texte en WinAnsi', () => {
    const pdf = writePdf([{ w: 297, h: 210, items: [{ kind: 'path', pts: [[0, 0], [100, 50]], stroke: '#000000', width: 0.5, dash: [3, 1.5] }, { kind: 'text', x: 10, y: 10, size: 5, text: 'Échelle 1:2 Ø10 (cote)', align: 'center' }] }], 'Essai');
    const s = Array.from(pdf, (b) => String.fromCharCode(b)).join('');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    const xref = parseInt(/startxref\n(\d+)/.exec(s)![1]!, 10);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const offs = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => parseInt(m[1]!, 10));
    offs.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(s).toContain('\\311chelle'); // É en octal
    expect(s).toContain('\\330'); // Ø
    expect(s).toContain('\\(cote\\)');
    expect(s).toMatch(/\/MediaBox \[0 0 841\.89 595\.276\]/);
    expect(pdfTextWidth('MM', 10)).toBeCloseTo(16.66, 1);
  });
});

describe.skipIf(!process.env.OCC)('mise en plan : lignes cachées (noyau)', () => {
  it('pièce percée : contours visibles, perçage caché en vue de face, cercle en vue de dessus', async () => {
    const k = new OccKernel(await initOpenCascade());
    const b = k.box({ x: 0, y: 0, z: 0 }, { x: 40, y: 20, z: 10 });
    const c = k.cylinder({ x: 20, y: 10, z: -1 }, 5, 12);
    const r = k.boolean('subtract', [b.shapeId], [c.shapeId]);
    const front = cleanProjection(k.hlr([r.shapeId], VIEWS.front.dir, VIEWS.front.xDir, true, false));
    expect(extentOf(front.visible)).toEqual({ min: [0, 0], max: [40, 10] });
    const hx = front.hidden.filter((x) => x.k === 'line' && Math.abs(x.a[0] - x.b[0]) < 1e-9).map((x) => (x.k === 'line' ? x.a[0] : 0)).sort((a, b) => a - b);
    expect(hx).toEqual([15, 25]);
    const raw = k.hlr([r.shapeId], VIEWS.top.dir, VIEWS.top.xDir, true, false);
    expect(raw.visible.some((x) => x.k === 'arc' && x.full && Math.abs(x.r - 5) < 1e-9 && Math.abs(x.c[0] - 20) < 1e-9)).toBe(true);
    expect(raw.cylinders.length).toBeGreaterThan(0);
    expect(axisCurves(raw.cylinders, VIEWS.front.dir, VIEWS.front.xDir, 3).length).toBe(1);
    const top = cleanProjection(raw);
    expect(top.hidden.length).toBe(0); // fond et cercle inférieur derrière les arêtes visibles
  }, 60_000);
});
