/**
 * Impression 3D (v1.10) : jeu des filets perpendiculaire aux flancs, compensation des trous,
 * aperçu cosmétique des filetages réels, interruption d'un calcul (relance du noyau).
 * Sans noyau OpenCascade (rapide).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { maxThreadGap, threadEngagement, threadProfile } from '../src/core/geometry/threads';
import { holeProfile, holeTitle, standardHole } from '../src/core/geometry/holes';
import { compensateHoles, hasRealThread as partHasRealThread, PARTS, previewValues, defaultValues } from '../src/app/parts';
import { hasRealThread, setFeatureParam, featureParams } from '../src/app/history';
import { featureId, DrawingDocument, type Entity, type Feature } from '../src/core/document/Document';
import { KernelClient } from '../src/kernel/KernelClient';
import { CommandCancelled } from '../src/core/commands/types';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import type { DisplayMesh, KernelRequest } from '../src/kernel/protocol';

const SIZES: [number, number][] = [
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [16, 2],
  [20, 2.5],
];

describe('profil de filet avec jeu', () => {
  it('sans jeu : profil d’origine (vis nominale inchangée)', () => {
    const t = threadProfile(8, 1.25, 0);
    const r1 = 4 - (5 / 8) * 0.866 * 1.25;
    expect(t.rBase).toBeCloseTo(r1 - 0.05 * 1.25, 9);
    expect(t.core).toBeCloseTo(r1 + 0.01 * 1.25, 9);
    expect(t.rCrest).toBe(4);
    expect(t.base).toBeCloseTo(0.4375 * 1.25, 9);
    expect(t.tip).toBeCloseTo(1.25 / 16, 9);
  });

  it('le jeu est bien perpendiculaire aux flancs (distance entre flancs = jeu)', () => {
    for (const [d, p] of SIZES) {
      const g = Math.min(0.15, maxThreadGap(p));
      const a = threadProfile(d, p, 0), b = threadProfile(d, p, g);
      // flanc nominal : droite par (rBase, -base) et (rCrest, -tip) ; distance du sommet décalé
      const ux = a.rCrest - a.rBase, uz = a.base - a.tip, n = Math.hypot(ux, uz);
      const dist = (r: number, z: number) => Math.abs((r - a.rBase) * uz - (z + a.base) * ux) / n;
      expect(dist(b.rCrest, -b.tip)).toBeCloseTo(g, 6);
      expect(b.rCrest - a.rCrest).toBeCloseTo(g, 9);
    }
  });

  it('toujours constructible : spires disjointes, filet du taraudage présent, jeu plafonné', () => {
    for (const [d, p] of SIZES)
      for (const g of [0, 0.05, 0.1, 0.2, 0.3, 0.5]) {
        const t = threadProfile(d, p, g);
        expect(t.gap).toBeLessThanOrEqual(maxThreadGap(p) + 1e-12);
        expect(t.capped).toBe(g > maxThreadGap(p) + 1e-9);
        expect(2 * t.base).toBeLessThan(p); // deux spires voisines ne se touchent pas
        expect(t.tip).toBeGreaterThan(0);
        expect(t.core).toBeLessThan(t.rCrest - 0.05 * p); // il reste une dent
        expect(threadEngagement(d, p, g)).toBeGreaterThan(0); // la vis accroche encore
      }
  });

  it('l’ancien jeu sur le Ø ne laissait que ¼ du jeu sur les flancs', () => {
    // agrandir le Ø de J décale le profil de J/2 radialement ; flanc à 30° : J/2 × sin 30° = J/4
    const J = 0.4;
    expect((J / 2) * Math.sin(Math.PI / 6)).toBeCloseTo(J / 4, 9);
  });
});

describe('trous imprimés', () => {
  it('compensation : passage, lamé, fraisé agrandis ; taraudé et insert inchangés', () => {
    const s = standardHole('counterbore', 'M6', 0, false, 0, 0.3);
    expect(s.diameter).toBe(6.6); // la cote normalisée reste lisible
    const prof = holeProfile(s, 50);
    expect(prof[1]).toEqual([5.65, -0.5]); // lamage (11 + 0,3) / 2
    expect(prof[3]![0]).toBeCloseTo(3.45, 9); // perçage (6,6 + 0,3) / 2
    expect(holeTitle(s)).toContain('(+0,3 impr.)');
    expect(standardHole('tapped', 'M6', 0, false, 0, 0.3).comp).toBeUndefined();
    expect(holeProfile(standardHole('insert', 'M3'), 10)[1]![0]).toBe(2);
  });

  it('historique : compensation modifiable, ancien jeu converti en jeu par côté', () => {
    const f: Feature = { kind: 'hole', spec: standardHole('simple', 'M8'), at: [], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Trou' };
    expect(featureParams(f).map((p) => p.key)).toContain('comp');
    const g = setFeatureParam(f, 'comp', 0.25) as Extract<Feature, { kind: 'hole' }>;
    expect(g.spec.comp).toBe(0.25);
    // dessin 1.9.5 : jeu de 0,4 sur le Ø, avant-trou 8,5 + 0,4
    const old: Feature = { kind: 'hole', spec: { ...standardHole('tapped', 'M10', 0, true), gap: undefined, clearance: 0.4, diameter: 8.9 }, at: [], normal: { x: 0, y: 0, z: 1 }, id: featureId(), name: 'Taraudé' };
    delete (old.spec as { gap?: number }).gap;
    expect(featureParams(old).map((p) => p.key)).toEqual(expect.arrayContaining(['clearance', 'gap']));
    const nw = setFeatureParam(old, 'gap', 0.2) as Extract<Feature, { kind: 'hole' }>;
    expect(nw.spec.gap).toBe(0.2);
    expect(nw.spec.clearance).toBeUndefined();
    expect(nw.spec.diameter).toBeCloseTo(8.9, 9); // 8,5 + 2 × 0,2
  });

  it('pièces : seuls les Ø de trous de passage sont compensés', () => {
    const plaque = PARTS.find((p) => p.id === 'plaque')!;
    const v = compensateHoles(plaque, defaultValues(plaque), 0.2);
    expect(v.dt).toBeCloseTo(6.7, 9);
    expect(v.L).toBe(100);
    const vis = PARTS.find((p) => p.id === 'vis-h')!;
    expect(compensateHoles(vis, defaultValues(vis), 0.2)).toEqual(defaultValues(vis));
  });
});

describe('filetage réel : aperçu cosmétique', () => {
  it('détection dans l’historique (outils des booléens compris)', () => {
    const vis = PARTS.find((p) => p.id === 'vis-h')!;
    const v = { ...defaultValues(vis), thread: 'reel' };
    expect(partHasRealThread(vis, v)).toBe(true);
    expect(previewValues(vis, v).thread).toBe('cosmetique');
    const calib = PARTS.find((p) => p.id === 'calib-filetage')!;
    expect(partHasRealThread(calib, defaultValues(calib))).toBe(true);
    const part: Feature = { kind: 'part', part: 'vis-h', values: v, index: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], realThread: true, id: featureId(), name: 'Vis' };
    const box: Feature = { kind: 'create', op: { op: 'box', corner: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }, id: featureId(), name: 'Boîte' };
    expect(hasRealThread([box])).toBe(false);
    expect(hasRealThread([box, { kind: 'boolean', bool: 'subtract', tools: [[part]], id: featureId(), name: 'Soustraction' }])).toBe(true);
    expect(hasRealThread([box, { kind: 'boolean', bool: 'subtract', tools: [[part]], id: featureId(), name: 'Soustraction', off: true }])).toBe(false);
  });

  it('« filet exact » oublié dès que la forme change (sauf si l’opération le précise)', () => {
    const doc = new DrawingDocument();
    const h = doc.addEntity({ type: '3DSOLID', name: 'Vis', shapeId: 's1', display: {} as DisplayMesh, threadsReal: true });
    doc.replaceEntity(h, { name: 'Vis 2' });
    expect((doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).threadsReal).toBe(true);
    doc.replaceEntity(h, { shapeId: 's2', threadsReal: true });
    expect((doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).threadsReal).toBe(true);
    doc.replaceEntity(h, { shapeId: 's3' });
    expect((doc.get(h) as Extract<Entity, { type: '3DSOLID' }>).threadsReal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Interruption d'un calcul
// ---------------------------------------------------------------------------

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  posted: { id: number; req: KernelRequest }[] = [];
  private fns: ((ev: MessageEvent) => void)[] = [];
  constructor() {
    FakeWorker.all.push(this);
    setTimeout(() => this.emit({ type: 'ready' }), 0);
  }
  addEventListener(t: string, fn: (ev: MessageEvent) => void) {
    if (t === 'message') this.fns.push(fn);
  }
  postMessage(m: { id: number; req: KernelRequest }) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    if (!this.terminated) for (const f of this.fns) f({ data } as MessageEvent);
  }
}

describe('interruption d’un calcul 3D', () => {
  const g = globalThis as unknown as { Worker?: unknown };
  const saved = g.Worker;
  afterEach(() => {
    g.Worker = saved;
    FakeWorker.all = [];
  });

  it('KernelClient.restart : worker arrêté, requêtes rejetées (Annuler), nouveau worker', async () => {
    g.Worker = FakeWorker;
    const k = new KernelClient();
    await k.ready;
    const long = k.call({ op: 'release', shapeIds: [] });
    const bg = k.call({ op: 'release', shapeIds: [] }, { background: true });
    expect(k.busy).toBe(1); // la tâche de fond n'est pas comptée
    const restarted = k.restart();
    await expect(long).rejects.toBeInstanceOf(CommandCancelled);
    await expect(bg).rejects.toBeInstanceOf(CommandCancelled);
    expect(k.busy).toBe(0);
    expect(k.generation).toBe(1);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    await restarted;
    expect(FakeWorker.all.length).toBe(2);
    expect(k.status).toBe('ready');
    // le nouveau worker répond normalement
    const p = k.call<string>({ op: 'release', shapeIds: [] });
    await Promise.resolve();
    const w = FakeWorker.all[1]!;
    await new Promise((r) => setTimeout(r, 0));
    w.emit({ id: w.posted[0]!.id, ok: true, result: 'ok' });
    await expect(p).resolves.toBe('ok');
  });

  it('AppHost.interruptKernel : solides rechargés depuis la copie B-rep, annulation vidée', async () => {
    let busy = 1;
    let next = 100;
    const calls: KernelRequest[] = [];
    const kernel = {
      status: 'ready',
      get busy() {
        return busy;
      },
      generation: 0,
      ready: Promise.resolve(),
      start: () => Promise.resolve(),
      onStatus: () => undefined,
      onProgress: () => undefined,
      restart: async () => {
        busy = 0;
        kernel.generation++;
      },
      call: async (r: KernelRequest) => {
        calls.push(r);
        return { shapeId: `n${next++}`, display: {}, warnings: [] };
      },
      solid: async (r: KernelRequest) => kernel.call(r),
    };
    const app = new AppHost(registerAll, kernel as unknown as KernelClient);
    const h = app.doc.transaction('x', () => app.doc.addEntity({ type: '3DSOLID', name: 'Plaque', shapeId: 'old1', display: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), solidCount: 1 } as unknown as DisplayMesh }));
    expect(app.doc.canUndo).toBe(true);
    app.brepCache.set('old1', new Uint8Array([1, 2, 3]));
    expect(await app.interruptKernel(true)).toBe(true);
    const e = app.doc.get(h as unknown as string) as Extract<Entity, { type: '3DSOLID' }>;
    expect(e.shapeId).toBe('n100');
    expect(calls[0]!.op).toBe('loadBrep');
    expect(app.doc.canUndo).toBe(false);
    expect(app.brepCache.get('n100')).toEqual(new Uint8Array([1, 2, 3]));
    // plus rien ne calcule : Échap ne relance pas le noyau
    expect(await app.interruptKernel(true)).toBe(false);
  });
});
