/**
 * Solveur de contraintes géométriques et dimensionnelles 2D.
 *
 * Moindres carrés non linéaires (Levenberg-Marquardt, jacobien par différences finies).
 * La matrice d'amortissement est pondérée : les entités que l'utilisateur vient de modifier
 * sont « lourdes », le solveur déplace donc de préférence les autres (comportement attendu
 * quand on change une cote pilotée ou qu'on déplace un objet contraint).
 *
 * Variables par entité : LINE (x1,y1,x2,y2), POLYLINE (xi,yi), CIRCLE (cx,cy,r),
 * ARC (cx,cy,r,a0,a1), POINT (x,y), ELLIPSE (cx,cy). Les Z sont conservés.
 */
import type { Vec3 } from '../commands/types';
import type { Entity, NewEntity } from '../document/Document';
import { evaluateNumber } from '../commands/InputParser';
import { isDimensional, type Constraint, type PartRef } from './types';

type P2 = { x: number; y: number };
type PointGetter = (x: Float64Array) => P2;
interface LineGetter {
  a: PointGetter;
  b: PointGetter;
}
interface CircleGetter {
  c: PointGetter;
  r: (x: Float64Array) => number;
}

export interface SolveResult {
  ok: boolean;
  patches: Map<string, Partial<NewEntity>>;
  residual: number;
  /** Degrés de liberté restants du système contraint. */
  dof: number;
  /** Rang du jacobien (nombre de contraintes indépendantes). */
  rank: number;
  message?: string;
}

interface Layout {
  handles: string[];
  offset: Map<string, number>;
  x0: Float64Array;
  entities: Map<string, Entity>;
}

function varsOf(e: Entity): number[] | null {
  switch (e.type) {
    case 'LINE':
      return [e.start.x, e.start.y, e.end.x, e.end.y];
    case 'POLYLINE':
      return e.points.flatMap((p) => [p.x, p.y]);
    case 'CIRCLE':
      return [e.center.x, e.center.y, e.radius];
    case 'ARC':
      return [e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle];
    case 'POINT':
      return [e.position.x, e.position.y];
    case 'ELLIPSE':
      return [e.center.x, e.center.y];
    default:
      return null;
  }
}

function buildLayout(get: (h: string) => Entity | undefined, constraints: Constraint[]): Layout {
  const handles: string[] = [];
  const offset = new Map<string, number>();
  const entities = new Map<string, Entity>();
  const values: number[] = [];
  for (const c of constraints)
    for (const r of c.refs) {
      if (offset.has(r.handle)) continue;
      const e = get(r.handle);
      const v = e && varsOf(e);
      if (!e || !v) throw new Error(`Entité ${r.handle} non contraignable.`);
      offset.set(r.handle, values.length);
      handles.push(r.handle);
      entities.set(r.handle, e);
      values.push(...v);
    }
  return { handles, offset, x0: new Float64Array(values), entities };
}

// ---------------------------------------------------------------------------
// Accès aux parties d'entités
// ---------------------------------------------------------------------------

function pointGetter(L: Layout, ref: PartRef): PointGetter {
  const e = L.entities.get(ref.handle)!;
  const o = L.offset.get(ref.handle)!;
  const at = (i: number): PointGetter => (x) => ({ x: x[o + i]!, y: x[o + i + 1]! });
  switch (e.type) {
    case 'LINE':
      if (ref.part === 'start') return at(0);
      if (ref.part === 'end') return at(2);
      break;
    case 'POLYLINE':
      if (ref.part.startsWith('v:')) return at(2 * Number(ref.part.slice(2)));
      break;
    case 'CIRCLE':
    case 'ELLIPSE':
      if (ref.part === 'center') return at(0);
      break;
    case 'ARC':
      if (ref.part === 'center') return at(0);
      if (ref.part === 'start' || ref.part === 'end') {
        const k = ref.part === 'start' ? 3 : 4;
        return (x) => ({ x: x[o]! + x[o + 2]! * Math.cos(x[o + k]!), y: x[o + 1]! + x[o + 2]! * Math.sin(x[o + k]!) });
      }
      break;
    case 'POINT':
      return at(0);
  }
  throw new Error(`Point "${ref.part}" introuvable sur ${e.type}.`);
}

