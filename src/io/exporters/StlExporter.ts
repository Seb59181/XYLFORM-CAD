/**
 * Export STL binaire (little-endian) :
 *
 *   UINT8[80]    en-tête (ne doit PAS commencer par "solid", sinon certains lecteurs
 *                le prennent pour de l'ASCII)
 *   UINT32       nombre de triangles
 *   pour chaque triangle (50 octets) :
 *     REAL32[3]  normale unitaire
 *     REAL32[3]  sommet 1, sommet 2, sommet 3 (sens trigonométrique vu de l'extérieur)
 *     UINT16     attribut (0)
 *
 * Le STL n'a pas d'unité : par convention universelle des trancheurs, on écrit des mm.
 */
import type { IndexedMesh } from '../../core/mesh/IndexedMesh';
import { mergeMeshes } from '../../core/mesh/IndexedMesh';
import { prepareForPrint, type PreparedMesh, type PrintExportOptions } from './PrintPreparation';

export interface StlExportResult {
  data: Uint8Array;
  prepared: PreparedMesh;
}

const HEADER = 'Xylform CAD binary STL - units: millimeter';

export function exportStlBinary(meshes: IndexedMesh | readonly IndexedMesh[], opts: PrintExportOptions = {}): StlExportResult {
  const merged = Array.isArray(meshes) ? mergeMeshes(meshes) : (meshes as IndexedMesh);
  const prepared = prepareForPrint(merged, opts);
  return { data: writeStlBinary(prepared.mesh), prepared };
}

/** Écriture brute, sans vérification (utilisée aussi par l'export de maillages déjà validés). */
export function writeStlBinary(mesh: IndexedMesh): Uint8Array {
  const p = mesh.positions;
  const ix = mesh.indices;
  const n = ix.length / 3;
  const buffer = new ArrayBuffer(84 + 50 * n);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(HEADER).subarray(0, 80));
  view.setUint32(80, n, true);

  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = 3 * ix[3 * t]!, b = 3 * ix[3 * t + 1]!, c = 3 * ix[3 * t + 2]!;
    // normale calculée en double précision depuis la géométrie (jamais confiance aux normales lissées)
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, p[v]!, true);
      view.setFloat32(o + 4, p[v + 1]!, true);
      view.setFloat32(o + 8, p[v + 2]!, true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}
