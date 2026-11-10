/**
 * Bibliothèque de pièces : chaque pièce se construit en solide étanche avec ses cotes par défaut.
 * Lent (noyau OpenCascade) : `npm run test:occ`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { run } from '../src/kernel/dispatch';
import { checkManifold } from '../src/core/mesh/ManifoldCheck';
import { PARTS, defaultValues, stagedKernel } from '../src/app/parts';
import { isRigid } from '../src/kernel/OccKernel';
import type { KernelRequest, SolidResult } from '../src/kernel/protocol';

let oc: OccKernel;
const k = async (r: KernelRequest) => run(oc, r) as SolidResult;

describe.skipIf(!process.env.OCC)('Bibliothèque de pièces', () => {
  beforeAll(async () => {
    oc = new OccKernel(await initOpenCascade());
  }, 120_000);

  for (const def of PARTS)
    it(`${def.name} (cotes par défaut)`, async () => {
      const parts = await def.build(k, defaultValues(def));
      for (const p of parts) {
        expect(p.result.display.solidCount).toBe(1);
        expect(p.result.display.volume).toBeGreaterThan(0);
        const [mesh] = oc.exportMesh([p.result.shapeId], 0.05, 15);
        const rep = checkManifold(mesh!);
        expect(rep.boundaryEdges + rep.nonManifoldEdges).toBe(0);
      }
    }, 60_000);

  it('filetage réel : vis, tige, écrou (plusieurs tailles)', async () => {
    const vis = PARTS.find((p) => p.id === 'vis-h')!;
    for (const size of ['M4', 'M6', 'M10']) {
      const v = { ...vis.applySize!(size, defaultValues(vis)), L: 16, thread: 'reel' };
      const r = (await vis.build(k, v))[0]!.result;
      const simple = (await vis.build(k, { ...v, thread: 'simple' }))[0]!.result;
      // le filet enlève de la matière par rapport au cylindre plein, mais pas trop
      expect(r.display.volume).toBeLessThan(simple.display.volume);
      expect(r.display.volume).toBeGreaterThan(simple.display.volume * 0.8);
      expect(r.display.solidCount).toBe(1);
    }
    const tige = PARTS.find((p) => p.id === 'tige')!;
    const t = (await tige.build(k, { ...tige.applySize!('M8', defaultValues(tige)), L: 30, thread: 'reel' }))[0]!.result;
    // la boîte englobante OCC des surfaces balayées est large : on mesure le maillage
    const [mesh] = oc.exportMesh([t.shapeId], 0.05, 15);
    const zs = mesh!.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(30, 2);
    expect(Math.min(...zs)).toBeCloseTo(0, 2);
    const rep = checkManifold(mesh!);
    expect(rep.boundaryEdges + rep.nonManifoldEdges).toBe(0);
    const nut = PARTS.find((p) => p.id === 'ecrou')!;
    const n = (await nut.build(k, { ...nut.applySize!('M6', defaultValues(nut)), thread: 'reel' }))[0]!.result;
    const plain = (await nut.build(k, { ...nut.applySize!('M6', defaultValues(nut)), thread: 'simple' }))[0]!.result;
    expect(n.display.solidCount).toBe(1);
    expect(n.display.volume).toBeGreaterThan(plain.display.volume);
  }, 300_000);

  it('chanfrein au bout des vis et des tiges (1.0.0) : Aucun, Cosmétique et Réel', async () => {
    const vis = PARTS.find((p) => p.id === 'vis-h')!;
    const tige = PARTS.find((p) => p.id === 'tige')!;
    /** Rayon maximal du maillage dans une tranche [z1, z2]. */
    const rmax = (shapeId: string, z1: number, z2: number) => {
      const [mesh] = oc.exportMesh([shapeId], 0.01, 10);
      const pos = mesh!.positions;
      let r = 0;
      for (let i = 0; i < pos.length; i += 3) if (pos[i + 2]! >= z1 && pos[i + 2]! <= z2) r = Math.max(r, Math.hypot(pos[i]!, pos[i + 1]!));
      expect(checkManifold(mesh!).boundaryEdges).toBe(0);
      return r;
    };
    for (const thread of ['simple', 'cosmetique', 'reel']) {
      const v = { ...vis.applySize!('M8', defaultValues(vis)), L: 16, thread };
      const r = (await vis.build(k, v))[0]!.result;
      expect(r.display.solidCount).toBe(1);
      // au bout (z = -L) : rayon réduit au fond de filet ; plus haut : rayon nominal
      expect(rmax(r.shapeId, -16.001, -15.99)).toBeLessThan(4 - 0.5);
      // juste au-dessus du chanfrein (≈ 0,68 mm en M8) : rayon nominal
      expect(rmax(r.shapeId, -15.4, -14.5)).toBeGreaterThan(3.95);
      // l'empreinte à soustraire garde un bout droit
      const e = (await vis.build(k, { ...v, usage: 'empreinte' }))[0]!.result;
      expect(rmax(e.shapeId, -16.6, -14.5)).toBeGreaterThan(3.95);
      const t = (await tige.build(k, { ...tige.applySize!('M8', defaultValues(tige)), L: 20, thread }))[0]!.result;
      expect(t.display.solidCount).toBe(1);
      expect(rmax(t.shapeId, -0.001, 0.01)).toBeLessThan(3.5);
      expect(rmax(t.shapeId, 19.99, 20.001)).toBeLessThan(3.5);
    }
  }, 300_000);

  it('vis à filetage réel soustraite d’une plaque : rapide (sans tolérance floue)', async () => {
    const def = PARTS.find((p) => p.id === 'vis-h')!;
    const vis = (await def.build(k, { ...def.applySize!('M6', defaultValues(def)), L: 20, thread: 'reel' }))[0]!.result;
    const plate = await k({ op: 'box', corner: { x: -15, y: -15, z: -12 }, size: { x: 30, y: 30, z: 8 } });
    const t = Date.now();
    const r = await k({ op: 'boolean', kind: 'subtract', targets: [plate.shapeId], tools: [vis.shapeId] });
    expect(Date.now() - t).toBeLessThan(30_000); // > 25 min avec la tolérance floue
    expect(r.display.solidCount).toBe(1);
    expect(r.display.volume).toBeLessThan(7200 - 6 * 6 * 2); // 30×30×8 moins au moins le noyau
    expect(r.display.volume).toBeGreaterThan(7200 - Math.PI * 9 * 8 - 1);
  }, 120_000);

  it('empreinte de vis à filetage réel : grossie du jeu, la vis imprimée passe sans toucher', async () => {
    const def = PARTS.find((p) => p.id === 'vis-h')!;
    const base = { ...def.applySize!('M6', defaultValues(def)), L: 12, thread: 'reel' };
    expect(def.title(base)).toBe('Vis H M6×12');
    const piece = (await def.build(k, base))[0]!.result;
    const emp = (await def.build(k, { ...base, usage: 'empreinte', jeu: 0.2 }))[0]!.result;
    expect(def.title({ ...base, usage: 'empreinte', jeu: 0.2 })).toBe('Empreinte vis H M6×12 (jeu 0.2)');
    expect(emp.display.solidCount).toBe(1);
    expect(emp.display.volume).toBeGreaterThan(piece.display.volume * 1.05);
    const plate = await k({ op: 'box', corner: { x: -12, y: -12, z: -8 }, size: { x: 24, y: 24, z: 6 } });
    const t = Date.now();
    const holed = await k({ op: 'boolean', kind: 'subtract', targets: [plate.shapeId], tools: [emp.shapeId] });
    expect(Date.now() - t).toBeLessThan(30_000);
    // la vis aux cotes nominales ne recoupe pas le trou taraudé avec jeu
    expect(await overlap(holed, piece)).toBeLessThan(1e-3);
  }, 300_000);

  it('jeu par côté (1.10) : taraudage M8 à 0,2 mm, la vis passe et le filet du trou existe', async () => {
    const vis = PARTS.find((p) => p.id === 'vis-h')!;
    const base = { ...vis.applySize!('M8', defaultValues(vis)), L: 10, thread: 'reel' };
    const piece = (await vis.build(k, base))[0]!.result;
    const emp = (await vis.build(k, { ...base, usage: 'empreinte', jeu: 0.2 }))[0]!.result;
    const plate = await k({ op: 'box', corner: { x: -12, y: -12, z: -7 }, size: { x: 24, y: 24, z: 5 } });
    const holed = await k({ op: 'boolean', kind: 'subtract', targets: [plate.shapeId], tools: [emp.shapeId] });
    expect(holed.display.solidCount).toBe(1);
    expect(await overlap(holed, piece)).toBeLessThan(1e-3);
    // il reste un filet femelle : plus de matière qu'un trou lisse au Ø 8,4
    const smooth = await k({ op: 'boolean', kind: 'subtract', targets: [plate.shapeId], tools: [(await k({ op: 'cylinder', center: { x: 0, y: 0, z: -8 }, radius: 4.2, height: 10 })).shapeId] });
    expect(holed.display.volume).toBeGreaterThan(smooth.display.volume + 20);
  }, 300_000);

  it('plaquette de calibration : aperçu cosmétique rapide, 3 trous réels étanches', async () => {
    const def = PARTS.find((p) => p.id === 'calib-filetage')!;
    const v = { ...def.applySize!('M6', defaultValues(def)), n: 3 };
    const t = Date.now();
    const prev = (await def.build(k, { ...v, thread: 'cosmetique' }))[0]!.result;
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(prev.display.solidCount).toBe(1);
    const real = (await def.build(k, v))[0]!.result;
    expect(real.display.solidCount).toBe(1);
    const [mesh] = oc.exportMesh([real.shapeId], 0.05, 15);
    const rep = checkManifold(mesh!);
    expect(rep.boundaryEdges + rep.nonManifoldEdges).toBe(0);
    expect(def.note!(v)).toContain('0,1 ; 0,15 ; 0,2');
  }, 300_000);

  it('tige filetée réelle longue (M8×100, plus de 80 spires) : hélice en tronçons', async () => {
    const tige = PARTS.find((p) => p.id === 'tige')!;
    const t = (await tige.build(k, { ...tige.applySize!('M8', defaultValues(tige)), L: 100, thread: 'reel' }))[0]!.result;
    expect(t.display.solidCount).toBe(1);
    const [mesh] = oc.exportMesh([t.shapeId], 0.05, 15);
    const zs = mesh!.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(100, 2);
    const rep = checkManifold(mesh!);
    expect(rep.boundaryEdges + rep.nonManifoldEdges).toBe(0);
  }, 300_000);
  const build = async (id: string, over: Record<string, number | string> = {}) => {
    const def = PARTS.find((p) => p.id === id)!;
    return def.build(k, { ...defaultValues(def), ...over });
  };
  /** Volume commun de deux solides (0 s'ils ne se touchent pas). */
  const overlap = async (a: SolidResult, b: SolidResult) => {
    try {
      return (await k({ op: 'boolean', kind: 'intersect', targets: [a.shapeId, b.shapeId], tools: [] })).display.volume;
    } catch {
      return 0;
    }
  };
  it('boulon complet : filetage aucun / cosmétique / réel sur vis et écrou', async () => {
    const def = PARTS.find((p) => p.id === 'boulon')!;
    const base = { ...def.applySize!('M6', defaultValues(def)), L: 30, serrage: 15 };
    const vol: Record<string, number[]> = {};
    for (const thread of ['simple', 'cosmetique', 'reel']) {
      const t0 = Date.now();
      const parts = await def.build(k, { ...base, thread });
      expect(parts).toHaveLength(3);
      vol[thread] = parts.map((p) => p.result.display.volume);
      for (const p of parts) {
        expect(p.result.display.solidCount).toBe(1);
        const [mesh] = oc.exportMesh([p.result.shapeId], 0.05, 15);
        const rep = checkManifold(mesh!);
        expect(rep.boundaryEdges + rep.nonManifoldEdges, `${thread} ${p.name}`).toBe(0);
      }
      console.log(`boulon ${thread} : ${Date.now() - t0} ms`);
    }
    // vis : le filet retire de la matière ; écrou : le taraudage en rajoute dans le trou
    expect(vol.cosmetique![0]).toBeLessThan(vol.simple![0]!);
    expect(vol.reel![0]).toBeLessThan(vol.simple![0]!);
    expect(vol.cosmetique![2]).toBeGreaterThan(vol.simple![2]!);
    expect(vol.reel![2]).toBeGreaterThan(vol.simple![2]!);
    // vis et écrou s'emboîtent sans se chevaucher
    // (l'intersection de deux filets hélicoïdaux est trop coûteuse : contrôle sur le cosmétique)
    const cos = await def.build(k, { ...base, thread: 'cosmetique' });
    expect(await overlap(cos[0]!.result, cos[2]!.result)).toBeLessThan(0.05);
  }, 300_000);



  it('charnières : pièces séparées sans interpénétration, ouvertures', async () => {
    // à goupille : 3 solides (2 lames + axe), aucun ne recoupe un autre
    const lames = await build('charniere-lames');
    expect(lames).toHaveLength(3);
    const [A, B, axe] = lames.map((p) => p.result) as [SolidResult, SolidResult, SolidResult];
    expect(await overlap(A, B)).toBeLessThan(1e-6);
    expect(await overlap(A, axe)).toBeLessThan(1e-6);
    expect(await overlap(B, axe)).toBeLessThan(1e-6);
    // refermée et à 90° : toujours sans collision
    for (const a of [0, 90]) {
      const [a1, b1] = (await build('charniere-lames', { a })).map((p) => p.result) as [SolidResult, SolidResult];
      expect(await overlap(a1, b1)).toBeLessThan(1e-6);
    }
    // imprimable assemblée : 2 solides imbriqués mais disjoints (jeu d'impression)
    const pip = await build('charniere-pip');
    expect(pip).toHaveLength(2);
    expect(await overlap(pip[0]!.result, pip[1]!.result)).toBeLessThan(1e-6);
    // l'axe intégré traverse bien les charnons de la lame B : sa boîte couvre toute la longueur
    expect(pip[0]!.result.display.bbox.max.x - pip[0]!.result.display.bbox.min.x).toBeGreaterThan(49.9);
    // piano : nombre de charnons déduit de la longueur
    const piano = await build('charniere-piano', { L: 100, pas: 10 });
    expect(piano).toHaveLength(3);
    expect(await overlap(piano[0]!.result, piano[1]!.result)).toBeLessThan(1e-6);
    // paumelle : mâle + femelle, axe dans le nœud femelle sans contact, à 180° et 90°
    for (const a of [180, 90]) {
      const [m, f] = (await build('paumelle', { a })).map((p) => p.result) as [SolidResult, SolidResult];
      expect(await overlap(m, f)).toBeLessThan(1e-6);
    }
    // film : la bande mince réduit le volume par rapport à une plaque pleine
    const film = (await build('charniere-film'))[0]!.result;
    expect(film.display.volume).toBeLessThan(60 * 20 * 3);
    expect(film.display.bbox.max.z).toBeCloseTo(3, 3);
    // fentes : de la matière enlevée, un seul solide
    const kerf = (await build('charniere-fentes'))[0]!.result;
    expect(kerf.display.volume).toBeLessThan(100 * 40 * 3);
    expect(kerf.display.solidCount).toBe(1);
  }, 300_000);

  it('raccords PVC : toutes les tailles, tube emboîté sans collision, butée', async () => {
    const pipe = (D: number, e: number, z0: number, L: number) =>
      k({ op: 'cylinder', center: { x: 0, y: 0, z: z0 }, radius: D / 2, height: L }).then(async (o) =>
        k({ op: 'boolean', kind: 'subtract', targets: [o.shapeId], tools: [(await k({ op: 'cylinder', center: { x: 0, y: 0, z: z0 - 1 }, radius: D / 2 - e, height: L + 2 })).shapeId] }),
      );
    for (const id of ['pvc-coude-22', 'pvc-coude-45', 'pvc-coude-67', 'pvc-coude-90', 'pvc-te-90', 'pvc-te-45']) {
      const def = PARTS.find((p) => p.id === id)!;
      for (const size of def.sizes!) {
        const v = def.applySize!(size, defaultValues(def));
        const [r] = await def.build(k, v);
        const s = r!.result;
        expect(s.display.solidCount, `${id} ${size}`).toBe(1);
        const rep = checkManifold(oc.exportMesh([s.shapeId], 0.1, 15)[0]!);
        expect(rep.boundaryEdges + rep.nonManifoldEdges, `${id} ${size}`).toBe(0);
        // un tube enfoncé jusqu'à la butée (emboîture du bas) ne touche pas le raccord
        const D = Number(v.D), e = Number(v.e), Ls = Number(v.Ls);
        expect(await overlap(s, await pipe(D, e, -20, 20 + Ls - 0.01))).toBeLessThan(1e-6);
        // … mais il bute : un tube plus long recoupe la butée
        expect(await overlap(s, await pipe(D, e, -20, 20 + Ls + 1))).toBeGreaterThan(0);
      }
    }
    // coude 90° Ø100 : emboîture B horizontale, embouchure à x = −(R + Ls)
    const c90 = PARTS.find((p) => p.id === 'pvc-coude-90')!;
    const e90 = (await c90.build(k, defaultValues(c90)))[0]!.result;
    expect(e90.display.bbox.min.x).toBeCloseTo(-(100 + 52), 0);
    // mâle / femelle : le bout mâle a le Ø du tube, moins de matière
    const mf = (await c90.build(k, { ...defaultValues(c90), bout: 'MF' }))[0]!.result;
    expect(mf.display.volume).toBeLessThan(e90.display.volume);
    // té réduit 100 × 40
    const te = PARTS.find((p) => p.id === 'pvc-te-90')!;
    const red = (await te.build(k, { ...defaultValues(te), d: 40 }))[0]!.result;
    expect(red.display.solidCount).toBe(1);
    expect(red.display.bbox.max.x).toBeGreaterThan(53 + 26);
    await expect(te.build(k, { ...defaultValues(te), d: 125 })).rejects.toThrow(/piquage/);
    await expect(c90.build(k, { ...defaultValues(c90), R: 40 })).rejects.toThrow(/cintrage/);
  }, 600_000);

  it('cotes incohérentes : message clair', async () => {
    await expect(build('charniere-lames', { dp: 7.8 })).rejects.toThrow(/axe/);
    await expect(build('charniere-film', { t: 4 })).rejects.toThrow(/film/);
  });

  it('optimisations : étapes sans maillage, déplacement rigide, libération', async () => {
    const before = oc.shapeCount;
    const st = stagedKernel(k);
    const [part] = await PARTS.find((p) => p.id === 'plaque')!.build(st.kernel, defaultValues(PARTS.find((p) => p.id === 'plaque')!));
    // étape intermédiaire : pas de triangles, mais volume et boîte disponibles
    expect(part!.result.display.indices.length).toBe(0);
    expect(part!.result.display.volume).toBeGreaterThan(0);
    const m = [0, -1, 0, 10, 1, 0, 0, 5, 0, 0, 1, 2] as const;
    expect(isRigid([...m] as never)).toBe(true);
    expect(isRigid([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0])).toBe(false);
    expect(isRigid([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBe(false);
    const placed = await k({ op: 'transform', shapeId: part!.result.shapeId, matrix: [...m] as never });
    expect(placed.display.indices.length).toBeGreaterThan(0);
    expect(placed.display.volume).toBeCloseTo(part!.result.display.volume, 3);
    // rotation de 90° autour de Z + translation : boîte déplacée
    expect(placed.display.bbox.min.z).toBeCloseTo(2, 3);
    const rep = checkManifold(oc.exportMesh([placed.shapeId], 0.05, 15)[0]!);
    expect(rep.boundaryEdges + rep.nonManifoldEdges).toBe(0);
    await k({ op: 'release', shapeIds: st.created } as KernelRequest);
    expect(oc.shapeCount).toBe(before + 1);
    // un solide déplacé reste utilisable dans un booléen
    const hole = await k({ op: 'cylinder', center: { x: 10, y: 5, z: 0 }, radius: 3, height: 20 });
    const cut = await k({ op: 'boolean', kind: 'subtract', targets: [placed.shapeId], tools: [hole.shapeId] });
    expect(cut.display.volume).toBeLessThan(placed.display.volume);
  }, 120_000);
});
