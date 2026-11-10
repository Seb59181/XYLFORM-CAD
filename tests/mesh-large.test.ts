/**
 * Corps maillé lourd (3MF/STL importé) : la surbrillance de sélection ne doit pas déborder la pile
 * (« Maximum call stack size exceeded » en v1.9.3 : `push(...arêtes)` sur ~100 000 arêtes vives).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { meshDisplay, transformMeshBody } from '../src/kernel/MeshBodies';
import { solidEdges } from '../src/render/solidEdges';
import { translation } from '../src/core/math/affine';

/** Sphère bosselée : presque chaque arête est une arête vive. */
function bumpySphere(nu: number, nv: number, R = 20) {
  const pos: number[] = [], idx: number[] = [];
  const rnd = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
  pos.push(0, 0, R);
  for (let j = 1; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu, r = R * (1 + 0.03 * rnd(j * nu + i));
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  pos.push(0, 0, -R);
  const S = pos.length / 3 - 1, v = (j: number, i: number) => 1 + (j - 1) * nu + (i % nu);
  for (let i = 0; i < nu; i++) idx.push(0, v(1, i), v(1, i + 1));
  for (let j = 1; j < nv - 1; j++) for (let i = 0; i < nu; i++) idx.push(v(j, i), v(j + 1, i), v(j + 1, i + 1), v(j, i), v(j + 1, i + 1), v(j, i + 1));
  for (let i = 0; i < nu; i++) idx.push(S, v(nv - 1, i + 1), v(nv - 1, i));
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) };
}

describe('Corps maillé lourd', () => {
  const body = { mesh: bumpySphere(300, 150), closed: true };
  const d = meshDisplay(body);

  it('beaucoup d’arêtes vives', () => {
    expect(d.meshTriangles).toBe(89400);
    expect(d.edgeCount).toBeGreaterThan(50000);
  });

  it('segments de surbrillance sans débordement de pile', () => {
    const acc: number[] = [1, 2, 3];
    expect(() => solidEdges(d, undefined, acc)).not.toThrow();
    expect(acc.length).toBe(3 + d.edgeCount * 6);
    expect(solidEdges(d, new Set([0, 1])).length).toBe(12);
  });

  it('aucun push(...) sur les arêtes dans le rendu', () => {
    const src = readFileSync(new URL('../src/render/SceneSync.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/push\(\.\.\.solidEdges/);
  });

  it('déplacement : boîte décalée, mêmes arêtes', () => {
    const moved = meshDisplay(transformMeshBody(body, translation({ x: 50, y: 0, z: 0 })));
    expect(moved.bbox.min.x).toBeCloseTo(d.bbox.min.x + 50, 6);
    expect(moved.edgeCount).toBe(d.edgeCount);
    expect(moved.volume).toBeCloseTo(d.volume, 3);
  });
});
