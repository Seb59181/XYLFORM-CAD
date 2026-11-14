/**
 * Géométrie des entités 2D : discrétisation pour l'affichage et la sélection, points
 * d'accrochage, transformations, décalage, profils pour le noyau, mesures.
 * Tout est analytique ; la discrétisation ne sert qu'à l'écran.
 */
import type { Vec3 } from '../commands/types';
import type { Entity, NewEntity } from '../document/Document';
import type { ProfileDef } from '../../kernel/protocol';
import { add, angleXY, apply, applyVector, determinant, dist, len, lerp, norm, polar, scale, scaleFactor, sub, type Affine } from '../math/affine';
import { bulgeArc, bulgePoint, isArcBulge, polylineSamples } from './bulge';

const TAU = Math.PI * 2;

export const TYPE_LABEL: Record<Entity['type'], string> = {
  LINE: 'Ligne',
  CIRCLE: 'Cercle',
  ARC: 'Arc',
  POLYLINE: 'Polyligne',
  ELLIPSE: 'Ellipse',
  SPLINE: 'Spline',
  POINT: 'Point',
  HELIX: 'Hélice',
  HATCH: 'Hachures',
  TEXT: 'Texte',
  DIMENSION: 'Cote alignée',
  '3DSOLID': 'Solide 3D',
  UNDERLAY: 'Fond de plan',
};

/** Angle normalisé dans [0, 2π). */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Balayage d'un arc (toujours positif, sens trigonométrique). */
export function arcSweep(start: number, end: number): number {
  const s = normAngle(end - start);
  return s < 1e-12 ? TAU : s;
}

// ---------------------------------------------------------------------------
// Discrétisation
// ---------------------------------------------------------------------------

export function arcPoints(c: Vec3, r: number, start: number, sweep: number, segs?: number): Vec3[] {
  const n = segs ?? Math.max(8, Math.ceil((Math.abs(sweep) / TAU) * 128));
  return Array.from({ length: n + 1 }, (_, i) => polar(c, r, start + (sweep * i) / n));
}

export function ellipsePoints(c: Vec3, major: Vec3, ratio: number, n = 128, t0 = 0, t1 = TAU): Vec3[] {
  const minor = { x: -major.y * ratio, y: major.x * ratio, z: 0 };
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / n;
    return add(c, add(scale(major, Math.cos(t)), scale(minor, Math.sin(t))));
  });
}

/** Spline d'interpolation Catmull-Rom centripète (passe par tous les points). */
export function splinePoints(fit: Vec3[], closed: boolean, perSpan = 16): Vec3[] {
  if (fit.length < 2) return [...fit];
  if (fit.length === 2 && !closed) return [...fit];
  const pts = closed ? [fit[fit.length - 1]!, ...fit, fit[0]!, fit[1]!] : [mirrorPt(fit[1]!, fit[0]!), ...fit, mirrorPt(fit[fit.length - 2]!, fit[fit.length - 1]!)];
  const out: Vec3[] = [];
  const spans = closed ? fit.length : fit.length - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = pts[i]!, p1 = pts[i + 1]!, p2 = pts[i + 2]!, p3 = pts[i + 3]!;
    const t0 = 0;
    const t1 = t0 + Math.sqrt(dist(p0, p1)) || t0 + 1e-6;
    const t2 = t1 + Math.sqrt(dist(p1, p2)) || t1 + 1e-6;
    const t3 = t2 + Math.sqrt(dist(p2, p3)) || t2 + 1e-6;
    for (let j = 0; j < perSpan; j++) {
      const t = t1 + ((t2 - t1) * j) / perSpan;
      const a1 = lerp2(p0, p1, t0, t1, t), a2 = lerp2(p1, p2, t1, t2, t), a3 = lerp2(p2, p3, t2, t3, t);
      const b1 = lerp2(a1, a2, t0, t2, t), b2 = lerp2(a2, a3, t1, t3, t);
      out.push(lerp2(b1, b2, t1, t2, t));
    }
  }
  out.push(closed ? fit[0]! : fit[fit.length - 1]!);
  return out;
}

function lerp2(a: Vec3, b: Vec3, ta: number, tb: number, t: number): Vec3 {
  const d = tb - ta || 1e-9;
  return add(scale(a, (tb - t) / d), scale(b, (t - ta) / d));
}

function mirrorPt(p: Vec3, about: Vec3): Vec3 {
  return sub(scale(about, 2), p);
}

export function helixPoints(h: Extract<Entity, { type: 'HELIX' }>, perTurn = 72): Vec3[] {
  const n = Math.max(8, Math.ceil(h.turns * perTurn));
  const dir = h.ccw ? 1 : -1;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const r = h.baseRadius + (h.topRadius - h.baseRadius) * t;
    const a = dir * TAU * h.turns * t;
    return { x: h.center.x + r * Math.cos(a), y: h.center.y + r * Math.sin(a), z: h.center.z + h.height * t };
  });
}

/** Polylignes représentant l'entité (affichage, sélection, accrochage « proche »). */
export function curvePoints(e: Entity): Vec3[][] {
  switch (e.type) {
    case 'LINE':
      return [[e.start, e.end]];
    case 'CIRCLE':
      return [arcPoints(e.center, e.radius, 0, TAU, 128)];
    case 'ARC':
      return [arcPoints(e.center, e.radius, e.startAngle, arcSweep(e.startAngle, e.endAngle))];
    case 'POLYLINE':
      if (e.bulges?.some(isArcBulge)) return [polylineSamples(e.points, e.closed, e.bulges).pts];
      return [e.closed && e.points.length > 2 ? [...e.points, e.points[0]!] : e.points];
    case 'ELLIPSE':
      return [ellipsePoints(e.center, e.majorAxis, e.ratio)];
    case 'SPLINE': {
      const k = splineFit(e);
      return [splinePoints(k.fit, k.closed)];
    }
    case 'HELIX':
      return [helixPoints(e)];
    case 'HATCH':
      return e.boundaries.map((b) => [...b, b[0]!]);
    case 'POINT':
      return [[e.position, e.position]];
    case 'TEXT': {
      const c = textBox(e);
      return [[...c, c[0]!]];
    }
    case 'DIMENSION':
      return dimensionGeometry(e).lines;
    case '3DSOLID':
      return [];
    case 'UNDERLAY':
      return [underlayFrame(e)];
  }
}

type UnderlayEntity = Extract<Entity, { type: 'UNDERLAY' }>;

/**
 * Matrice locale → monde d'un fond de plan : T(position) · Rz(rotation) · S(scale) · symétrie X.
 * Le point de base de la définition est son origine (comme une référence externe).
 */
export function underlayMatrix(e: Pick<UnderlayEntity, 'position' | 'scale' | 'rotation' | 'mirrored'>): Affine {
  const c = Math.cos(e.rotation), sn = Math.sin(e.rotation), s = e.scale, mx = e.mirrored ? -1 : 1;
  return [mx * s * c, -s * sn, 0, e.position.x, mx * s * sn, s * c, 0, e.position.y, 0, 0, s, e.position.z];
}

/** Cadre (fermé) de l'emprise d'un fond de plan, en coordonnées du dessin. */
export function underlayFrame(e: UnderlayEntity): Vec3[] {
  const m = underlayMatrix(e);
  const { min, max } = e.bounds;
  const c = [
    { x: min.x, y: min.y, z: 0 },
    { x: max.x, y: min.y, z: 0 },
    { x: max.x, y: max.y, z: 0 },
    { x: min.x, y: max.y, z: 0 },
  ].map((p) => apply(m, p));
  return [...c, c[0]!];
}

// Chasses Arial (millièmes de cadratin) des caractères ASCII 32 à 126 : la police d'affichage.
const ARIAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** Hauteur des majuscules d'Arial, en cadratin : la hauteur d'un texte CAO est celle des majuscules. */
export const TEXT_CAP = 0.716;

/** Largeur estimée d'une ligne de texte de hauteur (majuscules) `height`, en Arial. */
export function textWidth(text: string, height: number, widthFactor = 1): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? ARIAL[c - 32]! : ch.toUpperCase() !== ch ? 556 : 700;
  }
  return Math.max(w, 300) / 1000 * (height / TEXT_CAP) * widthFactor;
}

/** Interligne d'un texte multiligne : 5/3 de la hauteur × facteur (règle DXF). */
export const textPitch = (height: number, lineSpacing = 1) => height * (5 / 3) * lineSpacing;

/**
 * Mise en page d'un texte dans son repère local (x le long du texte, y vers le haut, origine au
 * point d'accroche) : ordonnée de la première ligne de base et largeur de chaque ligne.
 */
export function textLayout(e: { text: string; height: number; align?: string; valign?: string; widthFactor?: number; lineSpacing?: number }) {
  const lines = e.text.split('\n');
  const h = e.height, pitch = textPitch(h, e.lineSpacing);
  const n = lines.length;
  let base0: number;
  switch (e.valign) {
    case 'top':
      base0 = -h;
      break;
    case 'middle':
      base0 = ((n - 1) * pitch - h) / 2;
      break;
    case 'bottom':
      base0 = (n - 1) * pitch + h * 0.3;
      break;
    default:
      base0 = 0;
  }
  const widths = lines.map((l) => textWidth(l, h, e.widthFactor ?? 1));
  const W = Math.max(...widths);
  const x0 = e.align === 'center' ? -W / 2 : e.align === 'right' ? -W : 0;
  return { lines, widths, pitch, base0, W, x0, top: base0 + h, bottom: base0 - (n - 1) * pitch };
}

