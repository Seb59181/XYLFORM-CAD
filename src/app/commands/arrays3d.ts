/**
 * Réseaux 3D : copies d'objets en grille
 * X × Y × Z, en cercle autour d'un axe quelconque, ou le long d'un chemin (ligne, polyligne,
 * arc, spline, hélice) avec ou sans orientation sur la tangente. Les copies de solides gardent
 * leur historique paramétrique. Une seule étape d'annulation par réseau.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { curvePoints } from '../../core/entities/geometry';
import { add, cross, dist, dot, IDENTITY, len, lerp, multiply, norm, rotationAxis, scale, sub, translation, type Affine } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, DEG, fmt, getDistance, getKeyword, getNumber, getPoint, getPointOrKeyword, kw, outlines, pickRequired, selectObjects } from './helpers';

const MAX = 2500;

/** Aperçu : contours des objets déplacés par chaque matrice (budget limité). */
function previewOf(base: Vec3[][], ms: Affine[]): Vec3[][] {
  const per = Math.max(1, Math.floor(6000 / Math.max(1, base.reduce((n, p) => n + p.length, 0))));
  const out: Vec3[][] = [];
  for (const m of ms.slice(0, per)) for (const pl of base) out.push(pl.map((p) => applyM(m, p)));
  return out;
}

function applyM(m: Affine, p: Vec3): Vec3 {
  return { x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3], y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7], z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11] };
}

/** Rotation qui amène la direction a sur b (autour du point c). */
function align(c: Vec3, a: Vec3, b: Vec3): Affine {
  const u = norm(a), v = norm(b);
  const d = Math.max(-1, Math.min(1, dot(u, v)));
  if (d > 1 - 1e-12) return IDENTITY;
  let axis = cross(u, v);
  if (len(axis) < 1e-9) axis = Math.abs(u.z) < 0.9 ? cross(u, { x: 0, y: 0, z: 1 }) : cross(u, { x: 1, y: 0, z: 0 });
  return rotationAxis(c, norm(axis), Math.acos(d));
}

async function finish(ctx: CommandContext, app: AppHost, hs: string[], ms: Affine[], label: string): Promise<void> {
  if (!ms.length) return;
  if (ms.length * hs.length > MAX) throw new Error(`Réseau trop grand (${MAX} objets maximum).`);
  ctx.print(`Création de ${ms.length} copie(s)…`);
  const out = await app.copyEntities(hs, ms, label, ctx);
  ctx.print(`${label} : ${ms.length + 1} éléments (${out.length} objet(s) créé(s)).`);
}

async function axisFrom(ctx: CommandContext, msg: string): Promise<{ c: Vec3; u: Vec3 }> {
  const c = await getPoint(ctx, msg);
  const r = await getPointOrKeyword(ctx, 'Second point de l’axe', { basePoint: c, keywords: [kw('X', 'X', 'X'), kw('Y', 'Y', 'Y'), kw('Z', 'Z', 'Z')], defaultValue: 'Z', allowNone: true });
  if (r.keyword === 'X') return { c, u: { x: 1, y: 0, z: 0 } };
  if (r.keyword === 'Y') return { c, u: { x: 0, y: 1, z: 0 } };
  if (r.point && dist(r.point, c) > 1e-9) return { c, u: norm(sub(r.point, c)) };
  return { c, u: { x: 0, y: 0, z: 1 } };
}

async function rect(ctx: CommandContext, app: AppHost, hs: string[]): Promise<void> {
  const base = outlines(app, hs, 3000);
  const nx = (await getNumber(ctx, 'Nombre de colonnes (X)', { integer: true, defaultValue: 3, allowZero: false })) as number;
  const ny = (await getNumber(ctx, 'Nombre de rangées (Y)', { integer: true, defaultValue: 1, allowZero: false })) as number;
  const nz = (await getNumber(ctx, 'Nombre de niveaux (Z)', { integer: true, defaultValue: 1, allowZero: false })) as number;
  const grid = (dx: number, dy: number, dz: number) => {
    const ms: Affine[] = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i || j || k) ms.push(translation({ x: i * dx, y: j * dy, z: k * dz }));
    return ms;
  };
  const dx = nx > 1 ? ((await getDistance(ctx, 'Distance entre les colonnes (X)', { defaultValue: 20, allowNegative: true, allowZero: false, preview: () => previewOf(base, grid(20, 0, 0)) })) as number) : 0;
  const dy = ny > 1 ? ((await getDistance(ctx, 'Distance entre les rangées (Y)', { defaultValue: 20, allowNegative: true, allowZero: false })) as number) : 0;
  const dz = nz > 1 ? ((await getDistance(ctx, 'Distance entre les niveaux (Z)', { defaultValue: 20, allowNegative: true, allowZero: false })) as number) : 0;
  await finish(ctx, app, hs, grid(dx, dy, dz), 'Réseau 3D rectangulaire');
}