function lineGetter(L: Layout, ref: PartRef): LineGetter {
  const e = L.entities.get(ref.handle)!;
  if (e.type === 'LINE') return { a: pointGetter(L, { handle: ref.handle, part: 'start' }), b: pointGetter(L, { handle: ref.handle, part: 'end' }) };
  if (e.type === 'POLYLINE' && ref.part.startsWith('seg:')) {
    const i = Number(ref.part.slice(4));
    const n = e.points.length;
    return { a: pointGetter(L, { handle: ref.handle, part: `v:${i}` }), b: pointGetter(L, { handle: ref.handle, part: `v:${(i + 1) % n}` }) };
  }
  throw new Error('Une ligne ou un segment de polyligne est attendu.');
}

function circleGetter(L: Layout, ref: PartRef): CircleGetter {
  const e = L.entities.get(ref.handle)!;
  const o = L.offset.get(ref.handle)!;
  if (e.type === 'CIRCLE' || e.type === 'ARC') return { c: (x) => ({ x: x[o]!, y: x[o + 1]! }), r: (x) => x[o + 2]! };
  throw new Error('Un cercle ou un arc est attendu.');
}

const isCircleRef = (L: Layout, r: PartRef) => {
  const t = L.entities.get(r.handle)!.type;
  return (t === 'CIRCLE' || t === 'ARC') && (r.part === 'circle' || r.part === 'center');
};

// ---------------------------------------------------------------------------
// Paramètres (cotes pilotées)
// ---------------------------------------------------------------------------

/** Évalue les expressions des cotes (dépendances entre paramètres, cycles détectés). */
export function evaluateParameters(constraints: Constraint[], user: Record<string, string> = {}): Map<string, number> {
  const exprs = new Map<string, string>(Object.entries(user));
  for (const c of constraints) if (isDimensional(c)) exprs.set(c.name, c.expression);
  const values = new Map<string, number>();
  const visiting = new Set<string>();
  const evalName = (name: string): number => {
    if (values.has(name)) return values.get(name)!;
    const expr = exprs.get(name);
    if (expr === undefined) throw new Error(`Paramètre inconnu : ${name}`);
    if (visiting.has(name)) throw new Error(`Référence circulaire sur ${name}.`);
    visiting.add(name);
    const substituted = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => (id.toLowerCase() === 'pi' ? id : `(${evalName(id)})`));
    visiting.delete(name);
    const v = evaluateNumber(substituted);
    if (v === null) throw new Error(`Expression invalide pour ${name} : ${expr}`);
    values.set(name, v);
    return v;
  };
  for (const n of exprs.keys()) evalName(n);
  return values;
}

// ---------------------------------------------------------------------------
// Résidus
// ---------------------------------------------------------------------------

type Residual = (x: Float64Array) => number;

