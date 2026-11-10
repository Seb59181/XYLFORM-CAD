/**
 * MESUREGEOM (mètre 3D) : distance entre deux points
 * (accrochages, faces des solides), angle, épaisseur d'une paroi sous le curseur, distance et
 * angle entre deux faces. Les mesures restent affichées pendant la commande.
 */
import type { CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { add, cross, dist, dot, len, norm, scale, sub } from '../../core/math/affine';
import { cmd, DEG, fmt, getPointOrKeyword, kw, pickEntity } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const MODES = [
  kw('Distance', 'Distance', 'D', 'Entre deux points'),
  kw('Angle', 'Angle', 'A', 'Sommet puis deux points'),
  kw('Thickness', 'Epaisseur', 'E', 'Épaisseur de paroi sous un point de face'),
  kw('Faces', 'Faces', 'F', 'Distance et angle entre deux faces'),
  kw('Exit', 'Quitter', 'Q'),
];

/** Triangle d'affichage n°t d'un solide. */
function tri(d: Solid3D['display'], t: number): [Vec3, Vec3, Vec3] {
  const P = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
  return [P(d.indices[3 * t]!), P(d.indices[3 * t + 1]!), P(d.indices[3 * t + 2]!)];
}

/** Normale sortante d'une face au point désigné (triangle de la face le plus proche du point). */
export function faceNormalAt(s: Solid3D, face: number, p: Vec3): Vec3 | null {
  const d = s.display;
  let best: { n: Vec3; d: number } | null = null;
  for (let t = 0; t < d.faceIds.length; t++) {
    if (d.faceIds[t] !== face) continue;
    const [a, b, c] = tri(d, t);
    const n = cross(sub(b, a), sub(c, a));
    const L = len(n);
    if (L < 1e-14) continue;
    const u = scale(n, 1 / L);
    const g = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
    // distance au plan du triangle + éloignement du centre : le triangle qui porte le point
    const dd = Math.abs(dot(sub(p, a), u)) * 10 + dist(p, g);
    if (!best || dd < best.d) best = { n: u, d: dd };
  }
  return best?.n ?? null;
}

/** Premier impact (distance > eps) du rayon o + t·u sur les triangles du solide. */
export function rayHit(s: Solid3D, o: Vec3, u: Vec3, eps = 1e-6): number | null {
  const d = s.display;
  let best: number | null = null;
  for (let t = 0; t < d.indices.length / 3; t++) {
    const [a, b, c] = tri(d, t);
    // Möller–Trumbore
    const e1 = sub(b, a), e2 = sub(c, a);
    const pv = cross(u, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const tv = sub(o, a);
    const bu = dot(tv, pv) * inv;
    if (bu < -1e-9 || bu > 1 + 1e-9) continue;
    const qv = cross(tv, e1);
    const bv = dot(u, qv) * inv;
    if (bv < -1e-9 || bu + bv > 1 + 1e-9) continue;
    const dist = dot(e2, qv) * inv;
    if (dist > eps && (best === null || dist < best)) best = dist;
  }
  return best;
}

/** Petit repère en croix aux extrémités d'une mesure. */
function ticks(p: Vec3, size: number): Vec3[][] {
  return [
    [add(p, { x: -size, y: 0, z: 0 }), add(p, { x: size, y: 0, z: 0 })],
    [add(p, { x: 0, y: -size, z: 0 }), add(p, { x: 0, y: size, z: 0 })],
    [add(p, { x: 0, y: 0, z: -size }), add(p, { x: 0, y: 0, z: size })],
  ];
}

const measure = cmd(
  'MEASUREGEOM',
  'MESUREGEOM',
  ['MESURE3D', 'MES3D', 'METRE', 'MEA'],
  'Mètre 3D : distance, angle, épaisseur de paroi, distance entre faces',
  async (ctx, app) => {
    let mode = 'Distance';
    let shown: Vec3[][] = [];
    let last = '';
    const tick = () => 6 * (app.viewport?.worldUnitsPerPixel() ?? 0.1);
    const keep = (extra: Vec3[][] = []) => () => [...shown, ...extra];
    const report = (text: string, lines: Vec3[][]) => {
      shown = lines;
      last = text;
      ctx.print(text);
      app.ui.toast(text, 'info');
    };
    const prefix = () => (last ? `${last} — ` : '');
    for (;;) {
      if (mode === 'Distance' || mode === 'Angle') {
        const r = await getPointOrKeyword(ctx, `${prefix()}${mode === 'Distance' ? 'Premier point' : 'Sommet de l’angle'}`, { keywords: MODES, allowNone: true, preview: keep() });
        if (r.none || r.keyword === 'Exit') return;
        if (r.keyword) {
          mode = r.keyword;
          continue;
        }
        const a = r.point!;
        if (mode === 'Distance') {
          const r2 = await getPointOrKeyword(ctx, 'Deuxième point', { basePoint: a, preview: (c) => [[a, c], ...ticks(a, tick())] });
          if (!r2.point) return;
          const b = r2.point;
          const d = sub(b, a);
          report(`Distance = ${fmt(dist(a, b))}  (ΔX ${fmt(d.x)}, ΔY ${fmt(d.y)}, ΔZ ${fmt(d.z)})`, [[a, b], ...ticks(a, tick()), ...ticks(b, tick())]);
        } else {
          const r2 = await getPointOrKeyword(ctx, 'Premier côté', { basePoint: a, preview: (c) => [[a, c]] });
          if (!r2.point) return;
          const p1 = r2.point;
          const r3 = await getPointOrKeyword(ctx, 'Second côté', { basePoint: a, preview: (c) => [[p1, a, c]] });
          if (!r3.point) return;
          const p2 = r3.point;
          const u = norm(sub(p1, a)), w = norm(sub(p2, a));
          const ang = Math.acos(Math.max(-1, Math.min(1, dot(u, w)))) / DEG;
          // arc de visualisation
          const R = Math.min(dist(a, p1), dist(a, p2)) * 0.35;
          const perp = norm(sub(w, scale(u, dot(u, w))));
          const arc = Array.from({ length: 25 }, (_, i) => {
            const t = ((ang * DEG) * i) / 24;
            return add(a, add(scale(u, R * Math.cos(t)), scale(perp, R * Math.sin(t))));
          });
          report(`Angle = ${fmt(ang, 3)}°`, [[p1, a, p2], arc]);
        }
        continue;
      }
      // modes sur les faces des solides
      const isSolid = (e: Entity) => e.type === '3DSOLID';
      const f1 = await pickEntity(ctx, `${prefix()}${mode === 'Thickness' ? 'Cliquez la face dont mesurer l’épaisseur' : 'Première face'}`, { filter: isSolid, pickMode: 'face', keywords: MODES, allowNone: true });
      if (f1 === null || f1 === 'Exit') return;
      if (typeof f1 === 'string') {
        mode = f1;
        continue;
      }
      const s1 = app.doc.get(f1.handle) as Solid3D | undefined;
      if (!s1 || f1.sub === undefined) continue;
      const n1 = faceNormalAt(s1, f1.sub, f1.point);
      if (!n1) continue;
      if (mode === 'Thickness') {
        const inward = scale(n1, -1);
        const t = rayHit(s1, add(f1.point, scale(inward, 1e-7)), inward, 1e-6);
        if (t === null) {
          report('Épaisseur : aucune face opposée trouvée (surface ouverte ?).', []);
          continue;
        }
        const exit = add(f1.point, scale(inward, t));
        report(`Épaisseur = ${fmt(t)}`, [[f1.point, exit], ...ticks(f1.point, tick()), ...ticks(exit, tick())]);
        continue;
      }
      const f2 = await pickEntity(ctx, 'Seconde face', { filter: isSolid, pickMode: 'face', allowNone: true });
      if (!f2 || typeof f2 === 'string') return;
      const s2 = app.doc.get(f2.handle) as Solid3D | undefined;
      if (!s2 || f2.sub === undefined) continue;
      const n2 = faceNormalAt(s2, f2.sub, f2.point);
      if (!n2) continue;
      const cos = dot(n1, n2);
      const between = Math.acos(Math.max(-1, Math.min(1, Math.abs(cos)))) / DEG;
      if (between < 0.05) {
        // faces parallèles : distance entre leurs plans
        const gap = Math.abs(dot(sub(f2.point, f1.point), n1));
        const foot = add(f2.point, scale(n1, -dot(sub(f2.point, f1.point), n1)));
        report(`Faces parallèles : distance = ${fmt(gap)}`, [[f2.point, foot], ...ticks(f2.point, tick()), ...ticks(foot, tick())]);
      } else {
        const dihedral = Math.acos(Math.max(-1, Math.min(1, -cos))) / DEG;
        report(`Angle entre les faces = ${fmt(dihedral, 3)}° (normales à ${fmt(Math.acos(Math.max(-1, Math.min(1, cos))) / DEG, 3)}°)`, [[f1.point, f2.point]]);
      }
    }
  },
);

export const measureCommands: CommandDefinition[] = [measure];