async function polar(ctx: CommandContext, app: AppHost, hs: string[]): Promise<void> {
  const n = (await getNumber(ctx, 'Nombre d’éléments', { integer: true, defaultValue: 6, allowZero: false })) as number;
  if (n < 2) throw new Error('Au moins 2 éléments.');
  const fill = (await getNumber(ctx, 'Angle à décrire (360 = tour complet)', { defaultValue: 360, allowNegative: true, allowZero: false })) as number;
  const rot = (await getKeyword(ctx, 'Faire pivoter les objets', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'Yes')) === 'Yes';
  const { c, u } = await axisFrom(ctx, 'Premier point de l’axe de rotation');
  const step = Math.abs(Math.abs(fill) - 360) < 1e-9 ? (fill * DEG) / n : (fill * DEG) / (n - 1);
  // sans rotation : chaque copie est seulement translatée (son centre suit le cercle)
  const ents = hs.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
  const pts = outlines(app, hs, 2000).flat();
  const ctr = pts.length ? scale(pts.reduce((a, p) => add(a, p), { x: 0, y: 0, z: 0 }), 1 / pts.length) : c;
  void ents;
  const ms: Affine[] = [];
  for (let i = 1; i < n; i++) {
    const r = rotationAxis(c, u, step * i);
    ms.push(rot ? r : translation(sub(applyM(r, ctr), ctr)));
  }
  await finish(ctx, app, hs, ms, 'Réseau 3D polaire');
}

/** Points le long d'une polyligne à des abscisses curvilignes, avec la tangente. */
function along(pl: Vec3[], s: number[]): { p: Vec3; t: Vec3 }[] {
  const cum = [0];
  for (let i = 1; i < pl.length; i++) cum.push(cum[i - 1]! + dist(pl[i - 1]!, pl[i]!));
  return s.map((x) => {
    let i = 1;
    while (i < pl.length - 1 && cum[i]! < x) i++;
    const a = pl[i - 1]!, b = pl[i]!;
    const seg = cum[i]! - cum[i - 1]! || 1;
    return { p: lerp(a, b, Math.max(0, Math.min(1, (x - cum[i - 1]!) / seg))), t: norm(sub(b, a)) };
  });
}

async function path(ctx: CommandContext, app: AppHost, hs: string[]): Promise<void> {
  const { e } = await pickRequired(ctx, 'Choisissez le chemin (ligne, polyligne, arc, cercle, spline, hélice)', (x) => !hs.includes(x.handle) && x.type !== '3DSOLID' && x.type !== 'TEXT' && x.type !== 'HATCH' && curvePoints(x).length > 0);
  const pl = curvePoints(e).flat().filter((p, i, a) => i === 0 || dist(p, a[i - 1]!) > 1e-9);
  if (pl.length < 2) throw new Error('Chemin trop court.');
  let total = 0;
  for (let i = 1; i < pl.length; i++) total += dist(pl[i - 1]!, pl[i]!);
  const closed = dist(pl[0]!, pl[pl.length - 1]!) < 1e-6;
  const r = await getNumber(ctx, `Nombre d’éléments (chemin de ${fmt(total)})`, { integer: true, defaultValue: 5, allowZero: false, keywords: [kw('Spacing', 'Espacement', 'E', 'Distance fixe entre les éléments')] });
  let s: number[];
  if (r === 'Spacing') {
    const d = (await getDistance(ctx, 'Distance entre les éléments', { defaultValue: total / 4, allowZero: false })) as number;
    s = [];
    for (let x = d; x <= total + 1e-9 && s.length < MAX; x += d) s.push(x);
  } else {
    const n = r as number;
    if (n < 2) throw new Error('Au moins 2 éléments.');
    const step = closed ? total / n : total / (n - 1);
    s = Array.from({ length: n - 1 }, (_, i) => step * (i + 1));
  }
  const orient = (await getKeyword(ctx, 'Orienter les objets sur le chemin (tangente)', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'Yes')) === 'Yes';
  // point de base : départ du chemin (les objets sont copiés tels qu'ils sont placés par rapport à lui)
  const start = along(pl, [0])[0]!;
  const ms = along(pl, s).map(({ p, t }) => {
    const move = translation(sub(p, start.p));
    return orient ? multiply(move, align(start.p, start.t, t)) : move;
  });
  await finish(ctx, app, hs, ms, 'Réseau 3D le long d’un chemin');
}

const array3d = cmd('3DARRAY', 'RESEAU3D', ['3A', 'RES3D', 'MOTIF'], 'Réseau 3D : copies en grille X×Y×Z, en cercle autour d’un axe ou le long d’un chemin', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets à répéter');
  if (!hs.length) return;
  const k = await getKeyword(ctx, 'Type de réseau', [kw('Rectangular', 'Rectangulaire', 'R', 'Grille X × Y × Z'), kw('Polar', 'Polaire', 'P', 'En cercle autour d’un axe'), kw('Path', 'Chemin', 'C', 'Le long d’une courbe')], 'Rectangular');
  if (k === 'Polar') return polar(ctx, app, hs);
  if (k === 'Path') return path(ctx, app, hs);
  return rect(ctx, app, hs);
});

const arrayPath = cmd('ARRAYPATH', 'RESEAUCHEMIN', ['RC', 'RESCHEMIN'], 'Réseau le long d’un chemin (orienté sur la tangente)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets à répéter');
  if (hs.length) await path(ctx, app, hs);
});

export const array3dCommands: CommandDefinition[] = [array3d, arrayPath];
