/**
 * Contrôle d'imprimabilité d'un maillage (impression FDM, plateau = plan Z le plus bas) :
 *
 * - **Porte-à-faux** : faces tournées vers le bas, plus inclinées que `overhangDeg` par rapport à
 *   la verticale (0° = paroi verticale, 90° = plafond plat). Les faces posées sur le plateau
 *   (au Z minimal) ne comptent pas.
 * - **Parois fines** : depuis le centre de chaque triangle, un rayon part vers l'intérieur de la
 *   matière ; s'il ressort par une face à peu près opposée (paroi) à moins de `minWall`, le
 *   triangle est sur une paroi trop fine. Les arêtes vives (dents de filet, chanfreins) ne sont
 *   pas des parois : la face touchée doit faire face (normales opposées à ±45° près).
 *
 * Recherche accélérée par une grille de pas ≈ `minWall` : seuls les triangles proches du rayon
 * sont testés (quelques dizaines de millisecondes pour 100 000 triangles).
 */

export interface PrintabilityOptions {
  /** Inclinaison maximale sans support, depuis la verticale (degrés, défaut 45). */
  overhangDeg?: number;
  /** Épaisseur de paroi minimale (mêmes unités que le maillage, défaut 0,8). */
  minWall?: number;
  /** Hauteur du plateau (défaut : Z le plus bas du maillage). */
  bedZ?: number;
}

export interface PrintabilityReport {
  triangles: number;
  /** Indices des triangles en porte-à-faux / sur une paroi trop fine. */
  overhang: number[];
  thin: number[];
  /** Surfaces concernées et surface totale. */
  overhangArea: number;
  thinArea: number;
  area: number;
  /** Paroi la plus fine trouvée (Infinity si aucune sous `minWall`). */
  minThickness: number;
}

type Arr = ArrayLike<number>;

export function analyzePrintability(positions: Arr, indices: Arr, opts: PrintabilityOptions = {}): PrintabilityReport {
  const overhangDeg = opts.overhangDeg ?? 45;
  const minWall = opts.minWall ?? 0.8;
  const nt = Math.floor(indices.length / 3);
  const nx = new Float64Array(nt), ny = new Float64Array(nt), nz = new Float64Array(nt), ar = new Float64Array(nt);
  const cx = new Float64Array(nt), cy = new Float64Array(nt), cz = new Float64Array(nt);
  let zmin = Infinity, zmax = -Infinity;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  zmin = opts.bedZ ?? min[2]!;
  zmax = max[2]!;
  const diag = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) || 1;
  const bedTol = Math.max(1e-6, diag * 1e-6, minWall * 0.01);
  let area = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t]! * 3, b = indices[3 * t + 1]! * 3, c = indices[3 * t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    ar[t] = l / 2;
    area += l / 2;
    if (l > 0) {
      x /= l;
      y /= l;
      z /= l;
    }
    nx[t] = x;
    ny[t] = y;
    nz[t] = z;
    cx[t] = (positions[a]! + positions[b]! + positions[c]!) / 3;
    cy[t] = (positions[a + 1]! + positions[b + 1]! + positions[c + 1]!) / 3;
    cz[t] = (positions[a + 2]! + positions[b + 2]! + positions[c + 2]!) / 3;
  }

  // --- porte-à-faux ---------------------------------------------------------------------
  const lim = Math.sin((overhangDeg * Math.PI) / 180);
  const overhang: number[] = [];
  let overhangArea = 0;
  for (let t = 0; t < nt; t++) {
    if (!(-nz[t]! > lim + 1e-9) || ar[t] === 0) continue;
    const a = indices[3 * t]! * 3, b = indices[3 * t + 1]! * 3, c = indices[3 * t + 2]! * 3;
    const top = Math.max(positions[a + 2]!, positions[b + 2]!, positions[c + 2]!);
    if (top <= zmin + bedTol) continue; // posé sur le plateau
    overhang.push(t);
    overhangArea += ar[t]!;
  }

  // --- parois fines ---------------------------------------------------------------------
  const thin: number[] = [];
  let thinArea = 0;
  let minThickness = Infinity;
  if (minWall > 0 && nt > 0 && zmax >= zmin) {
    const grid = buildGrid(positions, indices, nt, min, max, minWall);
    const eps = Math.max(1e-9, minWall * 1e-4);
    const seen = new Int32Array(nt).fill(-1);
    for (let t = 0; t < nt; t++) {
      if (ar[t] === 0) continue;
      // rayon vers l'intérieur
      const dx = -nx[t]!, dy = -ny[t]!, dz = -nz[t]!;
      const ox = cx[t]!, oy = cy[t]!, oz = cz[t]!;
      const ex = ox + dx * minWall, ey = oy + dy * minWall, ez = oz + dz * minWall;
      let best = Infinity;
      grid.visit(Math.min(ox, ex), Math.min(oy, ey), Math.min(oz, ez), Math.max(ox, ex), Math.max(oy, ey), Math.max(oz, ez), (u) => {
        if (u === t || seen[u] === t) return;
        seen[u] = t;
        // une paroi : la face touchée regarde vers nous
        if (nx[t]! * nx[u]! + ny[t]! * ny[u]! + nz[t]! * nz[u]! > -0.7) return;
        const d = rayTriangle(positions, indices, u, ox, oy, oz, dx, dy, dz);
        if (d > eps && d < best) best = d;
      });
      if (best < minWall) {
        thin.push(t);
        thinArea += ar[t]!;
        if (best < minThickness) minThickness = best;
      }
    }
  }
  return { triangles: nt, overhang, thin, overhangArea, thinArea, area, minThickness };
}