function residualsFor(L: Layout, c: Constraint, params: Map<string, number>): Residual[] {
  const dirOf = (l: LineGetter) => (x: Float64Array) => {
    const a = l.a(x), b = l.b(x);
    return { x: b.x - a.x, y: b.y - a.y };
  };
  const len = (v: P2) => Math.hypot(v.x, v.y) || 1e-12;
  switch (c.type) {
    case 'horizontal': {
      const l = lineGetter(L, c.refs[0]!);
      return [(x) => l.b(x).y - l.a(x).y];
    }
    case 'vertical': {
      const l = lineGetter(L, c.refs[0]!);
      return [(x) => l.b(x).x - l.a(x).x];
    }
    case 'parallel':
    case 'perpendicular': {
      const d1 = dirOf(lineGetter(L, c.refs[0]!)), d2 = dirOf(lineGetter(L, c.refs[1]!));
      return [
        (x) => {
          const u = d1(x), v = d2(x);
          const k = c.type === 'parallel' ? u.x * v.y - u.y * v.x : u.x * v.x + u.y * v.y;
          return k / (len(u) * len(v));
        },
      ];
    }
    case 'coincident':
    case 'concentric': {
      const asPoint = (r: PartRef) => (c.type === 'concentric' ? circleOrCenter(L, r) : pointGetter(L, r));
      const p = asPoint(c.refs[0]!), q = asPoint(c.refs[1]!);
      return [(x) => q(x).x - p(x).x, (x) => q(x).y - p(x).y];
    }
    case 'fix': {
      const p = pointGetter(L, c.refs[0]!);
      return [(x) => p(x).x - c.at.x, (x) => p(x).y - c.at.y];
    }
    case 'tangent': {
      const [r0, r1] = c.refs as [PartRef, PartRef];
      if (isCircleRef(L, r0) && isCircleRef(L, r1)) {
        const a = circleGetter(L, r0), b = circleGetter(L, r1);
        return [
          (x) => {
            const d = Math.hypot(a.c(x).x - b.c(x).x, a.c(x).y - b.c(x).y);
            return c.internal ? d - Math.abs(a.r(x) - b.r(x)) : d - (a.r(x) + b.r(x));
          },
        ];
      }
      const [lr, cr] = isCircleRef(L, r0) ? [r1, r0] : [r0, r1];
      const l = lineGetter(L, lr), ci = circleGetter(L, cr);
      return [
        (x) => {
          const a = l.a(x), b = l.b(x), cc = ci.c(x);
          const d = { x: b.x - a.x, y: b.y - a.y };
          return Math.abs(d.x * (cc.y - a.y) - d.y * (cc.x - a.x)) / len(d) - ci.r(x);
        },
      ];
    }
    case 'equal': {
      const [r0, r1] = c.refs as [PartRef, PartRef];
      if (isCircleRef(L, r0) && isCircleRef(L, r1)) {
        const a = circleGetter(L, r0), b = circleGetter(L, r1);
        return [(x) => a.r(x) - b.r(x)];
      }
      const a = lineGetter(L, r0), b = lineGetter(L, r1);
      return [(x) => len(dirOf(a)(x)) - len(dirOf(b)(x))];
    }
    case 'distance': {
      const v = params.get(c.name)!;
      let p: PointGetter, q: PointGetter;
      if (c.refs.length === 1) ({ a: p, b: q } = lineGetter(L, c.refs[0]!));
      else (p = pointGetter(L, c.refs[0]!)), (q = pointGetter(L, c.refs[1]!));
      if (c.axis === 'x') return [(x) => Math.abs(q(x).x - p(x).x) - v];
      if (c.axis === 'y') return [(x) => Math.abs(q(x).y - p(x).y) - v];
      return [(x) => Math.hypot(q(x).x - p(x).x, q(x).y - p(x).y) - v];
    }
    case 'radius':
    case 'diameter': {
      const v = params.get(c.name)!;
      const ci = circleGetter(L, c.refs[0]!);
      return [(x) => (c.type === 'diameter' ? 2 * ci.r(x) : ci.r(x)) - v];
    }
    case 'angle': {
      const v = (params.get(c.name)! * Math.PI) / 180;
      const d1 = dirOf(lineGetter(L, c.refs[0]!)), d2 = dirOf(lineGetter(L, c.refs[1]!));
      return [
        (x) => {
          const u = d1(x), w = d2(x);
          let a = Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y) - v;
          while (a > Math.PI) a -= 2 * Math.PI;
          while (a < -Math.PI) a += 2 * Math.PI;
          return a;
        },
      ];
    }
  }
}

function circleOrCenter(L: Layout, r: PartRef): PointGetter {
  const e = L.entities.get(r.handle)!;
  if (e.type === 'CIRCLE' || e.type === 'ARC' || e.type === 'ELLIPSE') return pointGetter(L, { handle: r.handle, part: 'center' });
  return pointGetter(L, r);
}

