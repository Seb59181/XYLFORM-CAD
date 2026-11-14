/**
 * Xylform CAD 1.1.0 : saisie dynamique à deux cases, pas de grille, vues nommées, nouvelles cotes
 * (angulaire, longueur d'arc, ordonnée, en série, ligne de base).
 */
import { describe, expect, it } from 'vitest';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { constrainDyn, dynLayout, splitDyn, tabDyn } from '../src/core/commands/dynInput';
import type { PromptSpec } from '../src/core/commands';
import type { Entity } from '../src/core/document/Document';
import { dimensionGeometry, dimensionLabel, dimensionText, transformEntity } from '../src/core/entities/geometry';
import { loadProject, saveProject } from '../src/io/project';
import type { KernelClient } from '../src/kernel/KernelClient';

const kernel = {
  status: 'idle',
  busy: 0,
  generation: 0,
  onStatus: () => () => undefined,
  onProgress: () => () => undefined,
  start: async () => undefined,
  call: async () => undefined,
} as unknown as KernelClient;

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = (x: number, y: number) => ({ x, y, z: 0 });
type Dim = Extract<Entity, { type: 'DIMENSION' }>;
const dim = (d: Omit<Dim, 'handle' | 'layer'>): Dim => ({ handle: '1', layer: '0', ...d }) as Dim;

async function run(app: AppHost, ...inputs: string[]) {
  for (const s of inputs) {
    app.processor.submit(s);
    await tick();
  }
}

describe('saisie dynamique à deux cases', () => {
  const polar: PromptSpec = { kind: 'point', message: '', basePoint: P(10, 10) };
  const rect: PromptSpec = { kind: 'point', message: '', dynBase: P(10, 10), dynLabels: ['Largeur', 'Hauteur'] };

  it('choisit Longueur/Angle après un point de base, Largeur/Hauteur pour un coin opposé', () => {
    expect(dynLayout(polar)?.mode).toBe('polar');
    expect(dynLayout(rect)).toMatchObject({ mode: 'xy', labels: ['Largeur', 'Hauteur'] });
    expect(dynLayout({ kind: 'point', message: '' })).toMatchObject({ mode: 'xy', base: null });
    expect(dynLayout({ kind: 'distance', message: '' })).toBeNull();
    expect(dynLayout(polar, false)?.mode).toBe('xy');
  });

  it('Tab passe d’une case à l’autre', () => {
    expect(tabDyn('100', 'polar')).toBe('100<');
    expect(tabDyn('100<', 'polar')).toBe('100');
    expect(tabDyn('120', 'xy')).toBe('120,');
    expect(splitDyn('120,80', 'xy')).toEqual({ fields: ['120', '80'], active: 1 });
    expect(splitDyn('@5,0', 'xy')).toBeNull();
  });

  it('verrouille le curseur sur les valeurs tapées', () => {
    const p = constrainDyn(dynLayout(polar)!, '10', P(30, 10))!;
    expect(p.x).toBeCloseTo(20);
    expect(p.y).toBeCloseTo(10);
    const q = constrainDyn(dynLayout(polar)!, '10<90', P(30, 10))!;
    expect(q.x).toBeCloseTo(10);
    expect(q.y).toBeCloseTo(20);
    expect(constrainDyn(dynLayout(rect)!, '120,', P(50, 60))).toEqual({ x: 130, y: 60, z: 0 });
  });

  it('RECTANGLE : « 120,80 » au 2e coin = 120 × 80 depuis le 1er coin', async () => {
    const app = new AppHost(registerAll, kernel);
    app.set('dyn', true);
    app.set('dynRelative', true);
    await run(app, 'RECTANGLE', '10,10', '120,80');
    const r = app.doc.all()[0] as Extract<Entity, { type: 'POLYLINE' }>;
    expect(r.points).toContainEqual({ x: 130, y: 90, z: 0 });
    // « 120< » (seconde case vide) et ligne : longueur seule = entrée directe de distance
    await run(app, 'LIGNE', '0,0', '#5,0', '');
    const l = app.doc.all()[1] as Extract<Entity, { type: 'LINE' }>;
    expect(l.end).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('coordonnées absolues si COORDSDYN = Absolues', async () => {
    const app = new AppHost(registerAll, kernel);
    app.set('dyn', true);
    app.set('dynRelative', false);
    await run(app, 'RECTANGLE', '10,10', '120,80');
    const r = app.doc.all()[0] as Extract<Entity, { type: 'POLYLINE' }>;
    expect(r.points).toContainEqual({ x: 120, y: 80, z: 0 });
  });
});

describe('pas de la grille et de la résolution', () => {
  it('GRILLE et RESOL règlent le pas', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'GRILLE', '10');
    expect(app.settings.gridUnit).toBe(10);
    await run(app, 'RESOL', '2.5');
    expect(app.settings.snapUnit).toBe(2.5);
    expect(app.settings.snap).toBe(true);
    await run(app, 'GRILLE', 'AD');
    expect(app.settings.gridUnit).toBe(0);
  });
});

