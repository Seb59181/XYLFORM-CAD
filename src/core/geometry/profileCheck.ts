/**
 * Contrôle d'un contour fermé avant d'en faire une face (extrusion, révolution, région…).
 *
 * - Non plan : un contour cliqué en vue 3D peut avoir un point légèrement hors du plan
 *   (accrochage sur un objet à une autre hauteur, arrondi). Un petit écart est corrigé en
 *   projetant tous les points sur le plan moyen ; un grand écart est refusé avec un message
 *   qui désigne le point fautif.
 * - Auto-sécant : la courbe se croise elle-même ; on donne l'endroit du croisement.
 */
import type { Vec3 } from '../commands/types';

/** Écart toléré, en fraction de la taille du contour, corrigé automatiquement. */
export const FLATTEN_TOLERANCE = 0.01;

export interface ProfileCheck {
  /** Points à utiliser (projetés sur le plan moyen si nécessaire). */
  points: Vec3[];
  /** Écart maximal au plan moyen avant correction. */
  deviation: number;
  /** Avertissement à afficher (contour aplani). */
  warning?: string;
  /** Message d'erreur (contour inutilisable). */
  error?: string;
}

const f = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString().replace('.', ',');
};
const fp = (p: Vec3) => `(${f(p.x)} ; ${f(p.y)} ; ${f(p.z)})`;

/** Normale moyenne (méthode de Newell) et barycentre d'un contour fermé. */
export function bestFitPlane(points: Vec3[]): { origin: Vec3; normal: Vec3 } | null {
  const n = points.length;
  if (n < 3) return null;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
    cx += a.x; cy += a.y; cz += a.z;
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-300) return null;
  return { origin: { x: cx / n, y: cy / n, z: cz / n }, normal: { x: nx / l, y: ny / l, z: nz / l } };
}

/**
 * Contrôle un contour fermé de segments droits (`checkCrossing` faux pour les polylignes à
 * arcs, dont les cordes ne représentent pas la vraie courbe).
 */
export function checkClosedProfile(points: Vec3[], checkCrossing = true): ProfileCheck {
  const plane = bestFitPlane(points);
  if (!plane) {
    // aire nulle : souvent une boucle en « 8 » dont les deux lobes s'annulent
    const nv = anyNormal(points);
    const x = nv && checkCrossing ? selfCrossing(points, nv) : null;
    return { points, deviation: 0, error: x ? crossingMessage(x) : 'Profil dégénéré (aire nulle) : impossible d’en faire une face.' };
  }
  const { origin: o, normal: nv } = plane;
  let size = 0;
  for (const p of points) size = Math.max(size, Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z));
  let dev = 0, worst = 0;
  const d = points.map((p, i) => {
    const s = (p.x - o.x) * nv.x + (p.y - o.y) * nv.y + (p.z - o.z) * nv.z;
    if (Math.abs(s) > dev) { dev = Math.abs(s); worst = i; }
    return s;
  });
  const res: ProfileCheck = { points, deviation: dev };
  if (dev > FLATTEN_TOLERANCE * 2 * size) {
    res.error =
      `Profil non plan : le point ${fp(points[worst]!)} sort de ${f(dev)} du plan des autres points. ` +
      'Ramenez-le dans le plan (poignée ou Propriétés), ou lancez APLANIR sur la courbe, puis recommencez.';
    return res;
  }
  if (dev > 0) {
    res.points = points.map((p, i) => ({ x: p.x - d[i]! * nv.x, y: p.y - d[i]! * nv.y, z: p.z - d[i]! * nv.z }));
    // un écart visible (au-delà des arrondis de calcul) est signalé
    if (dev > 1e-6 * Math.max(size, 1)) res.warning = `Profil légèrement non plan (écart ${f(dev)}) : aplani automatiquement.`;
  }
  if (checkCrossing) {
    const x = selfCrossing(res.points, nv);
    if (x) {
      res.error = crossingMessage(x);
    }
  }
  return res;
}

/** Premier croisement entre deux segments non voisins d'un contour fermé plan, ou null. */
export function selfCrossing(points: Vec3[], normal: Vec3): Vec3 | null {
  const n = points.length;
  if (n < 4) return null;
  // repère 2D du plan
  const ref = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let ux = ref.y * normal.z - ref.z * normal.y, uy = ref.z * normal.x - ref.x * normal.z, uz = ref.x * normal.y - ref.y * normal.x;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = normal.y * uz - normal.z * uy, vy = normal.z * ux - normal.x * uz, vz = normal.x * uy - normal.y * ux;
  const P = points.map((p) => [p.x * ux + p.y * uy + p.z * uz, p.x * vx + p.y * vy + p.z * vz] as const);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of P) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const eps = 1e-9 * Math.max(maxX - minX, maxY - minY, 1e-300);
  // boîtes englobantes des segments, triées en x (balayage)
  const segs = Array.from({ length: n }, (_, i) => {
    const a = P[i]!, b = P[(i + 1) % n]!;
    return { i, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  }).sort((s, t) => s.x0 - t.x0);
  for (let k = 0; k < n; k++) {
    const s = segs[k]!;
    for (let m = k + 1; m < n && segs[m]!.x0 <= s.x1 + eps; m++) {
      const t = segs[m]!;
      if (t.y0 > s.y1 + eps || t.y1 < s.y0 - eps) continue;
      const i = s.i, j = t.i;
      if (Math.abs(i - j) === 1 || Math.abs(i - j) === n - 1) continue; // voisins : se touchent au sommet
      const a = P[i]!, b = P[(i + 1) % n]!, c = P[j]!, e = P[(j + 1) % n]!;
      const r = [b[0] - a[0], b[1] - a[1]], q = [e[0] - c[0], e[1] - c[1]];
      const den = r[0]! * q[1]! - r[1]! * q[0]!;
      if (Math.abs(den) < 1e-300) continue;
      const w = [c[0] - a[0], c[1] - a[1]];
      const tt = (w[0]! * q[1]! - w[1]! * q[0]!) / den;
      const uu = (w[0]! * r[1]! - w[1]! * r[0]!) / den;
      if (tt >= 0 && tt <= 1 && uu >= 0 && uu <= 1) {
        const pa = points[i]!, pb = points[(i + 1) % n]!;
        return { x: pa.x + (pb.x - pa.x) * tt, y: pa.y + (pb.y - pa.y) * tt, z: pa.z + (pb.z - pa.z) * tt };
      }
    }
  }
  return null;
}

const crossingMessage = (x: Vec3) =>
  `Profil auto-sécant : la courbe se croise elle-même près du point ${fp(x)}. ` +
  'Déplacez un point de la courbe pour supprimer la boucle, puis recommencez.';

/** Normale du plan de trois points non alignés du contour, ou null. */
function anyNormal(points: Vec3[]): Vec3 | null {
  const a = points[0]!;
  let best: Vec3 | null = null, bl = 0;
  for (let i = 1; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const b = points[i]!, c = points[j]!;
      const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
      const l = Math.hypot(n.x, n.y, n.z);
      if (l > bl) { bl = l; best = { x: n.x / l, y: n.y / l, z: n.z / l }; }
    }
    if (i > 64) break;
  }
  return best;
}
