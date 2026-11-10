/** Contrôle d'imprimabilité (1.11) et interface de la visserie : sans noyau. */
import { describe, expect, it } from 'vitest';
import { analyzePrintability } from '../src/core/mesh/Printability';
import { drawingUnit, overlapGroups, analyzeMeshes, describeChecks, analysisLayers } from '../src/app/printCheck';
import { PARTS } from '../src/app/parts';

/** Boîte fermée, normales sortantes. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(p), indices: new Uint32Array(f) };
}
function merge(...ms: { positions: Float64Array; indices: Uint32Array }[]) {
  const pos: number[] = [], ix: number[] = [];
  for (const m of ms) {
    const o = pos.length / 3;
    pos.push(...m.positions);
    ix.push(...Array.from(m.indices, (i) => i + o));
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(ix) };
}

describe('analyse d’imprimabilité', () => {
  it('cube posé : rien à signaler (le dessous est sur le plateau)', () => {
    const r = analyzePrintability(box(0, 0, 0, 20, 20, 10).positions, box(0, 0, 0, 20, 20, 10).indices);
    expect(r.overhang).toEqual([]);
    expect(r.thin).toEqual([]);
    expect(r.area).toBeCloseTo(2 * 400 + 4 * 200, 6);
  });

  it('plaque de 0,5 mm : paroi fine sur les grandes faces', () => {
    const m = box(0, 0, 0, 30, 30, 0.5);
    const r = analyzePrintability(m.positions, m.indices, { minWall: 0.8 });
    expect(r.thin.length).toBe(4); // dessus et dessous (2 triangles chacun)
    expect(r.minThickness).toBeCloseTo(0.5, 6);
    expect(analyzePrintability(m.positions, m.indices, { minWall: 0.4 }).thin).toEqual([]);
  });

  it('porte-à-faux : dessous d’un plateau en hauteur, pas le pied posé', () => {
    const m = merge(box(0, 0, 0, 4, 4, 10), box(-10, -10, 10, 14, 14, 13));
    const r = analyzePrintability(m.positions, m.indices);
    expect(r.overhang.length).toBe(2); // dessous du plateau supérieur
    expect(r.overhangArea).toBeCloseTo(24 * 24, 6);
    // incliné à 30° depuis l'horizontale = 60° depuis la verticale : signalé à 45°, pas à 70°
    const s = Math.sin(Math.PI / 6), c = Math.cos(Math.PI / 6);
    const tri = { positions: new Float64Array([0, 0, 5, 0, 10, 5, 10 * c, 0, 5 + 10 * s]), indices: new Uint32Array([0, 1, 2]) };
    // normale (vers le bas) d'un triangle seul : tester les deux seuils
    const r45 = analyzePrintability(new Float64Array([...tri.positions, 0, 0, 0]), new Uint32Array([0, 1, 2]), { overhangDeg: 45, minWall: 0 });
    const r70 = analyzePrintability(new Float64Array([...tri.positions, 0, 0, 0]), new Uint32Array([0, 1, 2]), { overhangDeg: 70, minWall: 0 });
    expect(r45.overhang.length).toBe(1);
    expect(r70.overhang.length).toBe(0);
  });

  it('compte rendu en mm et calques colorés, unités du dessin converties', () => {
    const m = box(0, 0, 0, 3, 3, 0.05); // dessin en cm : 30 × 30 × 0,5 mm
    const checks = analyzeMeshes([m], 'cm', 0.8, 45);
    const lines = describeChecks(['Plaque'], checks, 'cm', 0.8, 45);
    expect(lines[0]).toContain('0,5 mm au plus fin');
    expect(lines[0]).toContain('1800 mm²');
    const layers = analysisLayers(checks);
    expect(layers.length).toBe(1);
    expect(layers[0]!.positions.length).toBe(4 * 9);
  });

  it('chevauchements regroupés, unité du dessin', () => {
    expect(overlapGroups(5, [{ a: 0, b: 1, volume: 1 }, { a: 1, b: 3, volume: 1 }])).toEqual([[0, 1, 3]]);
    expect(overlapGroups(3, [])).toEqual([]);
    expect([4, 1, 2, 5, 6, 0].map(drawingUnit)).toEqual(['mm', 'in', 'ft', 'cm', 'm', 'mm']);
  });
});

describe('interface de la visserie', () => {
  const threaded = PARTS.filter((p) => p.params.some((q) => q.key === 'thread'));
  it('Filetage : Aucun ou Réel seulement, avec aide', () => {
    expect(threaded.map((p) => p.id).sort()).toEqual(['boulon', 'ecrou', 'tige', 'vis-chc', 'vis-h']);
    for (const p of threaded) {
      const t = p.params.find((q) => q.key === 'thread')!;
      expect(t.options!.map((o) => o.value)).toEqual(['simple', 'reel']);
      expect(t.help).toContain('Réel');
    }
  });
  it('Usage et Jeu : aide, jeu masqué pour la pièce à imprimer', () => {
    for (const p of PARTS.filter((q) => q.params.some((x) => x.key === 'usage'))) {
      const u = p.params.find((q) => q.key === 'usage')!;
      const j = p.params.find((q) => q.key === 'jeu')!;
      expect(u.help).toContain('Empreinte');
      expect(j.help).toContain('0,4 mm');
      expect(j.visible!({ usage: 'piece' })).toBe(false);
      expect(j.visible!({ usage: 'empreinte' })).toBe(true);
    }
    // tout champ de jeu a son point d'interrogation
    for (const p of PARTS) for (const q of p.params) if (/jeu/i.test(q.label)) expect(q.help, `${p.id}.${q.key}`).toBeTruthy();
  });
});