describe('vues nommées', () => {
  it('sont enregistrées dans le dessin et relues', async () => {
    const app = new AppHost(registerAll, kernel);
    const view = { projection: 'orthographic' as const, position: P(0, 0), target: P(5, 5), up: { x: 0, y: 1, z: 0 }, halfHeight: 40 };
    app.doc.putNamedView({ name: 'Face avant', view, style: 'technical', workspace: '3d' });
    app.doc.putNamedView({ name: 'face AVANT', view: { ...view, halfHeight: 20 } });
    expect(app.doc.namedViews).toHaveLength(1);
    expect(app.doc.namedView('Face avant')?.view.halfHeight).toBe(20);
    const bytes = await saveProject(app);
    const other = new AppHost(registerAll, kernel);
    await loadProject(other, bytes, 'x.xcad');
    expect(other.doc.namedViews.map((v) => v.name)).toEqual(['face AVANT']);
    other.doc.deleteNamedView('FACE avant');
    expect(other.doc.namedViews).toHaveLength(0);
  });
});

describe('nouvelles cotes', () => {
  it('angulaire entre deux lignes : secteur choisi par l’emplacement', () => {
    const base = { type: 'DIMENSION' as const, dimType: 'angular' as const, angLines: true, center: P(0, 0), p1: P(10, 0), p2: P(10, 10) };
    const inside = dim({ ...base, offsetPoint: P(8, 3) });
    expect((dimensionGeometry(inside).value * 180) / Math.PI).toBeCloseTo(45);
    expect(dimensionText(inside)).toBe('45°');
    const beside = dim({ ...base, offsetPoint: P(-2, 6) });
    expect((dimensionGeometry(beside).value * 180) / Math.PI).toBeCloseTo(135);
  });

  it('angulaire par trois points : angle ou complément', () => {
    const base = { type: 'DIMENSION' as const, dimType: 'angular' as const, center: P(0, 0), p1: P(10, 0), p2: P(0, 10) };
    expect((dimensionGeometry(dim({ ...base, offsetPoint: P(5, 5) })).value * 180) / Math.PI).toBeCloseTo(90);
    expect((dimensionGeometry(dim({ ...base, offsetPoint: P(-5, -5) })).value * 180) / Math.PI).toBeCloseTo(270);
  });

  it('longueur d’arc et symbole ⌒', () => {
    const d = dim({ type: 'DIMENSION', dimType: 'arclength', center: P(0, 0), p1: P(10, 0), p2: P(0, 10), offsetPoint: P(9, 9) });
    expect(dimensionGeometry(d).value).toBeCloseTo((Math.PI / 2) * 10);
    expect(dimensionText(d)).toBe('15.71');
    expect(dimensionLabel(d, 2.5).lines).toHaveLength(1);
  });

  it('ordonnée en X et en Y depuis l’origine', () => {
    const x = dim({ type: 'DIMENSION', dimType: 'ordinate', center: P(5, 5), p1: P(25, 12), p2: P(25, 12), ordAxis: 'x', offsetPoint: P(25, 30) });
    expect(dimensionGeometry(x).value).toBeCloseTo(20);
    const y = dim({ ...x, ordAxis: 'y', offsetPoint: P(40, 12) });
    expect(dimensionGeometry(y).value).toBeCloseTo(7);
    // rotation de 90° : la cote en X devient une cote en Y
    const rot = transformEntity(x, [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]) as Partial<Dim>;
    expect(rot.ordAxis).toBe('y');
  });

  it('COTCONTINUE et COTLIGNEBASE enchaînent à partir de la dernière cote', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'COTLIN', '0,0', '#10,0', '#5,-10');
    await run(app, 'COTCONTINUE', '#25,0', '#40,0', '');
    const dims = app.doc.all().filter((e): e is Dim => e.type === 'DIMENSION');
    expect(dims).toHaveLength(3);
    expect(dims.map((d) => dimensionGeometry(d).value)).toEqual([10, 15, 15]);
    expect(dims[2]!.offsetPoint.y).toBeCloseTo(dims[0]!.offsetPoint.y);
    await run(app, 'COTLIGNEBASE', '#60,0', '');
    const b = app.doc.all().filter((e): e is Dim => e.type === 'DIMENSION')[3]!;
    expect(b.p1).toEqual(dims[2]!.p1);
    expect(dimensionGeometry(b).value).toBeCloseTo(35);
    expect(b.offsetPoint.y).toBeLessThan(dims[2]!.offsetPoint.y);
  });

  it('COTANG entre deux côtés d’un rectangle tourné', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'COTANG', '', '#0,0', '#10,0', '#0,10', '#3,3');
    const d = app.doc.all()[0] as Dim;
    expect(d.dimType).toBe('angular');
    expect(dimensionText(d)).toBe('90°');
  });
});
