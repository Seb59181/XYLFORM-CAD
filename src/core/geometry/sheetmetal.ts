/**
 * Tôlerie : tôle de base tirée d'un contour fermé,
 * bords pliés sur ses arêtes (angle, longueur, sens, rayon intérieur), mise à plat avec la
 * longueur développée (facteur K). Géométrie pure, partagée par le noyau (construction du
 * solide) et l'interface (aperçu, mise à plat, cotes).
 *
 * Conventions : le contour est dans un plan horizontal (z constant), la tôle va de z0 à
 * z0 + épaisseur. Longueur d'un bord = longueur extérieure jusqu'à l'arête vive fictive
 * (comme les cotes extérieures d'un plan). Position « intérieure » : le contour dessiné est
 * l'encombrement extérieur (le pli est pris dans la tôle de base) ; « extérieure » : le pli
 * s'ajoute au contour.
 */
import type { Vec3 } from '../commands/types';

export interface SheetFlange {
  /** Index de l'arête du contour (du sommet i au sommet i + 1). */
  edge: number;
  /** Angle de pliage en degrés (1 à 150). */
  angle: number;
  /** Longueur extérieure du bord (arête vive fictive → extrémité). */
  length: number;
  /** Plié vers le haut (+Z) ou vers le bas. */
  up: boolean;
}

export interface SheetMetalDef {
  /** Contour fermé de la tôle de base (z constant). */
  points: Vec3[];
  thickness: number;
  /** Rayon intérieur de pliage. */
  radius: number;
  /** Facteur K (position de la fibre neutre, 0 à 1 ; 0,44 pour l'acier plié en V). */
  k: number;
  /** Pli pris dans le contour (contour = encombrement extérieur). */
  inside: boolean;
  flanges: SheetFlange[];
}

export const SHEET_DEFAULTS = { thickness: 2, radius: 2, k: 0.44, angle: 90, length: 20 };

type P = { x: number; y: number };

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const addS = (a: P, b: P, s: number): P => ({ x: a.x + b.x * s, y: a.y + b.y * s });
const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;

export function signedArea(pts: P[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i]!, pts[(i + 1) % pts.length]!);
  return s / 2;
}

/** Contour nettoyé (sans doublons ni fermeture répétée). */
export function cleanContour(pts: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1]!.x, p.y - out[out.length - 1]!.y) > 1e-9) out.push(p);
  if (out.length > 2 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 1e-9) out.pop();
  return out;
}

/** Recul extérieur : distance de l'arête vive fictive au début du pli. */
export function setback(def: Pick<SheetMetalDef, 'thickness' | 'radius'>, angleDeg: number): number {
  return (def.radius + def.thickness) * Math.tan((angleDeg * Math.PI) / 360);
}

/** Longueur développée du pli (sur la fibre neutre). */
export function bendAllowance(def: Pick<SheetMetalDef, 'thickness' | 'radius' | 'k'>, angleDeg: number): number {
  return ((angleDeg * Math.PI) / 180) * (def.radius + def.k * def.thickness);
}

export interface FlangeLayout {
  f: SheetFlange;
  /** Arête de départ du pli (après recul éventuel), de a vers b. */
  a: Vec3;
  b: Vec3;
  /** Direction de l'arête et normale extérieure (dans le plan). */
  u: P;
  n: P;
  /** Longueur droite après le pli. */
  straight: number;
  /** Longueur développée du pli. */
  ba: number;
}

export interface SheetLayout {
  /** Contour de la tôle de base (après recul des arêtes pliées en position intérieure), sens trigonométrique. */
  base: Vec3[];
  flanges: FlangeLayout[];
  z0: number;
}

