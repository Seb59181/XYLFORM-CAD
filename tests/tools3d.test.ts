/**
 * Outils 3D côté interface : distance le long d'un axe quelconque (APPUYERTIRER,
 * ANALYSECOUPE) et analyse des faces du maillage d'affichage.
 */
import { describe, expect, it } from 'vitest';
import { CommandProcessor, CommandRegistry, ask, promptAxis, type CommandDefinition } from '../src/core/commands';
import { faceInfo } from '../src/core/geometry/faces';
import type { DisplayMesh } from '../src/kernel/protocol';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('prompts axiaux', () => {
  it('promptAxis : verticale par défaut, axe normalisé', () => {
    expect(promptAxis({ kind: 'distance', message: '', vertical: true })).toEqual({ x: 0, y: 0, z: 1 });
    const a = promptAxis({ kind: 'distance', message: '', axis: { x: 3, y: 0, z: 4 } })!;
    expect(a.x).toBeCloseTo(0.6);
    expect(a.z).toBeCloseTo(0.8);
    expect(promptAxis({ kind: 'distance', message: '' })).toBeUndefined();
  });

  it('un clic donne la distance signée projetée sur l’axe', async () => {
    const got: number[] = [];
    const def: CommandDefinition = {
      name: 'T',
      localName: 'T',
      async run(ctx) {
        const r = await ask(ctx, { kind: 'distance', message: 'd', basePoint: { x: 1, y: 1, z: 1 }, axis: { x: 0, y: -2, z: 0 }, allowNegative: true });
        if (r.kind === 'number') got.push(r.value);
      },
    };
    const reg = new CommandRegistry();
    reg.register(def);
    const cp = new CommandProcessor(reg, {}, {});
    cp.execute('T');
    await tick();
    cp.pick({ x: 5, y: 4, z: 9 }); // 3 unités vers +Y = -3 le long de -Y
    await tick();
    expect(got).toEqual([-3]);
  });
});

describe('faceInfo', () => {
  // carré unité dans le plan z = 2 (normale +Z) + un triangle incliné (face 1)
  const d = {
    positions: new Float32Array([0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5]),
    faceIds: new Uint32Array([0, 0, 1]),
  } as unknown as DisplayMesh;

  it('normale, aire, centre et contour d’une face plane', () => {
    const f = faceInfo(d, 0)!;
    expect(f.planar).toBe(true);
    expect(f.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(f.area).toBeCloseTo(1);
    expect(f.centroid.x).toBeCloseTo(0.5);
    expect(f.centroid.z).toBeCloseTo(2);
    expect(f.boundary).toHaveLength(1);
    expect(f.boundary[0]).toHaveLength(5); // 4 sommets + retour au départ
  });

  it('face absente', () => {
    expect(faceInfo(d, 7)).toBeNull();
  });
});
