/**
 * Onglet Début › Modification : effacer, déplacer, copier, rotation, miroir, échelle, décaler,
 * étirer, raccord, chanfrein, ajuster, prolonger, coupure, diviser, joindre, décomposer, réseaux.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, NewEntity } from '../../core/document/Document';
import {
  breakEntity,
  chamferLines,
  dividePoints,
  explodeEntity,
  extendEntity,
  filletLines,
  filletPolyline,
  joinEntities,
  nearestOn,
  TRIMMABLE,
  trimEntity,
} from '../../core/entities/edit';
import { curvePoints, offsetEntity } from '../../core/entities/geometry';
import { underlayEntities } from '../../core/entities/underlay';
export { outlines };
import { add, angleXY, apply, dist, mirrorLine, rotationZ, scaling, sub, translation, type Affine } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, DEG, fmt, getAngle, getDistance, getKeyword, getNumber, getPoint, getPointOrKeyword, is, kw, outlines, pickEntity, pickRequired, selectObjects } from './helpers';
import { filletSolidEdges, chamferSolidEdges } from './solids';

const strip = (e: Entity): NewEntity => {
  const { handle: _h, ...rest } = e;
  return rest as NewEntity;
};

const transformed = (polys: Vec3[][], m: Affine) => polys.map((pl) => pl.map((p) => apply(m, p)));

// ---------------------------------------------------------------------------

const erase = cmd('ERASE', 'EFFACER', ['E', 'EF', 'DELETE'], 'Supprime des objets', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  app.doc.transaction('Effacer', () => hs.forEach((h) => app.doc.removeEntity(h)));
  ctx.print(`${hs.length} objet(s) supprimé(s).`);
});

const move = cmd('MOVE', 'DEPLACER', ['DE', 'M'], 'Déplace des objets', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const r = await getPointOrKeyword(ctx, 'Spécifiez le point de base', { keywords: [kw('Displacement', 'Déplacement', 'D')] });
  let d: Vec3;
  if (r.keyword) d = await getPoint(ctx, 'Spécifiez le déplacement (x,y,z)');
  else {
    const base = r.point!;
    const p2 = await getPointOrKeyword(ctx, 'Spécifiez le deuxième point ou <utiliser le premier point comme déplacement>', {
      basePoint: base,
      allowNone: true,
      preview: (p) => transformed(polys, translation(sub(p, base))),
    });
    d = p2.point ? sub(p2.point, base) : base;
  }
  await app.transformEntities(hs, translation(d), { label: 'Déplacer', ctx });
});

const copy = cmd('COPY', 'COPIER', ['CP', 'CO'], 'Copie des objets', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  let n = 0;
  for (;;) {
    const r = await getPointOrKeyword(ctx, 'Spécifiez le deuxième point', {
      basePoint: base,
      allowNone: true,
      keywords: n ? [kw('Exit', 'Quitter', 'Q')] : [],
      defaultValue: n ? 'Exit' : undefined,
      preview: (p) => transformed(polys, translation(sub(p, base))),
    });
    if (!r.point) break;
    await app.transformEntities(hs, translation(sub(r.point, base)), { copy: true, label: 'Copier', ctx });
    n++;
  }
});

const rotate = cmd('ROTATE', 'ROTATION', ['RO'], 'Fait pivoter des objets autour d’un point', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  let copyMode = false;
  let refAngle = 0;
  for (;;) {
    const r = await getAngle(ctx, 'Spécifiez l’angle de rotation', {
      basePoint: base,
      keywords: [kw('Copy', 'Copier', 'C'), kw('Reference', 'Référence', 'R')],
      defaultValue: 0,
      preview: (p) => transformed(polys, rotationZ(base, angleXY(base, p) - refAngle)),
    });
    if (r === 'Copy') {
      copyMode = true;
      ctx.print('Rotation d’une copie des objets sélectionnés.');
      continue;
    }
    if (r === 'Reference') {
      refAngle = (await getAngle(ctx, 'Spécifiez l’angle de référence', { basePoint: base, defaultValue: 0 })) as number;
      const nw = (await getAngle(ctx, 'Spécifiez le nouvel angle', { basePoint: base, preview: (p) => transformed(polys, rotationZ(base, angleXY(base, p) - refAngle)) })) as number;
      await app.transformEntities(hs, rotationZ(base, nw - refAngle), { copy: copyMode, label: 'Rotation', ctx });
      return;
    }
    await app.transformEntities(hs, rotationZ(base, r as number), { copy: copyMode, label: 'Rotation', ctx });
    return;
  }
});

const mirror = cmd('MIRROR', 'MIROIR', ['MI'], 'Crée une copie symétrique', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const p1 = await getPoint(ctx, 'Spécifiez le premier point de l’axe de symétrie');
  const p2 = await getPoint(ctx, 'Spécifiez le deuxième point de l’axe de symétrie', {
    basePoint: p1,
    preview: (p) => (dist(p, p1) > 1e-9 ? transformed(polys, mirrorLine(p1, p)) : []),
  });
  const del = await getKeyword(ctx, 'Effacer les objets sources ?', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'No');
  await app.transformEntities(hs, mirrorLine(p1, p2), { copy: del === 'No', label: 'Miroir', ctx });
});

const scaleCmd = cmd('SCALE', 'ECHELLE', ['EC', 'SC'], 'Agrandit ou réduit des objets', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  let copyMode = false;
  let refLen = 1;
  for (;;) {
    const r = await getDistance(ctx, 'Spécifiez le facteur d’échelle', {
      basePoint: base,
      defaultValue: 1,
      allowZero: false,
      keywords: [kw('Copy', 'Copier', 'C'), kw('Reference', 'Référence', 'R')],
      preview: (p) => (dist(base, p) > 1e-9 ? transformed(polys, scaling(base, dist(base, p) / refLen)) : []),
    });
    if (r === 'Copy') {
      copyMode = true;
      continue;
    }
    if (r === 'Reference') {
      refLen = (await getDistance(ctx, 'Spécifiez la longueur de référence', { defaultValue: 1, allowZero: false })) as number;
      const nl = (await getDistance(ctx, 'Spécifiez la nouvelle longueur', { basePoint: base, allowZero: false, preview: (p) => transformed(polys, scaling(base, dist(base, p) / refLen)) })) as number;
      await app.transformEntities(hs, scaling(base, nl / refLen), { copy: copyMode, label: 'Échelle', ctx });
      return;
    }
    await app.transformEntities(hs, scaling(base, r as number), { copy: copyMode, label: 'Échelle', ctx });
    return;
  }
});

// ---------------------------------------------------------------------------

const offset = cmd('OFFSET', 'DECALER', ['DC', 'O'], 'Crée des courbes parallèles (décalage)', async (ctx, app) => {
  const sv = app.sysvars;
  const r = await getDistance(ctx, 'Spécifiez la distance de décalage', { defaultValue: sv.OFFSETDIST, allowZero: false, keywords: [kw('Through', 'Par', 'P', 'Passe par un point')] });
  const through = r === 'Through';
  if (!through) sv.OFFSETDIST = r as number;
  const ok = is('LINE', 'CIRCLE', 'ARC', 'POLYLINE', 'ELLIPSE');
  for (;;) {
    const pick = await pickEntity(ctx, 'Choisissez l’objet à décaler (Entrée pour terminer)', { filter: ok, allowNone: true });
    if (!pick || typeof pick === 'string') return;
    const e = app.doc.get(pick.handle)!;
    const side = await getPoint(ctx, through ? 'Spécifiez le point de passage' : 'Spécifiez un point sur le côté à décaler', {
      noRubberBand: true,
      preview: (p) => {
        const d = through ? dist(nearestOn(e, p) ?? p, p) : sv.OFFSETDIST;
        const patch = offsetEntity(e, d, p);
        return patch ? curvePoints({ ...e, ...patch } as Entity) : [];
      },
    });
    const d = through ? dist(nearestOn(e, side) ?? side, side) : sv.OFFSETDIST;
    const patch = offsetEntity(e, d, side);
    if (!patch) {
      ctx.print('Décalage impossible (rayon négatif ou objet non pris en charge).');
      continue;
    }
    app.addEntity({ ...strip(e), ...patch } as NewEntity);
  }
});

// ---------------------------------------------------------------------------

function stretchPatch(e: Entity, inside: (p: Vec3) => boolean, d: Vec3): Partial<NewEntity> | 'move' | null {
  const mv = (p: Vec3) => (inside(p) ? add(p, d) : p);
  switch (e.type) {
    case 'LINE':
      return inside(e.start) || inside(e.end) ? { start: mv(e.start), end: mv(e.end) } : null;
    case 'POLYLINE':
      return e.points.some(inside) ? { points: e.points.map(mv) } : null;
    case 'SPLINE':
      return e.fitPoints.some(inside) ? { fitPoints: e.fitPoints.map(mv) } : null;
    case 'DIMENSION':
      if (e.dimType === 'angular' || e.dimType === 'arclength' || e.dimType === 'ordinate') {
        // sommet / centre / origine solidaires : étirés seulement s'ils sont dans la fenêtre
        const patch: Partial<Extract<Entity, { type: 'DIMENSION' }>> = {};
        if (inside(e.p1)) patch.p1 = mv(e.p1);
        if (inside(e.p2)) patch.p2 = mv(e.p2);
        if (inside(e.offsetPoint)) patch.offsetPoint = mv(e.offsetPoint);
        if (e.center && inside(e.center)) patch.center = mv(e.center);
        return Object.keys(patch).length ? patch : null;
      }
      return inside(e.p1) || inside(e.p2) || inside(e.offsetPoint) ? { p1: mv(e.p1), p2: mv(e.p2), offsetPoint: mv(e.offsetPoint) } : null;
    case 'HATCH':
      return e.boundaries.some((b) => b.some(inside)) ? { boundaries: e.boundaries.map((b) => b.map(mv)) } : null;
    case 'CIRCLE':
    case 'ELLIPSE':
    case 'HELIX':
      return inside(e.center) ? 'move' : null;
    case 'ARC':
      return inside(e.center) ? 'move' : null;
    case 'POINT':
      return inside(e.position) ? 'move' : null;
    case 'TEXT':
    case 'UNDERLAY':
      return inside(e.position) ? 'move' : null;
    case '3DSOLID': {
      const b = e.display.bbox;
      return inside(b.min) && inside(b.max) ? 'move' : null;
    }
  }
}

const stretch = cmd('STRETCH', 'ETIRER', ['ET', 'S'], 'Étire les objets traversés par une fenêtre de capture', async (ctx, app) => {
  ctx.print('Choisissez les objets à étirer par une fenêtre de capture.');
  const c1 = await getPoint(ctx, 'Spécifiez le premier coin de la fenêtre de capture');
  const c2 = await getPoint(ctx, 'Spécifiez le coin opposé', {
    noRubberBand: true,
    preview: (p) => [[c1, { ...c1, x: p.x }, { ...p, z: c1.z }, { ...c1, y: p.y }, c1]],
  });
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x), y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  const inside = (p: Vec3) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const targets = app.doc.all().filter((e) => app.doc.isPickable(e) && stretchPatch(e, inside, { x: 0, y: 0, z: 0 }) !== null);
  if (!targets.length) {
    ctx.print('Aucun objet dans la fenêtre.');
    return;
  }
  ctx.print(`${targets.length} trouvé(s)`);
  app.selection.set(targets.map((e) => e.handle));
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  const preview = (p: Vec3) => {
    const d = sub(p, base);
    return targets.flatMap((e) => {
      const patch = stretchPatch(e, inside, d);
      if (patch === 'move') return outlines(app, [e.handle]).map((pl) => pl.map((q) => add(q, d)));
      return patch ? curvePoints({ ...e, ...patch } as Entity) : [];
    });
  };
  const p2 = await getPoint(ctx, 'Spécifiez le deuxième point', { basePoint: base, preview });
  const d = sub(p2, base);
  const moved = targets.filter((e) => stretchPatch(e, inside, d) === 'move').map((e) => e.handle);
  if (moved.length) await app.transformEntities(moved, translation(d), { label: 'Étirer', ctx });
  app.doc.transaction('Étirer', () => {
    for (const e of targets) {
      const patch = stretchPatch(e, inside, d);
      if (patch && patch !== 'move') app.doc.replaceEntity(e.handle, patch);
    }
  });
});

// ---------------------------------------------------------------------------

async function cornerCommand(ctx: CommandContext, app: AppHost, kind: 'fillet' | 'chamfer'): Promise<void> {
  const sv = app.sysvars;
  const settings = () => (kind === 'fillet' ? `Paramètres courants : Mode = AJUSTER, Rayon = ${fmt(sv.FILLETRAD)}` : `Paramètres courants : Distance1 = ${fmt(sv.CHAMFERA)}, Distance2 = ${fmt(sv.CHAMFERB || sv.CHAMFERA)}`);
  ctx.print(settings());
  const keywords =
    kind === 'fillet'
      ? [kw('Radius', 'Rayon', 'R'), kw('Polyline', 'Polyligne', 'P', 'Tous les sommets d’une polyligne'), kw('Multiple', 'Multiple', 'M')]
      : [kw('Distance', 'Distance', 'D'), kw('Polyline', 'Polyligne', 'P', 'Tous les sommets d’une polyligne'), kw('Multiple', 'Multiple', 'M')];
  let multiple = false;
  for (;;) {
    const first = await pickEntity(ctx, 'Choisissez le premier objet', { filter: is('LINE', 'POLYLINE', '3DSOLID'), keywords, allowNone: multiple });
    if (first === null) return;
    if (first === 'Radius') {
      sv.FILLETRAD = (await getDistance(ctx, 'Spécifiez le rayon de raccord', { defaultValue: sv.FILLETRAD, allowZero: true })) as number;
      continue;
    }
    if (first === 'Distance') {
      sv.CHAMFERA = (await getDistance(ctx, 'Spécifiez la première distance de chanfrein', { defaultValue: sv.CHAMFERA, allowZero: true })) as number;
      sv.CHAMFERB = (await getDistance(ctx, 'Spécifiez la deuxième distance de chanfrein', { defaultValue: sv.CHAMFERB || sv.CHAMFERA, allowZero: true })) as number;
      continue;
    }
    if (first === 'Multiple') {
      multiple = true;
      continue;
    }
    if (first === 'Polyline') {
      const { e } = await pickRequired(ctx, 'Choisissez une polyligne 2D', is('POLYLINE'));
      const res = filletPolyline(e as Extract<Entity, { type: 'POLYLINE' }>, sv.FILLETRAD, kind === 'chamfer' ? { d1: sv.CHAMFERA, d2: sv.CHAMFERB || sv.CHAMFERA } : undefined);
      app.doc.replaceEntity(e.handle, { points: res.points, bulges: res.bulges });
      ctx.print(`${res.count} sommet(s) traité(s).`);
      if (!multiple) return;
      continue;
    }
    if (typeof first === 'string') continue;
    const e1 = app.doc.get(first.handle)!;
    if (e1.type === '3DSOLID') {
      // raccord d'arêtes d'un solide
      if (kind === 'fillet') await filletSolidEdges(ctx, app, e1.handle, first.sub);
      else await chamferSolidEdges(ctx, app, e1.handle, first.sub);
      return;
    }
    if (e1.type !== 'LINE') {
      ctx.print('Pour une polyligne, utilisez l’option Polyligne.');
      continue;
    }
    const second = await pickRequired(ctx, 'Choisissez le deuxième objet', (e) => e.type === 'LINE' && e.handle !== e1.handle);
    const l1 = e1 as Extract<Entity, { type: 'LINE' }>, l2 = second.e as Extract<Entity, { type: 'LINE' }>;
    const res =
      kind === 'fillet'
        ? filletLines(l1, first.point, l2, second.pick.point, sv.FILLETRAD)
        : chamferLines(l1, first.point, l2, second.pick.point, sv.CHAMFERA, sv.CHAMFERB || sv.CHAMFERA);
    if (typeof res === 'string') {
      ctx.print(res);
      app.ui.toast(res, 'error');
    } else
      app.doc.transaction(kind === 'fillet' ? 'Raccord' : 'Chanfrein', () => {
        app.doc.replaceEntity(l1.handle, res.line1);
        app.doc.replaceEntity(l2.handle, res.line2);
        if (res.arc) app.addEntity({ ...res.arc, layer: l1.layer, color: l1.color });
        if (res.segment) app.addEntity({ ...res.segment, layer: l1.layer, color: l1.color });
      });
    if (!multiple) return;
  }
}

const fillet = cmd('FILLET', 'RACCORD', ['RA', 'F'], 'Arrondit l’angle entre deux lignes (ou les arêtes d’un solide)', (ctx, app) => cornerCommand(ctx, app, 'fillet'));
const chamfer = cmd('CHAMFER', 'CHANFREIN', ['CHA'], 'Chanfreine l’angle entre deux lignes (ou les arêtes d’un solide)', (ctx, app) => cornerCommand(ctx, app, 'chamfer'));

// ---------------------------------------------------------------------------

const trim = cmd('TRIM', 'AJUSTER', ['AJ', 'TR'], 'Coupe les objets à leurs intersections (mode rapide)', async (ctx, app) => {
  ctx.print('Paramètres courants : Mode = Rapide. Toutes les géométries servent d’arêtes de coupe.');
  for (;;) {
    const pick = await pickEntity(ctx, 'Choisissez l’objet à ajuster (Entrée pour terminer)', { filter: (e) => TRIMMABLE.has(e.type), allowNone: true });
    if (!pick || typeof pick === 'string') return;
    const e = app.doc.get(pick.handle)!;
    const pieces = trimEntity(e, pick.point, app.visible());
    if (pieces === null) {
      ctx.print('Impossible d’ajuster cet objet (un cercle a besoin de deux intersections).');
      continue;
    }
    app.doc.transaction('Ajuster', () => {
      app.doc.removeEntity(e.handle);
      for (const p of pieces) app.addEntity({ ...p, layer: e.layer, color: e.color } as NewEntity);
    });
  }
});

const extend = cmd('EXTEND', 'PROLONGER', ['PR', 'EX'], 'Prolonge des objets jusqu’aux limites les plus proches', async (ctx, app) => {
  for (;;) {
    const pick = await pickEntity(ctx, 'Choisissez l’objet à prolonger (près de l’extrémité, Entrée pour terminer)', { filter: is('LINE', 'ARC', 'POLYLINE'), allowNone: true });
    if (!pick || typeof pick === 'string') return;
    const e = app.doc.get(pick.handle)!;
    const patch = extendEntity(e, pick.point, app.visible());
    if (!patch) ctx.print('L’objet ne rencontre aucune limite.');
    else app.doc.replaceEntity(e.handle, patch);
  }
});

const breakCmd = cmd('BREAK', 'COUPURE', ['CB', 'BR'], 'Coupe un objet entre deux points', async (ctx, app) => {
  const { e, pick } = await pickRequired(ctx, 'Choisissez l’objet', (x) => TRIMMABLE.has(x.type));
  let p1 = pick.point;
  let r = await getPointOrKeyword(ctx, 'Spécifiez le second point de coupure', { keywords: [kw('First', 'Premier point', 'P')], basePoint: p1 });
  if (r.keyword) {
    p1 = await getPoint(ctx, 'Spécifiez le premier point de coupure');
    r = { point: await getPoint(ctx, 'Spécifiez le second point de coupure', { basePoint: p1 }) };
  }
  const pieces = breakEntity(e, p1, r.point!);
  if (!pieces) {
    ctx.print('Coupure impossible.');
    return;
  }
  app.doc.transaction('Coupure', () => {
    app.doc.removeEntity(e.handle);
    for (const p of pieces) app.addEntity({ ...p, layer: e.layer, color: e.color } as NewEntity);
  });
});

const breakAtPoint = cmd('BREAKATPOINT', 'COUPUREPOINT', ['CBP'], 'Coupe un objet en deux en un point', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Choisissez l’objet', (x) => TRIMMABLE.has(x.type) && x.type !== 'CIRCLE');
  const p = await getPoint(ctx, 'Spécifiez le point de coupure');
  const pieces = breakEntity(e, p, p);
  if (!pieces) return;
  app.doc.transaction('Coupure', () => {
    app.doc.removeEntity(e.handle);
    for (const q of pieces) app.addEntity({ ...q, layer: e.layer, color: e.color } as NewEntity);
  });
});

const divide = cmd('DIVIDE', 'DIVISER', ['DIV'], 'Place des points régulièrement espacés sur un objet', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Choisissez l’objet à diviser', is('LINE', 'ARC', 'CIRCLE', 'POLYLINE', 'ELLIPSE', 'SPLINE', 'HELIX'));
  const n = (await getNumber(ctx, 'Entrez le nombre de segments', { integer: true, defaultValue: 4, allowZero: false })) as number;
  if (n < 2 || n > 32767) throw new Error('Le nombre de segments doit être compris entre 2 et 32767.');
  const pts = dividePoints(e, n);
  app.doc.transaction('Diviser', () => pts.forEach((p) => app.addEntity({ type: 'POINT', position: p, layer: e.layer })));
  ctx.print(`${pts.length} point(s) créé(s).`);
});

const join = cmd('JOIN', 'JOINDRE', ['J'], 'Joint lignes, arcs et polylignes contigus en une polyligne', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets à joindre', is('LINE', 'ARC', 'POLYLINE'));
  const { result, consumed } = joinEntities(hs.map((h) => app.doc.get(h)!), 1e-6);
  if (!result.length) {
    ctx.print('Aucun objet joint : les extrémités doivent coïncider.');
    return;
  }
  app.doc.transaction('Joindre', () => {
    consumed.forEach((h) => app.doc.removeEntity(h));
    result.forEach((r) => app.addEntity(r));
  });
  ctx.print(`${consumed.length} objets joints en ${result.length} polyligne(s).`);
});

const explode = cmd('EXPLODE', 'DECOMPOS', ['X'], 'Décompose polylignes, cotes, hachures et copies de blocs', async (ctx, app) => {
  const isBlock = (e: Entity) => e.type === 'UNDERLAY' && app.doc.underlays[e.ref]?.kind === 'block';
  const hs = await selectObjects(ctx, 'Choisissez les objets', (e) => is('POLYLINE', 'DIMENSION', 'HATCH')(e) || isBlock(e));
  let n = 0;
  app.doc.transaction('Décomposer', () => {
    for (const h of hs) {
      const e = app.doc.get(h)!;
      // copie de bloc : ses objets deviennent indépendants (sur leurs calques d'origine)
      const parts = isBlock(e) && e.type === 'UNDERLAY' ? underlayEntities(e, app.doc.underlays[e.ref]!).map(({ handle: _h, ...rest }) => rest as NewEntity) : explodeEntity(e);
      if (!parts) continue;
      app.doc.removeEntity(h);
      parts.forEach((p) => app.addEntity(p));
      n++;
    }
  });
  ctx.print(`${n} objet(s) décomposé(s).`);
});

// ---------------------------------------------------------------------------

const arrayRect = cmd('ARRAYRECT', 'RESEAURECT', ['RR'], 'Réseau rectangulaire (rangées × colonnes)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const cols = (await getNumber(ctx, 'Entrez le nombre de colonnes', { integer: true, defaultValue: 4, allowZero: false })) as number;
  const rows = (await getNumber(ctx, 'Entrez le nombre de rangées', { integer: true, defaultValue: 3, allowZero: false })) as number;
  const polys = outlines(app, hs, 8000);
  const dx = (await getDistance(ctx, 'Spécifiez la distance entre les colonnes', { defaultValue: 10, allowNegative: true, allowZero: false })) as number;
  const dy = (await getDistance(ctx, 'Spécifiez la distance entre les rangées', {
    defaultValue: 10,
    allowNegative: true,
    allowZero: false,
  })) as number;
  void polys;
  if (cols * rows > 2500) throw new Error('Réseau trop grand (2500 éléments maximum).');
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      if (!i && !j) continue;
      await app.transformEntities(hs, translation({ x: i * dx, y: j * dy, z: 0 }), { copy: true, label: 'Réseau', ctx });
    }
  ctx.print(`Réseau de ${cols} × ${rows} éléments créé.`);
});

const arrayPolar = cmd('ARRAYPOLAR', 'RESEAUPOLAIRE', ['RP'], 'Réseau polaire autour d’un centre', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const c = await getPoint(ctx, 'Spécifiez le centre du réseau');
  const n = (await getNumber(ctx, 'Entrez le nombre d’éléments', { integer: true, defaultValue: 6, allowZero: false })) as number;
  const fill = (await getNumber(ctx, 'Spécifiez l’angle à décrire (+ = trigonométrique)', { defaultValue: 360, allowNegative: true, allowZero: false })) as number;
  if (n < 2 || n > 2500) throw new Error('Entre 2 et 2500 éléments.');
  const step = Math.abs(Math.abs(fill) - 360) < 1e-9 ? (fill * DEG) / n : (fill * DEG) / (n - 1);
  for (let i = 1; i < n; i++) await app.transformEntities(hs, rotationZ(c, step * i), { copy: true, label: 'Réseau polaire', ctx });
  ctx.print(`Réseau polaire de ${n} éléments créé.`);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

/** Ramène des courbes dans le plan horizontal de l'élévation courante (comme FLATTEN). */
const flatten = cmd('FLATTEN', 'APLANIR', ['APL'], 'Ramène des courbes à plat (même hauteur Z)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const z = app.processor.elevation;
  const at = (p: Vec3): Vec3 => ({ ...p, z });
  let n = 0;
  app.doc.transaction('Aplanir', () => {
    for (const h of hs) {
      const e = app.doc.get(h);
      if (!e) continue;
      let patch: Partial<NewEntity> | null = null;
      switch (e.type) {
        case 'LINE': patch = { start: at(e.start), end: at(e.end) } as Partial<NewEntity>; break;
        case 'POLYLINE': patch = { points: e.points.map(at) } as Partial<NewEntity>; break;
        case 'SPLINE': patch = { fitPoints: e.fitPoints.map(at) } as Partial<NewEntity>; break;
        case 'CIRCLE': case 'ARC': patch = { center: at(e.center) } as Partial<NewEntity>; break;
        case 'ELLIPSE': patch = { center: at(e.center), majorAxis: { ...e.majorAxis, z: 0 } } as Partial<NewEntity>; break;
      }
      if (patch) { app.doc.replaceEntity(h, patch); n++; }
    }
  });
  ctx.print(n ? `${n} courbe(s) ramenée(s) à Z = ${fmt(z)}.` : 'Aucune courbe à aplanir (lignes, polylignes, splines, cercles, arcs, ellipses).');
});

/** Effacement immédiat de la sélection (touche Suppr). */
export function eraseSelection(app: AppHost): void {
  const hs = app.selection.list().filter((h) => {
    const e = app.doc.get(h);
    return e && app.doc.isPickable(e);
  });
  if (!hs.length) return;
  app.doc.transaction('Effacer', () => hs.forEach((h) => app.doc.removeEntity(h)));
  app.selection.clear();
  app.log(`${hs.length} objet(s) supprimé(s).`);
}


export const modifyCommands: CommandDefinition[] = [erase, move, copy, rotate, mirror, scaleCmd, offset, stretch, fillet, chamfer, trim, extend, breakCmd, breakAtPoint, divide, join, explode, arrayRect, arrayPolar, flatten];
