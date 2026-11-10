/** Onglets de dessins (2.0) : documents indépendants, annulation séparée, fermeture. */
import { describe, expect, it } from 'vitest';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import type { KernelClient } from '../src/kernel/KernelClient';

const released: string[][] = [];
const kernel = {
  status: 'idle',
  busy: 0,
  generation: 0,
  onStatus: () => () => undefined,
  onProgress: () => () => undefined,
  start: async () => undefined,
  call: async (r: { op: string; shapeIds?: string[] }) => {
    if (r.op === 'release') released.push(r.shapeIds ?? []);
    return undefined;
  },
} as unknown as KernelClient;

const line = (x: number) => ({ type: 'LINE' as const, layer: '0', start: { x, y: 0, z: 0 }, end: { x: x + 10, y: 0, z: 0 } });

describe('onglets de dessins', () => {
  it('chaque onglet a son document, sa sélection et son annulation', () => {
    const app = new AppHost(registerAll, kernel);
    const first = app.tab;
    expect(app.docs).toHaveLength(1);
    expect(app.isBlank()).toBe(true);
    app.doc.transaction('a', () => app.addEntity(line(0)));
    const h = app.doc.all()[0]!.handle;
    app.selection.set([h]);

    const second = app.newTab();
    expect(app.docs).toHaveLength(2);
    expect(app.tab).toBe(second);
    expect(second.doc.fileName).toBe('Dessin2.xcad');
    expect(app.doc.size).toBe(0);
    expect(app.selection.size).toBe(0);
    app.doc.transaction('b', () => {
      app.addEntity(line(5));
      app.addEntity(line(9));
    });
    expect(app.doc.size).toBe(2);

    app.activate(first);
    expect(app.doc.size).toBe(1);
    expect(app.selection.list()).toEqual([h]);
    app.doc.undo();
    expect(app.doc.size).toBe(0);
    expect(second.doc.size).toBe(2);
    expect(second.doc.dirty).toBe(true);
  });

  it('fermer l’onglet actif active le voisin ; le dernier est remplacé par un dessin vide', () => {
    const app = new AppHost(registerAll, kernel);
    const a = app.tab;
    const b = app.newTab();
    const c = app.newTab();
    app.activate(b);
    app.removeTab(b);
    expect(app.docs).toEqual([a, c]);
    expect(app.tab).toBe(c);
    app.removeTab(c);
    app.removeTab(a);
    expect(app.docs).toHaveLength(1);
    expect(app.isBlank()).toBe(true);
  });

  it('les formes d’un dessin fermé sont libérées, sauf celles d’un autre onglet', () => {
    const app = new AppHost(registerAll, kernel);
    (kernel as unknown as { status: string }).status = 'ready';
    const display = { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edgePoints: new Float32Array(), edgeOffsets: [0], volume: 0, solidCount: 1 };
    app.addEntity({ type: '3DSOLID', layer: '0', name: 'x', shapeId: 's1', display } as never);
    app.addEntity({ type: '3DSOLID', layer: '0', name: 'y', shapeId: 's2', display } as never);
    const t1 = app.tab;
    app.newTab();
    app.addEntity({ type: '3DSOLID', layer: '0', name: 'z', shapeId: 's2', display } as never);
    released.length = 0;
    app.removeTab(t1);
    expect(released).toEqual([['s1']]);
    (kernel as unknown as { status: string }).status = 'idle';
  });

  it('noms libres et réordonnancement', () => {
    const app = new AppHost(registerAll, kernel);
    const a = app.tab;
    const b = app.newTab();
    const c = app.newTab();
    expect(c.doc.fileName).toBe('Dessin3.xcad');
    app.moveTab(c, 0);
    expect(app.docs).toEqual([c, a, b]);
    app.removeTab(a);
    expect(app.newTab().doc.fileName).toBe('Dessin1.xcad');
  });
});