/** Rectangle englobant d'un texte (monde), dans le sens du texte. */
export function textBox(e: Extract<Entity, { type: 'TEXT' }>): Vec3[] {
  const L = textLayout(e);
  const u = { x: Math.cos(e.rotation), y: Math.sin(e.rotation), z: 0 };
  const v = { x: -u.y, y: u.x, z: 0 };
  const at = (x: number, y: number) => add(e.position, add(scale(u, x), scale(v, y)));
  const bottom = L.bottom - e.height * 0.25; // jambages
  return [at(L.x0, bottom), at(L.x0 + L.W, bottom), at(L.x0 + L.W, L.top), at(L.x0, L.top)];
}

type Dimension = Extract<Entity, { type: 'DIMENSION' }>;

// ---------------------------------------------------------------------------------------------
// Styles de cote
// ---------------------------------------------------------------------------------------------

export type ArrowKind = 'closed' | 'open' | 'oblique' | 'dot' | 'none';
export type TolMode = 'none' | 'symmetric' | 'deviation' | 'limits';

/** Style de cote résolu (champs absents : valeurs des variables DIMASZ / DIMDEC passées en argument). */
export interface DimStyleLike {
  arrow?: ArrowKind;
  arrowSize?: number;
  decimals?: number;
  sep?: '.' | ',';
  prefix?: string;
  suffix?: string;
  tol?: TolMode;
  tolPlus?: number;
  tolMinus?: number;
}

let dimStyleResolver: ((e: Dimension) => DimStyleLike | undefined) | null = null;

/** Branche la résolution des styles de cote du dessin actif (appelé par l'application). */
export function setDimStyleResolver(fn: ((e: Dimension) => DimStyleLike | undefined) | null): void {
  dimStyleResolver = fn;
}

/** Style effectif d'une cote : style nommé, puis réglages propres à la cote (tolérance). */
export function dimStyleOf(e: Dimension): DimStyleLike {
  const st = { ...(dimStyleResolver?.(e) ?? {}) };
  if (e.tol !== undefined) st.tol = e.tol;
  if (e.tolPlus !== undefined) st.tolPlus = e.tolPlus;
  if (e.tolMinus !== undefined) st.tolMinus = e.tolMinus;
  return st;
}

let entityLookup: ((handle: string) => Entity | undefined) | null = null;

/** Branche la recherche des objets du dessin actif (étiquettes, cotes associatives). */
export function setEntityLookup(fn: ((handle: string) => Entity | undefined) | null): void {
  entityLookup = fn;
}

let itemLookup: ((handle: string) => number | null) | null = null;

/** Numéros de repère de nomenclature (bulles), fournis par l'application. */
export function setItemLookup(fn: ((handle: string) => number | null) | null): void {
  itemLookup = fn;
}

type ArrowPoly = Vec3[] & { arrow?: { tip: Vec3; back: Vec3; side?: Vec3 } };
/** `side` : normale de la flèche dans le plan de la cote (XY par défaut). */
const markArrow = (poly: Vec3[], tip: Vec3, back: Vec3, side?: Vec3): Vec3[] => Object.assign(poly, { arrow: { tip, back, side } });
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Remplace les flèches (polylignes marquées) selon le style : pleine, ouverte, oblique, point, aucune. */
function styleArrows(lines: Vec3[][], kind: ArrowKind, size: number): { lines: Vec3[][]; fills: Vec3[][] } {
  if (kind === 'open') return { lines, fills: [] };
  const out: Vec3[][] = [];
  const fills: Vec3[][] = [];
  for (const l of lines as ArrowPoly[]) {
    const a = l.arrow;
    if (!a) {
      out.push(l);
      continue;
    }
    const n = a.side ?? { x: -a.back.y, y: a.back.x, z: 0 };
    if (kind === 'closed') {
      const p0 = add(a.tip, add(scale(a.back, size), scale(n, size * 0.17))), p2 = add(a.tip, add(scale(a.back, size), scale(n, -size * 0.17)));
      out.push([p0, a.tip, p2, p0]);
      fills.push([p0, a.tip, p2]);
    } else if (kind === 'oblique') {
      const d = norm(add(a.back, n));
      out.push([add(a.tip, scale(d, size * 0.5)), add(a.tip, scale(d, -size * 0.5))]);
    } else if (kind === 'dot') {
      const r = size * 0.2;
      const ring = Array.from({ length: 13 }, (_, i) => polar(a.tip, r, (i / 12) * TAU));
      out.push(ring);
      for (let i = 0; i < 12; i++) fills.push([a.tip, ring[i]!, ring[i + 1]!]);
    }
  }
  return { lines: out, fills };
}

/**
 * Géométrie d'une cote : lignes d'attache, ligne de cote, flèches (traits `lines`, triangles
 * pleins `fills`), position et angle du texte, valeur mesurée.
 */
export function dimensionGeometry(e: Dimension, arrow = 2.5): { lines: Vec3[][]; fills: Vec3[][]; textPos: Vec3; angle: number; value: number } {
  const st = dimStyleOf(e);
  const size = st.arrowSize ?? arrow;
  const g = rawDimensionGeometry(e, size);
  return { ...g, ...styleArrows(g.lines, st.arrow ?? 'closed', size) };
}

function rawDimensionGeometry(e: Dimension, arrow: number): { lines: Vec3[][]; textPos: Vec3; angle: number; value: number } {
  if (e.dimType === 'radius' || e.dimType === 'diameter') return radialDimensionGeometry(e, arrow);
  if (e.dimType === 'angular') return angularDimensionGeometry(e, arrow);
  if (e.dimType === 'arclength') return arcLengthDimensionGeometry(e, arrow);
  if (e.dimType === 'ordinate') return ordinateDimensionGeometry(e, arrow);
  if (e.dimType === 'leader') return leaderGeometry(e, arrow);
  if (e.dim3d) return aligned3dGeometry(e, arrow);
  if (e.dimType === 'linear' || e.rotation !== undefined) return linearDimensionGeometry(e, arrow);
  const d = sub(e.p2, e.p1);
  const L = Math.hypot(d.x, d.y);
  const u = L > 1e-12 ? { x: d.x / L, y: d.y / L, z: 0 } : { x: 1, y: 0, z: 0 };
  const n = { x: -u.y, y: u.x, z: 0 };
  const off = (e.offsetPoint.x - e.p1.x) * n.x + (e.offsetPoint.y - e.p1.y) * n.y;
  const a = add(e.p1, scale(n, off));
  const b = add(e.p2, scale(n, off));
  const ext = Math.sign(off || 1) * 1.25;
  const head = (tip: Vec3, dirv: Vec3): Vec3[] =>
    markArrow([add(tip, add(scale(dirv, arrow), scale(n, arrow * 0.3))), tip, add(tip, add(scale(dirv, arrow), scale(n, -arrow * 0.3)))], tip, dirv);
  const lines: Vec3[][] = [
    [e.p1, add(a, scale(n, ext))],
    [e.p2, add(b, scale(n, ext))],
    [a, b],
    head(a, u),
    head(b, scale(u, -1)),
  ];
  return { lines, textPos: add(lerp(a, b, 0.5), scale(n, Math.sign(off || 1) * 1.2)), angle: Math.atan2(u.y, u.x), value: L };
}

/** Cote alignée dans l'espace : ligne de cote décalée vers `offsetPoint`, dans le plan des trois points. */
function aligned3dGeometry(e: Dimension, arrow: number) {
  const d = sub(e.p2, e.p1);
  const L = len(d);
  const u = L > 1e-12 ? scale(d, 1 / L) : { x: 1, y: 0, z: 0 };
  const w = sub(e.offsetPoint, e.p1);
  let off = sub(w, scale(u, dot3(w, u)));
  if (len(off) < 1e-9) off = scale(norm(cross3(u, Math.abs(u.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 })), 1e-6);
  const n = norm(off);
  const a = add(e.p1, off), b = add(e.p2, off);
  const head = (tip: Vec3, dirv: Vec3): Vec3[] =>
    markArrow([add(tip, add(scale(dirv, arrow), scale(n, arrow * 0.3))), tip, add(tip, add(scale(dirv, arrow), scale(n, -arrow * 0.3)))], tip, dirv, n);
  const lines: Vec3[][] = [[e.p1, add(a, scale(n, 1.25))], [e.p2, add(b, scale(n, 1.25))], [a, b], head(a, u), head(b, scale(u, -1))];
  return { lines, textPos: add(lerp(a, b, 0.5), scale(n, 1.2 + (e.textHeight ?? 2.5) * 0.6)), angle: 0, value: L };
}

/** Sens du palier d'un repère : vers la droite si le coude est à droite de la flèche. */
const leaderSide = (e: Dimension) => (e.p2.x >= e.p1.x ? 1 : -1);

