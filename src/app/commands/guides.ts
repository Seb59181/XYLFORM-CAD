/**
 * Lignes de construction (guides) : droites « infinies » sur le calque Guides,
 * accrochables (intersection, perpendiculaire, proche ; le milieu est le point de passage),
 * exclues du zoom étendu, des impressions et des exports. GUIDE (passage + direction,
 * horizontale, verticale, angle, décalage d'une ligne (mètre), bissectrice),
 * RAPPORTEUR (angle depuis un sommet et une direction de référence), EFFGUIDES.
 */
import type { CommandContext, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { add, dist, dot, norm, scale, sub } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, DEG, fmt, getAngle, getDistance, getPoint, getPointOrKeyword, kw, pickRequired } from './helpers';

/** Demi-longueur d'un guide (mm) : assez pour tout dessin courant. */
export const GUIDE_HALF = 20000;
export const GUIDE_LAYER = 'Guides';

const guideLine = (through: Vec3, dir: Vec3): [Vec3, Vec3] => {
  const u = norm(dir);
  return [sub(through, scale(u, GUIDE_HALF)), add(through, scale(u, GUIDE_HALF))];
};

function addGuide(app: AppHost, through: Vec3, dir: Vec3): string | null {
  if (Math.hypot(dir.x, dir.y, dir.z) < 1e-12) return null;
  if (!app.doc.layer(GUIDE_LAYER)) app.doc.addLayer(GUIDE_LAYER, '#7d9ad6');
  const [start, end] = guideLine(through, dir);
  return app.addEntity({ type: 'LINE', start, end, guide: true, layer: GUIDE_LAYER });
}

const previewGuide = (through: Vec3) => (p: Vec3) => (dist(p, through) > 1e-9 ? [guideLine(through, sub(p, through))] : []);

/** Segment droit désigné : ligne ou côté de polyligne le plus proche du point cliqué. */
function segmentAt(e: Entity, at: Vec3): [Vec3, Vec3] | null {
  if (e.type === 'LINE') return [e.start, e.end];
  if (e.type !== 'POLYLINE') return null;
  let best: [Vec3, Vec3] | null = null, bd = Infinity;
  const n = e.points.length;
  for (let i = 0; i < (e.closed ? n : n - 1); i++) {
    if (e.bulges?.[i]) continue;
    const a = e.points[i]!, b = e.points[(i + 1) % n]!;
    const u = sub(b, a), L2 = dot(u, u);
    const t = L2 ? Math.max(0, Math.min(1, dot(sub(at, a), u) / L2)) : 0;
    const d = dist(at, add(a, scale(u, t)));
    if (d < bd) (bd = d), (best = [a, b]);
  }
  return best;
}

const isStraight = (e: Entity) => e.type === 'LINE' || e.type === 'POLYLINE';

async function repeatThrough(ctx: CommandContext, app: AppHost, dir: Vec3, message: string) {
  for (;;) {
    const r = await getPointOrKeyword(ctx, message, { allowNone: true, noRubberBand: true, preview: (p) => [guideLine(p, dir)] });
    if (!r.point) return;
    addGuide(app, r.point, dir);
  }
}