/** Contour de base et position des bords. Lève une erreur si la définition est impossible. */
export function sheetLayout(def: SheetMetalDef): SheetLayout {
  let pts = cleanContour(def.points);
  if (pts.length < 3) throw new Error('Contour de tôle : au moins 3 sommets.');
  if (!(def.thickness > 0)) throw new Error('Épaisseur de tôle nulle.');
  if (!(def.radius >= 0)) throw new Error('Rayon de pliage négatif.');
  const z0 = pts[0]!.z;
  // sens trigonométrique : la normale extérieure est à droite de chaque arête
  const ccw = signedArea(pts) > 0;
  const nEdges = pts.length;
  const remap = (i: number) => (ccw ? i : nEdges - 2 - i < 0 ? nEdges - 1 : nEdges - 2 - i);
  if (!ccw) pts = [...pts].reverse();
  const byEdge = new Map<number, SheetFlange>();
  for (const f of def.flanges) {
    if (f.edge < 0 || f.edge >= nEdges) continue;
    if (!(f.angle > 0 && f.angle <= 150)) throw new Error(`Angle de pliage ${f.angle}° : choisissez entre 1 et 150°.`);
    byEdge.set(remap(f.edge), f);
  }
  const n = pts.length;
  const dirs = pts.map((p, i) => {
    const q = pts[(i + 1) % n]!;
    const d = sub(q, p);
    const L = Math.hypot(d.x, d.y);
    return { x: d.x / L, y: d.y / L };
  });
  const normals = dirs.map((u) => ({ x: u.y, y: -u.x }));
  // décalage vers l'intérieur des arêtes pliées (position intérieure)
  const shift = dirs.map((_, i) => {
    const f = byEdge.get(i);
    return f && def.inside ? setback(def, f.angle) : 0;
  });
  const base: Vec3[] = pts.map((p, i) => {
    const j = (i - 1 + n) % n; // arête précédente (j → i) et arête suivante (i → i+1)
    if (!shift[i] && !shift[j]) return p;
    const pa = addS(p, normals[j]!, -shift[j]!), pb = addS(p, normals[i]!, -shift[i]!);
    const den = cross(dirs[j]!, dirs[i]!);
    if (Math.abs(den) < 1e-9) return { ...addS(p, normals[i]!, -Math.max(shift[i]!, shift[j]!)), z: z0 };
    const t = cross(sub(pb, pa), dirs[i]!) / den;
    const q = addS(pa, dirs[j]!, t);
    return { x: q.x, y: q.y, z: z0 };
  });
  if (signedArea(base) <= 1e-9) throw new Error('Plis trop grands pour ce contour (tôle de base inversée).');
  const flanges: FlangeLayout[] = [];
  for (const [i, f] of byEdge) {
    const a = base[i]!, b = base[(i + 1) % n]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-6 || (b.x - a.x) * dirs[i]!.x + (b.y - a.y) * dirs[i]!.y <= 0) throw new Error(`Arête ${f.edge + 1} trop courte pour ses plis voisins.`);
    const straight = f.length - setback(def, f.angle);
    if (straight < -1e-9) throw new Error(`Bord de l’arête ${f.edge + 1} trop court : au moins ${fmt(setback(def, f.angle))} (rayon + épaisseur).`);
    flanges.push({ f, a, b, u: dirs[i]!, n: normals[i]!, straight: Math.max(0, straight), ba: bendAllowance(def, f.angle) });
  }
  return { base, flanges, z0 };
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString().replace('.', ',');

/** Profil du pli et du bord dans le repère local (x vers l'extérieur, y = épaisseur → pli). */
export function flangeProfile(def: SheetMetalDef, fl: FlangeLayout): { points: Vec3[]; bulges: number[] } {
  const t = def.thickness, r = def.radius;
  const th = (fl.f.angle * Math.PI) / 180;
  const c = { x: 0, y: t + r };
  const rad = { x: Math.sin(th), y: -Math.cos(th) }, d = { x: Math.cos(th), y: Math.sin(th) };
  const L = fl.straight;
  const p2 = addS(c, rad, r + t), p5 = addS(c, rad, r);
  const raw: [P, number][] = [
    [{ x: 0, y: 0 }, r + t > 0 ? Math.tan(th / 4) : 0],
    [p2, 0],
    [addS(p2, d, L), 0],
    [addS(p5, d, L), 0],
    [p5, r > 0 ? -Math.tan(th / 4) : 0],
    [{ x: 0, y: t }, 0],
  ];
  const points: Vec3[] = [], bulges: number[] = [];
  for (const [p, bl] of raw) {
    const last = points[points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-9) {
      bulges[bulges.length - 1] = bl || bulges[bulges.length - 1]!;
      continue;
    }
    points.push({ x: p.x, y: p.y, z: 0 }), bulges.push(bl);
  }
  return { points, bulges };
}

/** Matrice 3×4 (ligne par ligne) qui place le profil local d'un bord, et longueur d'extrusion. */
export function flangeFrame(def: SheetMetalDef, fl: FlangeLayout, z0: number): { matrix: [number, number, number, number, number, number, number, number, number, number, number, number]; length: number } {
  const X = { x: fl.n.x, y: fl.n.y, z: 0 };
  const Y = { x: 0, y: 0, z: fl.f.up ? 1 : -1 };
  const Z = { x: X.y * Y.z - X.z * Y.y, y: X.z * Y.x - X.x * Y.z, z: X.x * Y.y - X.y * Y.x };
  const fwd = Z.x * fl.u.x + Z.y * fl.u.y > 0;
  const o = fwd ? fl.a : fl.b;
  const oz = fl.f.up ? z0 : z0 + def.thickness;
  return {
    matrix: [X.x, Y.x, Z.x, o.x, X.y, Y.y, Z.y, o.y, X.z, Y.z, Z.z, oz],
    length: Math.hypot(fl.b.x - fl.a.x, fl.b.y - fl.a.y),
  };
}