/** Rayon de la bulle d'un repère (numéro entouré). */
function balloonRadius(text: string, h: number): number {
  return Math.max(textWidth(text, h) / 2 + h * 0.45, h * 1.05);
}

/** Repère : flèche en p1, ligne jusqu'au coude p2, palier horizontal (ou bulle) puis le texte. */
function leaderGeometry(e: Dimension, arrow: number) {
  const h = e.textHeight ?? 2.5;
  const s = leaderSide(e);
  const d = sub(e.p2, e.p1);
  const L = len(d);
  const back = L > 1e-12 ? scale(d, 1 / L) : { x: 1, y: 0, z: 0 };
  const side = e.dim3d ? norm(cross3(back, Math.abs(back.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 })) : undefined;
  const nn = side ?? { x: -back.y, y: back.x, z: 0 };
  const head = markArrow([add(e.p1, add(scale(back, arrow), scale(nn, arrow * 0.3))), e.p1, add(e.p1, add(scale(back, arrow), scale(nn, -arrow * 0.3)))], e.p1, back, side);
  const lines: Vec3[][] = [];
  let textPos: Vec3;
  if (e.balloon) {
    const R = balloonRadius(leaderText(e), h);
    const c = add(e.p2, { x: s * R, y: 0, z: 0 });
    lines.push([e.p1, e.p2], Array.from({ length: 33 }, (_, i) => polar(c, R, (i / 32) * TAU)));
    textPos = c;
  } else {
    const land = add(e.p2, { x: s * h, y: 0, z: 0 });
    lines.push([e.p1, e.p2, land]);
    textPos = land;
  }
  lines.push(head);
  return { lines, textPos, angle: 0, value: 0 };
}

/** Texte d'une étiquette calculée sur l'objet désigné (aire, longueur, volume, nom, coordonnées). */
function labelText(e: Dimension, st: DimStyleLike): string {
  const f = (v: number) => fmtDim(v, st, st.decimals ?? 2);
  const target = e.labelOf ? entityLookup?.(e.labelOf) : undefined;
  const what = e.label ?? 'auto';
  const coords = () => `X ${f(e.p1.x)}  Y ${f(e.p1.y)}${e.p1.z ? `  Z ${f(e.p1.z)}` : ''}`;
  if (what === 'item') return String((e.labelOf && itemLookup?.(e.labelOf)) ?? '?');
  if (what === 'coords' || !target) return coords();
  const area = () => {
    const a = target.type === '3DSOLID' ? target.display.area : entityArea(target);
    return a === null ? null : `Aire ${f(a)} mm²`;
  };
  const length = () => {
    const l = entityLength(target);
    return l === null ? null : `${target.type === 'CIRCLE' ? 'Périmètre' : 'Longueur'} ${f(l)}`;
  };
  const volume = () => (target.type === '3DSOLID' && target.display.solidCount ? `Volume ${f(target.display.volume)} mm³` : null);
  const radius = () => (target.type === 'CIRCLE' || target.type === 'ARC' ? `R${f(target.radius)} (Ø${f(target.radius * 2)})` : null);
  const name = () => (target.type === '3DSOLID' && target.name ? target.name : entityLabel(target));
  switch (what) {
    case 'area':
      return area() ?? name();
    case 'length':
      return length() ?? name();
    case 'volume':
      return volume() ?? name();
    case 'radius':
      return radius() ?? name();
    case 'name':
      return name();
    default:
      if (target.type === '3DSOLID') return [name(), volume(), area()].filter(Boolean).join('\n');
      if (target.type === 'CIRCLE' || target.type === 'ARC') return [radius(), target.type === 'CIRCLE' ? area() : length()].filter(Boolean).join('\n');
      return area() ?? length() ?? name();
  }
}

/** Texte d'un repère : texte saisi (« <> » = valeur de l'étiquette) ou étiquette calculée. */
function leaderText(e: Dimension): string {
  const st = dimStyleOf(e);
  const auto = e.label || e.labelOf ? labelText(e, st) : '';
  if (e.textOverride) return e.textOverride.replace('<>', auto);
  return auto || '?';
}

function linearDimensionGeometry(e: Dimension, arrow: number) {
  const r = e.rotation ?? 0;
  const u = { x: Math.cos(r), y: Math.sin(r), z: 0 };
  const n = { x: -u.y, y: u.x, z: 0 };
  const off = (q: Vec3) => (q.x - e.offsetPoint.x) * n.x + (q.y - e.offsetPoint.y) * n.y;
  const a = sub(e.p1, scale(n, off(e.p1)));
  const b = sub(e.p2, scale(n, off(e.p2)));
  const ab = sub(b, a);
  const L = ab.x * u.x + ab.y * u.y;
  const du = Math.sign(L || 1);
  const head = (tip: Vec3, dirv: Vec3): Vec3[] =>
    markArrow([add(tip, add(scale(dirv, arrow), scale(n, arrow * 0.3))), tip, add(tip, add(scale(dirv, arrow), scale(n, -arrow * 0.3)))], tip, dirv);
  const ext = (p: Vec3, q: Vec3) => {
    const s = Math.sign((q.x - p.x) * n.x + (q.y - p.y) * n.y) || 1;
    return [p, add(q, scale(n, s * 1.25))];
  };
  const side = Math.sign(-off(e.p1) || 1);
  return {
    lines: [ext(e.p1, a), ext(e.p2, b), [a, b], head(a, scale(u, du)), head(b, scale(u, -du))],
    textPos: add(lerp(a, b, 0.5), scale(n, side * 1.2)),
    angle: r,
    value: Math.abs(L),
  };
}

function radialDimensionGeometry(e: Dimension, arrow: number) {
  const c = e.p1;
  const rad = dist(e.p1, e.p2);
  const dirv = norm(sub(e.offsetPoint, c));
  const tip = add(c, scale(dirv, rad));
  const start = e.dimType === 'diameter' ? sub(c, scale(dirv, rad)) : c;
  const n = { x: -dirv.y, y: dirv.x, z: 0 };
  const head = (t: Vec3, back: Vec3): Vec3[] => markArrow([add(t, add(scale(back, arrow), scale(n, arrow * 0.3))), t, add(t, add(scale(back, arrow), scale(n, -arrow * 0.3)))], t, back);
  const lines: Vec3[][] = [[start, e.offsetPoint], head(tip, scale(dirv, -1))];
  if (e.dimType === 'diameter') lines.push(head(start, dirv));
  let angle = Math.atan2(dirv.y, dirv.x);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  return { lines, textPos: add(e.offsetPoint, scale(n, 1.2)), angle, value: e.dimType === 'diameter' ? 2 * rad : rad };
}

const normA = (a: number) => ((a % TAU) + TAU) % TAU;

/** Points d'un arc de centre c (angles en radians, sens trigonométrique de a0 à a0 + sweep). */
function arcPolyline(c: Vec3, r: number, a0: number, sweep: number): Vec3[] {
  const n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  return Array.from({ length: n + 1 }, (_, i) => polar(c, r, a0 + (sweep * i) / n));
}

/** Flèche dont la pointe est en `tip`, orientée selon la tangente unitaire `t` (vers la pointe). */
function arrowHead(tip: Vec3, t: Vec3, arrow: number): Vec3[] {
  const n = { x: -t.y, y: t.x, z: 0 };
  return markArrow([add(tip, add(scale(t, -arrow), scale(n, arrow * 0.3))), tip, add(tip, add(scale(t, -arrow), scale(n, -arrow * 0.3)))], tip, scale(t, -1));
}

/** Ligne d'attache radiale de q jusqu'à l'arc de cote (rayon R autour de c), avec dépassement. */
function radialExtension(c: Vec3, q: Vec3, dir: Vec3, R: number): Vec3[] | null {
  const dq = (q.x - c.x) * dir.x + (q.y - c.y) * dir.y;
  const from = dq > 0 ? q : c;
  const df = dq > 0 ? dq : 0;
  if (Math.abs(R - df) < 1e-9) return null;
  const s = Math.sign(R - df);
  return [from, add(c, scale(dir, R + s * 1.25))];
}

/**
 * Secteur d'une cote angulaire : sommet `center`, côtés passant par p1 et p2, arc par offsetPoint.
 * `angLines` (deux lignes) : les côtés sont des droites, l'arc choisit l'un des quatre secteurs ;
 * sinon (sommet + 2 points, arc, cercle) : angle de p1 à p2, ou son complément à 360°.
 */
export function angularSector(e: Dimension): { a0: number; sweep: number } {
  const c = e.center ?? e.p1;
  const a1 = angleXY(c, e.p1), a2 = angleXY(c, e.p2), ao = normA(angleXY(c, e.offsetPoint));
  if (e.angLines) {
    const dirs = [a1, a2, a1 + Math.PI, a2 + Math.PI].map(normA).sort((x, y) => x - y);
    for (let i = 0; i < 4; i++) {
      const lo = dirs[i]!, hi = i === 3 ? dirs[0]! + TAU : dirs[i + 1]!;
      const o = ao < lo ? ao + TAU : ao;
      if (o >= lo && o <= hi) return { a0: lo, sweep: hi - lo };
    }
  }
  const s12 = normA(a2 - a1);
  const inside = normA(ao - a1) <= s12;
  return inside ? { a0: normA(a1), sweep: s12 } : { a0: normA(a2), sweep: TAU - s12 };
}

