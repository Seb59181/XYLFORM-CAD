/**
 * Xylform CAD 1.2.0 : styles de cote, repères et étiquettes, guides, accrochages, cotes 3D,
 * cotes associatives, mise en plan, blocs, plans de coupe, scènes.
 */
import { nextSectionName, planeFrame, flatSection } from '../src/app/commands/sectionPlanes';
import { describe, expect, it } from 'vitest';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import type { Entity } from '../src/core/document/Document';
import { dimensionGeometry, dimensionLabel, dimensionText } from '../src/core/entities/geometry';
import { loadProject, saveProject } from '../src/io/project';
import type { KernelClient } from '../src/kernel/KernelClient';

export const kernel = {
  status: 'idle',
  busy: 0,
  generation: 0,
  onStatus: () => () => undefined,
  onProgress: () => () => undefined,
  start: async () => undefined,
  call: async () => undefined,
} as unknown as KernelClient;

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = (x: number, y: number, z = 0) => ({ x, y, z });
type Dim = Extract<Entity, { type: 'DIMENSION' }>;
const dims = (app: AppHost) => app.doc.all().filter((e): e is Dim => e.type === 'DIMENSION');

async function run(app: AppHost, ...inputs: string[]) {
  for (const s of inputs) {
    app.processor.submit(s);
    await tick();
  }
}

describe('styles de cote', () => {
  it('flèches, séparateur, préfixe/suffixe et tolérances', async () => {
    const app = new AppHost(registerAll, kernel);
    app.doc.putDimStyle({ name: 'Méca', arrow: 'oblique', decimals: 1, sep: ',', suffix: ' mm', tol: 'symmetric', tolPlus: 0.05 });
    app.doc.currentDimStyle = 'Méca';
    await run(app, 'COTALI', '0,0', '#12.25,0', '#5,5');
    const d = dims(app)[0]!;
    expect(d.dimStyle).toBe('Méca');
    expect(dimensionText(d)).toBe('12,3 mm ±0,1');
    // flèches obliques : pas de remplissage
    expect(dimensionGeometry(d).fills).toHaveLength(0);
    app.doc.putDimStyle({ name: 'Méca', arrow: 'closed', decimals: 2, tol: 'deviation', tolPlus: 0.1, tolMinus: 0.05 });
    const g = dimensionGeometry(app.doc.get(d.handle) as Dim);
    expect(g.fills).toHaveLength(2);
    const lab = dimensionLabel(app.doc.get(d.handle) as Dim, 2.5);
    expect(lab.texts.map((t) => t.text)).toEqual(['12.25', '+0.1', '−0.05']);
    // tolérance propre à la cote
    app.doc.replaceEntity(d.handle, { tol: 'limits', tolPlus: 0.1, tolMinus: 0.1 });
    expect(dimensionLabel(app.doc.get(d.handle) as Dim, 2.5).texts.map((t) => t.text)).toEqual(['12.35', '12.15']);
    const bytes = await saveProject(app);
    const other = new AppHost(registerAll, kernel);
    await loadProject(other, bytes, 'x.xcad');
    expect(other.doc.dimStyles['Méca']?.tol).toBe('deviation');
    expect(other.doc.currentDimStyle).toBe('Méca');
  });
});

describe('modificateurs de point', () => {
  it('DE : point de base puis décalage', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'LIGNE', 'DE', '10,10', '@5,2', '#30,12', '');
    const l = app.doc.all()[0] as Extract<Entity, { type: 'LINE' }>;
    expect(l.start).toEqual(P(15, 12));
  });
  it('M2P : milieu de deux points', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'CERCLE', 'M2P', '0,0', '#10,4', '3');
    const c = app.doc.all()[0] as Extract<Entity, { type: 'CIRCLE' }>;
    expect(c.center).toEqual(P(5, 2));
  });
});

describe('repères et étiquettes', () => {
  it('REPERE : flèche, coude, texte sur plusieurs lignes', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'REPERE', '0,0', '#10,10', 'Percer\\nØ8');
    const d = dims(app)[0]!;
    expect(d.dimType).toBe('leader');
    const lab = dimensionLabel(d, 2.5);
    expect(lab.texts.map((t) => t.text)).toEqual(['Percer', 'Ø8']);
    // texte à droite du palier
    expect(lab.texts[0]!.at.x).toBeGreaterThan(12.5);
    expect(dimensionGeometry(d).fills).toHaveLength(1);
  });

  it('ETIQUETTE : aire recalculée quand l’objet change, texte gardé s’il est effacé', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'RECTANGLE', '#0,0', '#10,5');
    const r = app.doc.all()[0]!;
    app.processor.submit('ETIQUETTE');
    await tick();
    app.processor.pickEntity({ handle: r.handle, point: P(10, 2) });
    await tick();
    await run(app, '#20,10', '');
    const d = dims(app)[0]!;
    expect(dimensionText(d)).toBe('Aire 50 mm²');
    app.doc.replaceEntity(r.handle, { points: [P(0, 0), P(20, 0), P(20, 5), P(0, 5)] });
    expect(dimensionText(app.doc.get(d.handle) as Dim)).toBe('Aire 100 mm²');
    app.doc.removeEntity(r.handle);
    const after = app.doc.get(d.handle) as Dim;
    expect(after.labelOf).toBeUndefined();
    expect(dimensionText(after)).toBe('Aire 100 mm²');
  });
});

