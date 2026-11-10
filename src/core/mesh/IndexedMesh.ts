/**
 * Maillage triangulaire indexé : format pivot entre le noyau B-rep (tessellation OCC),
 * le moteur de CSG maillé (manifold-3d), le rendu (BufferGeometry) et les exporteurs.
 * Coordonnées en double précision tant qu'on n'a pas écrit le fichier.
 */
export interface IndexedMesh {
  /** x0,y0,z0, x1,y1,z1, … */
  positions: Float64Array;
  /** Triangles a,b,c dans le sens trigonométrique vu de l'extérieur (normale sortante). */
  indices: Uint32Array;
}

export function vertexCount(m: IndexedMesh): number {
  return m.positions.length / 3;
}

export function triangleCount(m: IndexedMesh): number {
  return m.indices.length / 3;
}

/** Volume signé (théorème de divergence). Positif si les normales sont sortantes. */
export function signedVolume(m: IndexedMesh, triangles?: Iterable<number>): number {
  const p = m.positions;
  const ix = m.indices;
  let v = 0;
  const tris = triangles ?? range(triangleCount(m));
  for (const t of tris) {
    const a = 3 * ix[3 * t]!, b = 3 * ix[3 * t + 1]!, c = 3 * ix[3 * t + 2]!;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
}

export function boundingBox(m: IndexedMesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

export function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

/** Boîte fermée de test (12 triangles, normales sortantes). */
export function makeBox(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): IndexedMesh {
  const positions = new Float64Array([
    0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz,
  ]);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i]! += ox;
    positions[i + 1]! += oy;
    positions[i + 2]! += oz;
  }
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bas  (-Z)
    4, 5, 6, 4, 6, 7, // haut (+Z)
    0, 1, 5, 0, 5, 4, // avant (-Y)
    2, 3, 7, 2, 7, 6, // arrière (+Y)
    1, 2, 6, 1, 6, 5, // droite (+X)
    3, 0, 4, 3, 4, 7, // gauche (-X)
  ]);
  return { positions, indices };
}

/** Concatène plusieurs maillages (sans soudure). */
export function mergeMeshes(meshes: readonly IndexedMesh[]): IndexedMesh {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0);
  const ni = meshes.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float64Array(nv);
  const indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const base = pv / 3;
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i]! + base;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  return { positions, indices };
}