/** Distance le long du rayon jusqu'au triangle `u` (Möller–Trumbore), Infinity sinon. */
function rayTriangle(p: Arr, ix: Arr, u: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const a = ix[3 * u]! * 3, b = ix[3 * u + 1]! * 3, c = ix[3 * u + 2]! * 3;
  const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
  const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  const tx = ox - p[a]!, ty = oy - p[a + 1]!, tz = oz - p[a + 2]!;
  const uu = (tx * px + ty * py + tz * pz) * inv;
  if (uu < -1e-9 || uu > 1 + 1e-9) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const vv = (dx * qx + dy * qy + dz * qz) * inv;
  if (vv < -1e-9 || uu + vv > 1 + 1e-9) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Grille uniforme (table de hachage des cellules) des triangles. */
function buildGrid(p: Arr, ix: Arr, nt: number, min: number[], max: number[], minWall: number) {
  const span = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!, 1e-9);
  // pas ≈ épaisseur minimale, mais au plus 256 cellules par côté
  let h = Math.max(minWall, span / 256);
  for (;;) {
    const cells = new Map<number, number[]>();
    const n = Math.ceil(span / h) + 2;
    const key = (i: number, j: number, k: number) => (i * n + j) * n + k;
    const cell = (v: number, a: number) => Math.max(0, Math.floor((v - min[a]!) / h));
    let entries = 0;
    let overflow = false;
    for (let t = 0; t < nt && !overflow; t++) {
      const a = ix[3 * t]! * 3, b = ix[3 * t + 1]! * 3, c = ix[3 * t + 2]! * 3;
      const lo = [0, 1, 2].map((d) => cell(Math.min(p[a + d]!, p[b + d]!, p[c + d]!), d));
      const hi = [0, 1, 2].map((d) => cell(Math.max(p[a + d]!, p[b + d]!, p[c + d]!), d));
      for (let i = lo[0]!; i <= hi[0]!; i++)
        for (let j = lo[1]!; j <= hi[1]!; j++)
          for (let k = lo[2]!; k <= hi[2]!; k++) {
            const kk = key(i, j, k);
            let l = cells.get(kk);
            if (!l) cells.set(kk, (l = []));
            l.push(t);
            if (++entries > 4_000_000) overflow = true;
          }
    }
    if (overflow) {
      h *= 2;
      continue;
    }
    return {
      visit(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, fn: (t: number) => void) {
        const i0 = cell(x0, 0), i1 = cell(x1, 0), j0 = cell(y0, 1), j1 = cell(y1, 1), k0 = cell(z0, 2), k1 = cell(z1, 2);
        for (let i = i0; i <= i1; i++)
          for (let j = j0; j <= j1; j++)
            for (let k = k0; k <= k1; k++) {
              const l = cells.get(key(i, j, k));
              if (l) for (const t of l) fn(t);
            }
      },
    };
  }
}
