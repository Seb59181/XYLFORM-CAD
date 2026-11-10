/**
 * Historique paramétrique des corps (une chronologie des opérations) : chaque corps
 * garde la liste des étapes qui l'ont construit (primitive, extrusion, congé, perçage,
 * soustraction d'un autre corps — lui-même avec son historique —, déplacements…). Modifier
 * une cote d'une étape, la supprimer ou changer un paramètre utilisateur rejoue tout
 * l'historique et remplace le corps (annulable).
 */
import { CommandCancelled, type Vec3 } from '../core/commands/types';
import { featureId, type CreateOp, type Feature, type ModifyOp } from '../core/document/Document';
import { evaluateParameters } from '../core/constraints/Solver';
import { HOLE_LABEL, holeProfile, holeTitle, SIZES, sizeLabel, standardHole, type HoleSpec, type HoleType } from '../core/geometry/holes';
import { add, cross, dist, len, norm, scale } from '../core/math/affine';
import type { Affine, DisplayMesh, KernelRequest, SolidResult } from '../kernel/protocol';
import type { Constraint } from '../core/constraints/types';

export type Kernel = (req: KernelRequest) => Promise<SolidResult>;

// ---------------------------------------------------------------------------
// Chemins dans l'historique (étapes imbriquées des outils de booléens)
// ---------------------------------------------------------------------------

/** Chemin d'une étape : [i] ou [i, outil, j, outil, k…]. */
export type FeaturePath = number[];

export function featureAt(h: Feature[], path: FeaturePath): Feature | undefined {
  let list = h;
  let f: Feature | undefined;
  for (let k = 0; k < path.length; k += 2) {
    f = list[path[k]!];
    if (!f) return undefined;
    if (k + 1 < path.length) {
      if (f.kind !== 'boolean') return undefined;
      list = f.tools[path[k + 1]!] ?? [];
    }
  }
  return f;
}

/** Copie de l'historique où l'étape `path` est remplacée (null = retirée). */
export function replaceAt(h: Feature[], path: FeaturePath, next: Feature | null): Feature[] {
  const [i, t, ...rest] = path;
  if (t === undefined) return next ? h.map((f, k) => (k === i ? next : f)) : h.filter((_, k) => k !== i);
  return h.map((f, k) => (k === i && f.kind === 'boolean' ? { ...f, tools: f.tools.map((tl, n) => (n === t ? replaceAt(tl, rest, next) : tl)) } : f));
}

// ---------------------------------------------------------------------------
// Titres et cotes modifiables
// ---------------------------------------------------------------------------

const f2 = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');

export function featureTitle(f: Feature): string {
  switch (f.kind) {
    case 'create': {
      const o = f.op;
      switch (o.op) {
        case 'box':
          return `Boîte ${f2(Math.abs(o.size.x))} × ${f2(Math.abs(o.size.y))} × ${f2(Math.abs(o.size.z))}`;
        case 'cylinder':
          return `Cylindre Ø${f2(o.radius * 2)} × ${f2(Math.abs(o.height))}`;
        case 'cone':
          return `Cône Ø${f2(o.radius * 2)} × ${f2(Math.abs(o.height))}`;
        case 'sphere':
          return `Sphère Ø${f2(o.radius * 2)}`;
        case 'torus':
          return `Tore R${f2(o.radius)} r${f2(o.tubeRadius)}`;
        case 'pyramid':
          return `Pyramide ${o.sides} côtés × ${f2(Math.abs(o.height))}`;
        case 'extrude':
          return `${f.name} ${f2(o.direction ? len(o.direction) : o.height)}`;
        case 'revolve':
          return `${f.name} ${f2(o.angleDeg)}°`;
        case 'extrudeRegions':
          return `${f.name} (${f2(len(o.direction))})`;
        case 'sheetMetal':
          return `Tôle ép. ${f2(o.def.thickness)}, ${o.def.flanges.length} bord(s)`;
        default:
          return f.name;
      }
    }
    case 'modify': {
      const o = f.op;
      switch (o.op) {
        case 'fillet':
          return `${f.name} R${f2(o.radius)}${o.radius2 !== undefined ? `→${f2(o.radius2)}` : ''}`;
        case 'chamfer':
          return `${f.name} ${f2(o.distance)}`;
        case 'shell':
          return `${f.name} ${f2(o.thickness)}`;
        case 'pressPull':
          return `${f.name} ${o.distance > 0 ? '+' : ''}${f2(o.distance)}`;
        case 'thicken':
          return `${f.name} ${f2(o.thickness)}`;
      }
      return f.name;
    }
    case 'transform':
      return f.name;
    case 'boolean':
      return f.name;
    case 'hole':
      return `${holeTitle(f.spec)}${f.at.length > 1 ? ` (${f.at.length} trous)` : ''}`;
    case 'part':
      return `${f.name}${f.realThread ? ' (filetage réel)' : ''}`;
  }
}