/** Valeur actuelle mesurée d'une cote (pour proposer la valeur par défaut). */
export function measure(get: (h: string) => Entity | undefined, c: Omit<Extract<Constraint, { name: string }>, 'id'>): number {
  const fake = { ...c, id: '_', name: '_m', expression: '0' } as Constraint;
  const L = buildLayout(get, [fake]);
  const r = residualsFor(L, fake, new Map([['_m', 0]]))[0]!;
  return c.type === 'angle' ? (r(L.x0) * 180) / Math.PI : r(L.x0);
}

// ---------------------------------------------------------------------------
// Algèbre linéaire
// ---------------------------------------------------------------------------

function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = new Float64Array(A);
  const x = new Float64Array(b);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i * n + k]!) > Math.abs(M[p * n + k]!)) p = i;
    if (Math.abs(M[p * n + k]!) < 1e-300) return null;
    if (p !== k) {
      for (let j = 0; j < n; j++) [M[k * n + j], M[p * n + j]] = [M[p * n + j]!, M[k * n + j]!];
      [x[k], x[p]] = [x[p]!, x[k]!];
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k]! / M[k * n + k]!;
      if (!f) continue;
      for (let j = k; j < n; j++) M[i * n + j]! -= f * M[k * n + j]!;
      x[i]! -= f * x[k]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) s -= M[i * n + j]! * x[j]!;
    x[i] = s / M[i * n + i]!;
  }
  return x;
}

function rankOf(J: Float64Array, m: number, n: number, tol = 1e-8): number {
  const M = new Float64Array(J);
  let rank = 0;
  const used = new Uint8Array(m);
  for (let col = 0; col < n && rank < m; col++) {
    let p = -1, best = tol;
    for (let i = 0; i < m; i++) if (!used[i] && Math.abs(M[i * n + col]!) > best) (best = Math.abs(M[i * n + col]!)), (p = i);
    if (p < 0) continue;
    used[p] = 1;
    rank++;
    for (let i = 0; i < m; i++) {
      if (i === p) continue;
      const f = M[i * n + col]! / M[p * n + col]!;
      if (f) for (let j = col; j < n; j++) M[i * n + j]! -= f * M[p * n + j]!;
    }
  }
  return rank;
}

function jacobian(res: Residual[], x: Float64Array): Float64Array {
  const m = res.length, n = x.length;
  const J = new Float64Array(m * n);
  const f0 = res.map((r) => r(x));
  for (let j = 0; j < n; j++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[j]!));
    const old = x[j]!;
    x[j] = old + h;
    for (let i = 0; i < m; i++) J[i * n + j] = (res[i]!(x) - f0[i]!) / h;
    x[j] = old;
  }
  return J;
}

// ---------------------------------------------------------------------------
// Résolution
// ---------------------------------------------------------------------------