function angularDimensionGeometry(e: Dimension, arrow: number) {
  const c = e.center ?? e.p1;
  const R = Math.max(dist(c, e.offsetPoint), 1e-9);
  const { a0, sweep } = angularSector(e);
  const lines: Vec3[][] = [arcPolyline(c, R, a0, sweep)];
  // côté = droite passant par p1 ou p2 (son prolongement au-delà du sommet pour les deux lignes)
  const lineGap = (p: Vec3, a: number) => Math.abs(Math.sin(angleXY(c, p) - a));
  for (const a of [a0, a0 + sweep]) {
    const dir = { x: Math.cos(a), y: Math.sin(a), z: 0 };
    const q = lineGap(e.p1, a) <= lineGap(e.p2, a) ? e.p1 : e.p2;
    const ext = radialExtension(c, q, dir, R);
    if (ext) lines.push(ext);
  }
  const t0 = { x: -Math.sin(a0), y: Math.cos(a0), z: 0 }, a1 = a0 + sweep, t1 = { x: -Math.sin(a1), y: Math.cos(a1), z: 0 };
  const big = R * sweep > 2.5 * arrow;
  lines.push(arrowHead(polar(c, R, a0), big ? scale(t0, -1) : t0, arrow), arrowHead(polar(c, R, a1), big ? t1 : scale(t1, -1), arrow));
  const mid = a0 + sweep / 2;
  return { lines, textPos: polar(c, R + 1.2, mid), angle: mid - Math.PI / 2, value: sweep };
}

/** Cote de longueur d'arc : centre `center`, arc de p1 à p2 (sens trigonométrique), arc de cote par offsetPoint. */
function arcLengthDimensionGeometry(e: Dimension, arrow: number) {
  const c = e.center ?? e.p1;
  const r = dist(c, e.p1);
  const R = Math.max(dist(c, e.offsetPoint), 1e-9);
  const a0 = normA(angleXY(c, e.p1));
  const sweep = normA(angleXY(c, e.p2) - a0) || TAU;
  const lines: Vec3[][] = [arcPolyline(c, R, a0, sweep)];
  for (const [p, a] of [[e.p1, a0], [e.p2, a0 + sweep]] as [Vec3, number][]) {
    const ext = radialExtension(c, p, { x: Math.cos(a), y: Math.sin(a), z: 0 }, R);
    if (ext) lines.push(ext);
  }
  const a1 = a0 + sweep;
  lines.push(arrowHead(polar(c, R, a0), { x: Math.sin(a0), y: -Math.cos(a0), z: 0 }, arrow), arrowHead(polar(c, R, a1), { x: -Math.sin(a1), y: Math.cos(a1), z: 0 }, arrow));
  const mid = a0 + sweep / 2;
  return { lines, textPos: polar(c, R + 1.2, mid), angle: mid - Math.PI / 2, value: r * sweep };
}

/**
 * Cote ordonnée : distance en X (`ordAxis` 'x', ligne de repère verticale) ou en Y ('y', ligne
 * horizontale) du point p1 à l'origine `center` ; la ligne de repère va de p1 à offsetPoint.
 */
function ordinateDimensionGeometry(e: Dimension, arrow: number) {
  const o = e.center ?? { x: 0, y: 0, z: 0 };
  const p = e.p1, q = e.offsetPoint;
  const isX = e.ordAxis !== 'y';
  const gap = Math.min(arrow * 0.25, 0.6);
  let pts: Vec3[];
  if (isX) {
    const s = Math.sign(q.y - p.y) || 1;
    const start = { x: p.x, y: p.y + s * gap, z: p.z };
    if (Math.abs(q.x - p.x) < 1e-9) pts = [start, { x: p.x, y: q.y, z: p.z }];
    else {
      const jog = Math.min(Math.abs(q.y - p.y) / 3, 2 * arrow);
      pts = [start, { x: p.x, y: q.y - s * 2 * jog, z: p.z }, { x: q.x, y: q.y - s * jog, z: p.z }, { x: q.x, y: q.y, z: p.z }];
    }
  } else {
    const s = Math.sign(q.x - p.x) || 1;
    const start = { x: p.x + s * gap, y: p.y, z: p.z };
    if (Math.abs(q.y - p.y) < 1e-9) pts = [start, { x: q.x, y: p.y, z: p.z }];
    else {
      const jog = Math.min(Math.abs(q.x - p.x) / 3, 2 * arrow);
      pts = [start, { x: q.x - s * 2 * jog, y: p.y, z: p.z }, { x: q.x - s * jog, y: q.y, z: p.z }, { x: q.x, y: q.y, z: p.z }];
    }
  }
  return { lines: [pts], textPos: q, angle: isX ? Math.PI / 2 : 0, value: Math.abs(isX ? p.x - o.x : p.y - o.y) };
}

/** Nombre d'une cote selon le style : décimales, séparateur (virgule à la française). */
function fmtDim(v: number, st: DimStyleLike, precision: number): string {
  const s = formatNumber(v, st.decimals ?? precision);
  return st.sep === ',' ? s.replace('.', ',') : s;
}

/** Valeur affichée (unités, préfixe R/Ø/style, suffixe), sans tolérance. */
function dimValueText(e: Dimension, st: DimStyleLike, precision: number, value = rawDimensionGeometry(e, 2.5).value): string {
  const ang = e.dimType === 'angular';
  const num = ang ? `${fmtDim((value * 180) / Math.PI, { ...st, decimals: Math.min(st.decimals ?? precision, 2) }, precision)}°` : fmtDim(value, st, precision);
  const kind = e.dimType === 'radius' ? 'R' : e.dimType === 'diameter' ? 'Ø' : '';
  return `${st.prefix ?? ''}${kind}${num}${ang ? '' : (st.suffix ?? '')}`;
}

/** Texte affiché par une cote (valeur mesurée ou texte imposé), tolérance symétrique comprise. */
export function dimensionText(e: Dimension, precision = 2): string {
  if (e.dimType === 'leader') return leaderText(e);
  const st = dimStyleOf(e);
  let v = dimValueText(e, st, precision);
  if (st.tol === 'symmetric' && st.tolPlus) v += ` ±${fmtDim(st.tolPlus, st, precision)}`;
  if (e.textOverride) return e.textOverride.replace('<>', v);
  if (st.tol === 'limits') {
    const value = rawDimensionGeometry(e, 2.5).value;
    return dimValueText(e, st, precision, value + (st.tolPlus ?? 0));
  }
  return v;
}

/** Écarts affichés à droite de la cote (tolérance « écarts ») ou valeur mini (« limites »). */
function toleranceTexts(e: Dimension, st: DimStyleLike, precision: number): { upper: string; lower: string } | null {
  if (e.textOverride || (st.tol !== 'deviation' && st.tol !== 'limits')) return null;
  const plus = st.tolPlus ?? 0, minus = st.tolMinus ?? 0;
  if (st.tol === 'limits') {
    const value = rawDimensionGeometry(e, 2.5).value;
    return { upper: dimValueText(e, st, precision, value + plus), lower: dimValueText(e, st, precision, value - minus) };
  }
  const f = (v: number, sign: string) => (v === 0 ? '0' : `${sign}${fmtDim(Math.abs(v), st, precision)}`);
  return { upper: f(plus, plus < 0 ? '−' : '+'), lower: f(minus, minus < 0 ? '+' : '−') };
}

/**
 * Emplacement du texte d'une cote, commun à l'écran, au PDF, au SVG et au DXF : point de la ligne
 * de base (texte centré), angle lisible, et traits en plus (symbole d'arc ⌒ des longueurs d'arc).
 */
export interface DimensionLabel {
  at: Vec3;
  angle: number;
  text: string;
  lines: Vec3[][];
  texts: { at: Vec3; text: string; height: number }[];
  /** Cote 3D : textes centrés sur `at`, tournés vers l'écran. */
  billboard?: boolean;
}