export interface FlatPattern {
  /** Contour extérieur développé. */
  outline: Vec3[];
  /** Lignes de pliage (milieu de la zone de pli) avec leur légende. */
  bends: { a: Vec3; b: Vec3; label: string; f: FlangeLayout }[];
  /** Limites des zones de pli (début et fin). */
  zones: [Vec3, Vec3][];
  layout: SheetLayout;
}

/** Développé de la tôle, dans le plan de la tôle de base (z0). */
export function flatPattern(def: SheetMetalDef): FlatPattern {
  const layout = sheetLayout(def);
  const n = layout.base.length;
  const byIndex = new Map<number, FlangeLayout>();
  for (const fl of layout.flanges) byIndex.set(layout.base.indexOf(fl.a), fl);
  const outline: Vec3[] = [];
  const bends: FlatPattern['bends'] = [];
  const zones: [Vec3, Vec3][] = [];
  const z = layout.z0;
  for (let i = 0; i < n; i++) {
    const p = layout.base[i]!;
    outline.push(p);
    const fl = byIndex.get(i);
    if (!fl) continue;
    const D = fl.ba + fl.straight;
    const out = (q: Vec3, s: number): Vec3 => ({ x: q.x + fl.n.x * s, y: q.y + fl.n.y * s, z });
    outline.push(out(fl.a, D), out(fl.b, D));
    bends.push({ a: out(fl.a, fl.ba / 2), b: out(fl.b, fl.ba / 2), label: `${fl.f.up ? 'HAUT' : 'BAS'} ${fmt(fl.f.angle)}° Ri ${fmt(def.radius)}`, f: fl });
    zones.push([out(fl.a, 0), out(fl.b, 0)], [out(fl.a, fl.ba), out(fl.b, fl.ba)]);
  }
  return { outline: cleanContour(outline), bends, zones, layout };
}

/**
 * Position développée d'un point de la tôle pliée (pour reporter les perçages) : sur la tôle
 * de base il ne bouge pas, sur la partie droite d'un bord il est déplié autour du pli.
 * Renvoie null hors de la tôle (zone de pli, autre face…).
 */
export function unfoldPoint(def: SheetMetalDef, layout: SheetLayout, p: Vec3, tol = 1e-3): Vec3 | null {
  const t = def.thickness;
  const z = layout.z0;
  if (p.z >= z - tol && p.z <= z + t + tol && insidePoly(layout.base, p)) return { x: p.x, y: p.y, z };
  for (const fl of layout.flanges) {
    const th = (fl.f.angle * Math.PI) / 180;
    const along = (p.x - fl.a.x) * fl.u.x + (p.y - fl.a.y) * fl.u.y;
    const span = Math.hypot(fl.b.x - fl.a.x, fl.b.y - fl.a.y);
    if (along < -tol || along > span + tol) continue;
    // coordonnées locales (s vers l'extérieur, h vers le pli)
    const s = (p.x - fl.a.x) * fl.n.x + (p.y - fl.a.y) * fl.n.y;
    const h = fl.f.up ? p.z - z : z + t - p.z;
    const c = { x: 0, y: t + def.radius };
    const rad = { x: Math.sin(th), y: -Math.cos(th) }, d = { x: Math.cos(th), y: Math.sin(th) };
    const start = addS(c, rad, def.radius + t / 2); // fin du pli, fibre moyenne
    const rel = sub({ x: s, y: h }, start);
    const w = rel.x * d.x + rel.y * d.y; // le long du bord
    const across = rel.x * rad.x + rel.y * rad.y; // dans l'épaisseur
    if (w < -tol || w > fl.straight + tol || Math.abs(across) > t / 2 + tol) continue;
    return { x: fl.a.x + fl.u.x * along + fl.n.x * (fl.ba + w), y: fl.a.y + fl.u.y * along + fl.n.y * (fl.ba + w), z };
  }
  return null;
}

function insidePoly(poly: P[], p: P): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Volume théorique (contrôle) : tôle de base + plis + bords droits. */
export function sheetVolume(def: SheetMetalDef): number {
  const L = sheetLayout(def);
  let v = Math.abs(signedArea(L.base)) * def.thickness;
  for (const fl of L.flanges) {
    const span = Math.hypot(fl.b.x - fl.a.x, fl.b.y - fl.a.y);
    const th = (fl.f.angle * Math.PI) / 180;
    v += span * ((th / 2) * ((def.radius + def.thickness) ** 2 - def.radius ** 2) + fl.straight * def.thickness);
  }
  return v;
}
