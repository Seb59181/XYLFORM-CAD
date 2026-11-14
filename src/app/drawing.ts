/**
 * Mise en plan : vues projetées
 * d'un modèle 3D avec élimination des lignes cachées, axes et marques de centre, cadre et
 * cartouche à l'échelle. Les vues sont tracées en vraie grandeur dans le plan XY (les cotes
 * mesurent donc les vraies dimensions) ; seul le cadre est agrandi de 1/échelle.
 */
import type { Vec3 } from '../core/commands/types';
import type { DrawingSheet, DrawingView, Entity, NewEntity, PaperFormat } from '../core/document/Document';
import type { Linetype } from '../core/linetypes';
import type { HlrCurve, HlrResult } from '../kernel/protocol';
import type { AppHost } from './AppHost';
import { materialById } from '../core/materials';

type P2 = [number, number];
type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

// ---------------------------------------------------------------------------------------------
// Vues normalisées
// ---------------------------------------------------------------------------------------------

export type ViewKind = 'front' | 'top' | 'left' | 'right' | 'bottom' | 'back' | 'iso';

const S3 = 1 / Math.sqrt(3), S2 = 1 / Math.sqrt(2);

export const VIEWS: Record<ViewKind, { name: string; dir: Vec3; xDir: Vec3 }> = {
  front: { name: 'Face', dir: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } },
  top: { name: 'Dessus', dir: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
  left: { name: 'Gauche', dir: { x: -1, y: 0, z: 0 }, xDir: { x: 0, y: -1, z: 0 } },
  right: { name: 'Droite', dir: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } },
  bottom: { name: 'Dessous', dir: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } },
  back: { name: 'Arrière', dir: { x: 0, y: 1, z: 0 }, xDir: { x: -1, y: 0, z: 0 } },
  iso: { name: 'Isométrique', dir: { x: -S3, y: -S3, z: S3 }, xDir: { x: S2, y: -S2, z: 0 } },
};

/**
 * Position des vues autour de la vue de face (colonne, rangée) : projection européenne
 * (ISO E, premier dièdre : la vue de dessus va SOUS la face, la vue de gauche à DROITE) ou
 * américaine (troisième dièdre : inverse).
 */
export function gridCell(kind: ViewKind, european: boolean): [number, number] {
  const s = european ? 1 : -1;
  switch (kind) {
    case 'front':
      return [0, 0];
    case 'top':
      return [0, -s];
    case 'bottom':
      return [0, s];
    case 'left':
      return [s, 0];
    case 'right':
      return [-s, 0];
    case 'back':
      return [european ? 2 : -2, 0];
    case 'iso':
      return [1, -1];
  }
}

export function yDirOf(dir: Vec3, x: Vec3): Vec3 {
  return { x: dir.y * x.z - dir.z * x.y, y: dir.z * x.x - dir.x * x.z, z: dir.x * x.y - dir.y * x.x };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

export function project(p: Vec3, dir: Vec3, xDir: Vec3): P2 {
  return [dot(p, xDir), dot(p, yDirOf(dir, xDir))];
}

// ---------------------------------------------------------------------------------------------
// Nettoyage du résultat de projection
// ---------------------------------------------------------------------------------------------

function samples(c: HlrCurve, n = 24): P2[] {
  if (c.k === 'line') return [c.a, c.b];
  if (c.k === 'poly') return c.pts;
  let a1 = c.a1;
  if (c.full) a1 = c.a0 + 2 * Math.PI;
  else while (a1 <= c.a0 + 1e-12) a1 += 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = c.a0 + ((a1 - c.a0) * i) / n;
    return [c.c[0] + c.r * Math.cos(a), c.c[1] + c.r * Math.sin(a)] as P2;
  });
}

/** Polyligne rectiligne → ligne. */
export function simplify(c: HlrCurve, tol: number): HlrCurve {
  if (c.k !== 'poly' || c.pts.length < 2) return c;
  const a = c.pts[0]!, b = c.pts[c.pts.length - 1]!;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < tol) return c;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  for (const p of c.pts) if (Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) > tol) return c;
  return { k: 'line', a, b };
}

function key(c: HlrCurve): string {
  const r = (v: number) => Math.round(v * 1000);
  if (c.k === 'arc') return `a${r(c.c[0])},${r(c.c[1])},${r(c.r)},${c.full ? 'f' : `${r(c.a0)},${r(c.a1)}`}`;
  const pts = c.k === 'line' ? [c.a, c.b] : c.pts;
  const s = pts.map((p) => `${r(p[0])},${r(p[1])}`);
  const f = s.join(';'), b = [...s].reverse().join(';');
  return f < b ? f : b;
}