/** L'historique contient-il un filetage réel (pièce ou trou taraudé), outils compris ? */
export function hasRealThread(h: Feature[] | undefined): boolean {
  return !!h?.some((f) => !f.off && ((f.kind === 'part' && !!f.realThread) || (f.kind === 'hole' && f.spec.type === 'tapped' && !!f.spec.thread) || (f.kind === 'boolean' && f.tools.some(hasRealThread))));
}

export interface FeatureParam {
  key: string;
  label: string;
  type: 'number' | 'select' | 'checkbox';
  value: number | string | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  integer?: boolean;
  /** Valeur 0 autorisée (profondeur 0 = débouchant…). */
  allowZero?: boolean;
  hint?: string;
}

const num = (key: string, label: string, value: number, extra: Partial<FeatureParam> = {}): FeatureParam => ({ key, label, type: 'number', value, ...extra });
const sgn = (v: number) => (v < 0 ? -1 : 1);

/** Cotes modifiables d'une étape (valeurs courantes). */
export function featureParams(f: Feature): FeatureParam[] {
  if (f.kind === 'create') {
    const o = f.op;
    switch (o.op) {
      case 'box':
        return [num('L', 'Longueur', Math.abs(o.size.x)), num('W', 'Largeur', Math.abs(o.size.y)), num('H', 'Hauteur', Math.abs(o.size.z))];
      case 'cylinder':
        return [num('D', 'Diamètre', o.radius * 2), num('H', 'Hauteur', Math.abs(o.height))];
      case 'cone':
        return [num('D', 'Diamètre de base', o.radius * 2), num('D2', 'Diamètre au sommet', o.topRadius * 2, { allowZero: true }), num('H', 'Hauteur', Math.abs(o.height))];
      case 'sphere':
        return [num('D', 'Diamètre', o.radius * 2)];
      case 'torus':
        return [num('R', 'Rayon', o.radius), num('r', 'Rayon du tube', o.tubeRadius)];
      case 'pyramid':
        return [num('N', 'Côtés', o.sides, { integer: true, min: 3 }), num('R', 'Rayon de base', o.radius), num('R2', 'Rayon au sommet', o.topRadius, { allowZero: true }), num('H', 'Hauteur', Math.abs(o.height))];
      case 'extrude': {
        const out = [num('H', 'Hauteur', o.direction ? len(o.direction) : Math.abs(o.height))];
        if (!o.direction && !o.surface) out.push(num('T', 'Dépouille (°)', o.taperDeg, { allowZero: true, min: -89 }));
        if (o.profile.kind === 'circle') out.push(num('D', 'Diamètre du profil', o.profile.radius * 2));
        return out;
      }
      case 'revolve':
        return [num('A', 'Angle (°)', o.angleDeg)];
      case 'extrudeRegions':
        return [num('H', 'Épaisseur', len(o.direction))];
      case 'sheetMetal': {
        const d = o.def;
        const out: FeatureParam[] = [
          num('T', 'Épaisseur', d.thickness),
          num('R', 'Rayon de pliage intérieur', d.radius, { allowZero: true }),
          num('K', 'Facteur K', d.k, { allowZero: true, hint: '0,33 à 0,5 (fibre neutre)' }),
          { key: 'inside', label: 'Pli dans le contour (contour = extérieur)', type: 'checkbox', value: d.inside },
        ];
        d.flanges.forEach((fl, i) => {
          out.push(
            num(`A${i}`, `Bord ${i + 1} (arête ${fl.edge + 1}) : angle (°)`, fl.angle),
            num(`L${i}`, `Bord ${i + 1} : longueur extérieure`, fl.length),
            { key: `U${i}`, label: `Bord ${i + 1} : sens`, type: 'select', value: fl.up ? 'up' : 'down', options: [{ value: 'up', label: 'Vers le haut' }, { value: 'down', label: 'Vers le bas' }] },
          );
        });
        return out;
      }
      default:
        return [];
    }
  }
  if (f.kind === 'modify') {
    const o = f.op;
    switch (o.op) {
      case 'fillet':
        return o.radius2 !== undefined ? [num('R', 'Rayon au début', o.radius), num('R2', 'Rayon à la fin', o.radius2)] : [num('R', 'Rayon', o.radius)];
      case 'chamfer':
        return [num('D', 'Distance', o.distance)];
      case 'shell':
        return [num('T', 'Épaisseur', o.thickness, { min: -1e9 })];
      case 'pressPull':
        return [num('D', 'Distance (± tirer/pousser)', o.distance, { min: -1e9 })];
      case 'thicken':
        return [num('T', 'Épaisseur', o.thickness, { min: -1e9 })];
    }
  }
  if (f.kind === 'hole') {
    const s = f.spec;
    const out: FeatureParam[] = [
      { key: 'type', label: 'Type', type: 'select', value: s.type, options: (Object.keys(HOLE_LABEL) as HoleType[]).map((t) => ({ value: t, label: HOLE_LABEL[t] })) },
      { key: 'size', label: 'Taille', type: 'select', value: s.size, options: [...(s.size === 'Ø' ? [{ value: 'Ø', label: 'Diamètre libre' }] : []), ...SIZES.map((z) => ({ value: z, label: sizeLabel(z) }))] },
      num('diameter', 'Ø de perçage', s.diameter),
      num('depth', 'Profondeur', s.depth, { allowZero: true, hint: '0 = débouchant' }),
    ];
    if (s.type === 'counterbore') out.push(num('cbDiameter', 'Ø du lamage', s.cbDiameter ?? 0), num('cbDepth', 'Prof. du lamage', s.cbDepth ?? 0));
    if (s.type === 'countersink') out.push(num('csDiameter', 'Ø fraisure (90°)', s.csDiameter ?? 0));
    if (s.type === 'tapped') out.push({ key: 'thread', label: 'Filetage réel (lent)', type: 'checkbox', value: !!s.thread });
    if (s.type === 'tapped' && s.thread) {
      if (s.gap === undefined && s.clearance) out.push(num('clearance', 'Jeu d’impression (Ø, ancien)', s.clearance, { allowZero: true, hint: 'ancienne méthode : agrandit le Ø du filet' }));
      out.push(num('gap', 'Jeu d’impression par côté', s.gap ?? 0, { allowZero: true, hint: 'perpendiculaire aux flancs du filet (plafonné à 0,2 × pas)' }));
    }
    if (s.type === 'simple' || s.type === 'counterbore' || s.type === 'countersink') out.push(num('comp', 'Compensation impression (Ø)', s.comp ?? 0, { allowZero: true, hint: 'agrandit le trou imprimé (OPTIONS : valeur par défaut)' }));
    return out;
  }
  return [];
}