export function dimensionLabel(e: Dimension, height: number, arrow = 2.5, precision = 2): DimensionLabel {
  const g = dimensionGeometry(e, arrow);
  const text = dimensionText(e, precision);
  const readable = (a: number) => {
    let r = Math.atan2(Math.sin(a), Math.cos(a));
    if (r > Math.PI / 2 + 1e-6 || r < -Math.PI / 2 - 1e-6) r += Math.PI;
    return Math.atan2(Math.sin(r), Math.cos(r));
  };
  if (e.dimType === 'leader') {
    // lignes alignées sur le palier (à gauche ou à droite), bloc centré verticalement ; en 3D le
    // texte est centré sur `at` et tourné vers l'écran (`billboard`)
    const rows = text.split('\n');
    if (e.balloon || e.dim3d) {
      const lh = height * 1.5;
      const texts = rows.map((t, i) => ({ at: add(g.textPos, { x: 0, y: ((rows.length - 1) / 2 - i) * lh - (e.dim3d ? 0 : height / 2), z: 0 }), text: t, height }));
      return { at: texts[0]!.at, angle: 0, text, lines: [], texts, billboard: !!e.dim3d };
    }
    const s = leaderSide(e);
    const lh = height * 1.6;
    const texts = rows.map((t, i) => {
      const w = textWidth(t, height);
      return { at: add(g.textPos, { x: s * (height * 0.4 + w / 2), y: ((rows.length - 1) / 2 - i) * lh - height / 2, z: 0 }), text: t, height };
    });
    return { at: texts[0]!.at, angle: 0, text, lines: [], texts };
  }
  if (e.dim3d) return { at: g.textPos, angle: 0, text, lines: [], texts: [{ at: g.textPos, text, height }], billboard: true };
  const a = readable(g.angle);
  const up = { x: -Math.sin(a), y: Math.cos(a), z: 0 };
  const u = { x: Math.cos(a), y: Math.sin(a), z: 0 };
  let ref: Vec3;
  let at: Vec3;
  if (e.dimType === 'ordinate') {
    // au bout de la ligne de repère, dans son prolongement, centré sur la ligne
    const w = textWidth(text, height);
    const pts = g.lines[0]!;
    const last = pts[pts.length - 1]!, prev = pts[pts.length - 2] ?? e.p1;
    const d = norm(sub(last, prev));
    const along = (d.x * u.x + d.y * u.y) >= 0 ? 1 : -1;
    at = add(add(last, scale(u, along * (height * 0.4 + w / 2))), scale(up, -height * 0.5));
    return { at, angle: a, text, lines: [], texts: [{ at, text, height }] };
  }
  if (e.dimType === 'angular' || e.dimType === 'arclength') {
    const c = e.center ?? e.p1;
    const R = dist(c, e.offsetPoint);
    const mid = angleXY(c, g.textPos);
    ref = polar(c, R, mid);
    // texte du côté extérieur de l'arc
    const out = { x: Math.cos(mid), y: Math.sin(mid), z: 0 };
    const s = out.x * up.x + out.y * up.y >= 0 ? 1 : -1;
    at = add(ref, scale(up, s > 0 ? height * 0.5 : -height * 1.5));
  } else if (e.dimType === 'radius' || e.dimType === 'diameter') {
    ref = e.offsetPoint;
    at = add(ref, scale(up, height * 0.5));
  } else {
    const line = g.lines[2]!;
    ref = lerp(line[0]!, line[1]!, 0.5);
    at = add(ref, scale(up, height * 0.5));
  }
  const lines: Vec3[][] = [];
  if (e.dimType === 'arclength' && !e.textOverride) {
    // symbole ⌒ au-dessus du nombre
    const w = Math.max(textWidth(text, height) * 0.8, height);
    const top = add(at, scale(up, height * 1.25));
    lines.push(Array.from({ length: 9 }, (_, i) => {
      const t = (i / 8) * Math.PI;
      return add(top, add(scale(u, (-Math.cos(t) * w) / 2), scale(up, Math.sin(t) * height * 0.35)));
    }));
  }
  // tolérance en écarts (deux petits nombres à droite) ou en limites (deux valeurs superposées)
  const tol = toleranceTexts(e, dimStyleOf(e), precision);
  let texts = [{ at, text, height }];
  if (tol) {
    const th = height * 0.7;
    if (dimStyleOf(e).tol === 'limits') {
      texts = [
        { at: add(at, scale(up, height * 0.45)), text: tol.upper, height: th },
        { at: add(at, scale(up, -height * 0.45)), text: tol.lower, height: th },
      ];
    } else {
      const w = textWidth(text, height), wt = Math.max(textWidth(tol.upper, th), textWidth(tol.lower, th));
      const main = add(at, scale(u, -(wt + height * 0.3) / 2));
      const x = add(main, scale(u, w / 2 + height * 0.3 + wt / 2));
      texts = [
        { at: main, text, height },
        { at: add(x, scale(up, height * 0.5)), text: tol.upper, height: th },
        { at: add(x, scale(up, -height * 0.15)), text: tol.lower, height: th },
      ];
    }
  }
  return { at: texts[0]!.at, angle: a, text: texts[0]!.text, lines, texts };
}

export function formatNumber(v: number, precision = 4): string {
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const DIM_LABEL: Record<NonNullable<Dimension['dimType']>, string> = {
  aligned: 'Cote alignée',
  linear: 'Cote linéaire',
  radius: 'Cote de rayon',
  diameter: 'Cote de diamètre',
  angular: 'Cote angulaire',
  arclength: 'Cote de longueur d’arc',
  ordinate: 'Cote ordonnée',
  leader: 'Repère',
};

/** Libellé de l'entité (palette Propriétés). */
export function entityLabel(e: Entity): string {
  if (e.type === '3DSOLID') return e.display.solidCount === 0 ? 'Surface' : 'Solide 3D';
  if (e.type === 'DIMENSION') return e.dimType === 'leader' ? (e.balloon ? 'Bulle' : e.label || e.labelOf ? 'Étiquette' : 'Repère') : DIM_LABEL[e.dimType ?? 'aligned'];
  return TYPE_LABEL[e.type];
}

// ---------------------------------------------------------------------------
// Accrochage aux objets
// ---------------------------------------------------------------------------

export type SnapKind = 'END' | 'MID' | 'CEN' | 'QUA' | 'NOD' | 'INT' | 'NEA' | 'INS' | 'PER' | 'TAN' | 'EXT' | 'PAR' | 'FACE';

export const SNAP_LABEL: Record<SnapKind, string> = {
  END: 'Extrémité',
  MID: 'Milieu',
  CEN: 'Centre',
  QUA: 'Quadrant',
  NOD: 'Nodal',
  INT: 'Intersection',
  NEA: 'Proche',
  INS: 'Insertion',
  PER: 'Perpendiculaire',
  TAN: 'Tangente',
  EXT: 'Prolongement',
  PAR: 'Parallèle',
  FACE: 'Sur la face',
};

export interface SnapCandidate {
  kind: SnapKind;
  point: Vec3;
}

export function snapPoints(e: Entity): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const end = (p: Vec3) => out.push({ kind: 'END', point: p });
  const mid = (a: Vec3, b: Vec3) => out.push({ kind: 'MID', point: lerp(a, b, 0.5) });
  switch (e.type) {
    case 'LINE':
      end(e.start), end(e.end), mid(e.start, e.end);
      break;
    case 'POLYLINE': {
      e.points.forEach(end);
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        if (isArcBulge(bu)) {
          out.push({ kind: 'MID', point: bulgePoint(a, b, bu, 0.5) });
          out.push({ kind: 'CEN', point: bulgeArc(a, b, bu).center });
        } else mid(a, b);
      }
      break;
    }
    case 'CIRCLE':
      out.push({ kind: 'CEN', point: e.center });
      for (let i = 0; i < 4; i++) out.push({ kind: 'QUA', point: polar(e.center, e.radius, (i * Math.PI) / 2) });
      break;
    case 'ARC': {
      out.push({ kind: 'CEN', point: e.center });
      end(polar(e.center, e.radius, e.startAngle));
      end(polar(e.center, e.radius, e.endAngle));
      out.push({ kind: 'MID', point: polar(e.center, e.radius, e.startAngle + arcSweep(e.startAngle, e.endAngle) / 2) });
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        if (normAngle(a - e.startAngle) <= arcSweep(e.startAngle, e.endAngle)) out.push({ kind: 'QUA', point: polar(e.center, e.radius, a) });
      }
      break;
    }
    case 'ELLIPSE': {
      out.push({ kind: 'CEN', point: e.center });
      const minor = { x: -e.majorAxis.y * e.ratio, y: e.majorAxis.x * e.ratio, z: 0 };
      for (const v of [e.majorAxis, scale(e.majorAxis, -1), minor, scale(minor, -1)]) out.push({ kind: 'QUA', point: add(e.center, v) });
      break;
    }
    case 'SPLINE': {
      const k = splineFit(e);
      k.fit.forEach((p) => out.push({ kind: 'NOD', point: p }));
      if (!k.closed && k.fit.length) end(k.fit[0]!), end(k.fit[k.fit.length - 1]!);
      break;
    }
    case 'POINT':
      out.push({ kind: 'NOD', point: e.position });
      break;
    case 'HELIX': {
      const pts = helixPoints(e, 8);
      end(pts[0]!), end(pts[pts.length - 1]!);
      out.push({ kind: 'CEN', point: e.center });
      break;
    }
    case 'TEXT':
      out.push({ kind: 'INS', point: e.position });
      break;
    case 'DIMENSION':
      end(e.p1), end(e.p2);
      if (e.center && (e.dimType === 'angular' || e.dimType === 'arclength')) out.push({ kind: 'CEN', point: e.center });
      break;
    case 'HATCH':
      e.boundaries.forEach((b) => b.forEach(end));
      break;
    case 'UNDERLAY':
      out.push({ kind: 'INS', point: e.position });
      break;
    case '3DSOLID': {
      // extrémités des arêtes B-rep (un corps maillé très fin n'en propose pas : trop de points)
      const d = e.display;
      if (d.edgeOffsets.length > 20000) break;
      for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
        const a = d.edgeOffsets[i]!, b = d.edgeOffsets[i + 1]!;
        if (b - a < 2) continue;
        const p = (k: number): Vec3 => ({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: d.edgePoints[3 * k + 2]! });
        end(p(a));
        end(p(b - 1));
        if (b - a === 2) mid(p(a), p(b - 1));
        // arête circulaire (trou, axe de charnière…) : centre
        else if (b - a >= 5) {
          const c = circleCenter(p(a), p(a + Math.floor((b - a) / 3)), p(a + Math.floor((2 * (b - a)) / 3)));
          if (c) {
            const r = Math.hypot(p(a).x - c.x, p(a).y - c.y, p(a).z - c.z);
            let ok = r > 1e-9;
            for (let k = a; ok && k < b; k += Math.max(1, Math.floor((b - a) / 8))) ok = Math.abs(Math.hypot(p(k).x - c.x, p(k).y - c.y, p(k).z - c.z) - r) < r * 0.01;
            if (ok) out.push({ kind: 'CEN', point: c });
          }
        }
      }
      break;
    }
  }
  return out;
}