describe('cotes associatives et 3D', () => {
  it('la cote suit la ligne cotée (étirement, déplacement)', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'LIGNE', '#0,0', '#10,0', '');
    const l = app.doc.all()[0]!;
    await run(app, 'COTALI', '#0,0', '#10,0', '#5,5');
    const d = dims(app)[0]!;
    expect(d.assoc?.map((a) => a.ref)).toEqual(['start', 'end']);
    app.doc.replaceEntity(l.handle, { end: P(25, 0) });
    expect(dimensionGeometry(app.doc.get(d.handle) as Dim).value).toBeCloseTo(25);
    // déplacement de la ligne seule : la cote vient avec, au même écart
    await app.transformEntities([l.handle], [1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1, 0], { label: 'Déplacer' });
    const moved = app.doc.get(d.handle) as Dim;
    expect(moved.p1).toEqual(P(0, 30));
    expect(moved.offsetPoint.y).toBeCloseTo(35);
  });

  it('cote 3D : ligne de cote dans le plan des points, texte face à l’écran', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'COT3D', '#0,0,0', '#0,0,20', '#5,0,10');
    const d = dims(app)[0]!;
    expect(d.dim3d).toBe(true);
    const g = dimensionGeometry(d);
    expect(g.value).toBeCloseTo(20);
    expect(g.lines[2]![0]).toEqual(P(5, 0, 0));
    expect(dimensionLabel(d, 2.5).billboard).toBe(true);
  });
});

describe('lignes de construction', () => {
  it('GUIDE par deux points, décalage d’une ligne, hors de l’export', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'GUIDE', '#0,0', '#1,1', '');
    const g = app.doc.all()[0] as Extract<Entity, { type: 'LINE' }>;
    expect(g.guide).toBe(true);
    expect(g.layer).toBe('Guides');
    expect(Math.abs(g.end.x - g.end.y)).toBeLessThan(1e-6);
    await run(app, 'LIGNE', '#0,0', '#10,0', '');
    const l = app.doc.all()[1]!;
    app.processor.submit('GUIDE');
    await tick();
    await run(app, 'D');
    app.processor.pickEntity({ handle: l.handle, point: P(5, 0) });
    await tick();
    await run(app, '7.5', '#5,-3');
    const par = app.doc.all()[2] as Extract<Entity, { type: 'LINE' }>;
    expect(par.start.y).toBeCloseTo(-7.5);
    expect(par.end.y).toBeCloseTo(-7.5);
    await run(app, 'RAPPORTEUR', '#0,0', '#10,0', '30');
    const r = app.doc.all()[3] as Extract<Entity, { type: 'LINE' }>;
    expect((Math.atan2(r.end.y - r.start.y, r.end.x - r.start.x) * 180) / Math.PI).toBeCloseTo(30);
    await run(app, 'EFFGUIDES');
    expect(app.doc.all()).toHaveLength(1);
  });
});

describe('blocs et composants', () => {
  it('BLOC, INSERER, redéfinition suivie par les copies, DECOMPOS', async () => {
    const app = new AppHost(registerAll, kernel);
    await run(app, 'LIGNE', '#0,0', '#10,0', '');
    await run(app, 'CERCLE', '#5,5', '2');
    app.selection.set(app.doc.all().map((e) => e.handle));
    await run(app, 'BLOC', 'Vis', '#0,0');
    const def = Object.values(app.doc.underlays).find((d) => d.kind === 'block')!;
    expect(def.entities).toHaveLength(2);
    expect(app.doc.all()).toHaveLength(1);
    await run(app, 'INSERER', '#100,0', '2', '0');
    app.processor.cancel();
    await tick();
    expect(app.doc.underlayInstances(def.id)).toHaveLength(2);
    // redéfinition : un rectangle seul
    await run(app, 'RECTANGLE', '#0,0', '#4,4');
    app.selection.set([app.doc.all().pop()!.handle]);
    await run(app, 'BLOC', 'vis', '#0,0');
    expect(app.doc.underlays[def.id]!.entities).toHaveLength(1);
    expect(app.doc.underlayInstances(def.id)).toHaveLength(2);
    // décomposer la copie à l'échelle 2
    const big = app.doc.underlayInstances(def.id).find((e) => e.scale === 2)!;
    app.selection.set([big.handle]);
    await run(app, 'DECOMPOS');
    const rect = app.doc.all().find((e) => e.type === 'POLYLINE') as Extract<Entity, { type: 'POLYLINE' }>;
    expect(rect.points).toContainEqual(P(108, 8));
  });
});