/** Étape avec la cote `key` modifiée. */
export function setFeatureParam(f: Feature, key: string, v: number | string | boolean): Feature {
  const n = typeof v === 'number' ? v : Number(v);
  if (f.kind === 'create') {
    const o = f.op;
    let op: CreateOp = o;
    switch (o.op) {
      case 'box':
        op = { ...o, size: { x: key === 'L' ? sgn(o.size.x) * n : o.size.x, y: key === 'W' ? sgn(o.size.y) * n : o.size.y, z: key === 'H' ? sgn(o.size.z) * n : o.size.z } };
        break;
      case 'cylinder':
        op = key === 'D' ? { ...o, radius: n / 2 } : { ...o, height: sgn(o.height) * n };
        break;
      case 'cone':
        op = key === 'D' ? { ...o, radius: n / 2 } : key === 'D2' ? { ...o, topRadius: n / 2 } : { ...o, height: sgn(o.height) * n };
        break;
      case 'sphere':
        op = { ...o, radius: n / 2 };
        break;
      case 'torus':
        op = key === 'R' ? { ...o, radius: n } : { ...o, tubeRadius: n };
        break;
      case 'pyramid':
        op = key === 'N' ? { ...o, sides: Math.max(3, Math.round(n)) } : key === 'R' ? { ...o, radius: n } : key === 'R2' ? { ...o, topRadius: n } : { ...o, height: sgn(o.height) * n };
        break;
      case 'extrude':
        if (key === 'H') op = o.direction ? { ...o, height: n, direction: scale(norm(o.direction), n) } : { ...o, height: sgn(o.height) * n };
        else if (key === 'T') op = { ...o, taperDeg: n };
        else if (key === 'D' && o.profile.kind === 'circle') op = { ...o, profile: { ...o.profile, radius: n / 2 } };
        break;
      case 'revolve':
        op = { ...o, angleDeg: n };
        break;
      case 'extrudeRegions':
        op = { ...o, direction: scale(norm(o.direction), n) };
        break;
      case 'sheetMetal': {
        const d = o.def;
        const m = /^([ALU])(\d+)$/.exec(key);
        if (m) {
          const i = Number(m[2]);
          const flanges = d.flanges.map((fl, k) => (k !== i ? fl : m[1] === 'A' ? { ...fl, angle: n } : m[1] === 'L' ? { ...fl, length: n } : { ...fl, up: v === 'up' }));
          op = { ...o, def: { ...d, flanges } };
        } else if (key === 'inside') op = { ...o, def: { ...d, inside: !!v } };
        else op = { ...o, def: { ...d, ...(key === 'T' ? { thickness: n } : key === 'R' ? { radius: n } : { k: n }) } };
        break;
      }
    }
    return { ...f, op };
  }
  if (f.kind === 'modify') {
    const o = f.op;
    let op: ModifyOp = o;
    switch (o.op) {
      case 'fillet':
        op = key === 'R2' ? { ...o, radius2: n } : { ...o, radius: n };
        break;
      case 'chamfer':
        op = { ...o, distance: n };
        break;
      case 'shell':
        op = { ...o, thickness: n };
        break;
      case 'pressPull':
        op = { ...o, distance: n };
        break;
      case 'thicken':
        op = { ...o, thickness: n };
        break;
    }
    return { ...f, op };
  }
  if (f.kind === 'hole') {
    const s = f.spec;
    let spec: HoleSpec;
    if (key === 'type' || key === 'size') {
      const type = (key === 'type' ? v : s.type) as HoleType;
      let size = (key === 'size' ? v : s.size) as string;
      if (size === 'Ø') size = 'M6';
      spec = standardHole(type, size, type === 'insert' && key === 'type' ? 0 : s.depth, !!s.thread, gapOf(s), s.comp ?? 0);
    } else if (key === 'thread') spec = standardHole(s.type, s.size === 'Ø' ? 'M6' : s.size, s.depth, !!v, gapOf(s), s.comp ?? 0);
    else if (key === 'clearance') spec = { ...s, clearance: Math.max(0, n), diameter: s.diameter - (s.clearance ?? 0) + Math.max(0, n) };
    else if (key === 'gap') {
      // passage à la nouvelle méthode : l'ancien jeu sur le Ø est retiré de l'avant-trou
      const { clearance: old, ...rest } = s;
      spec = { ...rest, gap: Math.max(0, n), diameter: s.diameter - (s.gap === undefined ? (old ?? 0) : 2 * s.gap) + 2 * Math.max(0, n) };
    } else if (key === 'comp') {
      const { comp: _c, ...rest } = s;
      spec = n > 0 ? { ...rest, comp: n } : rest;
    } else spec = { ...s, [key]: n };
    return { ...f, spec, name: HOLE_LABEL[spec.type] };
  }
  return f;
}

