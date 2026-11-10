/**
 * Bibliothèque de pièces prêtes à l'emploi : visserie ISO (vis H, vis CHC, écrou, rondelle, boulon,
 * tige filetée), tubes, coude, profilés, boîte, plaque percée, charnières (à lames, piano,
 * imprimable assemblée, paumelle, à film, à fentes), raccords d'évacuation PVC (coudes 22°30, 45°,
 * 67°30, 90°, tés 87°30/90° et 45°). Chaque pièce se règle par quelques
 * cotes (préremplies d'après la norme pour la visserie) et se construit avec le noyau 3D, axe Z
 * vers le haut, puis est orientée et posée au point d'insertion.
 */
import type { CommandContext, Vec3 } from '../core/commands';
import type { Affine, KernelRequest, ProfileDef, SolidResult } from '../kernel/protocol';
import type { AppHost } from './AppHost';
import { maxThreadGap, threadProfile } from '../core/geometry/threads';
import { featureId } from '../core/document/Document';

export type PartValues = Record<string, number | string>;

export interface PartParam {
  key: string;
  label: string;
  /** Valeur par défaut (nombre) ou liste de choix (texte). */
  value: number | string;
  options?: { value: string; label: string }[];
  min?: number;
  step?: number;
  unit?: string;
  /** Explication affichée par le point d'interrogation à côté du libellé. */
  help?: string;
  /** Champ affiché seulement si la condition est vraie (ex. jeu : seulement pour l'empreinte). */
  visible?: (v: PartValues) => boolean;
  /** Rappel toujours affiché sous le champ selon les valeurs (ex. usage de l'empreinte). */
  note?: (v: PartValues) => string | undefined;
  /**
   * Diamètre d'un trou de passage : agrandi de la compensation des trous imprimés (réglage
   * « Compensation des trous », OPTIONS) au moment de la construction.
   */
  hole?: boolean;
}

export interface PartDef {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  params: PartParam[];
  /** Taille normalisée (M3…M20) : remplit les autres cotes. */
  sizes?: string[];
  applySize?: (size: string, v: PartValues) => PartValues;
  /** Taille proposée par défaut (sinon celle qui correspond à `d`, ou M8). */
  defaultSize?: string;
  /** Nom de l'objet créé. */
  title: (v: PartValues) => string;
  /** Contour d'aperçu (repère local, axe Z). */
  preview: (v: PartValues) => Vec3[][];
  /** Construction (repère local) : un ou plusieurs solides (le boulon en donne trois). */
  build: (k: Kernel, v: PartValues) => Promise<{ result: SolidResult; name?: string }[]>;
  /**
   * La pièce porte un filetage réel (hélice) avec ces valeurs : construite en aperçu cosmétique
   * pendant le dessin, en filet exact à l'export (défaut : option Filetage = Réel).
   */
  realThread?: (v: PartValues) => boolean;
  /** Valeurs de l'aperçu cosmétique (défaut : Filetage = Cosmétique). */
  previewValues?: (v: PartValues) => PartValues;
  /** Message affiché après l'insertion (mode d'emploi). */
  note?: (v: PartValues) => string;
}

type Kernel = (req: KernelRequest) => Promise<SolidResult>;

// ---------------------------------------------------------------------------
// Visserie métrique ISO (pas gros)
// ---------------------------------------------------------------------------

interface Iso {
  /** Pas, ouverture de clé (H), hauteur de tête H, Ø et hauteur de tête CHC, clé six pans CHC. */
  p: number;
  s: number;
  k: number;
  dk: number;
  kc: number;
  sc: number;
  /** Hauteur d'écrou ISO 4032, rondelle ISO 7089 (Ø int, Ø ext, épaisseur). */
  m: number;
  d1: number;
  d2: number;
  h: number;
}

export const ISO_METRIC: Record<string, Iso> = {
  M3: { p: 0.5, s: 5.5, k: 2, dk: 5.5, kc: 3, sc: 2.5, m: 2.4, d1: 3.2, d2: 7, h: 0.5 },
  M4: { p: 0.7, s: 7, k: 2.8, dk: 7, kc: 4, sc: 3, m: 3.2, d1: 4.3, d2: 9, h: 0.8 },
  M5: { p: 0.8, s: 8, k: 3.5, dk: 8.5, kc: 5, sc: 4, m: 4.7, d1: 5.3, d2: 10, h: 1 },
  M6: { p: 1, s: 10, k: 4, dk: 10, kc: 6, sc: 5, m: 5.2, d1: 6.4, d2: 12, h: 1.6 },
  M8: { p: 1.25, s: 13, k: 5.3, dk: 13, kc: 8, sc: 6, m: 6.8, d1: 8.4, d2: 16, h: 1.6 },
  M10: { p: 1.5, s: 16, k: 6.4, dk: 16, kc: 10, sc: 8, m: 8.4, d1: 10.5, d2: 20, h: 2 },
  M12: { p: 1.75, s: 18, k: 7.5, dk: 18, kc: 12, sc: 10, m: 10.8, d1: 13, d2: 24, h: 2.5 },
  M14: { p: 2, s: 21, k: 8.8, dk: 21, kc: 14, sc: 12, m: 12.8, d1: 15, d2: 28, h: 2.5 },
  M16: { p: 2, s: 24, k: 10, dk: 24, kc: 16, sc: 14, m: 14.8, d1: 17, d2: 30, h: 3 },
  M20: { p: 2.5, s: 30, k: 12.5, dk: 30, kc: 20, sc: 17, m: 18, d1: 21, d2: 37, h: 3 },
};
const SIZES = Object.keys(ISO_METRIC);
const dia = (size: string) => parseFloat(size.slice(1));

/**
 * Choix proposés : Aucun ou Réel. La valeur interne « cosmetique » reste comprise (aperçu rapide
 * des filetages réels pendant le dessin, anciens réglages) mais n'est plus proposée.
 */
const THREAD: PartParam = {
  key: 'thread',
  label: 'Filetage',
  value: 'simple',
  options: [
    { value: 'simple', label: 'Aucun (tige lisse)' },
    { value: 'reel', label: 'Réel (hélice)' },
  ],
  help: 'Aucun : tige lisse, sans filet (léger et rapide). Réel : vraie hélice ISO, nécessaire pour qu’une vis imprimée se visse. Pendant le dessin, le filet réel s’affiche en aperçu ; le filet exact est calculé à l’export STL / 3MF / STEP.',
};

/**
 * Vis, tige : « Empreinte » = même pièce agrandie du jeu (filet compris), à soustraire d'un
 * solide pour obtenir un trou taraudé où la vis imprimée (cotes nominales) se visse. Le jeu est
 * donné PAR CÔTÉ : perpendiculaire aux flancs du filet réel, radial ailleurs (tête, cylindre).
 */
const USAGE: PartParam = {
  key: 'usage',
  label: 'Usage',
  value: 'piece',
  options: [
    { value: 'piece', label: 'Pièce à imprimer' },
    { value: 'empreinte', label: 'Empreinte (perçage)' },
  ],
  help:
    'Il faut insérer les DEUX, elles n’ont pas la même taille. ' +
    '1) Empreinte : une copie de la vis plus grosse du jeu (0,2 mm de chaque côté, filet compris). Elle ne sert qu’à creuser le trou : placez-la dans la plaque puis SOUSTRACTION ; elle disparaît. Ne l’imprimez jamais comme vis. ' +
    '2) Pièce : la vraie vis, aux cotes exactes (M5 = 5 mm), celle que vous imprimez. ' +
    'Résultat : le trou est 0,4 mm plus large que la vis sur le diamètre, la vis imprimée y entre sans forcer.',
  note: (v) =>
    v.usage === 'empreinte'
      ? 'Empreinte = outil de perçage, plus grosse que la vis du jeu par côté. Soustrayez-la de la plaque, puis insérez la vis à imprimer avec Usage « Pièce ». Ne l’imprimez pas.'
      : 'Vis à imprimer, aux cotes exactes. Pour son trou dans une plaque, insérez aussi la même vis en Usage « Empreinte » et soustrayez-la.',
};
const JEU_EMPREINTE: PartParam = {
  key: 'jeu',
  label: 'Jeu d’impression par côté',
  value: 0.2,
  min: 0,
  step: 0.05,
  unit: 'mm',
  help: 'Ne sert qu’à l’empreinte (l’outil de perçage), jamais à la vis à imprimer, qui garde ses cotes exactes. Le jeu s’ajoute de chaque côté du trou (sur les flancs du filet) : 0,2 mm par défaut, soit 0,4 mm de plus sur le diamètre. Plafonné à 0,2 × pas pour qu’il reste un filet.',
  visible: (v) => v.usage === 'empreinte',
};
/** Jeu par côté de l'empreinte (0 pour une pièce). */
const extra = (v: PartValues) => (v.usage === 'empreinte' ? Math.max(0, Number(v.jeu) || 0) : 0);
const usageTitle = (v: PartValues, t: string) => (v.usage === 'empreinte' ? `Empreinte ${t.charAt(0).toLowerCase()}${t.slice(1)} (jeu ${v.jeu})` : t);

const num = (v: PartValues, k: string) => Number(v[k]);

// ---------------------------------------------------------------------------
// Aides géométriques
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

function ring(r: number, z: number, n = 48, rot = 0): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => P(r * Math.cos(rot + (TAU * i) / n), r * Math.sin(rot + (TAU * i) / n), z));
}

/** Prisme (contour d'aperçu) : deux anneaux et quelques génératrices. */
function prismOutline(r: number, z0: number, z1: number, n = 48, rot = 0): Vec3[][] {
  const a = ring(r, z0, n, rot), b = ring(r, z1, n, rot);
  const step = Math.max(1, Math.floor(n / 6));
  const gens = a.slice(0, n).filter((_, i) => i % step === 0).map((p, i) => [p, b[i * step]!]);
  return [a, b, ...gens];
}

function rectOutline(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Vec3[][] {
  const q = (z: number) => [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z), P(x0, y0, z)];
  const a = q(z0), b = q(z1);
  return [a, b, ...a.slice(0, 4).map((p, i) => [p, b[i]!])];
}

/** Rayon du cercle circonscrit d'un hexagone d'ouverture `s`. */
const hexR = (s: number) => s / Math.sqrt(3);

const hexPrism = (k: Kernel, s: number, z: number, h: number) => k({ op: 'pyramid', center: P(0, 0, z), sides: 6, radius: hexR(s), topRadius: hexR(s), height: h, rotation: Math.PI / 6 });
const cyl = (k: Kernel, r: number, z: number, h: number) => k({ op: 'cylinder', center: P(0, 0, z), radius: r, height: h });
const union = (k: Kernel, ...s: SolidResult[]) => k({ op: 'boolean', kind: 'union', targets: s.map((x) => x.shapeId), tools: [] });
const subtract = (k: Kernel, a: SolidResult, ...b: SolidResult[]) => k({ op: 'boolean', kind: 'subtract', targets: [a.shapeId], tools: b.map((x) => x.shapeId) });
/** Booléens des filetages : exacts (la tolérance floue et la fusion des faces bloquent le noyau). */
const unionExact = (k: Kernel, ...s: SolidResult[]) => k({ op: 'boolean', kind: 'union', targets: s.map((x) => x.shapeId), tools: [], exact: true });
const subtractExact = (k: Kernel, a: SolidResult, ...b: SolidResult[]) => k({ op: 'boolean', kind: 'subtract', targets: [a.shapeId], tools: b.map((x) => x.shapeId), exact: true });

