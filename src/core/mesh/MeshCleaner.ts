/**
 * Nettoyage de maillage après booléen ou tessellation :
 *   1. soudure des sommets à tolérance (table de hachage spatiale, voisinage 3×3×3) ;
 *   2. suppression des triangles dégénérés (indices répétés, aire quasi nulle) ;
 *   3. suppression des doublons ; une paire de triangles identiques mais opposés est une
 *      double paroi interne (faces coplanaires coïncidentes) → les deux sont retirées ;
 *   4. compactage des sommets inutilisés.
 *
 * La tolérance par défaut est relative à la diagonale de la boîte englobante (1e-7),
 * ce qui reste bien en dessous de la résolution des imprimantes (≈ 1 µm sur 10 m).
 */
import { boundingBox, type IndexedMesh } from './IndexedMesh';

export interface CleanOptions {
  /** Distance de soudure absolue. Par défaut : 1e-7 × diagonale de la boîte. */
  weldTolerance?: number;
  /** Aire minimale relative (aire / diagonale²) en deçà de laquelle un triangle est dégénéré. */
  minRelativeArea?: number;
  removeInternalDoubleWalls?: boolean;
}

export interface CleanReport {
  weldedVertices: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  internalWallTriangles: number;
  removedVertices: number;
}

export function cleanMesh(mesh: IndexedMesh, opts: CleanOptions = {}): { mesh: IndexedMesh; report: CleanReport } {
  const { min, max } = boundingBox(mesh);
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const tol = opts.weldTolerance ?? diag * 1e-7;
  const minArea2 = (opts.minRelativeArea ?? 1e-14) * diag * diag;
  const removeWalls = opts.removeInternalDoubleWalls ?? true;

  // 1. Soudure ---------------------------------------------------------------
  const p = mesh.positions;
  const nv = p.length / 3;
  const remap = new Uint32Array(nv);
  const out: number[] = [];
  const grid = new Map<string, number[]>();
  const inv = 1 / tol;
  const tol2 = tol * tol;

  for (let i = 0; i < nv; i++) {
    const x = p[3 * i]!, y = p[3 * i + 1]!, z = p[3 * i + 2]!;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cell) continue;
          for (const j of cell) {
            const ex = out[3 * j]! - x, ey = out[3 * j + 1]! - y, ez = out[3 * j + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              found = j;
              break search;
            }
          }
        }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const cell = grid.get(key);
      if (cell) cell.push(found);
      else grid.set(key, [found]);
    }
    remap[i] = found;
  }
  const welded = new Float64Array(out);

  // 2. & 3. Triangles dégénérés et doublons --------------------------------------
  const ix = mesh.indices;
  const kept: number[] = [];
  const seen = new Map<string, { slot: number; parity: string }>();
  let degenerate = 0, duplicates = 0, walls = 0;

  for (let t = 0; t < ix.length / 3; t++) {
    const a = remap[ix[3 * t]!]!, b = remap[ix[3 * t + 1]!]!, c = remap[ix[3 * t + 2]!]!;
    if (a === b || b === c || a === c || triArea2(welded, a, b, c) <= minArea2) {
      degenerate++;
      continue;
    }
    const sorted = [a, b, c].sort((u, v) => u - v);
    const key = sorted.join(',');
    const parity = canonicalCycle(a, b, c);
    const prev = seen.get(key);
    if (prev) {
      if (prev.parity === parity) {
        duplicates++;
        continue;
      }
      if (removeWalls && prev.slot >= 0) {
        // double paroi : on annule aussi le triangle déjà conservé
        kept[prev.slot] = kept[prev.slot + 1] = kept[prev.slot + 2] = -1;
        prev.slot = -1;
        walls += 2;
        continue;
      }
    }
    seen.set(key, { slot: kept.length, parity });
    kept.push(a, b, c);
  }

  // 4. Compactage ------------------------------------------------------------
  const used = new Int32Array(welded.length / 3).fill(-1);
  const finalPos: number[] = [];
  const finalIdx: number[] = [];
  for (let i = 0; i < kept.length; i += 3) {
    if (kept[i]! < 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = kept[i + k]!;
      if (used[v] === -1) {
        used[v] = finalPos.length / 3;
        finalPos.push(welded[3 * v]!, welded[3 * v + 1]!, welded[3 * v + 2]!);
      }
      finalIdx.push(used[v]!);
    }
  }

  const result: IndexedMesh = { positions: new Float64Array(finalPos), indices: new Uint32Array(finalIdx) };
  return {
    mesh: result,
    report: {
      weldedVertices: nv - welded.length / 3,
      degenerateTriangles: degenerate,
      duplicateTriangles: duplicates,
      internalWallTriangles: walls,
      removedVertices: welded.length / 3 - finalPos.length / 3,
    },
  };
}

/** Carré de deux fois l'aire. */
function triArea2(p: Float64Array, a: number, b: number, c: number): number {
  const ux = p[3 * b]! - p[3 * a]!, uy = p[3 * b + 1]! - p[3 * a + 1]!, uz = p[3 * b + 2]! - p[3 * a + 2]!;
  const vx = p[3 * c]! - p[3 * a]!, vy = p[3 * c + 1]! - p[3 * a + 1]!, vz = p[3 * c + 2]! - p[3 * a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

/** Représentation canonique du cycle (rotation commençant au plus petit indice). */
function canonicalCycle(a: number, b: number, c: number): string {
  if (a < b && a < c) return `${a},${b},${c}`;
  if (b < a && b < c) return `${b},${c},${a}`;
  return `${c},${a},${b}`;
}