// ---------------------------------------------------------------------------
// Expressions (paramètres utilisateur)
// ---------------------------------------------------------------------------

/** Valeur d'une expression (`ep*2`, `largeur/2+5`) avec les paramètres du dessin. */
export function evalExpression(expr: string, constraints: Constraint[], params: Record<string, string>): number {
  const key = '__sebcad_expr__';
  const v = evaluateParameters(constraints, { ...params, [key]: expr }).get(key);
  if (v === undefined || !Number.isFinite(v)) throw new Error(`Expression invalide : ${expr}`);
  return v;
}

/**
 * Réévalue les cotes liées à des expressions ; renvoie l'historique mis à jour, ou null si
 * rien ne change.
 */
export function refreshExpressions(h: Feature[], constraints: Constraint[], params: Record<string, string>): Feature[] | null {
  let changed = false;
  const walk = (list: Feature[]): Feature[] =>
    list.map((f) => {
      let g = f;
      for (const [key, expr] of Object.entries(f.exprs ?? {})) {
        let v: number;
        try {
          v = evalExpression(expr, constraints, params);
        } catch {
          continue;
        }
        const cur = featureParams(g).find((p) => p.key === key)?.value;
        if (typeof cur === 'number' && Math.abs(cur - v) > 1e-9) {
          g = setFeatureParam(g, key, v);
          changed = true;
        }
      }
      if (g.kind === 'boolean') {
        const tools = g.tools.map(walk);
        if (tools.some((t, i) => t !== (g as Extract<Feature, { kind: 'boolean' }>).tools[i])) g = { ...g, tools };
      }
      return g === f ? f : g;
    });
  const out = walk(h);
  return changed ? out : null;
}