export function solveConstraints(
  get: (h: string) => Entity | undefined,
  constraints: Constraint[],
  opts: { edited?: Set<string>; maxIterations?: number; user?: Record<string, string> } = {},
): SolveResult {
  const empty: SolveResult = { ok: true, patches: new Map(), residual: 0, dof: 0, rank: 0 };
  if (!constraints.length) return empty;
  const params = evaluateParameters(constraints, opts.user);
  const L = buildLayout(get, constraints);
  const res = constraints.flatMap((c) => residualsFor(L, c, params));
  const n = L.x0.length, m = res.length;
  const x = new Float64Array(L.x0);

  // poids d'amortissement : les variables des entités modifiées résistent au déplacement
  const D = new Float64Array(n).fill(1);
  for (const h of opts.edited ?? []) {
    const o = L.offset.get(h);
    if (o === undefined) continue;
    const k = varsOf(L.entities.get(h)!)!.length;
    for (let i = 0; i < k; i++) D[o + i] = 1e4;
  }

  const norm2 = (v: number[]) => v.reduce((s, r) => s + r * r, 0);
  let f = res.map((r) => r(x));
  let cost = norm2(f);
  let lambda = 1e-3;
  const maxIt = opts.maxIterations ?? 200;
  for (let it = 0; it < maxIt && cost > 1e-24; it++) {
    const J = jacobian(res, x);
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++)
      for (let a = 0; a < n; a++) {
        const Jia = J[i * n + a]!;
        if (!Jia) continue;
        g[a]! -= Jia * f[i]!;
        for (let b = 0; b < n; b++) A[a * n + b]! += Jia * J[i * n + b]!;
      }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = new Float64Array(A);
      for (let a = 0; a < n; a++) Ad[a * n + a]! += lambda * D[a]! + 1e-12;
      const step = solveLinear(Ad, g, n);
      if (!step) {
        lambda *= 10;
        continue;
      }
      const xn = new Float64Array(n);
      for (let a = 0; a < n; a++) xn[a] = x[a]! + step[a]!;
      const fn = res.map((r) => r(xn));
      const cn = norm2(fn);
      if (cn < cost) {
        x.set(xn);
        f = fn;
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  const residual = Math.sqrt(cost);
  const J = jacobian(res, x);
  const rank = rankOf(J, m, n);
  const ok = residual < 1e-6;

  // radii et longueurs positives
  for (const h of L.handles) {
    const e = L.entities.get(h)!;
    const o = L.offset.get(h)!;
    if ((e.type === 'CIRCLE' || e.type === 'ARC') && x[o + 2]! <= 0) {
      return { ok: false, patches: new Map(), residual, dof: n - rank, rank, message: 'La solution donnerait un rayon négatif.' };
    }
  }

  const patches = new Map<string, Partial<NewEntity>>();
  for (const h of L.handles) {
    const e = L.entities.get(h)!;
    const o = L.offset.get(h)!;
    const P = (i: number, z: number): Vec3 => ({ x: x[o + i]!, y: x[o + i + 1]!, z });
    let patch: Partial<NewEntity> | null = null;
    switch (e.type) {
      case 'LINE':
        patch = { start: P(0, e.start.z), end: P(2, e.end.z) };
        break;
      case 'POLYLINE':
        patch = { points: e.points.map((p, i) => P(2 * i, p.z)) };
        break;
      case 'CIRCLE':
        patch = { center: P(0, e.center.z), radius: x[o + 2]! };
        break;
      case 'ARC':
        patch = { center: P(0, e.center.z), radius: x[o + 2]!, startAngle: x[o + 3]!, endAngle: x[o + 4]! };
        break;
      case 'POINT':
        patch = { position: P(0, e.position.z) };
        break;
      case 'ELLIPSE':
        patch = { center: P(0, e.center.z) };
        break;
    }
    const changed = varsOf(e)!.some((v, i) => Math.abs(v - x[o + i]!) > 1e-12);
    if (patch && changed) patches.set(h, patch);
  }
  return {
    ok,
    patches: ok ? patches : new Map(),
    residual,
    dof: n - rank,
    rank,
    message: ok ? undefined : 'Contraintes conflictuelles : la géométrie ne peut pas toutes les satisfaire.',
  };
}

/** Rang du système (pour refuser une contrainte redondante avant de l'ajouter). */
export function constraintRank(get: (h: string) => Entity | undefined, constraints: Constraint[], user?: Record<string, string>): number {
  if (!constraints.length) return 0;
  const params = evaluateParameters(constraints, user);
  const L = buildLayout(get, constraints);
  const res = constraints.flatMap((c) => residualsFor(L, c, params));
  return rankOf(jacobian(res, new Float64Array(L.x0)), res.length, L.x0.length);
}

/** Nombre de résidus (équations) d'une contrainte. */
export function equationCount(c: Constraint): number {
  return c.type === 'coincident' || c.type === 'concentric' || c.type === 'fix' ? 2 : 1;
}
