import type { Entity } from '../core/document/Document';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

/** Segments des arêtes d'un solide, ajoutés à `out` (jamais par `push(...)` : un corps maillé
 * importé peut en compter des centaines de milliers → « Maximum call stack size exceeded »). */
export function solidEdges(d: Solid3D['display'], only?: Set<number>, out: number[] = []): number[] {
  const p = d.edgePoints;
  for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
    if (only && !only.has(i)) continue;
    for (let k = d.edgeOffsets[i]!; k + 1 < d.edgeOffsets[i + 1]!; k++) out.push(p[3 * k]!, p[3 * k + 1]!, p[3 * k + 2]!, p[3 * k + 3]!, p[3 * k + 4]!, p[3 * k + 5]!);
  }
  return out;
}