/** Jeu par côté d'un trou taraudé (anciens dessins : moitié du jeu sur le Ø, 0,2 par défaut). */
const gapOf = (s: HoleSpec): number => s.gap ?? (s.clearance ? s.clearance / 2 : 0.2);

export const hasExpressions = (h: Feature[]): boolean => h.some((f) => (f.exprs && Object.keys(f.exprs).length > 0) || (f.kind === 'boolean' && f.tools.some(hasExpressions)));

// ---------------------------------------------------------------------------
// Perçages
// ---------------------------------------------------------------------------

/** Repère d'un trou : w = axe vers l'intérieur de la matière, u et v perpendiculaires. */
function holeFrame(normal: Vec3): { u: Vec3; v: Vec3; w: Vec3 } {
  const w = norm(scale(normal, -1));
  const ref = Math.abs(w.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = norm(cross(ref, w));
  return { u, v: cross(w, u), w };
}

/** Outils de perçage (révolution du demi-profil) aux points `at` ; `through` = longueur d'un débouchant. */
export async function holeTools(k: Kernel, spec: HoleSpec, at: Vec3[], normal: Vec3, through: number): Promise<SolidResult[]> {
  const { u, w } = holeFrame(normal);
  const prof = holeProfile(spec, through);
  const out: SolidResult[] = [];
  for (const o of at) {
    const P = (r: number, z: number) => add(o, add(scale(u, r), scale(w, z)));
    out.push(await k({ op: 'revolve', profile: { kind: 'poly', points: prof.map(([r, z]) => P(r, z)), closed: true }, axisStart: o, axisEnd: add(o, w), angleDeg: 360, startDeg: 0 }));
  }
  return out;
}

/** Matrice locale → monde d'un trou (z local = axe dans la matière). */
export function holeMatrix(o: Vec3, normal: Vec3): Affine {
  const { u, v, w } = holeFrame(normal);
  return [u.x, v.x, w.x, o.x, u.y, v.y, w.y, o.y, u.z, v.z, w.z, o.z];
}

/** Perce le corps `shapeId` : renvoie la nouvelle forme. `threaded` construit une tige filetée locale. */
export async function drillHoles(
  k: Kernel,
  shapeId: string,
  bbox: { min: Vec3; max: Vec3 },
  f: { spec: HoleSpec; at: Vec3[]; normal: Vec3 },
  threaded?: (k: Kernel, d: number, p: number, z0: number, L: number, gap: number) => Promise<SolidResult>,
): Promise<SolidResult> {
  const through = dist(bbox.min, bbox.max) * 2 + 10;
  const tools = await holeTools(k, f.spec, f.at, f.normal, through);
  let r = await k({ op: 'boolean', kind: 'subtract', targets: [shapeId], tools: tools.map((t) => t.shapeId) });
  const s = f.spec;
  if (s.type === 'tapped' && s.thread && s.nominal && s.pitch && threaded) {
    const L = (s.depth > 0 ? s.depth - s.pitch : through) + s.pitch;
    const rods: SolidResult[] = [];
    for (const o of f.at) {
      // nouveau jeu : décalage des flancs ; ancien jeu (avant 1.10) : Ø du filet agrandi
      const local = s.gap !== undefined ? await threaded(k, s.nominal, s.pitch, -s.pitch, L, s.gap) : await threaded(k, s.nominal + (s.clearance ?? 0), s.pitch, -s.pitch, L, 0);
      rods.push(await k({ op: 'transform', shapeId: local.shapeId, matrix: holeMatrix(o, f.normal) }));
    }
    r = await k({ op: 'boolean', kind: 'subtract', targets: [r.shapeId], tools: rods.map((t) => t.shapeId), exact: true });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

export class RebuildError extends Error {
  constructor(
    readonly feature: Feature,
    cause: string,
  ) {
    super(`Échec à l’étape « ${featureTitle(feature)} » : ${cause}`);
  }
}

export interface ReplayOptions {
  /** Outil de taraudage (filet réel, ou aperçu cosmétique) ; `gap` = jeu par côté. */
  threaded?: (k: Kernel, d: number, p: number, z0: number, L: number, gap: number) => Promise<SolidResult>;
  /** Pièce de la bibliothèque (étape « part »). */
  part?: (k: Kernel, f: Extract<Feature, { kind: 'part' }>) => Promise<SolidResult>;
}

/** Rejoue un historique avec un noyau (déjà « lazy ») ; renvoie la forme finale. */
export async function replayHistory(k: Kernel, h: Feature[], opts: ReplayOptions = {}, start: SolidResult | null = null): Promise<SolidResult> {
  let cur: SolidResult | null = start;
  for (const f of h) {
    if (f.off && (f !== h[0] || start)) continue;
    try {
      switch (f.kind) {
        case 'create':
          cur = await k(f.op);
          break;
        case 'modify':
          if (!cur) throw new Error('aucune forme');
          cur = await k({ ...f.op, shapeId: cur.shapeId } as ModifyOp);
          break;
        case 'transform':
          if (!cur) throw new Error('aucune forme');
          cur = await k({ op: 'transform', shapeId: cur.shapeId, matrix: f.matrix });
          break;
        case 'boolean': {
          if (!cur) throw new Error('aucune forme');
          const tools: SolidResult[] = [];
          for (const t of f.tools) tools.push(await replayHistory(k, t, opts));
          cur = await k({ op: 'boolean', kind: f.bool, targets: [cur.shapeId], tools: tools.map((t) => t.shapeId) });
          break;
        }
        case 'hole':
          if (!cur) throw new Error('aucune forme');
          cur = await drillHoles(k, cur.shapeId, cur.display.bbox, f, opts.threaded);
          break;
        case 'part':
          if (!opts.part) throw new Error('pièce de bibliothèque non reconstructible ici');
          cur = await opts.part(k, f);
          break;
      }
    } catch (e) {
      if (e instanceof RebuildError || e instanceof CommandCancelled) throw e;
      throw new RebuildError(f, e instanceof Error ? e.message : String(e));
    }
  }
  if (!cur) throw new Error('Historique vide.');
  return cur;
}

/** Ajoute une étape à un historique (undefined si le corps n'en a pas : il reste « figé »). */
export function appendFeature(h: Feature[] | undefined, f: Feature): Feature[] | undefined {
  return h ? [...h, f] : undefined;
}

export type { DisplayMesh };

// ---------------------------------------------------------------------------
// Construction des étapes par les commandes
// ---------------------------------------------------------------------------

export const createStep = (op: CreateOp, name: string): Feature[] => [{ kind: 'create', op, id: featureId(), name }];

/** Étape « modifier » : l'identifiant de forme est retiré (remplacé à la reconstruction). */
export const modifyStep = (op: ModifyOp, name: string): Feature => ({ kind: 'modify', op: { ...op, shapeId: '' }, id: featureId(), name });

/** Booléen avec les historiques des outils ; undefined si un outil n'a pas d'historique. */
export function booleanStep(bool: 'union' | 'subtract' | 'intersect', tools: (Feature[] | undefined)[], name: string): Feature | undefined {
  if (tools.some((t) => !t)) return undefined;
  return { kind: 'boolean', bool, tools: tools as Feature[][], id: featureId(), name };
}

/** Historique prolongé d'une étape (undefined si le corps ou l'étape n'en a pas). */
export function extend(h: Feature[] | undefined, f: Feature | undefined): Feature[] | undefined {
  return h && f ? [...h, f] : undefined;
}

// ---------------------------------------------------------------------------
// Modifications depuis l'interface (Propriétés, Navigateur)
// ---------------------------------------------------------------------------

/** Hôte minimal (évite une dépendance circulaire vers AppHost). */
interface HistoryHost {
  doc: {
    get(h: string): unknown;
    constraints: Constraint[];
    parameters: Record<string, string>;
  };
  rebuildSolid(handle: string, history: Feature[], label?: string): Promise<void>;
}

function historyOf(app: HistoryHost, handle: string): Feature[] {
  const e = app.doc.get(handle) as { type?: string; history?: Feature[] } | undefined;
  if (e?.type !== '3DSOLID' || !e.history) throw new Error('Ce corps n’a pas d’historique.');
  return e.history;
}

/**
 * Modifie une cote d'une étape puis reconstruit. `input` : nombre, ou texte (nombre ou
 * expression avec les paramètres utilisateur : la cote reste alors liée à l'expression).
 */
export async function editFeatureParam(app: HistoryHost, handle: string, path: FeaturePath, key: string, input: number | string | boolean): Promise<void> {
  const h = historyOf(app, handle);
  const f = featureAt(h, path);
  if (!f) throw new Error('Étape introuvable.');
  const desc = featureParams(f).find((p) => p.key === key);
  if (!desc) throw new Error('Cote inconnue.');
  let value: number | string | boolean = input;
  const exprs = { ...(f.exprs ?? {}) };
  delete exprs[key];
  if (desc.type === 'number' && typeof input === 'string') {
    const text = input.trim().replace(/(\d),(\d)/g, '$1.$2');
    const plain = Number(text);
    if (text !== '' && Number.isFinite(plain)) value = plain;
    else {
      value = evalExpression(text, app.doc.constraints, app.doc.parameters);
      exprs[key] = text;
    }
  }
  if (desc.type === 'number') {
    const n = value as number;
    const min = desc.min ?? 0;
    if (!Number.isFinite(n) || n < min || (n === 0 && !desc.allowZero && min >= 0)) throw new Error(`${desc.label} : valeur ${n} refusée.`);
  }
  let g = setFeatureParam(f, key, value);
  g = Object.keys(exprs).length ? { ...g, exprs } : (({ exprs: _e, ...rest }) => rest as Feature)(g);
  await app.rebuildSolid(handle, replaceAt(h, path, g), `Historique : ${featureTitle(g)}`);
}

/** Supprime / rétablit une étape (ignorée à la reconstruction). */
export async function toggleFeature(app: HistoryHost, handle: string, path: FeaturePath): Promise<void> {
  const h = historyOf(app, handle);
  const f = featureAt(h, path);
  if (!f) return;
  if (path.length === 1 && path[0] === 0) throw new Error('La première étape crée le corps : elle ne peut pas être supprimée.');
  await app.rebuildSolid(handle, replaceAt(h, path, { ...f, off: !f.off }), f.off ? `Rétablir « ${featureTitle(f)} »` : `Supprimer « ${featureTitle(f)} »`);
}

/** Retire définitivement une étape de l'historique. */
export async function deleteFeature(app: HistoryHost, handle: string, path: FeaturePath): Promise<void> {
  const h = historyOf(app, handle);
  const f = featureAt(h, path);
  if (!f) return;
  if (path.length === 1 && path[0] === 0) throw new Error('La première étape crée le corps : effacez plutôt le corps.');
  await app.rebuildSolid(handle, replaceAt(h, path, null), `Retirer « ${featureTitle(f)} »`);
}

/** Étapes à plat (avec profondeur) pour l'affichage. */
export function flattenHistory(h: Feature[], base: FeaturePath = [], depth = 0): { f: Feature; path: FeaturePath; depth: number }[] {
  return h.flatMap((f, i) => {
    const path = [...base, i];
    const self = { f, path, depth };
    if (f.kind !== 'boolean') return [self];
    return [self, ...f.tools.flatMap((t, ti) => flattenHistory(t, [...path, ti], depth + 1))];
  });
}