/** Index spatial simple des segments visibles. */
class SegGrid {
  private cells = new Map<string, number[]>();
  private segs: [P2, P2][] = [];
  constructor(private readonly size: number) {}
  private k(x: number, y: number): string {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  add(a: P2, b: P2): void {
    const i = this.segs.push([a, b]) - 1;
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.size), x1 = Math.floor(Math.max(a[0], b[0]) / this.size);
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.size), y1 = Math.floor(Math.max(a[1], b[1]) / this.size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const kk = `${x},${y}`;
        let c = this.cells.get(kk);
        if (!c) this.cells.set(kk, (c = []));
        c.push(i);
      }
  }
  near(a: P2, b: P2): [P2, P2][] {
    const out = new Set<number>();
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.size), x1 = Math.floor(Math.max(a[0], b[0]) / this.size);
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.size), y1 = Math.floor(Math.max(a[1], b[1]) / this.size);
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) for (const i of this.cells.get(`${x},${y}`) ?? []) out.add(i);
    return [...out].map((i) => this.segs[i]!);
  }
  pointOn(p: P2, tol: number): boolean {
    return this.near(p, p).some(([a, b]) => distSeg(p, a, b) <= tol);
  }
}

function distSeg(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Supprime les doublons et les arêtes cachées confondues avec une arête visible (arête
 * arrière exactement derrière une arête avant) ; les lignes cachées partiellement recouvertes
 * sont raccourcies.
 */
export function cleanProjection(r: Pick<HlrResult, 'visible' | 'hidden' | 'smooth'>, tol = 1e-3): { visible: HlrCurve[]; hidden: HlrCurve[]; smooth: HlrCurve[] } {
  const dedupe = (cs: HlrCurve[], seen = new Set<string>()) =>
    cs
      .map((c) => simplify(c, tol))
      .filter((c) => {
        const k = key(c);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  const visible = dedupe(r.visible);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of visible) for (const p of samples(c, 8)) (minX = Math.min(minX, p[0])), (maxX = Math.max(maxX, p[0])), (minY = Math.min(minY, p[1])), (maxY = Math.max(maxY, p[1]));
  const grid = new SegGrid(Math.max((maxX - minX + maxY - minY) / 80, tol * 10, 1e-6) || 1);
  for (const c of visible) {
    const s = samples(c, 48);
    for (let i = 1; i < s.length; i++) grid.add(s[i - 1]!, s[i]!);
  }
  const covered = (c: HlrCurve) => samples(c, 16).every((p) => grid.pointOn(p, tol * 4));
  const hidden: HlrCurve[] = [];
  for (const c of dedupe(r.hidden)) {
    if (c.k !== 'line') {
      if (!covered(c)) hidden.push(c);
      continue;
    }
    // ligne : on retire les intervalles recouverts par des segments visibles colinéaires
    const [a, b] = [c.a, c.b];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < tol) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const iv: [number, number][] = [];
    for (const [p, q] of grid.near(a, b)) {
      const dp = (p[0] - a[0]) * uy - (p[1] - a[1]) * ux, dq = (q[0] - a[0]) * uy - (q[1] - a[1]) * ux;
      if (Math.abs(dp) > tol * 2 || Math.abs(dq) > tol * 2) continue;
      const t0 = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy, t1 = (q[0] - a[0]) * ux + (q[1] - a[1]) * uy;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
      if (hi > lo) iv.push([lo, hi]);
    }
    iv.sort((x, y) => x[0] - y[0]);
    let t = 0;
    const pt = (s: number): P2 => [a[0] + ux * s, a[1] + uy * s];
    for (const [lo, hi] of iv) {
      if (lo - t > tol * 4) hidden.push({ k: 'line', a: pt(t), b: pt(lo) });
      t = Math.max(t, hi);
    }
    if (L - t > tol * 4) hidden.push({ k: 'line', a: pt(t), b: pt(L) });
  }
  const smooth = dedupe(r.smooth).filter((c) => !covered(c));
  return { visible, hidden, smooth };
}

/** Emprise 2D d'un jeu de courbes. */
export function extentOf(cs: HlrCurve[]): { min: P2; max: P2 } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cs) {
    if (c.k === 'arc' && c.full) {
      (minX = Math.min(minX, c.c[0] - c.r)), (maxX = Math.max(maxX, c.c[0] + c.r)), (minY = Math.min(minY, c.c[1] - c.r)), (maxY = Math.max(maxY, c.c[1] + c.r));
      continue;
    }
    for (const p of samples(c, 32)) (minX = Math.min(minX, p[0])), (maxX = Math.max(maxX, p[0])), (minY = Math.min(minY, p[1])), (maxY = Math.max(maxY, p[1]));
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

// ---------------------------------------------------------------------------------------------
// Entités
// ---------------------------------------------------------------------------------------------

export const LAYERS: Record<'visible' | 'hidden' | 'axes' | 'smooth' | 'frame' | 'dims' | 'hatch', { name: string; color: string; lineweight: number; linetype?: Linetype }> = {
  visible: { name: 'MEP-Visible', color: '#ffffff', lineweight: 0.5 },
  hidden: { name: 'MEP-Cachées', color: '#9aa6b5', lineweight: 0.25, linetype: 'HIDDEN' },
  axes: { name: 'MEP-Axes', color: '#e06c5a', lineweight: 0.18, linetype: 'CENTER' },
  smooth: { name: 'MEP-Tangentes', color: '#7d8896', lineweight: 0.18 },
  frame: { name: 'MEP-Cadre', color: '#ffffff', lineweight: 0.35 },
  dims: { name: 'MEP-Cotes', color: '#4fa8e8', lineweight: 0.25 },
  hatch: { name: 'MEP-Hachures', color: '#9aa6b5', lineweight: 0.13 },
};

export function ensureDrawingLayers(app: AppHost): void {
  for (const l of Object.values(LAYERS)) {
    if (app.doc.layer(l.name)) continue;
    app.doc.addLayer(l.name, l.color);
    app.doc.updateLayer(l.name, { lineweight: l.lineweight, ...(l.linetype ? { linetype: l.linetype } : {}) });
  }
}

const V = (p: P2, at: Vec3): Vec3 => ({ x: at.x + p[0], y: at.y + p[1], z: at.z });

export function curveEntity(c: HlrCurve, at: Vec3, layer: string): NewEntity {
  if (c.k === 'line') return { type: 'LINE', layer, start: V(c.a, at), end: V(c.b, at) };
  if (c.k === 'arc') {
    const center = V(c.c, at);
    return c.full ? { type: 'CIRCLE', layer, center, radius: c.r } : { type: 'ARC', layer, center, radius: c.r, startAngle: c.a0, endAngle: c.a1 };
  }
  return { type: 'POLYLINE', layer, points: c.pts.map((p) => V(p, at)), closed: false };
}

/**
 * Axes des cylindres perpendiculaires à la vue (un seul trait par axe, même interrompu par
 * la matière : bossages alignés, alésages étagés), marques de centre de ceux qui lui font face.
 */
export function axisCurves(cyl: HlrResult['cylinders'], dir: Vec3, xDir: Vec3, ext: number): HlrCurve[] {
  const marks = new Map<string, { x: number; y: number; r: number }>();
  const lines = new Map<string, { p: P2; u: P2; t0: number; t1: number }>();
  const r3 = (v: number) => Math.round(v * 100);
  for (const c of cyl) {
    const along = Math.abs(dot(c.d, dir));
    if (along > 1 - 1e-6) {
      const [x, y] = project(c.c, dir, xDir);
      const k = `${r3(x)},${r3(y)}`;
      const m = marks.get(k);
      if (!m || m.r < c.r) marks.set(k, { x, y, r: c.r });
    } else if (along < 1e-6) {
      const p0 = project({ x: c.c.x + c.d.x * c.t0, y: c.c.y + c.d.y * c.t0, z: c.c.z + c.d.z * c.t0 }, dir, xDir);
      const p1 = project({ x: c.c.x + c.d.x * c.t1, y: c.c.y + c.d.y * c.t1, z: c.c.z + c.d.z * c.t1 }, dir, xDir);
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (L < 1e-9) continue;
      // direction canonique (x > 0, ou y > 0 si verticale) et droite repérée par sa distance à l'origine
      let ux = (p1[0] - p0[0]) / L, uy = (p1[1] - p0[1]) / L;
      if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) (ux = -ux), (uy = -uy);
      const off = p0[0] * uy - p0[1] * ux;
      const k = `${r3(ux * 100)},${r3(uy * 100)},${r3(off)}`;
      const ta = p0[0] * ux + p0[1] * uy, tb = p1[0] * ux + p1[1] * uy;
      const cur = lines.get(k);
      if (cur) (cur.t0 = Math.min(cur.t0, ta, tb)), (cur.t1 = Math.max(cur.t1, ta, tb));
      else lines.set(k, { p: [off * uy, -off * ux], u: [ux, uy], t0: Math.min(ta, tb), t1: Math.max(ta, tb) });
    }
  }
  const out: HlrCurve[] = [];
  for (const m of marks.values()) {
    const L = m.r + ext;
    out.push({ k: 'line', a: [m.x - L, m.y], b: [m.x + L, m.y] }, { k: 'line', a: [m.x, m.y - L], b: [m.x, m.y + L] });
  }
  for (const l of lines.values()) {
    const at = (t: number): P2 => [l.p[0] + l.u[0] * t, l.p[1] + l.u[1] * t];
    out.push({ k: 'line', a: at(l.t0 - ext), b: at(l.t1 + ext) });
  }
  return out;
}