const guide = cmd('XLINE', 'GUIDE', ['XL', 'DROITE', 'CONSTRUCTION', 'LIGNECONSTRUCTION'], 'Ligne de construction infinie (guide) : par deux points, horizontale, verticale, angle, décalage d’une ligne (mètre), bissectrice', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez un point de passage', {
    keywords: [kw('Hor', 'Hor', 'H'), kw('Ver', 'Ver', 'V'), kw('Ang', 'Ang', 'A'), kw('Offset', 'Décalage', 'D', 'Parallèle à une ligne, à une distance (mètre)'), kw('Bisect', 'Bissectrice', 'B')],
  });
  if (r.keyword === 'Hor') return repeatThrough(ctx, app, { x: 1, y: 0, z: 0 }, 'Point de passage (Entrée pour terminer)');
  if (r.keyword === 'Ver') return repeatThrough(ctx, app, { x: 0, y: 1, z: 0 }, 'Point de passage (Entrée pour terminer)');
  if (r.keyword === 'Ang') {
    const a = await getAngle(ctx, 'Angle de la ligne (°)');
    if (typeof a !== 'number') return;
    return repeatThrough(ctx, app, { x: Math.cos(a), y: Math.sin(a), z: 0 }, 'Point de passage (Entrée pour terminer)');
  }
  if (r.keyword === 'Offset') {
    const { e, pick } = await pickRequired(ctx, 'Choisissez la ligne (ou le côté de polyligne) de référence', isStraight);
    const seg = segmentAt(e, pick.point);
    if (!seg) return ctx.print('Choisissez une ligne droite.');
    const u = norm(sub(seg[1], seg[0]));
    const n = norm({ x: -u.y, y: u.x, z: 0 });
    const side = (p: Vec3) => (dot(sub(p, seg[0]), n) >= 0 ? 1 : -1);
    const d = await getDistance(ctx, 'Distance de décalage, ou cliquez le point de passage', { basePoint: pick.point, noRubberBand: false });
    if (typeof d !== 'number') return;
    const s = side(await getPoint(ctx, 'Côté du décalage', { noRubberBand: true, preview: (p) => [guideLine(add(seg[0], scale(n, side(p) * d)), u)] }));
    addGuide(app, add(seg[0], scale(n, s * d)), u);
    return ctx.print(`Guide parallèle à ${fmt(d)}.`);
  }
  if (r.keyword === 'Bisect') {
    const v = await getPoint(ctx, 'Sommet de l’angle');
    const a = await getPoint(ctx, 'Point du premier côté', { basePoint: v });
    const b = await getPoint(ctx, 'Point du second côté', { basePoint: v });
    addGuide(app, v, add(norm(sub(a, v)), norm(sub(b, v))));
    return;
  }
  const p = r.point!;
  for (;;) {
    const q = await getPointOrKeyword(ctx, 'Point par lequel passe la ligne (Entrée pour terminer)', { basePoint: p, allowNone: true, noRubberBand: true, preview: previewGuide(p) });
    if (!q.point) return;
    addGuide(app, p, sub(q.point, p));
  }
});

const protractor = cmd('PROTRACTOR', 'RAPPORTEUR', ['RAP', 'GUIDEANGLE'], 'Rapporteur : guide à un angle donné depuis un sommet et une direction de référence', async (ctx, app) => {
  const v = await getPoint(ctx, 'Sommet (centre du rapporteur)');
  const ref = await getPoint(ctx, 'Point de la direction de référence (0°)', { basePoint: v });
  const a0 = Math.atan2(ref.y - v.y, ref.x - v.x);
  const r = await getAngle(ctx, 'Angle depuis la référence (°), ou cliquez', { basePoint: v, preview: previewGuide(v) });
  if (typeof r !== 'number') return;
  // angle cliqué = direction absolue (celle du curseur) ; angle tapé = relatif à la référence
  const c = app.cursor.world;
  const clicked = !!c && Math.abs(Math.atan2(c.y - v.y, c.x - v.x) - r) < 1e-9;
  const a = clicked ? r : a0 + r;
  addGuide(app, v, { x: Math.cos(a), y: Math.sin(a), z: 0 });
  ctx.print(`Guide à ${fmt(((a - a0) / DEG + 360) % 360, 2)}° de la référence.`);
});

const eraseGuides = cmd('DELGUIDES', 'EFFGUIDES', ['EFG', 'EFFACERGUIDES'], 'Efface toutes les lignes de construction (guides)', async (ctx, app) => {
  const hs = app.doc.all().filter((e) => e.type === 'LINE' && e.guide).map((e) => e.handle);
  if (!hs.length) return ctx.print('Aucun guide.');
  app.doc.transaction('Effacer les guides', () => hs.forEach((h) => app.doc.removeEntity(h)));
  ctx.print(`${hs.length} guide(s) effacé(s).`);
});

export const guideCommands = [guide, protractor, eraseGuides];