/**
 * Tige filetée de Ø `d`, pas `p`, de z0 à z0 + L : noyau au Ø du fond de filet et filet
 * triangulaire (60°) balayé le long d'une hélice à droite, rogné aux extrémités, avec un
 * chanfrein d'entrée à 45° jusqu'au fond de filet : `chamfer` = true ou { top } côté z0 + L,
 * { bottom } côté z0 (bout d'une vis). `gap` > 0 : outil de taraudage décalé de `gap` mm
 * perpendiculairement aux flancs (jeu d'impression réel, voir `threadProfile`).
 */
export async function threadedRod(k: Kernel, d: number, p: number, z0: number, L: number, chamfer: boolean | Tips, gap = 0): Promise<SolidResult> {
  const tips: Tips = typeof chamfer === 'boolean' ? { top: chamfer } : chamfer;
  const t = threadProfile(d, p, gap);
  // profil dans le plan XZ, posé au départ de l'hélice (angle 0), un pas sous z0
  const zs = z0 - p;
  const profile: ProfileDef = {
    kind: 'poly',
    points: [P(t.rBase, 0, zs - t.base), P(t.rCrest, 0, zs - t.tip), P(t.rCrest, 0, zs + t.tip), P(t.rBase, 0, zs + t.base)],
    closed: true,
  };
  const turns = (L + 2 * p) / p;
  const helix: ProfileDef = { kind: 'helix', center: P(0, 0, zs), baseRadius: t.rBase, topRadius: t.rBase, height: turns * p, turns, ccw: true };
  const ridge = await k({ op: 'sweep', profile, path: helix, align: false });
  // le cœur dépasse le filet aux deux bouts : ses disques d'extrémité ne coupent jamais l'hélice
  // (sinon la fusion OpenCascade échoue selon la position)
  const core = await cyl(k, t.core, zs - 2 * p, turns * p + 4 * p);
  const raw = await unionExact(k, core, ridge);
  // rognage des extrémités (et chanfrein d'entrée à 45° côté z0 + L) par enlèvement de matière
  const r1 = d / 2 - (5 / 8) * 0.866 * p; // fond de filet (chanfrein d'entrée)
  const R = d / 2 + p, top = z0 + L;
  const tools = [await cyl(k, R, z0 - 6 * p, 6 * p), await cyl(k, R, top, 6 * p)];
  const c = R - r1;
  if (tips.top) tools.push(await revolveZ(k, [P(r1, 0, top), P(R, 0, top - c), P(R, 0, top + p), P(r1, 0, top + p)]));
  if (tips.bottom) tools.push(await revolveZ(k, [P(r1, 0, z0), P(r1, 0, z0 - p), P(R, 0, z0 - p), P(R, 0, z0 + c)]));
  return subtractExact(k, raw, ...tools);
}

/** Extrémités chanfreinées d'une tige (bas = z0, haut = z0 + L). */
export interface Tips {
  bottom?: boolean;
  top?: boolean;
}

/** Solide de révolution autour de Z d'un contour fermé du plan XZ. */
const revolveZ = (k: Kernel, points: Vec3[]) => k({ op: 'revolve', profile: { kind: 'poly', points, closed: true }, axisStart: P(0, 0, 0), axisEnd: P(0, 0, 1), angleDeg: 360, startDeg: 0 });

/**
 * Chanfrein d'entrée d'une vis ou d'une tige filetée : 45°, jusqu'au fond de filet ISO
 * (5/8 de la hauteur du triangle générateur, ≈ 0,54 × pas), plafonné au quart du rayon.
 */
export const tipChamfer = (d: number, p: number) => Math.min((5 / 8) * 0.866 * p, d / 8);

/** Tige lisse de Ø `d` (z0 → z0 + L) aux extrémités chanfreinées à 45° : une seule révolution. */
async function chamferedRod(k: Kernel, d: number, p: number, z0: number, L: number, tips: Tips): Promise<SolidResult> {
  const R = d / 2, top = z0 + L;
  const c = Math.min(tipChamfer(d, p), L / 3);
  const pts: Vec3[] = [P(0, 0, z0)];
  if (tips.bottom) pts.push(P(R - c, 0, z0), P(R, 0, z0 + c));
  else pts.push(P(R, 0, z0));
  if (tips.top) pts.push(P(R, 0, top - c), P(R - c, 0, top));
  else pts.push(P(R, 0, top));
  pts.push(P(0, 0, top));
  return revolveZ(k, pts);
}

/**
 * Filetage cosmétique : tige de Ø `d` de z0 à z0 + L portant des stries annulaires au profil
 * du filet (60°, sans hélice). Une seule révolution : aspect fileté pour un coût proche du
 * cylindre lisse. Les stries sont calées sur `phase` (multiple du pas) pour que vis et écrou
 * d'un même boulon s'emboîtent.
 */
export async function groovedRod(k: Kernel, d: number, p: number, z0: number, L: number, phase = z0, tips: Tips = {}): Promise<SolidResult> {
  const H = 0.866 * p;
  const R = d / 2, r1 = R - (5 / 8) * H; // ISO 68-1 : fond p/4, sommet p/8, flancs à 60°
  const top = z0 + L;
  const pts: Vec3[] = [P(0, 0, z0), P(r1, 0, z0)];
  // première dent calée sur la phase, puis une dent par pas
  for (let zc = phase + Math.ceil((z0 - phase) / p - 1e-9) * p; zc + p <= top + 1e-9; zc += p)
    pts.push(P(r1, 0, zc + p / 8), P(R, 0, zc + p / 2 - p / 16), P(R, 0, zc + p / 2 + p / 16), P(r1, 0, zc + p - p / 8));
  pts.push(P(r1, 0, top), P(0, 0, top));
  const profile: ProfileDef = { kind: 'poly', points: pts, closed: true };
  const rod = await k({ op: 'revolve', profile, axisStart: P(0, 0, 0), axisEnd: P(0, 0, 1), angleDeg: 360, startDeg: 0 });
  if (!tips.bottom && !tips.top) return rod;
  // même chanfrein d'entrée que le filet réel (aperçu fidèle)
  const c = R - r1, Rx = R + p;
  const tools: SolidResult[] = [];
  if (tips.top) tools.push(await revolveZ(k, [P(r1, 0, top), P(Rx, 0, top - c - p), P(Rx, 0, top + p), P(r1, 0, top + p)]));
  if (tips.bottom) tools.push(await revolveZ(k, [P(r1, 0, z0), P(r1, 0, z0 - p), P(Rx, 0, z0 - p), P(Rx, 0, z0 + c + p)]));
  return subtract(k, rod, ...tools);
}

/**
 * Tige : filetée (réelle ou cosmétique) ou simple cylindre. `gap` : jeu d'impression par côté
 * (empreinte à soustraire) — perpendiculaire aux flancs pour le filet réel, radial sinon.
 */
async function shank(k: Kernel, v: PartValues, d: number, p: number, z0: number, L: number, tips: Tips = {}, gap = 0): Promise<SolidResult> {
  if (v.thread === 'reel') return threadedRod(k, d, p, z0, L, tips, gap);
  if (v.thread === 'cosmetique') return groovedRod(k, d + 2 * gap, p, z0, L, z0, tips);
  if (gap === 0 && (tips.bottom || tips.top)) return chamferedRod(k, d, p, z0, L, tips);
  return cyl(k, d / 2 + gap, z0, L);
}

/** Polyligne rectangle à coins arrondis (bulges), centrée sur l'origine. */
function roundedRect(w: number, h: number, r: number, z: number): ProfileDef {
  r = Math.max(0, Math.min(r, w / 2 - 1e-6, h / 2 - 1e-6));
  if (r < 1e-6) return { kind: 'poly', points: [P(-w / 2, -h / 2, z), P(w / 2, -h / 2, z), P(w / 2, h / 2, z), P(-w / 2, h / 2, z)], closed: true };
  const x = w / 2, y = h / 2;
  const b = Math.tan(Math.PI / 8); // quart de cercle
  const points = [P(-x + r, -y, z), P(x - r, -y, z), P(x, -y + r, z), P(x, y - r, z), P(x - r, y, z), P(-x + r, y, z), P(-x, y - r, z), P(-x, -y + r, z)];
  return { kind: 'poly', points, closed: true, bulges: [0, b, 0, b, 0, b, 0, b] };
}

const extrude = (k: Kernel, profile: ProfileDef, h: number) => k({ op: 'extrude', profile, height: h, taperDeg: 0 });


// ---------------------------------------------------------------------------
// Charnières
// ---------------------------------------------------------------------------

/** Cylindre d'axe X (charnons, axes). */
const cylX = (k: Kernel, r: number, x0: number, x1: number, cy: number, cz: number) =>
  k({ op: 'cylinder', center: P(x0, cy, cz), radius: r, height: x1 - x0, axis: P(1, 0, 0) });

const box = (k: Kernel, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  k({ op: 'box', corner: P(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)), size: P(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)) });

/** Contour d'aperçu d'un cylindre d'axe X. */
function cylXOutline(r: number, x0: number, x1: number, cy: number, cz: number, n = 24): Vec3[][] {
  const rg = (x: number) => Array.from({ length: n + 1 }, (_, i) => P(x, cy + r * Math.cos((TAU * i) / n), cz + r * Math.sin((TAU * i) / n)));
  const a = rg(x0), b = rg(x1);
  return [a, b, [a[n / 4]!, b[n / 4]!], [a[(3 * n) / 4]!, b[(3 * n) / 4]!]];
}

/** Rotation d'angle `deg` autour de l'axe X passant par (y = 0, z = zc). */
function rotX(deg: number, zc: number): Affine {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, zc * s, 0, s, c, zc - zc * c];
}