/**
 * Points d'accroche nommés d'un objet, pour les cotes associatives : extrémités, milieu, centre,
 * sommets de polyligne (`v3`), quadrants (`q0`…`q3`).
 */
export function assocRefs(e: Entity): { ref: string; point: Vec3 }[] {
  switch (e.type) {
    case 'LINE':
      return [
        { ref: 'start', point: e.start },
        { ref: 'end', point: e.end },
        { ref: 'mid', point: lerp(e.start, e.end, 0.5) },
      ];
    case 'POLYLINE': {
      const out = e.points.map((p, i) => ({ ref: `v${i}`, point: p }));
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        out.push({ ref: `m${i}`, point: isArcBulge(bu) ? bulgePoint(a, b, bu, 0.5) : lerp(a, b, 0.5) });
      }
      return out;
    }
    case 'CIRCLE':
      return [{ ref: 'center', point: e.center }, ...[0, 1, 2, 3].map((i) => ({ ref: `q${i}`, point: polar(e.center, e.radius, (i * Math.PI) / 2) }))];
    case 'ARC':
      return [
        { ref: 'center', point: e.center },
        { ref: 'start', point: polar(e.center, e.radius, e.startAngle) },
        { ref: 'end', point: polar(e.center, e.radius, e.endAngle) },
        { ref: 'mid', point: polar(e.center, e.radius, e.startAngle + arcSweep(e.startAngle, e.endAngle) / 2) },
      ];
    case 'POINT':
      return [{ ref: 'pos', point: e.position }];
    case 'ELLIPSE':
      return [{ ref: 'center', point: e.center }];
    default:
      return [];
  }
}

/** Point d'accroche `ref` d'un objet (cote associative) ; `a<angle>` = point du cercle à cet angle. */
export function assocPoint(e: Entity, ref: string): Vec3 | null {
  if (ref.startsWith('a') && (e.type === 'CIRCLE' || e.type === 'ARC')) return polar(e.center, e.radius, Number(ref.slice(1)));
  return assocRefs(e).find((r) => r.ref === ref)?.point ?? null;
}

/** Accroche d'un point posé sur un objet : point nommé confondu, ou point d'un cercle (cotes de rayon). */
export function findAssocRef(e: Entity, p: Vec3, onCircle = false): string | null {
  const tol = 1e-6 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
  const hit = assocRefs(e).find((r) => dist(r.point, p) <= tol);
  if (hit) return hit.ref;
  if (onCircle && (e.type === 'CIRCLE' || e.type === 'ARC') && Math.abs(dist(e.center, p) - e.radius) <= tol * 10) return `a${Math.atan2(p.y - e.center.y, p.x - e.center.x)}`;
  return null;
}

/** Centre du cercle passant par trois points de l'espace (null s'ils sont alignés). */
export function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const w = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const ww = w.x * w.x + w.y * w.y + w.z * w.z;
  const uu = u.x * u.x + u.y * u.y + u.z * u.z, vv = v.x * v.x + v.y * v.y + v.z * v.z;
  if (ww < 1e-18 * uu * vv) return null;
  // a + ((|u|² v − |v|² u) × w) / (2 |w|²)
  const t = { x: uu * v.x - vv * u.x, y: uu * v.y - vv * u.y, z: uu * v.z - vv * u.z };
  const k = { x: t.y * w.z - t.z * w.y, y: t.z * w.x - t.x * w.z, z: t.x * w.y - t.y * w.x };
  return { x: a.x + k.x / (2 * ww), y: a.y + k.y / (2 * ww), z: a.z + k.z / (2 * ww) };
}

/** Intersections dans le plan XY entre deux ensembles de polylignes. */
export function polylineIntersections(a: Vec3[][], b: Vec3[][], limit = 64): Vec3[] {
  const out: Vec3[] = [];
  for (const pa of a)
    for (let i = 0; i + 1 < pa.length; i++)
      for (const pb of b)
        for (let j = 0; j + 1 < pb.length; j++) {
          const p = segmentIntersection(pa[i]!, pa[i + 1]!, pb[j]!, pb[j + 1]!);
          if (p) {
            out.push(p);
            if (out.length >= limit) return out;
          }
        }
  return out;
}

export function segmentIntersection(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3, infinite = false): Vec3 | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (!infinite && (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9)) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y, z: p1.z + t * (p2.z - p1.z) };
}

export function nearestOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2));
  const point = add(a, scale(ab, t));
  return { point, t, d: dist(p, point) };
}