export interface ViewGeometry {
  visible: HlrCurve[];
  hidden: HlrCurve[];
  smooth: HlrCurve[];
  axes: HlrCurve[];
  extent: { min: P2; max: P2 } | null;
}

/** Projection d'une vue par le noyau, nettoyée. */
export async function computeView(app: AppHost, sources: string[], dir: Vec3, xDir: Vec3, opts: { hidden: boolean; smooth: boolean; axes: boolean; ext: number }): Promise<ViewGeometry> {
  const solids = sources.map((h) => app.doc.get(h)).filter((e): e is Solid3D => e?.type === '3DSOLID');
  const r = await app.kernel.call<HlrResult>({ op: 'hlr', shapeIds: solids.map((s) => s.shapeId), dir, xDir, hidden: opts.hidden, smooth: opts.smooth });
  const diag = solids.reduce((m, s) => Math.max(m, Math.hypot(s.display.bbox.max.x - s.display.bbox.min.x, s.display.bbox.max.y - s.display.bbox.min.y, s.display.bbox.max.z - s.display.bbox.min.z)), 1);
  const g = cleanProjection(r, Math.max(1e-4, diag * 1e-5));
  const axes = opts.axes ? axisCurves(r.cylinders, dir, xDir, opts.ext) : [];
  return { ...g, axes, extent: extentOf([...g.visible, ...g.hidden]) };
}

