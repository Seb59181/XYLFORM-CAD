/**
 * Mise en plan avancée : vues en coupe hachurées, vues de détail agrandies, nomenclature et
 * numéros de repère (bulles), rappels de perçage (« M8 prof. 12 »). Les vues en coupe et de
 * détail sont des vues de la feuille comme les autres : MAJVUES les régénère.
 */
import type { Vec3 } from '../core/commands/types';
import type { DrawingSheet, DrawingView, Entity, NewEntity } from '../core/document/Document';
import { curvePoints } from '../core/entities/geometry';
import type { HoleSpec } from '../core/geometry/holes';
import type { HlrResult, SolidResult } from '../kernel/protocol';
import type { AppHost } from './AppHost';
import { axisCurves, cleanProjection, curveEntity, extentOf, LAYERS, project, yDirOf, type ViewGeometry } from './drawing';
import { materialById } from '../core/materials';

type P2 = [number, number];
type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// ---------------------------------------------------------------------------------------------
// Vues et repères
// ---------------------------------------------------------------------------------------------

/** Point 3D du modèle (sur le plan passant par l'origine, face à la vue) d'un point de la vue. */
export function viewTo3d(v: Pick<DrawingView, 'at' | 'dir' | 'xDir'>, p: Vec3): Vec3 {
  const y = yDirOf(v.dir, v.xDir);
  return add(mul(v.xDir, p.x - v.at.x), mul(y, p.y - v.at.y));
}

/** Direction 3D d'un vecteur de la vue. */
export function viewVector(v: Pick<DrawingView, 'dir' | 'xDir'>, d: Vec3): Vec3 {
  return add(mul(v.xDir, d.x), mul(yDirOf(v.dir, v.xDir), d.y));
}

export function viewPoint(v: Pick<DrawingView, 'at' | 'dir' | 'xDir'>, p: Vec3): Vec3 {
  const [x, y] = project(p, v.dir, v.xDir);
  return { x: v.at.x + x, y: v.at.y + y, z: 0 };
}

/** Feuille et vue qui contiennent une entité générée. */
export function viewOfHandle(app: AppHost, handle: string): { sheet: DrawingSheet; view: DrawingView } | null {
  for (const sheet of app.doc.sheets) for (const view of sheet.views) if (view.handles.includes(handle)) return { sheet, view };
  return null;
}

/** Emprise d'une vue (ses entités) dans le dessin. */
export function viewBounds(app: AppHost, v: DrawingView): { min: Vec3; max: Vec3 } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const h of v.handles) {
    const e = app.doc.get(h);
    if (!e || e.type === 'TEXT') continue;
    for (const pl of curvePoints(e)) for (const p of pl) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  }
  return Number.isFinite(x0) ? { min: { x: x0, y: y0, z: 0 }, max: { x: x1, y: y1, z: 0 } } : null;
}

/** Vue sous un point du dessin (emprise élargie de 2 %), la plus petite si plusieurs. */
export function viewAt(app: AppHost, p: Vec3): { sheet: DrawingSheet; view: DrawingView } | null {
  let best: { sheet: DrawingSheet; view: DrawingView; area: number } | null = null;
  for (const sheet of app.doc.sheets)
    for (const view of sheet.views) {
      const b = viewBounds(app, view);
      if (!b) continue;
      const m = 0.02 * Math.max(b.max.x - b.min.x, b.max.y - b.min.y) + 1e-6;
      if (p.x < b.min.x - m || p.x > b.max.x + m || p.y < b.min.y - m || p.y > b.max.y + m) continue;
      const area = (b.max.x - b.min.x) * (b.max.y - b.min.y);
      if (!best || area < best.area) best = { sheet, view, area };
    }
  return best;
}

