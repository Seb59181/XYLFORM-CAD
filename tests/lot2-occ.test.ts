/**
 * Xylform CAD 1.2.0 avec le noyau (OCC=1) : vue en coupe hachurée, vue de détail, nomenclature,
 * bulles, rappel de perçage, cotes associées aux vues après MAJVUES.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { run as runKernel } from '../src/kernel/dispatch';
import type { KernelRequest } from '../src/kernel/protocol';
import type { KernelClient } from '../src/kernel/KernelClient';
import { AppHost, type FormSpec } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { featureId, type Entity, type Feature } from '../src/core/document/Document';
import { standardHole } from '../src/core/geometry/holes';
import { editFeatureParam } from '../src/app/history';
import { dimensionGeometry, dimensionText } from '../src/core/entities/geometry';
import { viewBounds } from '../src/app/drawingExtra';

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (f: () => boolean, ms = 30000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 5));
};
type Dim = Extract<Entity, { type: 'DIMENSION' }>;

describe.skipIf(!process.env.OCC)('mise en plan avancée (noyau)', () => {
  let app: AppHost;
  beforeAll(async () => {
    const k = new OccKernel(await initOpenCascade());
    const kernel = {
      status: 'ready',
      busy: 0,
      ready: Promise.resolve(),
      start: () => Promise.resolve(),
      onStatus: () => undefined,
      onProgress: () => undefined,
      solid: (r: KernelRequest) => Promise.resolve(runKernel(k, r)),
      call: (r: KernelRequest) => Promise.resolve(runKernel(k, r)),
    } as unknown as KernelClient;
    app = new AppHost(registerAll, kernel);
    app.ui = { ...app.ui, form: async (spec: FormSpec) => Object.fromEntries(spec.fields.map((f) => [f.key, f.key === 'format' ? 'none' : f.key === 'iso' || f.key === 'left' ? false : f.value])) };
  }, 60_000);

  async function cmd(...inputs: string[]) {
    for (const s of inputs) {
      app.processor.submit(s);
      await tick();
      await until(() => !!app.activeSpec || app.processor.isIdle, 30000);
    }
    await until(() => app.processor.isIdle, 60000);
  }

  it('coupe, détail, nomenclature, bulle, rappel de trou, cotes qui suivent MAJVUES', async () => {
    const h0: Feature[] = [{ kind: 'create', op: { op: 'box', corner: { x: 0, y: 0, z: 0 }, size: { x: 40, y: 20, z: 10 } }, id: featureId(), name: 'Boîte' }];
    const h = app.addSolid(await app.replay(h0), 'Plaque', undefined, undefined, h0);
    await app.applyStep(h, { kind: 'hole', spec: standardHole('tapped', 'M6', 8), at: [{ x: 10, y: 10, z: 10 }, { x: 30, y: 10, z: 10 }], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Trou' }, 'Perçage');
    await cmd('MISEENPLAN', '', '#200,0');
    const sheet = app.doc.sheets[0]!;
    const front = sheet.views.find((v) => v.id.endsWith('.front'))!;
    const top = sheet.views.find((v) => v.id.endsWith('.top'))!;
    const tb = viewBounds(app, top)!;
    expect(tb.max.x - tb.min.x).toBeCloseTo(40, 3);
    // coupe A-A par le milieu de la vue de dessus (y = 10), on regarde vers +Y
    const midY = (tb.min.y + tb.max.y) / 2;
    await cmd('VUECOUPE', `#${tb.min.x + 1},${midY}`, `#${tb.max.x - 1},${midY}`, `#${tb.min.x + 20},${midY + 5}`, '#200,80');
    const sec = app.doc.sheets[0]!.views.find((v) => v.section)!;
    expect(sec.name).toBe('Coupe A-A');
    const hatch = sec.handles.map((x) => app.doc.get(x)!).find((e) => e.type === 'HATCH') as Extract<Entity, { type: 'HATCH' }>;
    expect(hatch.pattern).toBe('ANSI31');
    expect(hatch.boundaries.length).toBeGreaterThanOrEqual(1);
    // détail B agrandi 2 fois
    await cmd('VUEDETAIL', `#${tb.min.x + 10},${tb.min.y + 10}`, '6', '2', '#300,0');
    const det = app.doc.sheets[0]!.views.find((v) => v.detail)!;
    expect(det.detail!.label).toBe('B');
    expect(det.handles.length).toBeGreaterThan(2);
    // nomenclature et bulle
    await cmd('NOMENCLATURE', '#0,-80');
    expect(app.doc.sheets[0]!.bom?.handles.length).toBeGreaterThan(5);
    await cmd('BULLE', `#${tb.min.x + 2},${tb.min.y + 2}`, '#150,-30');
    const bubble = app.doc.all().find((e): e is Dim => e.type === 'DIMENSION' && !!e.balloon)!;
    expect(dimensionText(bubble)).toBe('1');
    // rappel de perçage sur le cercle de la vue de dessus
    const circle = top.handles.map((x) => app.doc.get(x)!).find((e) => e.type === 'CIRCLE' && Math.abs(e.radius - 2.5) < 0.01)!;
    expect(circle).toBeTruthy();
    app.processor.submit('RAPPELTROU');
    await tick();
    app.processor.pickEntity({ handle: circle.handle, point: (circle as Extract<Entity, { type: 'CIRCLE' }>).center });
    await tick();
    await cmd('#100,-20');
    const note = app.doc.all().find((e): e is Dim => e.type === 'DIMENSION' && e.dimType === 'leader' && !!e.textOverride)!;
    expect(note.textOverride).toMatch(/^2× M6.* prof\. 8/);
    // cote sur la largeur de la vue de face, puis la plaque passe à 60 mm
    const vis = front.handles.map((x) => app.doc.get(x)!).filter((e): e is Extract<Entity, { type: 'LINE' }> => e.type === 'LINE' && e.layer === 'MEP-Visible');
    const xs = vis.flatMap((l) => [l.start.x, l.end.x]), ys = vis.flatMap((l) => [l.start.y, l.end.y]);
    const fb = { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
    await cmd('COTLIN', `#${fb.min.x},${fb.max.y}`, `#${fb.max.x},${fb.max.y}`, `#${fb.min.x + 20},${fb.max.y + 10}`);
    const d = app.doc.all().filter((e): e is Dim => e.type === 'DIMENSION' && e.dimType === 'linear').pop()!;
    expect(d.assoc?.length).toBe(2);
    await editFeatureParam(app, h, [0], 'L', '60');
    await cmd('MAJVUES');
    const d2 = app.doc.get(d.handle) as Dim;
    expect(dimensionGeometry(d2).value).toBeCloseTo(60, 3);
    expect(d2.assoc?.length).toBe(2);
  }, 120_000);

  it('plan de coupe enregistré posé à plat (COUPE2D)', async () => {
    const solid = app.doc.all().find((e) => e.type === '3DSOLID') as Extract<Entity, { type: '3DSOLID' }>;
    const b = solid.display.bbox;
    const zc = (b.min.z + b.max.z) / 2;
    app.doc.putSectionPlane({ id: 'spT', name: 'Coupe 1', origin: { x: 0, y: 0, z: zc }, normal: { x: 0, y: 0, z: -1 } });
    expect(app.doc.activeSectionPlane?.name).toBe('Coupe 1');
    const before = new Set(app.doc.all().map((e) => e.handle));
    await cmd('COUPE2D', '500,500');
    const added = app.doc.all().filter((e) => !before.has(e.handle));
    const polys = added.filter((e): e is Extract<Entity, { type: 'POLYLINE' }> => e.type === 'POLYLINE');
    expect(added.some((e) => e.type === 'HATCH')).toBe(true);
    expect(polys.length).toBeGreaterThanOrEqual(3); // contour + 2 trous taraudés
    const xs = polys.flatMap((p) => p.points.map((q) => q.x)), ys = polys.flatMap((p) => p.points.map((q) => q.y));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(b.max.x - b.min.x, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(b.max.y - b.min.y, 1);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(500, 3);
  }, 120_000);
});