/** Entités d'une vue placée en `at` (origine du modèle projetée). */
export function viewEntities(g: ViewGeometry, at: Vec3): NewEntity[] {
  return [
    ...g.visible.map((c) => curveEntity(c, at, LAYERS.visible.name)),
    ...g.hidden.map((c) => curveEntity(c, at, LAYERS.hidden.name)),
    ...g.smooth.map((c) => curveEntity(c, at, LAYERS.smooth.name)),
    ...g.axes.map((c) => curveEntity(c, at, LAYERS.axes.name)),
  ];
}

// ---------------------------------------------------------------------------------------------
// Cadre, cartouche, mise en page
// ---------------------------------------------------------------------------------------------

export const PAPER: Record<PaperFormat, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };

export function paperSize(format: PaperFormat, landscape: boolean): [number, number] {
  const [w, h] = PAPER[format];
  return landscape ? [w, h] : [h, w];
}

/** Échelles normalisées (unités du dessin par mm papier). */
export const SCALES: { k: number; label: string }[] = [
  { k: 0.1, label: '10:1' },
  { k: 0.2, label: '5:1' },
  { k: 0.5, label: '2:1' },
  { k: 1, label: '1:1' },
  { k: 2, label: '1:2' },
  { k: 2.5, label: '1:2,5' },
  { k: 5, label: '1:5' },
  { k: 10, label: '1:10' },
  { k: 20, label: '1:20' },
  { k: 50, label: '1:50' },
  { k: 100, label: '1:100' },
];

export function scaleLabel(k: number): string {
  const s = SCALES.find((x) => Math.abs(x.k - k) < 1e-9);
  if (s) return s.label;
  return k >= 1 ? `1:${+k.toFixed(3)}` : `${+(1 / k).toFixed(3)}:1`;
}