/** Solide vu sous un point d'une vue : celui dont la boîte, traversée par la ligne de visée, est la plus proche. */
export function solidAt(app: AppHost, v: DrawingView, p: Vec3): Solid3D | null {
  const o = viewTo3d(v, p);
  let best: { s: Solid3D; t: number } | null = null;
  for (const h of v.sources) {
    const s = app.doc.get(h);
    if (s?.type !== '3DSOLID') continue;
    const { min, max } = s.display.bbox;
    let t0 = -Infinity, t1 = Infinity;
    for (const k of ['x', 'y', 'z'] as const) {
      const d = v.dir[k], a = o[k];
      if (Math.abs(d) < 1e-12) {
        if (a < min[k] - 1e-6 || a > max[k] + 1e-6) (t0 = Infinity), (t1 = -Infinity);
        continue;
      }
      const ta = (min[k] - a) / d, tb = (max[k] - a) / d;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (t0 > t1) continue;
    // `dir` pointe vers l'observateur : le plus proche a la plus grande sortie
    if (!best || t1 > best.t) best = { s, t: t1 };
  }
  return best?.s ?? null;
}

// ---------------------------------------------------------------------------------------------
// Vue en coupe
// ---------------------------------------------------------------------------------------------

export interface SectionGeometry extends ViewGeometry {
  /** Contours de la matière coupée, dans le repère de la vue. */
  hatch: P2[][];
}

/** Contours des faces posées sur le plan de coupe (arêtes de bord des triangles du plan). */
export function planeLoops(display: SolidResult['display'], origin: Vec3, normal: Vec3, tol: number): Vec3[][] {
  const P = display.positions, I = display.indices;
  const at = (i: number): Vec3 => ({ x: P[3 * i]!, y: P[3 * i + 1]!, z: P[3 * i + 2]! });
  const on = (p: Vec3) => Math.abs(dot({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }, normal)) <= tol;
  const q = (p: Vec3) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)},${Math.round(p.z / tol)}`;
  const pts = new Map<string, Vec3>();
  const count = new Map<string, number>();
  const edges: [string, string][] = [];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const v = [at(I[t]!), at(I[t + 1]!), at(I[t + 2]!)];
    if (!v.every(on)) continue;
    const k = v.map((p) => {
      const s = q(p);
      pts.set(s, p);
      return s;
    });
    for (let i = 0; i < 3; i++) {
      const a = k[i]!, b = k[(i + 1) % 3]!;
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      edges.push([a, b]);
    }
  }
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (count.get(key) !== 1) continue;
    const l = next.get(a) ?? [];
    l.push(b);
    next.set(a, l);
  }
  const loops: Vec3[][] = [];
  for (const start of [...next.keys()]) {
    if (!next.get(start)?.length) continue;
    const loop: Vec3[] = [];
    let cur = start;
    for (let guard = 0; guard < 1e6; guard++) {
      loop.push(pts.get(cur)!);
      const l = next.get(cur);
      const n = l?.pop();
      if (!n) break;
      cur = n;
      if (cur === start) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Projection de la matière gardée derrière le plan de coupe, avec les contours à hachurer. */
export async function computeSection(
  app: AppHost,
  sources: string[],
  plane: { origin: Vec3; normal: Vec3 },
  dir: Vec3,
  xDir: Vec3,
  opts: { smooth: boolean; axes: boolean; ext: number },
): Promise<SectionGeometry> {
  const solids = sources.map((h) => app.doc.get(h)).filter((e): e is Solid3D => e?.type === '3DSOLID');
  const parts: SolidResult[] = [];
  for (const s of solids) {
    try {
      parts.push(...(await app.kernel.call<SolidResult[]>({ op: 'slice', shapeId: s.shapeId, origin: plane.origin, normal: plane.normal, keep: 'positive' })));
    } catch {
      /* le plan ne coupe pas ce solide de ce côté : rien derrière */
    }
  }
  try {
    if (!parts.length) return { visible: [], hidden: [], smooth: [], axes: [], extent: null, hatch: [] };
    const r = await app.kernel.call<HlrResult>({ op: 'hlr', shapeIds: parts.map((p) => p.shapeId), dir, xDir, hidden: false, smooth: opts.smooth });
    const diag = solids.reduce((m, s) => Math.max(m, Math.hypot(s.display.bbox.max.x - s.display.bbox.min.x, s.display.bbox.max.y - s.display.bbox.min.y, s.display.bbox.max.z - s.display.bbox.min.z)), 1);
    const g = cleanProjection(r, Math.max(1e-4, diag * 1e-5));
    const hatch = parts.flatMap((p) => planeLoops(p.display, plane.origin, plane.normal, Math.max(1e-5, diag * 1e-6))).map((l) => l.map((p) => project(p, dir, xDir)));
    const axes = opts.axes ? axisCurves(r.cylinders, dir, xDir, opts.ext) : [];
    return { ...g, axes, hatch, extent: extentOf([...g.visible, ...g.hidden]) };
  } finally {
    if (parts.length) void app.kernel.call({ op: 'release', shapeIds: parts.map((p) => p.shapeId) }).catch(() => undefined);
  }
}

/** Entités d'une vue en coupe : contours, hachures ANSI31, axes, titre « COUPE A-A ». */
export function sectionEntities(g: SectionGeometry, at: Vec3, label: string, k: number): NewEntity[] {
  const V = (p: P2): Vec3 => ({ x: at.x + p[0], y: at.y + p[1], z: 0 });
  const out: NewEntity[] = [
    ...g.visible.map((c) => curveEntity(c, at, LAYERS.visible.name)),
    ...g.smooth.map((c) => curveEntity(c, at, LAYERS.smooth.name)),
    ...g.axes.map((c) => curveEntity(c, at, LAYERS.axes.name)),
  ];
  if (g.hatch.length) out.push({ type: 'HATCH', layer: LAYERS.hatch.name, boundaries: g.hatch.map((l) => l.map(V)), pattern: 'ANSI31', scale: k, angle: 0 });
  if (g.extent) out.push(titleText(`COUPE ${label}-${label}`, { x: at.x + (g.extent.min[0] + g.extent.max[0]) / 2, y: at.y + g.extent.min[1] - 9 * k, z: 0 }, k));
  return out;
}

const titleText = (text: string, at: Vec3, k: number): NewEntity => ({ type: 'TEXT', layer: LAYERS.dims.name, position: at, height: 5 * k, text, rotation: 0, align: 'center', valign: 'top' });

/** Trait de coupe sur la vue d'origine : trait mixte, extrémités épaisses, flèches et lettres. */
export function cutLineEntities(a: Vec3, b: Vec3, side: Vec3, label: string, k: number): NewEntity[] {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L, z: 0 };
  const ext = 4 * k, tick = 7 * k, arrow = 6 * k, h = 5 * k;
  const A = add(a, mul(u, -ext)), B = add(b, mul(u, ext));
  const out: NewEntity[] = [{ type: 'LINE', layer: LAYERS.axes.name, start: A, end: B }];
  for (const [p, s] of [[A, 1], [B, -1]] as const) {
    const q = add(p, mul(u, s * tick));
    out.push({ type: 'POLYLINE', layer: LAYERS.visible.name, points: [p, q], closed: false });
    // flèche dans le sens d'observation (vers la matière gardée)
    const base = add(p, mul(u, (s * tick) / 2));
    const tip = add(base, mul(side, arrow * 1.6));
    const back = add(base, mul(side, arrow * 0.6));
    const n = { x: -side.y, y: side.x, z: 0 };
    out.push({ type: 'LINE', layer: LAYERS.dims.name, start: base, end: back });
    out.push({ type: 'HATCH', layer: LAYERS.dims.name, boundaries: [[tip, add(back, mul(n, arrow * 0.3)), add(back, mul(n, -arrow * 0.3))]], pattern: 'SOLID', scale: 1, angle: 0 });
    out.push({ type: 'TEXT', layer: LAYERS.dims.name, position: add(tip, mul(side, h * 0.4)), height: h, text: label, rotation: 0, align: 'center', valign: side.y < -0.5 ? 'top' : side.y > 0.5 ? 'bottom' : 'middle' });
  }
  return out;
}

/** Plan de coupe d'un trait tracé sur une vue et du côté regardé. */
export function sectionPlane(v: DrawingView, a: Vec3, b: Vec3, sidePoint: Vec3): { origin: Vec3; normal: Vec3; side2d: Vec3; dir: Vec3; xDir: Vec3 } {
  const u2 = { x: b.x - a.x, y: b.y - a.y, z: 0 };
  const L = Math.hypot(u2.x, u2.y) || 1;
  const n2a = { x: -u2.y / L, y: u2.x / L, z: 0 };
  const s = (sidePoint.x - a.x) * n2a.x + (sidePoint.y - a.y) * n2a.y >= 0 ? 1 : -1;
  const side2d = mul(n2a, s);
  const normal = unit(viewVector(v, side2d));
  const origin = viewTo3d(v, a);
  // on regarde dans le sens de la normale : direction vers l'observateur = −normale
  const dir = mul(normal, -1);
  let xDir = unit(viewVector(v, u2));
  // haut de la vue en coupe : celui de la vue d'origine s'il n'est pas dans l'axe de visée
  const up = Math.abs(dot(yDirOf(v.dir, v.xDir), normal)) < 0.9 ? yDirOf(v.dir, v.xDir) : v.dir;
  if (dot(yDirOf(dir, xDir), up) < 0) xDir = mul(xDir, -1);
  return { origin, normal, side2d, dir, xDir };
}

// ---------------------------------------------------------------------------------------------
// Vue de détail
// ---------------------------------------------------------------------------------------------

/** Morceaux d'une polyligne à l'intérieur d'un cercle (extrémités recalculées sur le cercle). */
export function clipToCircle(pl: Vec3[], c: Vec3, r: number): Vec3[][] {
  const inside = (p: Vec3) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= r * r;
  const out: Vec3[][] = [];
  let cur: Vec3[] = [];
  const cut = (a: Vec3, b: Vec3): number[] => {
    const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - c.x, fy = a.y - c.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    const D = B * B - 4 * A * C;
    if (A < 1e-18 || D < 0) return [];
    const s = Math.sqrt(D);
    return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t > 0 && t < 1).sort((x, y) => x - y);
  };
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 });
  for (let i = 0; i < pl.length; i++) {
    const p = pl[i]!;
    if (i === 0) {
      if (inside(p)) cur.push(p);
      continue;
    }
    const a = pl[i - 1]!;
    const ts = cut(a, p);
    let inA = inside(a);
    for (const t of ts) {
      const q = lerp(a, p, t);
      if (inA) {
        cur.push(q);
        if (cur.length > 1) out.push(cur);
        cur = [];
      } else cur = [q];
      inA = !inA;
    }
    if (inside(p)) cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Entités d'une vue de détail : traits de la vue d'origine dans le cercle, agrandis. */
export function detailEntities(app: AppHost, parent: DrawingView, d: { center: Vec3; radius: number; scale: number; label: string }, at: Vec3, k: number): NewEntity[] {
  const out: NewEntity[] = [];
  const S = (p: Vec3): Vec3 => ({ x: at.x + (p.x - d.center.x) * d.scale, y: at.y + (p.y - d.center.y) * d.scale, z: 0 });
  for (const h of parent.handles) {
    const e = app.doc.get(h);
    if (!e || e.type === 'TEXT' || e.type === 'HATCH') continue;
    for (const pl of curvePoints(e))
      for (const piece of clipToCircle(pl, d.center, d.radius)) {
        const pts = piece.map(S);
        out.push(pts.length === 2 ? { type: 'LINE', layer: e.layer, start: pts[0]!, end: pts[1]! } : { type: 'POLYLINE', layer: e.layer, points: pts, closed: false });
      }
  }
  out.push({ type: 'CIRCLE', layer: LAYERS.smooth.name, center: at, radius: d.radius * d.scale });
  out.push(titleText(`DÉTAIL ${d.label} (${fmtScale(d.scale)})`, { x: at.x, y: at.y - d.radius * d.scale - 6 * k, z: 0 }, k));
  return out;
}

const fmtScale = (s: number) => (s >= 1 ? `${+s.toFixed(2)} : 1` : `1 : ${+(1 / s).toFixed(2)}`);

/** Cercle et lettre du détail sur la vue d'origine. */
export function detailMarks(center: Vec3, radius: number, label: string, k: number): NewEntity[] {
  const h = 5 * k;
  return [
    { type: 'CIRCLE', layer: LAYERS.dims.name, center, radius },
    { type: 'TEXT', layer: LAYERS.dims.name, position: { x: center.x + radius * 0.75 + h * 0.3, y: center.y + radius * 0.75 + h * 0.3, z: 0 }, height: h, text: label, rotation: 0 },
  ];
}

/** Lettre libre suivante (A, B, C…) parmi les coupes et détails des feuilles. */
export function nextLetter(app: AppHost): string {
  const used = new Set(app.doc.sheets.flatMap((s) => s.views.map((v) => v.section?.label ?? v.detail?.label).filter(Boolean)));
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    if (!used.has(l) && l !== 'I' && l !== 'O') return l;
  }
  return 'Z';
}

// ---------------------------------------------------------------------------------------------
// Nomenclature et repères
// ---------------------------------------------------------------------------------------------

export interface BomRow {
  item: number;
  qty: number;
  name: string;
  material: string;
  handles: string[];
}

/** Lignes de nomenclature : solides des vues d'une feuille, identiques (nom, volume, matière) regroupés. */
export function bomRows(app: AppHost, sheet: DrawingSheet): BomRow[] {
  const rows: BomRow[] = [];
  const seen = new Set<string>();
  for (const v of sheet.views)
    for (const h of v.sources) {
      if (seen.has(h)) continue;
      seen.add(h);
      const s = app.doc.get(h);
      if (s?.type !== '3DSOLID') continue;
      const name = s.name || 'Pièce';
      const material = (s.material && materialById(s.material)?.label) || '—';
      const vol = Math.round(s.display.volume * 100) / 100;
      const row = rows.find((r) => r.name === name && r.material === material && Math.abs((app.doc.get(r.handles[0]!) as Solid3D).display.volume - vol) <= Math.max(0.01, vol * 1e-6));
      if (row) row.qty++, row.handles.push(h);
      else rows.push({ item: rows.length + 1, qty: 1, name, material, handles: [h] });
    }
  return rows;
}

/** Numéro de repère d'un solide (première feuille qui le montre). */
export function itemNumber(app: AppHost, handle: string): number | null {
  for (const s of app.doc.sheets) {
    const r = bomRows(app, s).find((x) => x.handles.includes(handle));
    if (r) return r.item;
  }
  return null;
}

/** Tableau de nomenclature : en-tête en bas (au-dessus du cartouche), repères croissants vers le haut. */
export function bomEntities(rows: BomRow[], at: Vec3, k: number): NewEntity[] {
  const cols = [14, 14, 80, 46].map((w) => w * k);
  const titles = ['Rep.', 'Qté', 'Désignation', 'Matière'];
  const rh = 7 * k, th = 3.5 * k;
  const W = cols.reduce((a, b) => a + b, 0);
  const n = rows.length + 1;
  const out: NewEntity[] = [];
  const L = 'MEP-Cadre';
  const P = (x: number, y: number): Vec3 => ({ x: at.x + x, y: at.y + y, z: 0 });
  for (let i = 0; i <= n; i++) out.push({ type: 'LINE', layer: L, start: P(0, i * rh), end: P(W, i * rh) });
  let x = 0;
  for (let c = 0; c <= cols.length; c++) {
    out.push({ type: 'LINE', layer: L, start: P(x, 0), end: P(x, n * rh) });
    x += cols[c] ?? 0;
  }
  const cell = (r: number, c: number, text: string) => {
    const x0 = cols.slice(0, c).reduce((a, b) => a + b, 0);
    out.push({ type: 'TEXT', layer: L, position: P(c >= 2 ? x0 + 2 * k : x0 + cols[c]! / 2, r * rh + rh / 2), height: th, text, rotation: 0, align: c >= 2 ? 'left' : 'center', valign: 'middle' });
  };
  titles.forEach((t, c) => cell(0, c, t));
  rows.forEach((row, i) => [String(row.item), String(row.qty), row.name, row.material].forEach((t, c) => cell(i + 1, c, t)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rappels de perçage
// ---------------------------------------------------------------------------------------------

const f = (v: number) => `${+v.toFixed(2)}`;

/** Texte de rappel d'un perçage de l'assistant (« 4× M8 prof. 12 », lamage, fraisure…). */
export function holeCallout(spec: HoleSpec, count: number): string {
  const n = count > 1 ? `${count}× ` : '';
  const depth = spec.depth > 0 ? ` prof. ${f(spec.depth)}` : ' traversant';
  switch (spec.type) {
    case 'tapped':
      return `${n}${spec.size}${spec.pitch && spec.nominal ? `×${f(spec.pitch)}` : ''}${depth}\nperçage Ø${f(spec.diameter)}`;
    case 'counterbore':
      return `${n}Ø${f(spec.diameter)}${depth}\nlamage Ø${f(spec.cbDiameter ?? 0)} prof. ${f(spec.cbDepth ?? 0)}`;
    case 'countersink':
      return `${n}Ø${f(spec.diameter)}${depth}\nfraisure Ø${f(spec.csDiameter ?? 0)} × 90°`;
    case 'insert':
      return `${n}insert ${spec.size} Ø${f(spec.diameter)}${depth}`;
    default:
      return `${n}Ø${f(spec.diameter)}${depth}`;
  }
}

/** Perçage de l'historique des solides de la vue dont l'axe tombe sur `center` (point de la vue). */
export function holeAt(app: AppHost, v: DrawingView, center: Vec3, tol: number): { spec: HoleSpec; count: number } | null {
  for (const h of v.sources) {
    const s = app.doc.get(h);
    if (s?.type !== '3DSOLID' || !s.history) continue;
    for (const ft of s.history) {
      if (ft.kind !== 'hole' || ft.off) continue;
      if (Math.abs(dot(unit(ft.normal), v.dir)) < 0.99) continue;
      for (const p of ft.at) {
        const q = viewPoint(v, p);
        if (Math.hypot(q.x - center.x, q.y - center.y) <= tol) return { spec: ft.spec, count: ft.at.length };
      }
    }
  }
  return null;
}

export const unitCross = (a: Vec3, b: Vec3) => unit(cross(a, b));