/** Rotation d'angle `deg` autour de l'axe Z. */
function rotZ(deg: number): Affine {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

const SCREW_HEAD: PartParam = {
  key: 'fraise',
  label: 'Trous de vis',
  value: 'fraise',
  options: [
    { value: 'fraise', label: 'Fraisés (vis à tête fraisée)' },
    { value: 'droit', label: 'Droits' },
  ],
};

interface KnuckleHinge {
  /** Longueur le long de l'axe (X), largeur d'une lame depuis l'axe, épaisseur des lames. */
  L: number;
  W: number;
  e: number;
  /** Rayon extérieur des charnons, nombre de charnons. */
  R: number;
  n: number;
  /** Rayon de l'axe, jeu radial, jeu axial entre charnons. */
  rp: number;
  jeu: number;
  ga: number;
  /** `pin` : axe séparé (3 solides) ; `pip` : axe solidaire de la lame A, imprimable assemblé. */
  mode: 'pin' | 'pip';
  /** Trous par lame, Ø, fraisage. */
  holes: number;
  dt: number;
  countersink: boolean;
  /** Ouverture (180 = à plat, 0 = refermée). */
  angle: number;
}

/**
 * Charnière à charnons alternés, axe X, posée à plat (lames sur z = 0, axe à z = R) :
 * lame A côté y < 0 (charnons pairs), lame B côté y > 0 (charnons impairs). Chaque lame est
 * dégagée (rayon R + jeu) au droit des charnons de l'autre, et percée pour l'axe.
 */
async function knuckleHinge(k: Kernel, o: KnuckleHinge): Promise<{ result: SolidResult; name?: string }[]> {
  const { L, W, e, R, rp, jeu, ga } = o;
  const n = Math.round(o.n);
  if (n < 2) throw new Error('Il faut au moins 2 charnons.');
  if (e > 2 * R) throw new Error('Les lames sont plus épaisses que les charnons (Ø charnon ≥ 2 × épaisseur).');
  if (W <= R + jeu + 1) throw new Error('Les lames sont trop étroites pour les charnons.');
  if (rp + jeu > R - 0.4) throw new Error('L’axe est trop gros pour les charnons (paroi < 0,4 mm).');
  if (ga * (n - 1) >= L * 0.5) throw new Error('Le jeu entre charnons est trop grand pour la longueur.');
  if (o.angle < 0 || o.angle > 180) throw new Error('L’ouverture doit être comprise entre 0° et 180°.');
  if (o.angle < 90 && e > R) throw new Error('Pour refermer la charnière, le rayon des charnons doit être ≥ épaisseur des lames.');
  const seg = (i: number): [number, number] => [(i * L) / n, ((i + 1) * L) / n];
  const knuckles = async (side: 0 | 1) => {
    const out: SolidResult[] = [];
    for (let i = side; i < n; i += 2) {
      const [a, b] = seg(i);
      out.push(await cylX(k, R, a + (i > 0 ? ga / 2 : 0), b - (i < n - 1 ? ga / 2 : 0), 0, R));
    }
    return out;
  };
  const clearance = async (side: 0 | 1) => {
    const out: SolidResult[] = [];
    for (let i = side; i < n; i += 2) {
      const [a, b] = seg(i);
      out.push(await cylX(k, R + jeu, a - (i === 0 ? 1 : 0), b + (i === n - 1 ? 1 : 0), 0, R));
    }
    return out;
  };
  const holes = async (sign: -1 | 1) => {
    const out: SolidResult[] = [];
    const nh = Math.max(0, Math.round(o.holes));
    if (!nh || o.dt <= 0) return out;
    const yc = sign * (R + jeu + (W - R - jeu) / 2);
    if (o.dt / 2 > (W - R - jeu) / 2 - 0.4) throw new Error('Les trous de vis débordent des lames.');
    for (let j = 0; j < nh; j++) {
      const x = (L * (j + 0.5)) / nh;
      out.push(await k({ op: 'cylinder', center: P(x, yc, -1), radius: o.dt / 2, height: e + 2 }));
      if (o.countersink) {
        // fraisure à 90° : Ø en surface ≈ 2 × Ø du trou (limitée par l'épaisseur)
        const depth = Math.min(o.dt / 2, e * 0.6);
        out.push(await k({ op: 'cone', center: P(x, yc, e - depth), radius: o.dt / 2, topRadius: o.dt / 2 + depth + 0.5, height: depth + 0.5 }));
      }
    }
    return out;
  };
  const plateA = await box(k, 0, -W, 0, L, 0, e);
  const plateB = await box(k, 0, 0, 0, L, W, e);
  let A = await subtract(k, await union(k, plateA, ...(await knuckles(0))), ...(await clearance(1)), ...(await holes(-1)));
  let B = await subtract(k, await union(k, plateB, ...(await knuckles(1))), ...(await clearance(0)), ...(await holes(1)));
  const bore = () => cylX(k, rp + jeu, -1, L + 1, 0, R);
  const out: { result: SolidResult; name?: string }[] = [];
  if (o.mode === 'pip') {
    // axe solidaire de A, qui traverse les charnons de B avec le jeu : imprimé déjà assemblé
    A = await union(k, A, await cylX(k, rp, 0, L, 0, R));
    B = await subtract(k, B, await bore());
  } else {
    A = await subtract(k, A, await bore());
    B = await subtract(k, B, await bore());
  }
  if (o.angle !== 180) B = await k({ op: 'transform', shapeId: B.shapeId, matrix: rotX(180 - o.angle, R) });
  out.push({ result: A, name: 'Lame A' }, { result: B, name: 'Lame B' });
  if (o.mode === 'pin') out.push({ result: await cylX(k, rp, 0, L, 0, R), name: `Axe Ø${+(2 * rp).toFixed(2)}×${L}` });
  return out;
}

function knucklePreview(L: number, W: number, e: number, R: number): Vec3[][] {
  return [...rectOutline(0, -W, L, W, 0, e), ...cylXOutline(R, 0, L, 0, R)];
}

const hingeOpts = (v: PartValues, mode: 'pin' | 'pip', n: number): KnuckleHinge => ({
  L: num(v, 'L'),
  W: num(v, 'W'),
  e: num(v, 'e'),
  R: num(v, 'D') / 2,
  n,
  rp: num(v, 'dp') / 2,
  jeu: num(v, 'jeu'),
  ga: num(v, 'ga'),
  mode,
  holes: num(v, 'nt'),
  dt: num(v, 'dt'),
  countersink: v.fraise === 'fraise',
  angle: num(v, 'a'),
});

const HINGE_ANGLE: PartParam = { key: 'a', label: 'Ouverture (180 = à plat)', value: 180, min: 0, unit: '°' };


// ---------------------------------------------------------------------------
// Raccords d'évacuation PVC (NF EN 1329, à coller)
// ---------------------------------------------------------------------------

/** Épaisseur du tube et profondeur d'emboîture usuelles par Ø extérieur du tube. */
export const PVC_EVAC: Record<string, { D: number; e: number; Ls: number }> = {
  'Ø32': { D: 32, e: 3, Ls: 22 },
  'Ø40': { D: 40, e: 3, Ls: 26 },
  'Ø50': { D: 50, e: 3, Ls: 30 },
  'Ø63': { D: 63, e: 3, Ls: 36 },
  'Ø80': { D: 80, e: 3, Ls: 44 },
  'Ø100': { D: 100, e: 3, Ls: 52 },
  'Ø125': { D: 125, e: 3.2, Ls: 64 },
};
const PVC_SIZES = Object.keys(PVC_EVAC);

const pvcSize = (withR: boolean) => (size: string, v: PartValues): PartValues => {
  const s = PVC_EVAC[size];
  if (!s) return v;
  const out: PartValues = { ...v, size, D: s.D, e: s.e, Ls: s.Ls };
  if (withR) out.R = s.D;
  if (v.d !== undefined) out.d = s.D;
  return out;
};

const PVC_COMMON: PartParam[] = [
  { key: 'D', label: 'Ø extérieur du tube', value: 100, min: 5, unit: 'mm' },
  { key: 'e', label: 'Épaisseur (paroi)', value: 3, min: 0.4, step: 0.1, unit: 'mm' },
  { key: 'Ls', label: 'Longueur d’emboîture', value: 52, min: 1, unit: 'mm' },
  { key: 'jeu', label: 'Jeu d’emboîture (sur le Ø)', value: 0.2, min: 0, step: 0.05, unit: 'mm', help: 'Ajouté au diamètre de l’emboîture pour que le tube entre : 0,2 mm sur le Ø, soit 0,1 mm de chaque côté.' },
];

interface PvcDims {
  /** Ø du tube, paroi, emboîture, jeu. */
  D: number;
  e: number;
  Ls: number;
  jeu: number;
}

const pvcDims = (v: PartValues): PvcDims => {
  const o = { D: num(v, 'D'), e: num(v, 'e'), Ls: num(v, 'Ls'), jeu: num(v, 'jeu') };
  if (4 * o.e >= o.D) throw new Error('La paroi est trop épaisse pour ce diamètre.');
  if (o.jeu >= o.e) throw new Error('Le jeu d’emboîture doit rester inférieur à l’épaisseur.');
  return o;
};

/** Cylindre d'axe quelconque (unitaire) partant de `c`. */
const cylAx = (k: Kernel, r: number, c: Vec3, ax: Vec3, h: number) => k({ op: 'cylinder', center: c, radius: r, height: h, axis: ax });
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => P(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

/**
 * Coude d'angle `a` : emboîture femelle A en bas (embouchure en z = 0, axe Z), cintrage de rayon
 * `R` (axe) vers −X, puis emboîture B (femelle) ou bout mâle au Ø du tube. Le corps garde le Ø
 * extérieur des emboîtures (D + 2e) et l'alésage du tube (D − 2e) : la butée fait e.
 */
export async function pvcElbow(k: Kernel, o: PvcDims & { R: number; a: number; male: boolean }): Promise<SolidResult> {
  const { D, e, Ls, jeu, R, a } = o;
  if (a <= 0 || a > 180) throw new Error('L’angle doit être compris entre 0° et 180°.');
  const ro = D / 2 + e, rb = D / 2 - e, rs = (D + jeu) / 2;
  if (R <= ro + 0.1) throw new Error(`Le rayon de cintrage doit dépasser ${+(ro + 0.1).toFixed(1)} mm (rayon extérieur).`);
  const t = (a * Math.PI) / 180;
  // fin du cintrage : point et direction de l'emboîture B
  const E = P(-R + R * Math.cos(t), 0, Ls + R * Math.sin(t));
  const dir = P(-Math.sin(t), 0, Math.cos(t));
  const bend = (r: number) =>
    k({ op: 'revolve', profile: { kind: 'circle', center: P(0, 0, Ls), radius: r }, axisStart: P(-R, 0, Ls), axisEnd: P(-R, -1, Ls), angleDeg: a, startDeg: 0 });
  const body = await union(k, await cyl(k, ro, 0, Ls), await bend(ro), await cylAx(k, o.male ? D / 2 : ro, E, dir, Ls));
  const tools = [await cyl(k, rs, -1, Ls + 1), await bend(rb)];
  tools.push(o.male ? await cylAx(k, rb, E, dir, Ls + 1) : await cylAx(k, rs, E, dir, Ls + 1));
  return subtract(k, body, ...tools);
}

/**
 * Té de raccordement : passage droit le long de Z (emboîtures en bas et en haut), piquage de
 * Ø `d` à `a`° de l'axe (90 = té, 45 = culotte), dans le plan XZ vers +X et vers le haut. Les
 * emboîtures sont placées hors de la zone de piquage.
 */
export async function pvcTee(k: Kernel, o: PvcDims & { d: number; a: number }): Promise<SolidResult> {
  const { D, e, Ls, jeu, d, a } = o;
  if (a < 30 || a > 90) throw new Error('L’angle du piquage doit être compris entre 30° et 90°.');
  if (d > D) throw new Error('Le Ø du piquage ne peut pas dépasser celui du passage droit.');
  if (4 * e >= d) throw new Error('La paroi est trop épaisse pour le Ø du piquage.');
  const t = (a * Math.PI) / 180, sn = Math.sin(t), cot = Math.cos(t) / sn;
  const ro = D / 2 + e, rob = d / 2 + e;
  const m = e; // marge entre la zone de piquage et les emboîtures
  const zc = Ls + m + Math.max(rob * sn, rob / sn - ro * cot);
  const zTop = zc + ro * cot + rob / sn + m;
  const H = zTop + Ls;
  const s0 = ro / sn + rob * cot + m; // fond de l'emboîture du piquage (distance à l'axe)
  const C = P(0, 0, zc), dir = P(sn, 0, Math.cos(t));
  const body = await union(k, await cyl(k, ro, 0, H), await cylAx(k, rob, C, dir, s0 + Ls));
  const tools = [
    await cyl(k, D / 2 - e, -1, H + 2),
    await cyl(k, (D + jeu) / 2, -1, Ls + 1),
    await cyl(k, (D + jeu) / 2, zTop, Ls + 1),
    await cylAx(k, d / 2 - e, C, dir, s0 + 1),
    await cylAx(k, (d + jeu) / 2, add(C, dir, s0), dir, Ls + 1),
  ];
  return subtract(k, body, ...tools);
}

function elbowPreview(v: PartValues): Vec3[][] {
  const D = num(v, 'D'), e = num(v, 'e'), Ls = num(v, 'Ls'), R = num(v, 'R'), t = (num(v, 'a') * Math.PI) / 180;
  const ro = D / 2 + e;
  const arc = (rr: number) => Array.from({ length: 25 }, (_, i) => P(-R + rr * Math.cos((t * i) / 24), 0, Ls + rr * Math.sin((t * i) / 24)));
  const E = P(-R + R * Math.cos(t), 0, Ls + R * Math.sin(t));
  // embouchure B : anneau dans le plan perpendiculaire à la direction (−sin t, 0, cos t)
  const end = ring(ro, 0, 32).map((p) => P(E.x - Ls * Math.sin(t) + p.x * Math.cos(t), p.y, E.z + Ls * Math.cos(t) + p.x * Math.sin(t)));
  return [...prismOutline(ro, 0, Ls, 32), arc(R - ro), arc(R + ro), end];
}

function teePreview(v: PartValues): Vec3[][] {
  const D = num(v, 'D'), e = num(v, 'e'), Ls = num(v, 'Ls'), d = num(v, 'd'), t = (num(v, 'a') * Math.PI) / 180;
  const ro = D / 2 + e, rob = d / 2 + e, sn = Math.sin(t), cot = Math.cos(t) / sn;
  const zc = Ls + e + Math.max(rob * sn, rob / sn - ro * cot);
  const H = zc + ro * cot + rob / sn + e + Ls;
  const L = ro / sn + rob * cot + e + Ls;
  // piquage : anneau d'embouchure dans le plan perpendiculaire à la direction (sin t, 0, cos t)
  const mouth = ring(rob, 0, 32).map((p) => P(L * sn + p.x * Math.cos(t), p.y, zc + L * Math.cos(t) - p.x * sn));
  const c = Math.cos(t);
  const gens = [1, -1].map((s) => [P(s * rob * c, 0, zc - s * rob * sn), P(L * sn + s * rob * c, 0, zc + L * c - s * rob * sn)]);
  return [...prismOutline(ro, 0, H, 32), mouth, ...gens];
}

const elbowDef = (a: number, label: string): PartDef => ({
  id: `pvc-coude-${Math.floor(a)}`,
  name: `Coude ${label}`,
  category: 'Plomberie (évacuation PVC)',
  description: `Coude d’évacuation ${label} à coller, emboîtures femelles (ou mâle/femelle)`,
  icon: 'part-pvc-elbow',
  sizes: PVC_SIZES,
  applySize: pvcSize(true),
  defaultSize: 'Ø100',
  params: [
    ...PVC_COMMON,
    { key: 'a', label: 'Angle', value: a, min: 1, step: 0.5, unit: '°' },
    { key: 'R', label: 'Rayon de cintrage (axe)', value: 100, min: 1, unit: 'mm' },
    {
      key: 'bout',
      label: 'Extrémités',
      value: 'FF',
      options: [
        { value: 'FF', label: 'Femelle / femelle' },
        { value: 'MF', label: 'Mâle / femelle' },
      ],
    },
  ],
  title: (v) => `Coude PVC Ø${v.D} ${v.a}°${v.bout === 'MF' ? ' MF' : ''}`,
  preview: elbowPreview,
  build: async (k, v) => [{ result: await pvcElbow(k, { ...pvcDims(v), R: num(v, 'R'), a: num(v, 'a'), male: v.bout === 'MF' }) }],
});

const teeDef = (a: number, id: string, name: string, description: string, icon: string): PartDef => ({
  id,
  name,
  category: 'Plomberie (évacuation PVC)',
  description,
  icon,
  sizes: PVC_SIZES,
  applySize: pvcSize(false),
  defaultSize: 'Ø100',
  params: [
    ...PVC_COMMON,
    { key: 'd', label: 'Ø du piquage (tube)', value: 100, min: 5, unit: 'mm' },
    { key: 'a', label: 'Angle du piquage', value: a, min: 30, step: 0.5, unit: '°' },
  ],
  title: (v) => `Té PVC ${v.D}×${v.d} ${v.a}°`,
  preview: teePreview,
  build: async (k, v) => [{ result: await pvcTee(k, { ...pvcDims(v), d: num(v, 'd'), a: num(v, 'a') }) }],
});

const PLUMBING: PartDef[] = [
  elbowDef(22.5, '22°30'),
  elbowDef(45, '45°'),
  elbowDef(67.5, '67°30'),
  elbowDef(90, '90° (87°30 possible)'),
  teeDef(90, 'pvc-te-90', 'Té 87°30 / 90°', 'Té de raccordement à piquage droit, 3 emboîtures femelles (piquage réduit possible)', 'part-pvc-tee'),
  teeDef(45, 'pvc-te-45', 'Té 45° (culotte)', 'Culotte à 45°, 3 emboîtures femelles (piquage réduit possible)', 'part-pvc-wye'),
];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const isoSize = (fields: (iso: Iso, d: number) => PartValues) => (size: string, v: PartValues): PartValues => {
  const iso = ISO_METRIC[size];
  return iso ? { ...v, size, ...fields(iso, dia(size)) } : v;
};

/** Disposition de la plaquette de calibration (repère local, plaque de z = 0 à e). */
function calibLayout(v: PartValues) {
  const d = num(v, 'd'), p = num(v, 'p');
  const n = Math.max(1, Math.min(8, Math.round(num(v, 'n')) || 1));
  const j0 = Math.max(0, num(v, 'j0') || 0), dj = Math.max(0.01, num(v, 'dj') || 0.05);
  const gmax = maxThreadGap(p);
  const raw = Array.from({ length: n }, (_, i) => Math.round((j0 + i * dj) * 1000) / 1000);
  const gaps = raw.map((g) => Math.min(g, gmax));
  const sx = Math.max(2.2 * d, d + 9);
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * sx);
  const plain = v.lisses === 'non' ? [] : [4, 6, 8, 10, 12].map((dd, i) => ({ d: dd, x: (i - 2) * 16 }));
  const W = Math.max(n * sx, plain.length ? 5 * 16 : 0) + 8;
  const yTop = d / 2 + 6;
  const yPlain = -(d / 2 + 11);
  const yBot = plain.length ? yPlain - 10 : -(d / 2 + 5);
  return { gaps, capped: raw.some((g) => g > gmax + 1e-9), xs, plain, W, yTop, yBot, yPlain };
}

export const PARTS: PartDef[] = [
  {
    id: 'vis-h',
    name: 'Vis à tête hexagonale',
    category: 'Visserie',
    description: 'ISO 4017 — tête H, tige entièrement filetée',
    icon: 'part-bolt',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 8, min: 1, unit: 'mm' },
      { key: 'L', label: 'Longueur sous tête L', value: 30, min: 1, unit: 'mm' },
      { key: 's', label: 'Ouverture de clé s', value: 13, min: 1, unit: 'mm' },
      { key: 'k', label: 'Hauteur de tête k', value: 5.3, min: 0.1, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1.25, min: 0.2, step: 0.05, unit: 'mm' },
      THREAD,
      USAGE,
      JEU_EMPREINTE,
    ],
    applySize: isoSize((i, d) => ({ d, s: i.s, k: i.k, p: i.p })),
    title: (v) => usageTitle(v, `Vis H ${v.size ?? `M${v.d}`}×${v.L}`),
    preview: (v) => [...prismOutline(hexR(num(v, 's')), 0, num(v, 'k'), 6, Math.PI / 6), ...prismOutline(num(v, 'd') / 2, -num(v, 'L'), 0, 24)],
    build: async (k, v) => {
      const j = extra(v);
      const head = await hexPrism(k, num(v, 's') + 2 * j, 0, num(v, 'k') + j);
      const tige = await shank(k, v, num(v, 'd'), num(v, 'p'), -num(v, 'L') - j, num(v, 'L') + j + 0.01 * num(v, 'p'), { bottom: j === 0 }, j);
      return [{ result: await (v.thread === 'reel' ? unionExact : union)(k, head, tige) }];
    },
  },
  {
    id: 'vis-chc',
    name: 'Vis à tête cylindrique (CHC)',
    category: 'Visserie',
    description: 'ISO 4762 — six pans creux',
    icon: 'part-chc',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 6, min: 1, unit: 'mm' },
      { key: 'L', label: 'Longueur sous tête L', value: 20, min: 1, unit: 'mm' },
      { key: 'dk', label: 'Ø de tête dk', value: 10, min: 1, unit: 'mm' },
      { key: 'k', label: 'Hauteur de tête k', value: 6, min: 0.1, unit: 'mm' },
      { key: 'sc', label: 'Clé six pans', value: 5, min: 0.5, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1, min: 0.2, step: 0.05, unit: 'mm' },
      THREAD,
      USAGE,
      JEU_EMPREINTE,
    ],
    applySize: isoSize((i, d) => ({ d, dk: i.dk, k: i.kc, sc: i.sc, p: i.p })),
    title: (v) => usageTitle(v, `Vis CHC ${v.size ?? `M${v.d}`}×${v.L}`),
    preview: (v) => [...prismOutline(num(v, 'dk') / 2, 0, num(v, 'k'), 32), ...prismOutline(num(v, 'd') / 2, -num(v, 'L'), 0, 24)],
    build: async (k, v) => {
      const j = extra(v);
      const kk = num(v, 'k') + j;
      const head = await cyl(k, num(v, 'dk') / 2 + j, 0, kk);
      const tige = await shank(k, v, num(v, 'd'), num(v, 'p'), -num(v, 'L') - j, num(v, 'L') + j + 0.01 * num(v, 'p'), { bottom: j === 0 }, j);
      const exact = v.thread === 'reel';
      // l'empreinte n'a pas de six pans creux (inutile pour le logement)
      if (j > 0) return [{ result: await (exact ? unionExact : union)(k, head, tige) }];
      const socket = await hexPrism(k, num(v, 'sc'), kk * 0.4, kk);
      return [{ result: await (exact ? subtractExact : subtract)(k, await (exact ? unionExact : union)(k, head, tige), socket) }];
    },
  },
  {
    id: 'ecrou',
    name: 'Écrou hexagonal',
    category: 'Visserie',
    description: 'ISO 4032 — taraudage lisse ou réel',
    icon: 'part-nut',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 8, min: 1, unit: 'mm' },
      { key: 's', label: 'Ouverture de clé s', value: 13, min: 1, unit: 'mm' },
      { key: 'm', label: 'Hauteur m', value: 6.8, min: 0.1, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1.25, min: 0.2, step: 0.05, unit: 'mm' },
      {
        key: 'jeu',
        label: 'Jeu d’impression par côté',
        value: 0.2,
        min: 0,
        step: 0.05,
        unit: 'mm',
        help: 'Agrandit le taraudage de l’écrou imprimé pour qu’une vis y entre. Le jeu s’ajoute de chaque côté du trou (sur les flancs du filet) : 0,2 mm par défaut, soit 0,4 mm de plus sur le diamètre. 0 = cotes exactes.',
      },
      THREAD,
    ],
    applySize: isoSize((i, d) => ({ d, s: i.s, m: i.m, p: i.p })),
    title: (v) => `Écrou H ${v.size ?? `M${v.d}`}`,
    preview: (v) => [...prismOutline(hexR(num(v, 's')), 0, num(v, 'm'), 6, Math.PI / 6), ...prismOutline(num(v, 'd') / 2, 0, num(v, 'm'), 24)],
    build: async (k, v) => {
      const m = num(v, 'm'), d = num(v, 'd'), p = num(v, 'p'), j = Math.max(0, Number(v.jeu) || 0);
      const body = await hexPrism(k, num(v, 's'), 0, m);
      const hole = v.thread === 'reel' ? await threadedRod(k, d, p, -p, m + 2 * p, false, j)
        : v.thread === 'cosmetique' ? await groovedRod(k, d + 2 * j, p, -p, m + 2 * p)
        : await cyl(k, d / 2 + j, -1, m + 2);
      return [{ result: await (v.thread === 'reel' ? subtractExact : subtract)(k, body, hole) }];
    },
  },
  {
    id: 'rondelle',
    name: 'Rondelle plate',
    category: 'Visserie',
    description: 'ISO 7089',
    icon: 'part-washer',
    sizes: SIZES,
    params: [
      { key: 'd1', hole: true, label: 'Ø intérieur', value: 8.4, min: 0.1, unit: 'mm' },
      { key: 'd2', label: 'Ø extérieur', value: 16, min: 0.2, unit: 'mm' },
      { key: 'h', label: 'Épaisseur', value: 1.6, min: 0.05, unit: 'mm' },
    ],
    applySize: isoSize((i) => ({ d1: i.d1, d2: i.d2, h: i.h })),
    title: (v) => `Rondelle ${v.size ?? `Ø${v.d1}`}`,
    preview: (v) => [...prismOutline(num(v, 'd2') / 2, 0, num(v, 'h')), ...prismOutline(num(v, 'd1') / 2, 0, num(v, 'h'))],
    build: async (k, v) => [{ result: await subtract(k, await cyl(k, num(v, 'd2') / 2, 0, num(v, 'h')), await cyl(k, num(v, 'd1') / 2, -1, num(v, 'h') + 2)) }],
  },
  {
    id: 'boulon',
    name: 'Boulon complet',
    category: 'Visserie',
    description: 'Vis H + rondelle + écrou, serrage réglable (3 solides)',
    icon: 'part-bolt',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 10, min: 1, unit: 'mm' },
      { key: 'L', label: 'Longueur de vis L', value: 40, min: 1, unit: 'mm' },
      { key: 'serrage', label: 'Épaisseur serrée', value: 20, min: 0, unit: 'mm' },
      { key: 's', label: 'Ouverture de clé s', value: 16, min: 1, unit: 'mm' },
      { key: 'k', label: 'Hauteur de tête k', value: 6.4, min: 0.1, unit: 'mm' },
      { key: 'm', label: 'Hauteur d’écrou m', value: 8.4, min: 0.1, unit: 'mm' },
      { key: 'd2', label: 'Ø de rondelle', value: 20, min: 0.2, unit: 'mm' },
      { key: 'h', label: 'Épaisseur de rondelle', value: 2, min: 0.05, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1.5, min: 0.2, step: 0.05, unit: 'mm' },
      THREAD,
    ],
    applySize: isoSize((i, d) => ({ d, s: i.s, k: i.k, m: i.m, d2: i.d2, h: i.h, p: i.p })),
    title: (v) => `Boulon ${v.size ?? `M${v.d}`}×${v.L}`,
    preview: (v) => [...prismOutline(hexR(num(v, 's')), 0, num(v, 'k'), 6, Math.PI / 6), ...prismOutline(num(v, 'd') / 2, -num(v, 'L'), 0, 24)],
    build: async (k, v) => {
      const d = num(v, 'd'), L = num(v, 'L'), clamp = num(v, 'serrage'), h = num(v, 'h'), m = num(v, 'm'), p = num(v, 'p');
      const reel = v.thread === 'reel';
      const tige = await shank(k, v, d, p, -L, L + 0.01 * p, { bottom: true });
      const vis = await (reel ? unionExact : union)(k, await hexPrism(k, num(v, 's'), 0, num(v, 'k')), tige);
      const zw = -clamp - h;
      const washer = await subtract(k, await cyl(k, num(v, 'd2') / 2, zw, h), await cyl(k, (d * 1.05) / 2, zw - 1, h + 2));
      let nut: SolidResult;
      if (reel) {
        // écrou taraudé construit à l'origine comme l'écrou seul (cas éprouvé du noyau), puis
        // posé et tourné pour que son filet prolonge celui de la vis (hélice de départ -L - p)
        const body = await hexPrism(k, num(v, 's'), 0, m);
        const local = await subtractExact(k, body, await threadedRod(k, d, p, -p, m + 2 * p, false));
        const tz = zw - m, a = TAU * ((((tz + L) / p) % 1) + 1);
        const c = Math.cos(a), sn = Math.sin(a);
        nut = await k({ op: 'transform', shapeId: local.shapeId, matrix: [c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1, tz] });
      } else {
        // stries de l'écrou calées sur celles de la vis (départ à -L, un multiple du pas)
        const zn = -L + Math.floor((zw - m - p + L) / p) * p;
        const hole = v.thread === 'cosmetique' ? await groovedRod(k, d, p, zn, zw + p - zn, -L) : await cyl(k, d / 2, zw - m - 1, m + 2);
        nut = await subtract(k, await hexPrism(k, num(v, 's'), zw - m, m), hole);
      }
      return [
        { result: vis, name: `Vis H M${d}×${L}` },
        { result: washer, name: `Rondelle M${d}` },
        { result: nut, name: `Écrou H M${d}` },
      ];
    },
  },
  {
    id: 'tige',
    name: 'Tige filetée',
    category: 'Visserie',
    description: 'DIN 976 — longueur au choix',
    icon: 'part-rod',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 8, min: 1, unit: 'mm' },
      { key: 'L', label: 'Longueur', value: 100, min: 1, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1.25, min: 0.2, step: 0.05, unit: 'mm' },
      THREAD,
      USAGE,
      JEU_EMPREINTE,
    ],
    applySize: isoSize((i, d) => ({ d, p: i.p })),
    title: (v) => usageTitle(v, `Tige filetée ${v.size ?? `M${v.d}`}×${v.L}`),
    preview: (v) => prismOutline(num(v, 'd') / 2, 0, num(v, 'L'), 24),
    build: async (k, v) => [{ result: await shank(k, v, num(v, 'd'), num(v, 'p'), -extra(v), num(v, 'L') + 2 * extra(v), { bottom: extra(v) === 0, top: extra(v) === 0 }, extra(v)) }],
  },
  {
    id: 'calib-filetage',
    name: 'Plaquette de calibration (filetage, trous)',
    category: 'Visserie',
    description: 'Trous taraudés à jeux croissants (points gravés) et trous lisses Ø4 à Ø12 : trouve le jeu et la compensation de votre imprimante',
    icon: 'part-plate',
    sizes: SIZES,
    params: [
      { key: 'd', label: 'Diamètre nominal d', value: 8, min: 2, unit: 'mm' },
      { key: 'p', label: 'Pas', value: 1.25, min: 0.2, step: 0.05, unit: 'mm' },
      { key: 'n', label: 'Nombre de trous taraudés', value: 5, min: 1, step: 1 },
      { key: 'j0', label: 'Premier jeu par côté', value: 0.1, min: 0, step: 0.05, unit: 'mm', help: 'Jeu du premier trou taraudé (1 point gravé). Le jeu s’ajoute de chaque côté du trou, sur les flancs du filet : 0,1 mm = 0,2 mm de plus sur le diamètre.' },
      { key: 'dj', label: 'Écart entre deux jeux', value: 0.05, min: 0.01, step: 0.01, unit: 'mm', help: 'Chaque trou suivant (un point gravé de plus) a ce jeu en plus. Avec 0,1 et 0,05 : 0,10 / 0,15 / 0,20 / 0,25 / 0,30 mm par côté.' },
      { key: 'e', label: 'Épaisseur', value: 8, min: 1, unit: 'mm' },
      {
        key: 'lisses',
        label: 'Trous lisses',
        value: 'oui',
        options: [
          { value: 'oui', label: 'Oui : Ø4, 6, 8, 10 et 12 (à mesurer)' },
          { value: 'non', label: 'Non' },
        ],
      },
    ],
    applySize: isoSize((i, d) => ({ d, p: i.p })),
    realThread: (v) => v.thread !== 'cosmetique',
    title: (v) => `Calibration filetage ${v.size ?? `M${v.d}`}`,
    preview: (v) => {
      const c = calibLayout(v);
      return rectOutline(-c.W / 2, c.yBot, c.W / 2, c.yTop, 0, num(v, 'e'));
    },
    note: (v) => {
      const c = calibLayout(v);
      return (
        `Jeux par côté, de gauche à droite (1 à ${c.gaps.length} point(s) gravé(s)) : ${c.gaps.map((g) => String(g).replace('.', ',')).join(' ; ')} mm` +
        `${c.capped ? ` (plafonnés à ${String(maxThreadGap(num(v, 'p'))).replace('.', ',')} mm pour ce pas)` : ''}. ` +
        'Imprimez aussi une vis de la bibliothèque (usage « Pièce »), essayez-la dans chaque trou et reportez le jeu du trou qui visse sans forcer dans « Jeu d’impression par côté ».' +
        (c.plain.length ? ` Trous lisses : mesurez-les ; compensation des trous = Ø nominal − Ø mesuré (OPTIONS).` : '')
      );
    },
    build: async (k, v) => {
      const c = calibLayout(v);
      const d = num(v, 'd'), p = num(v, 'p'), e = num(v, 'e');
      const real = v.thread !== 'cosmetique';
      let plate = await k({ op: 'box', corner: P(-c.W / 2, c.yBot, 0), size: P(c.W, c.yTop - c.yBot, e) });
      // repères : i + 1 points gravés au-dessus du trou i, trous lisses en bas
      const marks: SolidResult[] = [];
      for (let i = 0; i < c.xs.length; i++)
        for (let n = 0; n <= i; n++) marks.push(await k({ op: 'cylinder', center: P(c.xs[i]! + (n - i / 2) * 1.4, d / 2 + 2.2, e - 0.6), radius: 0.45, height: 1.6 }));
      for (const h of c.plain) marks.push(await k({ op: 'cylinder', center: P(h.x, c.yPlain, -1), radius: h.d / 2, height: e + 2 }));
      plate = await subtract(k, plate, ...marks);
      const tools: SolidResult[] = [];
      for (let i = 0; i < c.xs.length; i++) {
        const g = c.gaps[i]!;
        const local = real ? await threadedRod(k, d, p, -p, e + 2 * p, false, g) : await groovedRod(k, d + 2 * g, p, -p, e + 2 * p);
        tools.push(await k({ op: 'transform', shapeId: local.shapeId, matrix: [1, 0, 0, c.xs[i]!, 0, 1, 0, 0, 0, 0, 1, 0] }));
      }
      return [{ result: await (real ? subtractExact : subtract)(k, plate, ...tools) }];
    },
  },
  {
    id: 'tube',
    name: 'Tube rond',
    category: 'Tubes et profilés',
    description: 'Ø extérieur, épaisseur, longueur',
    icon: 'part-tube',
    params: [
      { key: 'D', label: 'Ø extérieur', value: 40, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 2, min: 0.05, unit: 'mm' },
      { key: 'L', label: 'Longueur', value: 200, min: 0.1, unit: 'mm' },
    ],
    title: (v) => `Tube Ø${v.D}×${v.e}`,
    preview: (v) => [...prismOutline(num(v, 'D') / 2, 0, num(v, 'L')), ...prismOutline(num(v, 'D') / 2 - num(v, 'e'), 0, num(v, 'L'))],
    build: async (k, v) => {
      const D = num(v, 'D'), e = num(v, 'e'), L = num(v, 'L');
      if (2 * e >= D) throw new Error('L’épaisseur doit être inférieure au rayon.');
      return [{ result: await subtract(k, await cyl(k, D / 2, 0, L), await cyl(k, D / 2 - e, -1, L + 2)) }];
    },
  },
  {
    id: 'tube-rect',
    name: 'Tube carré / rectangulaire',
    category: 'Tubes et profilés',
    description: 'Section L × l, épaisseur, rayon extérieur',
    icon: 'part-rect-tube',
    params: [
      { key: 'A', label: 'Largeur', value: 40, min: 0.2, unit: 'mm' },
      { key: 'B', label: 'Hauteur', value: 40, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 2, min: 0.05, unit: 'mm' },
      { key: 'r', label: 'Rayon extérieur', value: 4, min: 0, unit: 'mm' },
      { key: 'L', label: 'Longueur', value: 200, min: 0.1, unit: 'mm' },
    ],
    title: (v) => `Tube ${v.A}×${v.B}×${v.e}`,
    preview: (v) => rectOutline(-num(v, 'A') / 2, -num(v, 'B') / 2, num(v, 'A') / 2, num(v, 'B') / 2, 0, num(v, 'L')),
    build: async (k, v) => {
      const A = num(v, 'A'), B = num(v, 'B'), e = num(v, 'e'), r = num(v, 'r'), L = num(v, 'L');
      if (2 * e >= Math.min(A, B)) throw new Error('L’épaisseur est trop grande pour la section.');
      const out = await extrude(k, roundedRect(A, B, r, 0), L);
      const inner = await k({ op: 'extrude', profile: roundedRect(A - 2 * e, B - 2 * e, Math.max(0, r - e), -1), height: L + 2, taperDeg: 0 });
      return [{ result: await subtract(k, out, inner) }];
    },
  },
  {
    id: 'coude',
    name: 'Coude de tube',
    category: 'Tubes et profilés',
    description: 'Ø, épaisseur, rayon de cintrage, angle',
    icon: 'part-elbow',
    params: [
      { key: 'D', label: 'Ø extérieur', value: 40, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 2, min: 0.05, unit: 'mm' },
      { key: 'R', label: 'Rayon de cintrage (axe)', value: 60, min: 0.2, unit: 'mm' },
      { key: 'a', label: 'Angle', value: 90, min: 1, unit: '°' },
    ],
    title: (v) => `Coude Ø${v.D} ${v.a}° R${v.R}`,
    preview: (v) => {
      const R = num(v, 'R'), a = (num(v, 'a') * Math.PI) / 180, r = num(v, 'D') / 2;
      const arc = (rr: number) => Array.from({ length: 33 }, (_, i) => P(-R + rr * Math.cos((a * i) / 32), 0, rr * Math.sin((a * i) / 32)));
      return [arc(R), arc(R - r), arc(R + r), ring(r, 0)];
    },
    build: async (k, v) => {
      const D = num(v, 'D'), e = num(v, 'e'), R = num(v, 'R'), a = num(v, 'a');
      if (2 * e >= D) throw new Error('L’épaisseur doit être inférieure au rayon.');
      if (R <= D / 2) throw new Error('Le rayon de cintrage doit dépasser le rayon du tube.');
      // cercle dans le plan XY centré sur (0,0) ; axe de révolution parallèle à Y passant par (−R,0)
      const rev = (r: number) =>
        k({ op: 'revolve', profile: { kind: 'circle', center: P(0, 0), radius: r }, axisStart: P(-R, 0, 0), axisEnd: P(-R, -1, 0), angleDeg: Math.min(360, a), startDeg: 0 });
      return [{ result: await subtract(k, await rev(D / 2), await rev(D / 2 - e)) }];
    },
  },
  {
    id: 'corniere',
    name: 'Cornière (L)',
    category: 'Tubes et profilés',
    description: 'Ailes A × B, épaisseur, longueur',
    icon: 'part-angle',
    params: [
      { key: 'A', label: 'Aile A', value: 40, min: 0.2, unit: 'mm' },
      { key: 'B', label: 'Aile B', value: 40, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 4, min: 0.05, unit: 'mm' },
      { key: 'L', label: 'Longueur', value: 200, min: 0.1, unit: 'mm' },
    ],
    title: (v) => `Cornière ${v.A}×${v.B}×${v.e}`,
    preview: (v) => rectOutline(0, 0, num(v, 'A'), num(v, 'B'), 0, num(v, 'L')),
    build: async (k, v) => {
      const A = num(v, 'A'), B = num(v, 'B'), e = num(v, 'e');
      if (e >= Math.min(A, B)) throw new Error('L’épaisseur est trop grande.');
      const profile: ProfileDef = { kind: 'poly', points: [P(0, 0), P(A, 0), P(A, e), P(e, e), P(e, B), P(0, B)], closed: true };
      return [{ result: await extrude(k, profile, num(v, 'L')) }];
    },
  },
  {
    id: 'fer-u',
    name: 'Profilé en U',
    category: 'Tubes et profilés',
    description: 'Largeur, hauteur des ailes, épaisseur, longueur',
    icon: 'part-channel',
    params: [
      { key: 'A', label: 'Largeur (âme)', value: 50, min: 0.2, unit: 'mm' },
      { key: 'B', label: 'Hauteur des ailes', value: 25, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 3, min: 0.05, unit: 'mm' },
      { key: 'L', label: 'Longueur', value: 200, min: 0.1, unit: 'mm' },
    ],
    title: (v) => `U ${v.A}×${v.B}×${v.e}`,
    preview: (v) => rectOutline(-num(v, 'A') / 2, 0, num(v, 'A') / 2, num(v, 'B'), 0, num(v, 'L')),
    build: async (k, v) => {
      const A = num(v, 'A'), B = num(v, 'B'), e = num(v, 'e');
      if (2 * e >= A || e >= B) throw new Error('L’épaisseur est trop grande.');
      const x = A / 2;
      const profile: ProfileDef = { kind: 'poly', points: [P(-x, 0), P(x, 0), P(x, B), P(x - e, B), P(x - e, e), P(-x + e, e), P(-x + e, B), P(-x, B)], closed: true };
      return [{ result: await extrude(k, profile, num(v, 'L')) }];
    },
  },
  {
    id: 'boite',
    name: 'Boîte creuse',
    category: 'Formes',
    description: 'Ouverte en haut, parois et fond d’épaisseur réglable, angles arrondis',
    icon: 'part-box',
    params: [
      { key: 'L', label: 'Longueur (X)', value: 100, min: 0.2, unit: 'mm' },
      { key: 'l', label: 'Largeur (Y)', value: 60, min: 0.2, unit: 'mm' },
      { key: 'H', label: 'Hauteur (Z)', value: 40, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des parois', value: 2, min: 0.05, unit: 'mm' },
      { key: 'f', label: 'Épaisseur du fond', value: 2, min: 0.05, unit: 'mm' },
      { key: 'r', label: 'Rayon des angles', value: 5, min: 0, unit: 'mm' },
      {
        key: 'lid',
        label: 'Couvercle',
        value: 'non',
        options: [
          { value: 'non', label: 'Sans couvercle' },
          { value: 'oui', label: 'Avec couvercle emboîtant (à côté)' },
        ],
      },
    ],
    title: (v) => `Boîte ${v.L}×${v.l}×${v.H}`,
    preview: (v) => rectOutline(-num(v, 'L') / 2, -num(v, 'l') / 2, num(v, 'L') / 2, num(v, 'l') / 2, 0, num(v, 'H')),
    build: async (k, v) => {
      const L = num(v, 'L'), l = num(v, 'l'), H = num(v, 'H'), e = num(v, 'e'), f = num(v, 'f'), r = num(v, 'r');
      if (2 * e >= Math.min(L, l) || f >= H) throw new Error('Les épaisseurs sont trop grandes pour la boîte.');
      const outer = await extrude(k, roundedRect(L, l, r, 0), H);
      const inner = await extrude(k, roundedRect(L - 2 * e, l - 2 * e, Math.max(0, r - e), f), H);
      const out: { result: SolidResult; name?: string }[] = [{ result: await subtract(k, outer, inner), name: `Boîte ${L}×${l}×${H}` }];
      if (v.lid === 'oui') {
        // couvercle posé à côté : plaque + lèvre qui entre dans la boîte (jeu 0,2 mm)
        const gap = 0.2, lip = Math.min(H / 4, 5);
        const dx = L + 10;
        const plate = await k({ op: 'extrude', profile: roundedRect(L, l, r, 0), height: f, taperDeg: 0 });
        const rim = await subtract(
          k,
          await k({ op: 'extrude', profile: roundedRect(L - 2 * e - 2 * gap, l - 2 * e - 2 * gap, Math.max(0, r - e - gap), f), height: lip, taperDeg: 0 }),
          await k({ op: 'extrude', profile: roundedRect(L - 4 * e - 2 * gap, l - 4 * e - 2 * gap, Math.max(0, r - 2 * e - gap), f - 0.01), height: lip + 1, taperDeg: 0 }),
        );
        const lid = await k({ op: 'transform', shapeId: (await union(k, plate, rim)).shapeId, matrix: [1, 0, 0, dx, 0, 1, 0, 0, 0, 0, 1, 0] });
        out.push({ result: lid, name: `Couvercle ${L}×${l}` });
      }
      return out;
    },
  },
  {
    id: 'plaque',
    name: 'Plaque percée',
    category: 'Formes',
    description: '4 trous aux coins, angles arrondis',
    icon: 'part-plate',
    params: [
      { key: 'L', label: 'Longueur (X)', value: 100, min: 0.2, unit: 'mm' },
      { key: 'l', label: 'Largeur (Y)', value: 60, min: 0.2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 5, min: 0.05, unit: 'mm' },
      { key: 'dt', hole: true, label: 'Ø des trous', value: 6.5, min: 0, unit: 'mm' },
      { key: 'm', label: 'Entraxe au bord', value: 10, min: 0, unit: 'mm' },
      { key: 'r', label: 'Rayon des angles', value: 5, min: 0, unit: 'mm' },
    ],
    title: (v) => `Plaque ${v.L}×${v.l}×${v.e}`,
    preview: (v) => rectOutline(-num(v, 'L') / 2, -num(v, 'l') / 2, num(v, 'L') / 2, num(v, 'l') / 2, 0, num(v, 'e')),
    build: async (k, v) => {
      const L = num(v, 'L'), l = num(v, 'l'), e = num(v, 'e'), dt = num(v, 'dt'), m = num(v, 'm');
      let plate = await extrude(k, roundedRect(L, l, num(v, 'r'), 0), e);
      if (dt > 0) {
        const holes = await Promise.all(
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map(([sx, sy]) => k({ op: 'cylinder', center: P(sx! * (L / 2 - m), sy! * (l / 2 - m), -1), radius: dt / 2, height: e + 2 })),
        );
        plate = await subtract(k, plate, ...holes);
      }
      return [{ result: plate }];
    },
  },
  {
    id: 'entretoise',
    name: 'Entretoise / bague',
    category: 'Formes',
    description: 'Ø extérieur, Ø intérieur, hauteur',
    icon: 'part-washer',
    params: [
      { key: 'D', label: 'Ø extérieur', value: 12, min: 0.2, unit: 'mm' },
      { key: 'd', hole: true, label: 'Ø intérieur', value: 6.5, min: 0, unit: 'mm' },
      { key: 'H', label: 'Hauteur', value: 10, min: 0.05, unit: 'mm' },
    ],
    title: (v) => `Entretoise Ø${v.D}×${v.H}`,
    preview: (v) => [...prismOutline(num(v, 'D') / 2, 0, num(v, 'H')), ...prismOutline(num(v, 'd') / 2, 0, num(v, 'H'))],
    build: async (k, v) => {
      const body = await cyl(k, num(v, 'D') / 2, 0, num(v, 'H'));
      return [{ result: num(v, 'd') > 0 ? await subtract(k, body, await cyl(k, num(v, 'd') / 2, -1, num(v, 'H') + 2)) : body }];
    },
  },

  {
    id: 'charniere-lames',
    name: 'Charnière à lames (à goupille)',
    category: 'Charnières',
    description: 'Deux lames à charnons alternés + axe séparé (3 solides), trous de vis',
    icon: 'part-hinge',
    params: [
      { key: 'L', label: 'Longueur (axe)', value: 60, min: 2, unit: 'mm' },
      { key: 'W', label: 'Largeur d’une lame', value: 22, min: 1, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des lames', value: 2.5, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'D', label: 'Ø des charnons', value: 8, min: 0.5, unit: 'mm' },
      { key: 'n', label: 'Nombre de charnons', value: 5, min: 2, step: 1 },
      { key: 'dp', label: 'Ø de l’axe (goupille)', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'jeu', label: 'Jeu radial', value: 0.1, min: 0, step: 0.05, unit: 'mm', help: 'Espace entre l’axe et l’alésage des charnons, de chaque côté (radial) : 0,1 mm = 0,2 mm de plus sur le diamètre. Il permet à la charnière de tourner ; plus grand pour une impression assemblée.' },
      { key: 'ga', help: 'Espace entre deux charnons voisins (le long de l’axe), pour qu’ils ne se soudent pas à l’impression et tournent librement.', label: 'Jeu entre charnons', value: 0.3, min: 0, step: 0.05, unit: 'mm' },
      { key: 'nt', label: 'Trous par lame', value: 3, min: 0, step: 1 },
      { key: 'dt', hole: true, label: 'Ø des trous', value: 3.5, min: 0, step: 0.1, unit: 'mm' },
      SCREW_HEAD,
      HINGE_ANGLE,
    ],
    title: (v) => `Charnière ${v.L}×${2 * num(v, 'W')}`,
    preview: (v) => knucklePreview(num(v, 'L'), num(v, 'W'), num(v, 'e'), num(v, 'D') / 2),
    build: (k, v) => knuckleHinge(k, hingeOpts(v, 'pin', num(v, 'n'))),
  },
  {
    id: 'charniere-piano',
    name: 'Charnière à piano',
    category: 'Charnières',
    description: 'Charnière continue, charnons courts au pas réglable, axe séparé (3 solides)',
    icon: 'part-piano',
    params: [
      { key: 'L', label: 'Longueur', value: 200, min: 5, unit: 'mm' },
      { key: 'W', label: 'Largeur d’une lame', value: 16, min: 1, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des lames', value: 1.2, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'D', label: 'Ø des charnons', value: 4, min: 0.5, step: 0.1, unit: 'mm' },
      { key: 'pas', label: 'Longueur d’un charnon', value: 10, min: 1, unit: 'mm' },
      { key: 'dp', label: 'Ø de l’axe', value: 1.6, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'jeu', label: 'Jeu radial', value: 0.1, min: 0, step: 0.05, unit: 'mm', help: 'Espace entre l’axe et l’alésage des charnons, de chaque côté (radial) : 0,1 mm = 0,2 mm de plus sur le diamètre. Il permet à la charnière de tourner ; plus grand pour une impression assemblée.' },
      { key: 'ga', help: 'Espace entre deux charnons voisins (le long de l’axe), pour qu’ils ne se soudent pas à l’impression et tournent librement.', label: 'Jeu entre charnons', value: 0.2, min: 0, step: 0.05, unit: 'mm' },
      { key: 'nt', label: 'Trous par lame', value: 5, min: 0, step: 1 },
      { key: 'dt', hole: true, label: 'Ø des trous', value: 3, min: 0, step: 0.1, unit: 'mm' },
      SCREW_HEAD,
      HINGE_ANGLE,
    ],
    title: (v) => `Charnière piano ${v.L}×${2 * num(v, 'W')}`,
    preview: (v) => knucklePreview(num(v, 'L'), num(v, 'W'), num(v, 'e'), num(v, 'D') / 2),
    build: (k, v) => knuckleHinge(k, hingeOpts(v, 'pin', Math.max(2, Math.round(num(v, 'L') / num(v, 'pas'))))),
  },
  {
    id: 'charniere-pip',
    name: 'Charnière imprimable assemblée',
    category: 'Charnières',
    description: 'Print-in-place : axe intégré à une lame, jeu réglable, s’imprime à plat déjà montée (2 solides)',
    icon: 'part-pip',
    params: [
      { key: 'L', label: 'Longueur (axe)', value: 50, min: 2, unit: 'mm' },
      { key: 'W', label: 'Largeur d’une lame', value: 20, min: 1, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des lames', value: 3, min: 0.4, step: 0.1, unit: 'mm' },
      { key: 'D', label: 'Ø des charnons', value: 8, min: 1, unit: 'mm' },
      { key: 'n', label: 'Nombre de charnons', value: 5, min: 2, step: 1 },
      { key: 'dp', label: 'Ø de l’axe intégré', value: 4, min: 0.4, step: 0.1, unit: 'mm' },
      { key: 'jeu', label: 'Jeu d’impression (radial)', value: 0.35, min: 0.1, step: 0.05, unit: 'mm', help: 'Charnière imprimée déjà montée : espace entre l’axe et les charnons, de chaque côté (radial). 0,35 mm = 0,7 mm de plus sur le diamètre ; trop petit, les pièces se soudent.' },
      { key: 'ga', help: 'Espace entre deux charnons voisins (le long de l’axe), pour qu’ils ne se soudent pas à l’impression et tournent librement.', label: 'Jeu entre charnons', value: 0.4, min: 0.1, step: 0.05, unit: 'mm' },
      { key: 'nt', label: 'Trous par lame', value: 2, min: 0, step: 1 },
      { key: 'dt', hole: true, label: 'Ø des trous', value: 3.2, min: 0, step: 0.1, unit: 'mm' },
      SCREW_HEAD,
    ],
    title: (v) => `Charnière imprimable ${v.L}×${2 * num(v, 'W')}`,
    preview: (v) => knucklePreview(num(v, 'L'), num(v, 'W'), num(v, 'e'), num(v, 'D') / 2),
    build: (k, v) => knuckleHinge(k, { ...hingeOpts(v, 'pip', num(v, 'n')), angle: 180 }),
  },
  {
    id: 'paumelle',
    name: 'Paumelle (dégondable)',
    category: 'Charnières',
    description: 'Charnière de porte : partie mâle à axe fixe et partie femelle qui s’y emboîte (2 solides)',
    icon: 'part-paumelle',
    params: [
      { key: 'H', label: 'Hauteur totale', value: 80, min: 4, unit: 'mm' },
      { key: 'D', label: 'Ø du nœud', value: 12, min: 1, unit: 'mm' },
      { key: 'W', label: 'Largeur d’une lame', value: 30, min: 1, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des lames', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'dp', label: 'Ø de l’axe', value: 5, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'jeu', label: 'Jeu radial', value: 0.2, min: 0, step: 0.05, unit: 'mm', help: 'Espace entre l’axe et l’alésage des charnons, de chaque côté (radial) : 0,2 mm = 0,4 mm de plus sur le diamètre. Il permet à la charnière de tourner ; plus grand pour une impression assemblée.' },
      { key: 'g', label: 'Jeu entre nœuds', value: 1, min: 0, step: 0.1, unit: 'mm', help: 'Espace entre les nœuds des deux lames (le long de l’axe), pour pouvoir dégonder et tourner sans frottement.' },
      { key: 'nt', label: 'Trous par lame', value: 2, min: 0, step: 1 },
      { key: 'dt', hole: true, label: 'Ø des trous', value: 4.5, min: 0, step: 0.1, unit: 'mm' },
      { key: 'a', label: 'Ouverture', value: 180, min: 0, unit: '°' },
    ],
    title: (v) => `Paumelle ${v.H} Ø${v.D}`,
    preview: (v) => {
      const H = num(v, 'H'), W = num(v, 'W'), e = num(v, 'e'), R = num(v, 'D') / 2;
      return [...prismOutline(R, 0, H, 32), ...rectOutline(-W, -e / 2, W, e / 2, 0, H)];
    },
    build: async (k, v) => {
      const H = num(v, 'H'), R = num(v, 'D') / 2, W = num(v, 'W'), e = num(v, 'e'), rp = num(v, 'dp') / 2, jeu = num(v, 'jeu'), g = num(v, 'g');
      const nh = Math.max(0, Math.round(num(v, 'nt'))), dt = num(v, 'dt');
      if (e > 2 * R) throw new Error('Les lames sont plus épaisses que le nœud.');
      if (W <= R + 1) throw new Error('Les lames sont trop étroites.');
      if (rp + jeu > R - 0.5) throw new Error('L’axe est trop gros pour le nœud (paroi < 0,5 mm).');
      const h1 = (H - g) / 2;
      if (h1 < 1) throw new Error('Hauteur trop faible.');
      const cap = Math.min(3, h1 / 3); // fond de la femelle au-dessus de l'axe
      const holes = async (sign: -1 | 1, z0: number) => {
        const out: SolidResult[] = [];
        if (!nh || dt <= 0) return out;
        if (dt / 2 > (W - R) / 2 - 0.4 || dt / 2 > h1 / (2 * nh)) throw new Error('Les trous de vis débordent des lames.');
        const x = sign * (R + (W - R) / 2);
        for (let j = 0; j < nh; j++)
          out.push(await k({ op: 'cylinder', center: P(x, -e / 2 - 1, z0 + (h1 * (j + 0.5)) / nh), radius: dt / 2, height: e + 2, axis: P(0, 1, 0) }));
        return out;
      };
      // partie mâle (en bas, lame côté x < 0) : nœud + axe dépassant dans la femelle
      const male = await subtract(
        k,
        await union(k, await cyl(k, R, 0, h1), await box(k, -W, -e / 2, 0, 0, e / 2, h1), await cyl(k, rp, 0, H - cap - jeu)),
        ...(await holes(-1, 0)),
      );
      // partie femelle (en haut, lame côté x > 0) : nœud percé en aveugle
      const z1 = h1 + g;
      let female = await subtract(
        k,
        await union(k, await cyl(k, R, z1, H - z1), await box(k, 0, -e / 2, z1, W, e / 2, H)),
        await cyl(k, rp + jeu, z1 - 1, H - cap - z1 + 1),
        ...(await holes(1, z1)),
      );
      const a = num(v, 'a');
      if (a !== 180) female = await k({ op: 'transform', shapeId: female.shapeId, matrix: rotZ(a - 180) });
      return [
        { result: male, name: 'Paumelle mâle' },
        { result: female, name: 'Paumelle femelle' },
      ];
    },
  },
  {
    id: 'charniere-film',
    name: 'Charnière à film (living hinge)',
    category: 'Charnières',
    description: 'Deux plaques reliées par une bande mince souple (PP, PETG, TPU), un seul solide',
    icon: 'part-living',
    params: [
      { key: 'L', label: 'Longueur totale (X)', value: 60, min: 1, unit: 'mm' },
      { key: 'B', label: 'Largeur (Y)', value: 20, min: 0.5, unit: 'mm' },
      { key: 'e', label: 'Épaisseur des plaques', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 't', label: 'Épaisseur du film', value: 0.5, min: 0.1, step: 0.05, unit: 'mm' },
      { key: 'w', label: 'Longueur du film', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'c', label: 'Longueur des transitions', value: 1.5, min: 0, step: 0.1, unit: 'mm' },
    ],
    title: (v) => `Charnière à film ${v.L}×${v.B}`,
    preview: (v) => rectOutline(-num(v, 'L') / 2, -num(v, 'B') / 2, num(v, 'L') / 2, num(v, 'B') / 2, 0, num(v, 'e')),
    build: async (k, v) => {
      const L = num(v, 'L'), B = num(v, 'B'), e = num(v, 'e'), t = num(v, 't'), w = num(v, 'w'), c = num(v, 'c');
      if (t >= e) throw new Error('Le film doit être plus mince que les plaques.');
      if (w + 2 * c >= L - 1) throw new Error('Le film et ses transitions sont plus longs que la pièce.');
      // section dans le plan XY (y = épaisseur), film en bas (côté plateau d'impression)
      const x = L / 2, h = w / 2;
      const pts = [P(-x, 0), P(x, 0), P(x, e), P(h + c, e), P(h, t), P(-h, t), P(-h - c, e), P(-x, e)];
      const profile: ProfileDef = { kind: 'poly', points: c > 1e-9 ? pts : [P(-x, 0), P(x, 0), P(x, e), P(h, e), P(h, t), P(-h, t), P(-h, e), P(-x, e)], closed: true };
      const raw = await extrude(k, profile, B);
      // y → z (épaisseur verticale), largeur centrée sur Y
      return [{ result: await k({ op: 'transform', shapeId: raw.shapeId, matrix: [1, 0, 0, 0, 0, 0, -1, B / 2, 0, 1, 0, 0] }) }];
    },
  },
  {
    id: 'charniere-fentes',
    name: 'Charnière flexible à fentes',
    category: 'Charnières',
    description: 'Plaque à motif de fentes décalées (kerf / lattice hinge) qui se cintre, un seul solide',
    icon: 'part-kerf',
    params: [
      { key: 'L', label: 'Longueur (X)', value: 100, min: 2, unit: 'mm' },
      { key: 'B', label: 'Largeur (Y)', value: 40, min: 2, unit: 'mm' },
      { key: 'e', label: 'Épaisseur', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
      { key: 'z', label: 'Longueur de la zone souple', value: 40, min: 1, unit: 'mm' },
      { key: 'p', label: 'Pas des fentes', value: 2.5, min: 0.3, step: 0.1, unit: 'mm' },
      { key: 's', label: 'Largeur d’une fente', value: 0.8, min: 0.1, step: 0.05, unit: 'mm' },
      { key: 'b', label: 'Largeur des ponts', value: 3, min: 0.2, step: 0.1, unit: 'mm' },
    ],
    title: (v) => `Charnière à fentes ${v.L}×${v.B}`,
    preview: (v) => {
      const L = num(v, 'L'), B = num(v, 'B'), Z = num(v, 'z');
      return [...rectOutline(-L / 2, -B / 2, L / 2, B / 2, 0, num(v, 'e')), ...rectOutline(-Z / 2, -B / 2, Z / 2, B / 2, 0, num(v, 'e'))];
    },
    build: async (k, v) => {
      const L = num(v, 'L'), B = num(v, 'B'), e = num(v, 'e'), Z = num(v, 'z'), p = num(v, 'p'), sw = num(v, 's'), br = num(v, 'b');
      if (Z > L - 2) throw new Error('La zone souple est plus longue que la plaque.');
      if (sw >= p * 0.8) throw new Error('Les fentes sont trop larges pour leur pas.');
      if (2 * br >= B - 1) throw new Error('Les ponts sont trop larges pour la plaque.');
      const rows = Math.max(1, Math.floor(Z / p));
      if (rows > 200) throw new Error('Trop de fentes (200 au plus) : augmentez le pas.');
      const plate = await box(k, -L / 2, -B / 2, 0, L / 2, B / 2, e);
      const slots: SolidResult[] = [];
      const x0 = -((rows - 1) * p) / 2;
      for (let i = 0; i < rows; i++) {
        const x = x0 + i * p;
        if (i % 2 === 0) slots.push(await box(k, x - sw / 2, -B / 2 + br, -1, x + sw / 2, B / 2 - br, e + 1));
        else {
          // rangée décalée : deux fentes ouvertes sur les bords, pont au centre
          slots.push(await box(k, x - sw / 2, -B / 2 - 1, -1, x + sw / 2, -br / 2, e + 1));
          slots.push(await box(k, x - sw / 2, br / 2, -1, x + sw / 2, B / 2 + 1, e + 1));
        }
      }
      return [{ result: await subtract(k, plate, ...slots) }];
    },
  },
  ...PLUMBING,
];

export const partById = (id: string) => PARTS.find((p) => p.id === id);

/** Valeurs par défaut d'une pièce (taille normalisée par défaut appliquée). */
export function defaultValues(def: PartDef): PartValues {
  let v: PartValues = Object.fromEntries(def.params.map((p) => [p.key, p.value]));
  if (def.sizes && def.applySize) {
    const d = Number(v.d);
    const size = def.defaultSize ?? def.sizes.find((s) => dia(s) === d) ?? 'M8';
    v = def.applySize(size, v);
  }
  return v;
}

export type PartAxis = 'Z' | 'X' | 'Y';

/** Repère local (axe Z) → monde : axe choisi et point d'insertion. */
export function partMatrix(axis: PartAxis, at: Vec3): Affine {
  if (axis === 'X') return [0, 0, 1, at.x, 0, 1, 0, at.y, -1, 0, 0, at.z];
  if (axis === 'Y') return [1, 0, 0, at.x, 0, 0, 1, at.y, 0, -1, 0, at.z];
  return [1, 0, 0, at.x, 0, 1, 0, at.y, 0, 0, 1, at.z];
}

export function applyMatrix(m: Affine, p: Vec3): Vec3 {
  return { x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3], y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7], z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11] };
}

/**
 * Noyau « étapes intermédiaires » : chaque requête est faite sans maillage d'affichage
 * (`lazy`) et les formes créées sont notées pour être libérées une fois la pièce posée.
 */
export function stagedKernel(k: Kernel): { kernel: Kernel; created: string[] } {
  const created: string[] = [];
  const kernel: Kernel = async (req) => {
    const r = await k({ ...req, lazy: true });
    created.push(r.shapeId);
    return r;
  };
  return { kernel, created };
}

/** La pièce, avec ces valeurs, porte-t-elle un filetage réel (hélice) ? */
export const hasRealThread = (def: PartDef, v: PartValues): boolean => (def.realThread ? def.realThread(v) : v.thread === 'reel');

/** Valeurs de l'aperçu cosmétique d'une pièce à filetage réel. */
export const previewValues = (def: PartDef, v: PartValues): PartValues => (def.previewValues ? def.previewValues(v) : { ...v, thread: 'cosmetique' });

/** Valeurs avec les trous de passage agrandis de la compensation `comp` (Ø, mm). */
export function compensateHoles(def: PartDef, v: PartValues, comp: number): PartValues {
  if (!comp) return v;
  const out = { ...v };
  for (const p of def.params) if (p.hole && Number(out[p.key]) > 0) out[p.key] = Math.round((Number(out[p.key]) + comp) * 1e6) / 1e6;
  return out;
}

/**
 * Construit une pièce posée par `matrix` (reconstruction depuis l'historique : étape « part »).
 * `real` = filetage exact ; sinon aperçu cosmétique. `index` : solide voulu (boulon : 0 à 2).
 */
export async function buildPart(k: Kernel, id: string, v: PartValues, index: number, matrix: Affine, real: boolean): Promise<SolidResult> {
  const def = partById(id);
  if (!def) throw new Error(`Pièce inconnue de la bibliothèque : ${id}`);
  const parts = await def.build(k, real || !hasRealThread(def, v) ? v : previewValues(def, v));
  const r = parts[index];
  if (!r) throw new Error('Pièce incomplète.');
  return k({ op: 'transform', shapeId: r.result.shapeId, matrix });
}

/**
 * Construit la pièce et l'ajoute au dessin ; renvoie les poignées créées.
 * Trous de passage : agrandis de la compensation des trous imprimés. Filetage réel : en mode
 * « réel à l'export », la pièce est construite en aperçu cosmétique (rapide) et garde dans son
 * historique de quoi construire le filet exact à l'export (ou par FILETAGEREEL).
 */
export async function insertPart(app: AppHost, ctx: CommandContext | undefined, def: PartDef, v0: PartValues, axis: PartAxis, at: Vec3): Promise<string[]> {
  const v = compensateHoles(def, v0, app.settings.holeComp ?? 0);
  const threaded = hasRealThread(def, v);
  const real = !threaded || app.settings.threadMode === 'always';
  const k: Kernel = (req) => app.solid(ctx, req);
  const staged = stagedKernel(k);
  let parts: { result: SolidResult; name?: string }[];
  try {
    parts = await def.build(staged.kernel, real ? v : previewValues(def, v));
  } catch (e) {
    void app.kernel.call({ op: 'release', shapeIds: staged.created }).catch(() => undefined);
    throw e;
  }
  const m = partMatrix(axis, at);
  // seule la forme posée est triangulée pour l'affichage
  const placed = await Promise.all(parts.map((p) => k({ op: 'transform', shapeId: p.result.shapeId, matrix: m })));
  void app.kernel.call({ op: 'release', shapeIds: staged.created }).catch(() => undefined);
  const handles: string[] = [];
  app.doc.transaction(`Pièce ${def.name}`, () => {
    placed.forEach((r, i) => {
      const name = parts[i]!.name ?? def.title(v0);
      // l'historique (pièce paramétrée) n'est gardé que pour les filetages réels
      const history = threaded ? [{ kind: 'part' as const, part: def.id, values: v, index: i, matrix: m, realThread: true, id: featureId(), name }] : undefined;
      const h = app.addSolid(r, name, undefined, ctx, history);
      if (threaded && real) app.doc.replaceEntity(h, { threadsReal: true });
      handles.push(h);
    });
  });
  if (threaded && !real) ctx?.print('Filetage réel : aperçu cosmétique pendant le dessin ; le filet exact sera calculé à l’export STL/3MF/STEP (ou tout de suite avec FILETAGEREEL).');
  const note = def.note?.(v);
  if (note) ctx?.print(note);
  return handles;
}