export function nearestOnPolylines(polys: Vec3[][], p: Vec3): { point: Vec3; d: number; poly: number; seg: number; t: number } | null {
  let best: { point: Vec3; d: number; poly: number; seg: number; t: number } | null = null;
  polys.forEach((pl, pi) => {
    for (let i = 0; i + 1 < pl.length; i++) {
      const r = nearestOnSegment(p, pl[i]!, pl[i + 1]!);
      if (!best || r.d < best.d) best = { point: r.point, d: r.d, poly: pi, seg: i, t: r.t };
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

/** Nouvelle géométrie de l'entité transformée (sauf solides 3D, transformés par le noyau). */
export function transformEntity(e: Entity, m: Affine): Partial<NewEntity> {
  const P = (p: Vec3) => apply(m, p);
  const s = scaleFactor(m);
  const mirrored = determinant(m) < 0;
  switch (e.type) {
    case 'LINE':
      return { start: P(e.start), end: P(e.end) };
    case 'CIRCLE':
      return { center: P(e.center), radius: e.radius * s };
    case 'ARC': {
      const c = P(e.center);
      const a = angleXY(c, P(polar(e.center, e.radius, e.startAngle)));
      const b = angleXY(c, P(polar(e.center, e.radius, e.endAngle)));
      return mirrored ? { center: c, radius: e.radius * s, startAngle: normAngle(b), endAngle: normAngle(a) } : { center: c, radius: e.radius * s, startAngle: normAngle(a), endAngle: normAngle(b) };
    }
    case 'POLYLINE':
      return mirrored && e.bulges ? { points: e.points.map(P), bulges: e.bulges.map((b) => -b) } : { points: e.points.map(P) };
    case 'ELLIPSE': {
      const major = applyVector(m, e.majorAxis);
      return { center: P(e.center), majorAxis: major };
    }
    case 'SPLINE':
      return { fitPoints: e.fitPoints.map(P) };
    case 'POINT':
      return { position: P(e.position) };
    case 'HELIX':
      return { center: P(e.center), baseRadius: e.baseRadius * s, topRadius: e.topRadius * s, height: e.height * s, ccw: mirrored ? !e.ccw : e.ccw };
    case 'HATCH':
      return { boundaries: e.boundaries.map((b) => b.map(P)), scale: e.scale * s };
    case 'TEXT': {
      const dir = applyVector(m, { x: Math.cos(e.rotation), y: Math.sin(e.rotation), z: 0 });
      return { position: P(e.position), height: e.height * s, rotation: mirrored ? e.rotation : Math.atan2(dir.y, dir.x) };
    }
    case 'DIMENSION': {
      const patch: Partial<NewEntity> = { p1: P(e.p1), p2: P(e.p2), offsetPoint: P(e.offsetPoint), ...(e.center ? { center: P(e.center) } : {}) };
      // symétrie : un arc parcouru dans le sens trigonométrique change de sens
      if (mirrored && (e.dimType === 'arclength' || (e.dimType === 'angular' && !e.angLines))) Object.assign(patch, { p1: P(e.p2), p2: P(e.p1) });
      // cote ordonnée : l'axe mesuré tourne avec la cote (rotation de 90°)
      if (e.dimType === 'ordinate') {
        const d = applyVector(m, e.ordAxis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 });
        (patch as { ordAxis?: 'x' | 'y' }).ordAxis = Math.abs(d.x) >= Math.abs(d.y) ? 'x' : 'y';
      }
      if (e.rotation !== undefined) {
        const d = applyVector(m, { x: Math.cos(e.rotation), y: Math.sin(e.rotation), z: 0 });
        (patch as { rotation?: number }).rotation = Math.atan2(d.y, d.x);
      }
      return patch;
    }
    case '3DSOLID':
      return {};
    case 'UNDERLAY': {
      // nouvelle base locale = partie linéaire de m appliquée à l'ancienne base
      const A = underlayMatrix(e);
      const ax = applyVector(m, { x: A[0], y: A[4], z: 0 });
      const ay = applyVector(m, { x: A[1], y: A[5], z: 0 });
      const flip = ax.x * ay.y - ax.y * ay.x < 0;
      const dir = flip ? scale(ax, -1) : ax;
      return { position: P(e.position), scale: len(ax), rotation: normAngle(Math.atan2(dir.y, dir.x)), mirrored: flip || undefined };
    }
  }
}

// ---------------------------------------------------------------------------
// Décalage (DECALER)
// ---------------------------------------------------------------------------

/** Côté de `p` par rapport au segment a→b : +1 à gauche, -1 à droite. */
function sideOf(a: Vec3, b: Vec3, p: Vec3): number {
  return Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) || 1;
}

export function offsetEntity(e: Entity, d: number, side: Vec3): Partial<NewEntity> | null {
  switch (e.type) {
    case 'LINE': {
      const u = norm(sub(e.end, e.start));
      const n = { x: -u.y, y: u.x, z: 0 };
      const k = sideOf(e.start, e.end, side) * d;
      return { start: add(e.start, scale(n, k)), end: add(e.end, scale(n, k)) };
    }
    case 'CIRCLE': {
      const outside = dist(side, e.center) > e.radius;
      const r = e.radius + (outside ? d : -d);
      return r > 1e-9 ? { radius: r } : null;
    }
    case 'ARC': {
      const outside = dist(side, e.center) > e.radius;
      const r = e.radius + (outside ? d : -d);
      return r > 1e-9 ? { radius: r } : null;
    }
    case 'POLYLINE': {
      if (e.bulges?.some(isArcBulge)) return offsetBulgedPolyline(e.points, e.bulges, e.closed, d, side);
      const pts = offsetPolyline(e.points, e.closed, d, side);
      return pts ? { points: pts, bulges: undefined } : null;
    }
    case 'ELLIPSE': {
      // approximation : ellipse décalée échantillonnée en polyligne fermée
      const pts = ellipsePoints(e.center, e.majorAxis, e.ratio, 96).slice(0, -1);
      const out = offsetPolyline(pts, true, d, side);
      return out ? ({ type: 'POLYLINE', points: out, closed: true } as unknown as Partial<NewEntity>) : null;
    }
    default:
      return null;
  }
}

type OffsetElement =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'arc'; center: Vec3; radius: number; a: Vec3; b: Vec3; ccw: boolean };

/** Décalage exact d'une polyligne à arcs (arcs concentriques, raccords par intersection). */
function offsetBulgedPolyline(points: Vec3[], bulges: number[], closed: boolean, d: number, side: Vec3): Partial<NewEntity> | null {
  const n = points.length;
  const segCount = closed ? n : n - 1;
  if (segCount < 1) return null;
  // côté : celui du segment le plus proche du point indiqué (gauche = +)
  const samples = polylineSamples(points, closed, bulges);
  const near = nearestOnPolylines([samples.pts], side);
  const sa = samples.pts[near?.seg ?? 0]!, sb = samples.pts[(near?.seg ?? 0) + 1] ?? sa;
  const k = sideOf(sa, sb, side) * d;
  const els: OffsetElement[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!, bu = bulges[i];
    if (isArcBulge(bu)) {
      const arc = bulgeArc(a, b, bu);
      const ccw = bu > 0;
      // à gauche d'un arc trigonométrique = vers le centre
      const r = arc.radius + (ccw ? -k : k);
      if (r <= 1e-9) return null;
      const at = (p: Vec3) => add(arc.center, scale(norm(sub(p, arc.center)), r));
      els.push({ kind: 'arc', center: arc.center, radius: r, a: at(a), b: at(b), ccw });
    } else {
      const u = norm(sub(b, a));
      const nv = { x: -u.y * k, y: u.x * k, z: 0 };
      els.push({ kind: 'line', a: add(a, nv), b: add(b, nv) });
    }
  }
  const joints: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && i === 0) {
      joints.push(els[0]!.a);
      continue;
    }
    if (!closed && i === n - 1) {
      joints.push(els[segCount - 1]!.b);
      continue;
    }
    const prev = els[(i - 1 + segCount) % segCount]!, next = els[i % segCount]!;
    if (dist(prev.b, next.a) < 1e-7) {
      joints.push(prev.b);
      continue;
    }
    const cands = elementIntersections(prev, next);
    const ref = lerp(prev.b, next.a, 0.5);
    cands.sort((p, q) => dist(p, ref) - dist(q, ref));
    joints.push(cands[0] ?? prev.b);
  }
  const newBulges: number[] = [];
  for (let i = 0; i < segCount; i++) {
    const el = els[i]!;
    if (el.kind === 'line') {
      newBulges.push(0);
      continue;
    }
    const a = joints[i]!, b = joints[(i + 1) % n]!;
    const a0 = Math.atan2(a.y - el.center.y, a.x - el.center.x), a1 = Math.atan2(b.y - el.center.y, b.x - el.center.x);
    let sweep = a1 - a0;
    if (el.ccw) while (sweep <= 0) sweep += 2 * Math.PI;
    else while (sweep >= 0) sweep -= 2 * Math.PI;
    newBulges.push(Math.tan(sweep / 4));
  }
  if (closed) newBulges.length = n;
  return { points: joints, bulges: newBulges };
}

function elementIntersections(p: OffsetElement, q: OffsetElement): Vec3[] {
  if (p.kind === 'line' && q.kind === 'line') {
    const x = segmentIntersection(p.a, p.b, q.a, q.b, true);
    return x ? [x] : [];
  }
  if (p.kind === 'line' && q.kind === 'arc') return lineCircle(p.a, p.b, q.center, q.radius);
  if (p.kind === 'arc' && q.kind === 'line') return lineCircle(q.a, q.b, p.center, p.radius);
  if (p.kind === 'arc' && q.kind === 'arc') return circleCircle(p.center, p.radius, q.center, q.radius);
  return [];
}

/** Intersections droite infinie (a,b) / cercle. */
export function lineCircle(a: Vec3, b: Vec3, c: Vec3, r: number): Vec3[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  if (A < 1e-24) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-12) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const z = a.z;
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map((t) => ({ x: a.x + t * dx, y: a.y + t * dy, z }));
}

export function circleCircle(c1: Vec3, r1: number, c2: Vec3, r2: number): Vec3[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + (a * dx) / d, my = c1.y + (a * dy) / d;
  return [
    { x: mx + (h * dy) / d, y: my - (h * dx) / d, z: c1.z },
    { x: mx - (h * dy) / d, y: my + (h * dx) / d, z: c1.z },
  ];
}