describe('plans de coupe', () => {
  it('noms libres, repère du plan et mise à plat recentrée', () => {
    expect(nextSectionName([])).toBe('Coupe 1');
    expect(nextSectionName([{ id: 'a', name: 'coupe 1', origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } }])).toBe('Coupe 2');
    const f = planeFrame({ x: 0, y: 0, z: -1 });
    expect(Math.hypot(f.xDir.x, f.xDir.y, f.xDir.z)).toBeCloseTo(1);
    expect(f.xDir.x * f.dir.x + f.xDir.y * f.dir.y + f.xDir.z * f.dir.z).toBeCloseTo(0);
    const flat = flatSection([[{ x: 10, y: 0, z: 5 }, { x: 50, y: 0, z: 5 }, { x: 50, y: 20, z: 5 }, { x: 10, y: 20, z: 5 }]], { x: 0, y: 0, z: -1 });
    const xs = flat[0]!.map((p) => p[0]), ys = flat[0]!.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20);
    expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0);
  });
});


describe('scènes', () => {
  it('une scène garde les calques visibles et la coupe active, et les rétablit', async () => {
    const { saveNamedView, restoreNamedView, transitionToNamedView } = await import('../src/app/commands/utility');
    const app = new AppHost(registerAll, kernel);
    let state = { projection: 'perspective' as const, position: P(100, -100, 100), target: P(0, 0, 0), up: P(0, 0, 1), halfHeight: 50 };
    const sections: unknown[] = [];
    app.viewport = {
      getViewState: () => state,
      setViewState: (s: typeof state) => (state = s),
      transitionTo: async (s: typeof state) => void (state = s),
      setSection: (s: unknown) => sections.push(s),
      setWorkspace: () => undefined,
      setProjection: () => undefined,
      redraw: () => undefined,
      rebuild: () => undefined,
      setWorkPlane: () => undefined,
      setGridUnit: () => undefined,
    } as unknown as AppHost['viewport'];
    app.doc.addLayer('Cotes');
    app.doc.putSectionPlane({ id: 's1', name: 'Coupe 1', origin: P(0, 0, 5), normal: P(0, 0, -1) });
    app.set('workspace', '3d');
    app.doc.updateLayer('Cotes', { visible: false });
    expect(saveNamedView(app, 'Coupée')).toBe(true);
    const v = app.doc.namedView('Coupée')!;
    expect(v.layersOn).not.toContain('Cotes');
    expect(v.section).toBe('s1');
    // on change tout, puis on rappelle la scène
    app.doc.updateLayer('Cotes', { visible: true });
    app.doc.setActiveSection(null);
    state = { ...state, target: P(50, 50, 0) };
    expect(restoreNamedView(app, 'Coupée')).toBe(true);
    expect(app.doc.layer('Cotes')!.visible).toBe(false);
    expect(app.doc.activeSection).toBe('s1');
    expect(state.target).toEqual(P(0, 0, 0));
    state = { ...state, target: P(9, 9, 9) };
    expect(await transitionToNamedView(app, 'Coupée', 10)).toBe(true);
    expect(state.target).toEqual(P(0, 0, 0));
    // la scène survit à l'enregistrement du projet
    const data = await saveProject(app);
    const app2 = new AppHost(registerAll, kernel);
    await loadProject(app2, data, 'scenes.xcad');
    expect(app2.doc.namedView('Coupée')?.section).toBe('s1');
    expect(app2.doc.sectionPlanes[0]?.name).toBe('Coupe 1');
  });

  it('encode un GIF animé valide', async () => {
    const { encodeGif } = await import('../src/io/gif');
    const w = 32, h = 16;
    const frame = (c: number) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < d.length; i += 4) (d[i] = c), (d[i + 1] = 255 - c), (d[i + 2] = (i / 4) % 255), (d[i + 3] = 255);
      return { width: w, height: h, data: d };
    };
    const g = encodeGif([frame(0), frame(128), frame(255)], 100);
    expect(String.fromCharCode(...g.slice(0, 6))).toBe('GIF89a');
    expect(g[6]! | (g[7]! << 8)).toBe(w);
    expect(g[g.length - 1]).toBe(0x3b);
    expect([...g].filter((b, i) => b === 0x2c && g[i - 8] === 0x21 && g[i - 7] === 0xf9).length).toBe(3);
  });
});