export const MARGIN = 10;
export const TITLE_W = 180;
export const TITLE_H = 32;

/** Cadre et cartouche (dimensions papier × k), coin inférieur gauche en `o`. */
export function frameEntities(sheet: Pick<DrawingSheet, 'format' | 'landscape' | 'k' | 'title'> & { origin: Vec3 }, info: { material?: string; date: string; sheetId: string; european: boolean }): NewEntity[] {
  if (!sheet.format) return [];
  const k = sheet.k, o = sheet.origin;
  const [W, H] = paperSize(sheet.format, sheet.landscape);
  const L = LAYERS.frame.name;
  const P = (x: number, y: number): Vec3 => ({ x: o.x + x * k, y: o.y + y * k, z: o.z });
  const rect = (x0: number, y0: number, x1: number, y1: number): NewEntity => ({ type: 'POLYLINE', layer: L, points: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], closed: true });
  const line = (x0: number, y0: number, x1: number, y1: number): NewEntity => ({ type: 'LINE', layer: L, start: P(x0, y0), end: P(x1, y1) });
  const text = (x: number, y: number, h: number, t: string, align: 'left' | 'center' = 'left'): NewEntity => ({ type: 'TEXT', layer: L, position: P(x, y), height: h * k, text: t, rotation: 0, align });
  const out: NewEntity[] = [];
  // bord de feuille (trait fin) et cadre intérieur
  out.push(rect(0, 0, W, H), rect(MARGIN, MARGIN, W - MARGIN, H - MARGIN));
  // repères de centrage
  out.push(line(W / 2, 0, W / 2, MARGIN), line(W / 2, H - MARGIN, W / 2, H), line(0, H / 2, MARGIN, H / 2), line(W - MARGIN, H / 2, W, H / 2));
  // cartouche
  const x0 = W - MARGIN - TITLE_W, y0 = MARGIN;
  const c1 = x0 + 110, c2 = x0 + 145, x1 = W - MARGIN;
  out.push(rect(x0, y0, x1, y0 + TITLE_H));
  out.push(line(x0, y0 + 8, x1, y0 + 8), line(x0, y0 + 16, x1, y0 + 16), line(c1, y0, c1, y0 + TITLE_H), line(c2, y0 + 8, c2, y0 + 16), line(x0 + 55, y0, x0 + 55, y0 + 8));
  out.push(text(x0 + 2, y0 + 28.5, 1.8, 'Titre'));
  out.push(text(x0 + 3, y0 + 19.5, 5, sheet.title || 'Sans titre'));
  out.push(text(x0 + 2, y0 + 10.8, 2.5, `Matière : ${info.material ?? '—'}`));
  out.push(text(c1 + 2, y0 + 10.8, 2.5, `Échelle ${scaleLabel(k)}`));
  out.push(text(c2 + 2, y0 + 10.8, 2.5, `Format ${sheet.format}`));
  out.push(text(x0 + 2, y0 + 2.8, 2.5, 'Dessiné avec Xylform CAD'));
  out.push(text(x0 + 57, y0 + 2.8, 2.5, `Date : ${info.date}`));
  out.push(text(c1 + 2, y0 + 2.8, 2.5, `Feuille ${info.sheetId} · cotes en mm`));
  // symbole de projection (ISO 5456-2)
  out.push(text(c1 + 2, y0 + 28.5, 1.8, info.european ? 'Projection européenne' : 'Projection américaine'));
  out.push(...projectionSymbol(P, c1 + 35, y0 + 21, info.european));
  return out;
}

/** Tronc de cône vu de face et de gauche (premier ou troisième dièdre). */
function projectionSymbol(P: (x: number, y: number) => Vec3, cx: number, cy: number, european: boolean): NewEntity[] {
  const L = LAYERS.frame.name;
  const side = european ? 1 : -1;
  // vue de face du tronc : trapèze (petite base du côté de la vue de gauche)
  const fx = cx - side * 7;
  const tr = [P(fx - side * 5, cy - 4), P(fx + side * 5, cy - 2), P(fx + side * 5, cy + 2), P(fx - side * 5, cy + 4)];
  const k = Math.hypot(P(1, 0).x - P(0, 0).x, P(1, 0).y - P(0, 0).y);
  const c = P(cx + side * 7, cy);
  return [
    { type: 'POLYLINE', layer: L, points: tr, closed: true },
    { type: 'CIRCLE', layer: L, center: c, radius: 4 * k },
    { type: 'CIRCLE', layer: L, center: c, radius: 2 * k },
  ];
}