/** Décalage d'une polyligne (raccords vifs par intersection des segments décalés). */
export function offsetPolyline(points: Vec3[], closed: boolean, d: number, side: Vec3): Vec3[] | null {
  const n = points.length;
  if (n < 2) return null;
  // côté choisi : celui du segment le plus proche du point indiqué
  const near = nearestOnPolylines([closed ? [...points, points[0]!] : points], side);
  const si = near?.seg ?? 0;
  const k = sideOf(points[si]!, points[(si + 1) % n]!, side) * d;
  const segCount = closed ? n : n - 1;
  const segs: [Vec3, Vec3][] = [];
  for (let i = 0; i < segCount; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    const u = norm(sub(b, a));
    const nv = { x: -u.y * k, y: u.x * k, z: 0 };
    segs.push([add(a, nv), add(b, nv)]);
  }
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && i === 0) {
      out.push(segs[0]![0]);
      continue;
    }
    if (!closed && i === n - 1) {
      out.push(segs[segCount - 1]![1]);
      continue;
    }
    const prev = segs[(i - 1 + segCount) % segCount]!, next = segs[i % segCount]!;
    out.push(segmentIntersection(prev[0], prev[1], next[0], next[1], true) ?? prev[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profils pour le noyau
// ---------------------------------------------------------------------------

export function profileOf(e: Entity): ProfileDef | null {
  switch (e.type) {
    case 'CIRCLE':
      return { kind: 'circle', center: e.center, radius: e.radius };
    case 'ARC':
      return { kind: 'arc', center: e.center, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle };
    case 'POLYLINE': {
      const bulges = e.bulges?.some(isArcBulge) ? e.bulges : undefined;
      if (!e.closed && endsMeet(e.points)) {
        // Polyligne refermée « à la main » (dernier point = premier) : profil fermé.
        const n = e.points.length - 1;
        return { kind: 'poly', points: e.points.slice(0, n), closed: true, bulges: bulges?.slice(0, n) };
      }
      return { kind: 'poly', points: e.points, closed: e.closed, bulges };
    }
    case 'LINE':
      return { kind: 'poly', points: [e.start, e.end], closed: false };
    case 'ELLIPSE':
      return { kind: 'poly', points: ellipsePoints(e.center, e.majorAxis, e.ratio, 96).slice(0, -1), closed: true };
    case 'SPLINE': {
      // spline refermée « à la main » (dernier point = premier) : profil fermé, lisse au raccord
      const k = splineFit(e);
      const pts = splinePoints(k.fit, k.closed, 12);
      return { kind: 'poly', points: k.closed ? pts.slice(0, -1) : pts, closed: k.closed };
    }
    case 'HELIX':
      return { kind: 'helix', center: e.center, baseRadius: e.baseRadius, topRadius: e.topRadius, height: e.height, turns: e.turns, ccw: e.ccw };
    default:
      return null;
  }
}

/** Vrai si le dernier point rejoint le premier (au moins 3 sommets distincts). */
export function endsMeet(points: Vec3[]): boolean {
  if (points.length < 4) return false;
  const a = points[0]!, b = points[points.length - 1]!;
  let size = 0;
  for (const q of points) size = Math.max(size, Math.abs(q.x - a.x), Math.abs(q.y - a.y), Math.abs(q.z - a.z));
  return size > 0 && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= Math.max(1e-9, size * 1e-7);
}

/**
 * Points de lissage effectifs d'une spline : une spline dont le dernier point rejoint le premier
 * est traitée comme fermée (point en double retiré), comme une polyligne refermée à la main.
 */
export function splineFit(e: Extract<Entity, { type: 'SPLINE' }>): { fit: Vec3[]; closed: boolean } {
  if (!e.closed && endsMeet(e.fitPoints)) return { fit: e.fitPoints.slice(0, -1), closed: true };
  return { fit: e.fitPoints, closed: e.closed };
}

export function isClosedProfile(e: Entity): boolean {
  if (e.type === 'CIRCLE' || e.type === 'ELLIPSE') return true;
  if (e.type === 'SPLINE') return e.closed || endsMeet(e.fitPoints);
  if (e.type === 'POLYLINE') return e.closed || endsMeet(e.points);
  return false;
}

/** Contour fermé (pour les hachures) ; null si l'entité n'est pas fermée. */
export function closedLoop(e: Entity): Vec3[] | null {
  if (!isClosedProfile(e)) return null;
  const pts = curvePoints(e)[0]!;
  return pts.slice(0, -1);
}

// ---------------------------------------------------------------------------
// Mesures (palette Propriétés)
// ---------------------------------------------------------------------------

export function polylineLength(pts: Vec3[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += dist(pts[i]!, pts[i + 1]!);
  return l;
}

export function polygonArea(pts: Vec3[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function entityLength(e: Entity): number | null {
  switch (e.type) {
    case 'LINE':
      return dist(e.start, e.end);
    case 'CIRCLE':
      return TAU * e.radius;
    case 'ARC':
      return e.radius * arcSweep(e.startAngle, e.endAngle);
    case 'POLYLINE': {
      const n = e.points.length;
      let l = 0;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i]!, b = e.points[(i + 1) % n]!, bu = e.bulges?.[i];
        if (isArcBulge(bu)) {
          const arc = bulgeArc(a, b, bu);
          l += arc.radius * Math.abs(arc.sweep);
        } else l += dist(a, b);
      }
      return l;
    }
    case 'ELLIPSE':
    case 'SPLINE':
    case 'HELIX':
      return polylineLength(curvePoints(e)[0]!);
    default:
      return null;
  }
}

/** Aire signée exacte d'une polyligne fermée (segments d'arc compris). */
export function bulgedArea(points: Vec3[], bulges?: number[]): number {
  let a = polygonArea(points);
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const bu = bulges?.[i];
    if (!isArcBulge(bu)) continue;
    const arc = bulgeArc(points[i]!, points[(i + 1) % n]!, bu);
    // segment circulaire : à droite de la corde (extérieur d’un contour trigo) si renflement > 0
    a += Math.sign(arc.sweep) * 0.5 * arc.radius * arc.radius * (Math.abs(arc.sweep) - Math.sin(Math.abs(arc.sweep)));
  }
  return a;
}

export function entityArea(e: Entity): number | null {
  switch (e.type) {
    case 'CIRCLE':
      return Math.PI * e.radius * e.radius;
    case 'ELLIPSE':
      return Math.PI * len(e.majorAxis) * len(e.majorAxis) * e.ratio;
    case 'POLYLINE':
      return e.closed ? Math.abs(bulgedArea(e.points, e.bulges)) : null;
    case 'SPLINE':
      return isClosedProfile(e) ? Math.abs(polygonArea(curvePoints(e)[0]!)) : null;
    case 'HATCH':
      return Math.abs(e.boundaries.reduce((s, b, i) => s + (i === 0 ? 1 : -1) * Math.abs(polygonArea(b)), 0));
    default:
      return null;
  }
}

export function entityBBox(e: Entity): { min: Vec3; max: Vec3 } | null {
  let pts: Vec3[];
  if (e.type === '3DSOLID') return e.display.bbox;
  if (e.type === 'CIRCLE') return { min: sub(e.center, { x: e.radius, y: e.radius, z: 0 }), max: add(e.center, { x: e.radius, y: e.radius, z: 0 }) };
  pts = curvePoints(e).flat();
  if (!pts.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    min.x = Math.min(min.x, p.x), min.y = Math.min(min.y, p.y), min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x), max.y = Math.max(max.y, p.y), max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// Hachures
// ---------------------------------------------------------------------------

interface PatternFamily {
  angle: number;
  spacing: number;
  /** décalage le long de la ligne (non utilisé pour les motifs continus) */
}

const PATTERNS: Record<string, PatternFamily[]> = {
  ANSI31: [{ angle: Math.PI / 4, spacing: 3.175 }],
  ANSI37: [
    { angle: Math.PI / 4, spacing: 3.175 },
    { angle: -Math.PI / 4, spacing: 3.175 },
  ],
  NET: [
    { angle: 0, spacing: 3.175 },
    { angle: Math.PI / 2, spacing: 3.175 },
  ],
};

/**
 * Segments d'un motif de hachures, découpés par les contours (règle pair-impair :
 * les contours intérieurs forment des îlots).
 */
export function hatchSegments(boundaries: Vec3[][], pattern: string, patScale: number, patAngle: number, maxLines = 4000): Vec3[][] {
  const fams = PATTERNS[pattern];
  if (!fams || !boundaries.length) return [];
  const z = boundaries[0]![0]?.z ?? 0;
  const out: Vec3[][] = [];
  for (const f of fams) {
    const a = f.angle + patAngle;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const n = { x: -u.y, y: u.x };
    const spacing = f.spacing * patScale;
    let lo = Infinity, hi = -Infinity;
    for (const b of boundaries) for (const p of b) {
      const s = p.x * n.x + p.y * n.y;
      lo = Math.min(lo, s), hi = Math.max(hi, s);
    }
    const count = Math.ceil((hi - lo) / spacing);
    if (count > maxLines) continue;
    for (let i = Math.floor(lo / spacing); i * spacing <= hi; i++) {
      const s = i * spacing;
      const ts: number[] = [];
      for (const b of boundaries) {
        for (let k = 0; k < b.length; k++) {
          const p = b[k]!, q = b[(k + 1) % b.length]!;
          const sp = p.x * n.x + p.y * n.y, sq = q.x * n.x + q.y * n.y;
          if ((sp <= s && sq > s) || (sq <= s && sp > s)) {
            const t = (s - sp) / (sq - sp);
            const x = p.x + t * (q.x - p.x), y = p.y + t * (q.y - p.y);
            ts.push(x * u.x + y * u.y);
          }
        }
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k += 2) {
        const base = { x: n.x * s, y: n.y * s };
        out.push([
          { x: base.x + u.x * ts[k]!, y: base.y + u.y * ts[k]!, z },
          { x: base.x + u.x * ts[k + 1]!, y: base.y + u.y * ts[k + 1]!, z },
        ]);
      }
    }
  }
  return out;
}

/** Point dans le domaine hachuré (pair-impair). */
export function pointInLoops(p: Vec3, loops: Vec3[][]): boolean {
  let inside = false;
  for (const b of loops) {
    for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
      const pi = b[i]!, pj = b[j]!;
      if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
    }
  }
  return inside;
}

export function circleFromThreePoints(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
    z: a.z,
  };
  return { center, radius: Math.hypot(a.x - center.x, a.y - center.y) };
}

/** Arc passant par trois points (début, point intermédiaire, fin). */
export function arcFromThreePoints(a: Vec3, m: Vec3, b: Vec3): { center: Vec3; radius: number; startAngle: number; endAngle: number } | null {
  const c = circleFromThreePoints(a, m, b);
  if (!c) return null;
  const sa = angleXY(c.center, a), sm = angleXY(c.center, m), sb = angleXY(c.center, b);
  const ccw = normAngle(sm - sa) < normAngle(sb - sa);
  return ccw
    ? { ...c, startAngle: normAngle(sa), endAngle: normAngle(sb) }
    : { ...c, startAngle: normAngle(sb), endAngle: normAngle(sa) };
}
