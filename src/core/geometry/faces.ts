/**
 * Analyse d'une face B-rep à partir du maillage d'affichage (sans appel au noyau) :
 * normale extérieure, planéité, centre et contour. Sert à Appuyer/tirer, à l'esquisse sur
 * face et à l'analyse de coupe.
 */
import type { Vec3 } from '../commands/types';
import type { DisplayMesh } from '../../kernel/protocol';

export interface FaceInfo {
  /** Normale extérieure moyenne (unitaire). */
  normal: Vec3;
  /** Tous les triangles sont dans le même plan (tolérance relative à la taille de la face). */
  planar: boolean;
  /** Centre de gravité de la surface. */
  centroid: Vec3;
  area: number;
  /** Contour(s) de la face : arêtes de triangles non partagées, chaînées en polylignes. */
  boundary: Vec3[][];
}

export function faceInfo(d: DisplayMesh, face: number): FaceInfo | null {
  const P = d.positions, I = d.indices;
  const v = (i: number): Vec3 => ({ x: P[3 * i]!, y: P[3 * i + 1]!, z: P[3 * i + 2]! });
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, area = 0;
  const tris: number[] = [];
  for (let t = 0; t < d.faceIds.length; t++) {
    if (d.faceIds[t] !== face) continue;
    tris.push(t);
    const a = v(I[3 * t]!), b = v(I[3 * t + 1]!), c = v(I[3 * t + 2]!);
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    const tx = uy * wz - uz * wy, ty = uz * wx - ux * wz, tz = ux * wy - uy * wx;
    const ar = Math.hypot(tx, ty, tz) / 2;
    nx += tx;
    ny += ty;
    nz += tz;
    area += ar;
    cx += ((a.x + b.x + c.x) / 3) * ar;
    cy += ((a.y + b.y + c.y) / 3) * ar;
    cz += ((a.z + b.z + c.z) / 3) * ar;
  }
  if (!tris.length || area <= 0) return null;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < area * 1e-6) {
    // face fermée sur elle-même (cylindre complet) : normale du premier triangle, non plane
    const t = tris[0]!;
    const a = v(I[3 * t]!), b = v(I[3 * t + 1]!), c = v(I[3 * t + 2]!);
    nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    nl = Math.hypot(nx, ny, nz) || 1;
  }
  const normal = { x: nx / nl, y: ny / nl, z: nz / nl };
  const centroid = { x: cx / area, y: cy / area, z: cz / area };

  // planéité : écart des sommets au plan moyen et somme des normales ≈ aire (pas de courbure)
  let extent = 0, dev = 0;
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const p = v(I[3 * t + k]!);
      const dx = p.x - centroid.x, dy = p.y - centroid.y, dz = p.z - centroid.z;
      extent = Math.max(extent, Math.hypot(dx, dy, dz));
      dev = Math.max(dev, Math.abs(dx * normal.x + dy * normal.y + dz * normal.z));
    }
  const planar = dev <= Math.max(1e-6, extent * 1e-4) && Math.hypot(nx, ny, nz) / 2 >= area * (1 - 1e-6);

  // contour : arêtes de triangles utilisées une seule fois (sommets fusionnés par position)
  const key = (i: number) => `${P[3 * i]!.toFixed(6)},${P[3 * i + 1]!.toFixed(6)},${P[3 * i + 2]!.toFixed(6)}`;
  const id = new Map<string, number>();
  const pts: Vec3[] = [];
  const vid = (i: number) => {
    const k = key(i);
    let n = id.get(k);
    if (n === undefined) id.set(k, (n = pts.length)), pts.push(v(i));
    return n;
  };
  const count = new Map<string, [number, number, number]>();
  for (const t of tris) {
    const ids = [vid(I[3 * t]!), vid(I[3 * t + 1]!), vid(I[3 * t + 2]!)];
    for (let k = 0; k < 3; k++) {
      const a = ids[k]!, b = ids[(k + 1) % 3]!;
      const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
      const e = count.get(ek);
      if (e) e[2]++;
      else count.set(ek, [a, b, 1]);
    }
  }
  const next = new Map<number, number[]>();
  for (const [a, b, n] of count.values()) {
    if (n !== 1) continue;
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const boundary: Vec3[][] = [];
  const used = new Set<string>();
  for (const [start, outs] of next)
    for (const first of outs) {
      if (used.has(`${start}-${first}`)) continue;
      const loop = [pts[start]!];
      let a = start, b = first;
      for (let guard = 0; guard < 100000; guard++) {
        used.add(`${a}-${b}`);
        loop.push(pts[b]!);
        if (b === start) break;
        const nb = (next.get(b) ?? []).find((c) => !used.has(`${b}-${c}`));
        if (nb === undefined) break;
        a = b;
        b = nb;
      }
      if (loop.length > 2) boundary.push(loop);
    }
  return { normal, planar, centroid, area, boundary };
}