/** Zone utile du cadre (mm papier), au-dessus du cartouche. */
export function usableArea(format: PaperFormat, landscape: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const [W, H] = paperSize(format, landscape);
  return { x0: MARGIN + 8, y0: MARGIN + TITLE_H + 8, x1: W - MARGIN - 8, y1: H - MARGIN - 8 };
}

export interface LaidView {
  kind: ViewKind;
  geom: ViewGeometry;
  /** Position de l'origine du modèle projetée. */
  at: Vec3;
}

/**
 * Disposition des vues en grille (colonnes et rangées alignées sur la vue de face, comme
 * l'exige la projection orthogonale), centrée sur `center`. `gap` : écart entre vues.
 */
export function layoutViews(views: { kind: ViewKind; geom: ViewGeometry }[], european: boolean, gap: number, center: P2): LaidView[] {
  const cells = views.map((v) => ({ ...v, cell: gridCell(v.kind, european) }));
  const cols = new Map<number, number>(), rows = new Map<number, number>();
  for (const v of cells) {
    const e = v.geom.extent;
    if (!e) continue;
    cols.set(v.cell[0], Math.max(cols.get(v.cell[0]) ?? 0, e.max[0] - e.min[0]));
    rows.set(v.cell[1], Math.max(rows.get(v.cell[1]) ?? 0, e.max[1] - e.min[1]));
  }
  const cx = [...cols.keys()].sort((a, b) => a - b), ry = [...rows.keys()].sort((a, b) => a - b);
  // centre de chaque colonne / rangée
  const colC = new Map<number, number>(), rowC = new Map<number, number>();
  let x = 0;
  for (const c of cx) colC.set(c, x + cols.get(c)! / 2), (x += cols.get(c)! + gap);
  let y = 0;
  for (const r of ry) rowC.set(r, y + rows.get(r)! / 2), (y += rows.get(r)! + gap);
  const W = x - gap, H = y - gap;
  return cells
    .filter((v) => v.geom.extent)
    .map((v) => {
      const e = v.geom.extent!;
      const mx = (e.min[0] + e.max[0]) / 2, my = (e.min[1] + e.max[1]) / 2;
      return { kind: v.kind, geom: v.geom, at: { x: center[0] - W / 2 + colC.get(v.cell[0])! - mx, y: center[1] - H / 2 + rowC.get(v.cell[1])! - my, z: 0 } };
    });
}

/** Emprise totale de vues disposées. */
export function laidExtent(vs: LaidView[]): { w: number; h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of vs) {
    const e = v.geom.extent!;
    (minX = Math.min(minX, v.at.x + e.min[0])), (maxX = Math.max(maxX, v.at.x + e.max[0])), (minY = Math.min(minY, v.at.y + e.min[1])), (maxY = Math.max(maxY, v.at.y + e.max[1]));
  }
  return Number.isFinite(minX) ? { w: maxX - minX, h: maxY - minY } : { w: 0, h: 0 };
}

/** Plus grande échelle normalisée qui loge les vues (de vraie grandeur `w`×`h`, écarts `gaps`) dans la zone. */
export function autoScale(w: number, h: number, gaps: [number, number], area: { x0: number; y0: number; x1: number; y1: number }): number {
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
  for (const s of SCALES) {
    // gaps exprimés en mm papier : ils ne grandissent pas avec l'échelle
    if (w / s.k + gaps[0] <= aw && h / s.k + gaps[1] <= ah) return s.k;
  }
  return SCALES[SCALES.length - 1]!.k;
}

/** Matière affichée au cartouche (première matière attribuée). */
export function materialLabel(app: AppHost, sources: string[]): string | undefined {
  for (const h of sources) {
    const e = app.doc.get(h);
    if (e?.type === '3DSOLID' && e.material) return materialById(e.material)?.label;
  }
  return undefined;
}

export function newViewRecord(id: string, kind: ViewKind, sources: string[], at: Vec3, opts: { hidden: boolean; smooth: boolean; axes: boolean }, handles: string[]): DrawingView {
  const v = VIEWS[kind];
  return { id, name: v.name, sources, dir: v.dir, xDir: v.xDir, at, hidden: kind !== 'iso' && opts.hidden, smooth: opts.smooth, axes: kind !== 'iso' && opts.axes, handles };
}
