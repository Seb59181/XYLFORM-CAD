/**
 * Onglet Début › Dessiner, et onglet Annoter : lignes, polylignes, cercles, arcs, rectangles,
 * polygones, ellipses, splines, points, hachures, textes et cotes.
 */
import type { CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, HatchPattern, NewEntity } from '../../core/document/Document';
import { bulgeFromSweep, segmentPoints } from '../../core/entities/bulge';
import { detectBoundary, filletPolyline, loopsFromClosed, tangentTangentRadius } from '../../core/entities/edit';
import {
  arcFromThreePoints,
  arcPoints,
  arcSweep,
  circleFromThreePoints,
  closedLoop,
  curvePoints,
  dimensionGeometry,
  ellipsePoints,
  endsMeet,
  isClosedProfile,
  normAngle,
  splinePoints,
} from '../../core/entities/geometry';
import { add, angleXY, dist, lerp, norm, polar, scale, sub } from '../../core/math/affine';
import { cmd, DEG, getAngle, getDistance, getKeyword, getNumber, getPoint, getPointOrKeyword, getString, is, kw, pickRequired, selectObjects } from './helpers';

const TAU = Math.PI * 2;
const KW_UNDO = kw('Undo', 'annUler', 'U', 'Annule le dernier segment');
const KW_CLOSE = kw('Close', 'Clore', 'C', 'Ferme le contour');

const circle = (c: Vec3, r: number) => arcPoints(c, r, 0, TAU, 96);

// ---------------------------------------------------------------------------

const line = cmd('LINE', 'LIGNE', ['L'], 'Crée des segments de droite', async (ctx, app) => {
  const first = await getPoint(ctx, 'Spécifiez le premier point');
  const pts: Vec3[] = [first];
  const ids: string[] = [];
  for (;;) {
    const prev = pts[pts.length - 1]!;
    const keywords = [...(pts.length >= 3 ? [KW_CLOSE] : []), ...(pts.length >= 2 ? [KW_UNDO] : [])];
    const r = await getPointOrKeyword(ctx, 'Spécifiez le point suivant', { basePoint: prev, keywords, allowNone: true });
    if (r.none) return;
    if (r.keyword === 'Undo') {
      app.removeEntity(ids.pop()!);
      pts.pop();
      continue;
    }
    if (r.keyword === 'Close') {
      app.addEntity({ type: 'LINE', start: prev, end: pts[0]! });
      return;
    }
    if (r.point) {
      ids.push(app.addEntity({ type: 'LINE', start: prev, end: r.point }));
      pts.push(r.point);
    }
  }
});

// ---------------------------------------------------------------------------

/** Tangente en fin de dernier segment (pour enchaîner un arc). */
function endTangent(pts: Vec3[], bulges: number[]): Vec3 {
  const n = pts.length;
  if (n < 2) return { x: 1, y: 0, z: 0 };
  const a = pts[n - 2]!, b = pts[n - 1]!;
  const chord = norm(sub(b, a));
  const theta = 4 * Math.atan(bulges[n - 2] ?? 0);
  const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
  return { x: chord.x * c - chord.y * s, y: chord.x * s + chord.y * c, z: 0 };
}

function tangentBulge(from: Vec3, to: Vec3, t: Vec3): number {
  const d = sub(to, from);
  const alpha = Math.atan2(t.x * d.y - t.y * d.x, t.x * d.x + t.y * d.y);
  return Math.tan(alpha / 2);
}

const pline = cmd('PLINE', 'POLYLIGNE', ['PL', 'POLYLINE'], 'Crée une polyligne (segments droits et arcs)', async (ctx, app) => {
  const start = await getPoint(ctx, 'Spécifiez le point de départ');
  const pts: Vec3[] = [start];
  const bulges: number[] = [];
  let mode: 'line' | 'arc' = 'line';
  let handle: string | null = null;
  const commit = (closed = false) => {
    const ent = { type: 'POLYLINE' as const, points: [...pts], closed, bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? [...bulges, 0] : undefined };
    if (pts.length < 2) {
      if (handle) app.removeEntity(handle), (handle = null);
      return;
    }
    if (handle) app.doc.replaceEntity(handle, ent);
    else handle = app.addEntity(ent);
  };
  for (;;) {
    const prev = pts[pts.length - 1]!;
    const extra = [...(pts.length >= 3 ? [KW_CLOSE] : []), ...(pts.length >= 2 ? [KW_UNDO] : [])];
    const r =
      mode === 'line'
        ? await getPointOrKeyword(ctx, 'Spécifiez le point suivant', { basePoint: prev, planar: true, allowNone: true, keywords: [kw('Arc', 'Arc', 'A', 'Passe en mode arc'), ...extra] })
        : await getPointOrKeyword(ctx, 'Spécifiez l’extrémité de l’arc', {
            basePoint: prev,
            planar: true,
            allowNone: true,
            noRubberBand: true,
            keywords: [kw('Line', 'Ligne', 'L', 'Revient aux segments droits'), ...extra],
            preview: (p) => [segmentPoints(prev, p, tangentBulge(prev, p, endTangent(pts, bulges)))],
          });
    if (r.none) return;
    if (r.keyword === 'Arc') mode = 'arc';
    else if (r.keyword === 'Line') mode = 'line';
    else if (r.keyword === 'Undo') {
      pts.pop();
      bulges.pop();
      commit();
    } else if (r.keyword === 'Close') {
      if (mode === 'arc') bulges.push(tangentBulge(prev, pts[0]!, endTangent(pts, bulges)));
      else bulges.push(0);
      commit(true);
      return;
    } else if (r.point) {
      bulges.push(mode === 'arc' ? tangentBulge(prev, r.point, endTangent(pts, bulges)) : 0);
      pts.push(r.point);
      commit();
    }
  }
});

// ---------------------------------------------------------------------------

const circleCmd = cmd('CIRCLE', 'CERCLE', ['C'], 'Crée un cercle', async (ctx, app) => {
  const sv = app.sysvars;
  const r = await getPointOrKeyword(ctx, 'Spécifiez le centre du cercle', {
    keywords: [kw('3P', '3P', undefined, 'Par trois points'), kw('2P', '2P', undefined, 'Par les extrémités d’un diamètre'), kw('TTR', 'Ttr', 'T', 'Tangent, tangent, rayon')],
  });
  const emit = (center: Vec3, radius: number) => {
    sv.CIRCLERAD = radius;
    app.addEntity({ type: 'CIRCLE', center, radius });
  };
  if (r.keyword === '3P') {
    const p1 = await getPoint(ctx, 'Spécifiez le premier point du cercle');
    const p2 = await getPoint(ctx, 'Spécifiez le deuxième point du cercle', { basePoint: p1 });
    const p3 = await getPoint(ctx, 'Spécifiez le troisième point du cercle', {
      noRubberBand: true,
      preview: (p) => {
        const c = circleFromThreePoints(p1, p2, p);
        return c ? [circle(c.center, c.radius)] : [[p1, p2, p]];
      },
    });
    const c = circleFromThreePoints(p1, p2, p3);
    if (!c) throw new Error('Les trois points sont alignés.');
    return emit(c.center, c.radius);
  }
  if (r.keyword === '2P') {
    const p1 = await getPoint(ctx, 'Spécifiez la première extrémité du diamètre');
    const p2 = await getPoint(ctx, 'Spécifiez la deuxième extrémité du diamètre', { basePoint: p1, preview: (p) => [circle(lerp(p1, p, 0.5), dist(p1, p) / 2)] });
    return emit(lerp(p1, p2, 0.5), dist(p1, p2) / 2);
  }
  if (r.keyword === 'TTR') {
    const tangentable = is('LINE', 'CIRCLE', 'ARC', 'POLYLINE');
    const a = await pickRequired(ctx, 'Spécifiez un point sur l’objet pour la première tangente', tangentable);
    const b = await pickRequired(ctx, 'Spécifiez un point sur l’objet pour la deuxième tangente', tangentable);
    const rad = await getDistance(ctx, 'Spécifiez le rayon du cercle', { defaultValue: sv.CIRCLERAD || undefined, allowZero: false });
    const sol = tangentTangentRadius(a.e, a.pick.point, b.e, b.pick.point, rad as number);
    if (!sol) {
      ctx.print('Le cercle n’existe pas.');
      return;
    }
    return emit(sol.center, sol.radius);
  }
  const center = r.point!;
  const dflt = sv.CIRCLERAD > 0 ? sv.CIRCLERAD : undefined;
  const rad = await getDistance(ctx, 'Spécifiez le rayon du cercle', {
    keywords: [kw('Diameter', 'Diamètre', 'D')],
    basePoint: center,
    defaultValue: dflt,
    allowZero: false,
    preview: (p) => [circle(center, dist(center, p))],
  });
  if (rad === 'Diameter') {
    const d = await getDistance(ctx, 'Spécifiez le diamètre du cercle', {
      basePoint: center,
      defaultValue: dflt !== undefined ? 2 * dflt : undefined,
      allowZero: false,
      preview: (p) => [circle(center, dist(center, p) / 2)],
    });
    return emit(center, (d as number) / 2);
  }
  emit(center, rad as number);
});

// ---------------------------------------------------------------------------

const arcEnt = (center: Vec3, radius: number, a0: number, a1: number): NewEntity => ({ type: 'ARC', center, radius, startAngle: normAngle(a0), endAngle: normAngle(a1) });
const arcPreview = (center: Vec3, r: number, a0: number, a1: number) => [arcPoints(center, r, a0, arcSweep(a0, a1))];

const arcCmd = cmd('ARC', 'ARC', ['A'], 'Crée un arc (3 points, ou centre/départ/fin)', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez le point de départ de l’arc', { keywords: [kw('Center', 'Centre', 'CE')] });
  const centerStartEnd = async (c: Vec3, s: Vec3) => {
    const rad = dist(c, s);
    const a0 = angleXY(c, s);
    const e = await getPointOrKeyword(ctx, 'Spécifiez l’extrémité de l’arc', {
      basePoint: c,
      keywords: [kw('Angle', 'Angle', 'A', 'Angle inclus')],
      preview: (p) => arcPreview(c, rad, a0, angleXY(c, p)),
    });
    if (e.keyword === 'Angle') {
      const inc = (await getAngle(ctx, 'Spécifiez l’angle inclus', { basePoint: c })) as number;
      return inc >= 0 ? arcEnt(c, rad, a0, a0 + inc) : arcEnt(c, rad, a0 + inc, a0);
    }
    return arcEnt(c, rad, a0, angleXY(c, e.point!));
  };
  let ent: NewEntity;
  if (r.keyword === 'Center') {
    const c = await getPoint(ctx, 'Spécifiez le centre de l’arc');
    const s = await getPoint(ctx, 'Spécifiez le point de départ de l’arc', { basePoint: c });
    ent = await centerStartEnd(c, s);
  } else {
    const p1 = r.point!;
    const r2 = await getPointOrKeyword(ctx, 'Spécifiez le deuxième point de l’arc', { basePoint: p1, keywords: [kw('Center', 'Centre', 'CE'), kw('End', 'Fin', 'F')] });
    if (r2.keyword === 'Center') {
      const c = await getPoint(ctx, 'Spécifiez le centre de l’arc', { basePoint: p1 });
      ent = await centerStartEnd(c, p1);
    } else if (r2.keyword === 'End') {
      const e = await getPoint(ctx, 'Spécifiez l’extrémité de l’arc', { basePoint: p1 });
      const rad = (await getDistance(ctx, 'Spécifiez le rayon de l’arc', { allowZero: false })) as number;
      const half = dist(p1, e) / 2;
      if (rad < half - 1e-9) throw new Error('Rayon trop petit pour ces deux points.');
      const mid = lerp(p1, e, 0.5);
      const u = norm(sub(e, p1));
      const h = Math.sqrt(Math.max(0, rad * rad - half * half));
      const c = add(mid, scale({ x: -u.y, y: u.x, z: 0 }, h));
      ent = arcEnt(c, rad, angleXY(c, p1), angleXY(c, e));
    } else {
      const p2 = r2.point!;
      const p3 = await getPoint(ctx, 'Spécifiez l’extrémité de l’arc', {
        noRubberBand: true,
        preview: (p) => {
          const a = arcFromThreePoints(p1, p2, p);
          return a ? arcPreview(a.center, a.radius, a.startAngle, a.endAngle) : [[p1, p2, p]];
        },
      });
      const a = arcFromThreePoints(p1, p2, p3);
      if (!a) throw new Error('Les trois points sont alignés.');
      ent = { type: 'ARC', ...a };
    }
  }
  app.addEntity(ent);
});

// ---------------------------------------------------------------------------

function rectPoints(a: Vec3, b: Vec3): Vec3[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0, z: a.z },
    { x: x1, y: y0, z: a.z },
    { x: x1, y: y1, z: a.z },
    { x: x0, y: y1, z: a.z },
  ];
}

const rectangle = cmd('RECTANG', 'RECTANGLE', ['REC', 'RECTANG'], 'Crée un rectangle (coins arrondis ou chanfreinés en option)', async (ctx, app) => {
  let fillet = 0;
  let chamfer = 0;
  let first: Vec3;
  for (;;) {
    const r = await getPointOrKeyword(ctx, `Spécifiez le premier coin${fillet ? ` (raccord ${fillet})` : chamfer ? ` (chanfrein ${chamfer})` : ''}`, {
      keywords: [kw('Fillet', 'Raccord', 'R', 'Coins arrondis'), kw('Chamfer', 'Chanfrein', 'CH', 'Coins chanfreinés')],
    });
    if (r.keyword === 'Fillet') fillet = (await getDistance(ctx, 'Spécifiez le rayon de raccord des rectangles', { defaultValue: fillet, allowZero: true })) as number;
    else if (r.keyword === 'Chamfer') chamfer = (await getDistance(ctx, 'Spécifiez la distance de chanfrein des rectangles', { defaultValue: chamfer, allowZero: true })) as number;
    else {
      first = r.point!;
      break;
    }
  }
  const build = (b: Vec3) => {
    const pts = rectPoints(first, b);
    if (!fillet && !chamfer) return { points: pts, bulges: undefined as number[] | undefined };
    const tmp = { type: 'POLYLINE', handle: '', layer: '', points: pts, closed: true } as Extract<Entity, { type: 'POLYLINE' }>;
    const res = filletPolyline(tmp, fillet, chamfer ? { d1: chamfer, d2: chamfer } : undefined);
    return { points: res.points, bulges: res.bulges };
  };
  const preview = (p: Vec3) => curvePoints({ type: 'POLYLINE', handle: '', layer: '', closed: true, ...build(p) } as Entity);
  // saisie dynamique : « 120 Tab 80 » = largeur × hauteur depuis le 1er coin (négatif : autre côté)
  const r = await getPointOrKeyword(ctx, 'Spécifiez l’autre coin', { keywords: [kw('Dimensions', 'Cotes', 'C', 'Longueur et largeur')], preview, noRubberBand: true, dynBase: first!, dynLabels: ['Largeur', 'Hauteur'] });
  let other: Vec3;
  if (r.keyword === 'Dimensions') {
    const L = (await getDistance(ctx, 'Spécifiez la longueur des rectangles', { allowZero: false })) as number;
    const W = (await getDistance(ctx, 'Spécifiez la largeur des rectangles', { allowZero: false })) as number;
    const q = await getPoint(ctx, 'Spécifiez l’autre coin (quadrant)', {
      noRubberBand: true,
      preview: (p) => preview({ x: first.x + Math.sign(p.x - first.x || 1) * L, y: first.y + Math.sign(p.y - first.y || 1) * W, z: first.z }),
    });
    other = { x: first.x + Math.sign(q.x - first.x || 1) * L, y: first.y + Math.sign(q.y - first.y || 1) * W, z: first.z };
  } else other = r.point!;
  if (Math.abs(other.x - first.x) < 1e-9 || Math.abs(other.y - first.y) < 1e-9) throw new Error('Rectangle de surface nulle.');
  app.addEntity({ type: 'POLYLINE', closed: true, ...build(other) });
});

// ---------------------------------------------------------------------------

function polygonPoints(c: Vec3, n: number, vertexRadius: number, startAngle: number): Vec3[] {
  return Array.from({ length: n }, (_, i) => polar(c, vertexRadius, startAngle + (TAU * i) / n));
}

const polygon = cmd('POLYGON', 'POLYGONE', ['POL'], 'Crée un polygone régulier', async (ctx, app) => {
  const sv = app.sysvars;
  const n = (await getNumber(ctx, 'Entrez le nombre de côtés', { integer: true, defaultValue: sv.POLYSIDES, allowZero: false })) as number;
  if (n < 3 || n > 1024) throw new Error('Le nombre de côtés doit être compris entre 3 et 1024.');
  sv.POLYSIDES = n;
  const r = await getPointOrKeyword(ctx, 'Spécifiez le centre du polygone', { keywords: [kw('Edge', 'Côté', 'CO', 'Par un côté')] });
  if (r.keyword === 'Edge') {
    const e1 = await getPoint(ctx, 'Spécifiez la première extrémité du côté');
    const build = (e2: Vec3) => {
      const L = dist(e1, e2);
      const R = L / (2 * Math.sin(Math.PI / n));
      const mid = lerp(e1, e2, 0.5);
      const u = norm(sub(e2, e1));
      const apo = R * Math.cos(Math.PI / n);
      const c = add(mid, scale({ x: -u.y, y: u.x, z: 0 }, apo));
      return polygonPoints(c, n, R, angleXY(c, e1));
    };
    const e2 = await getPoint(ctx, 'Spécifiez la deuxième extrémité du côté', { basePoint: e1, preview: (p) => [[...build(p), build(p)[0]!]] });
    app.addEntity({ type: 'POLYLINE', points: build(e2), closed: true });
    return;
  }
  const c = r.point!;
  const mode = await getKeyword(ctx, 'Entrez une option', [kw('Inscribed', 'Inscrit dans le cercle', 'I'), kw('Circumscribed', 'Circonscrit au cercle', 'C')], 'Inscribed');
  const build = (p: Vec3) => {
    const rr = dist(c, p);
    const a = angleXY(c, p);
    return mode === 'Inscribed' ? polygonPoints(c, n, rr, a) : polygonPoints(c, n, rr / Math.cos(Math.PI / n), a + Math.PI / n);
  };
  const p = await getPoint(ctx, 'Spécifiez le rayon du cercle', { basePoint: c, preview: (q) => [[...build(q), build(q)[0]!]] });
  if (dist(c, p) < 1e-9) throw new Error('Rayon nul.');
  app.addEntity({ type: 'POLYLINE', points: build(p), closed: true });
});

// ---------------------------------------------------------------------------

const ellipse = cmd('ELLIPSE', 'ELLIPSE', ['EL'], 'Crée une ellipse', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez l’extrémité de l’axe de l’ellipse', { keywords: [kw('Center', 'Centre', 'C')] });
  let c: Vec3, major: Vec3;
  if (r.keyword === 'Center') {
    c = await getPoint(ctx, 'Spécifiez le centre de l’ellipse');
    const a = await getPoint(ctx, 'Spécifiez l’extrémité de l’axe', { basePoint: c });
    major = sub(a, c);
  } else {
    const a1 = r.point!;
    const a2 = await getPoint(ctx, 'Spécifiez l’autre extrémité de l’axe', { basePoint: a1 });
    c = lerp(a1, a2, 0.5);
    major = sub(a2, c);
  }
  const L = Math.hypot(major.x, major.y);
  if (L < 1e-9) throw new Error('Axe nul.');
  const make = (d: number) => {
    if (d <= L) return { center: c, majorAxis: major, ratio: Math.max(1e-6, d / L) };
    // l'autre axe est plus long : il devient le grand axe
    const u = { x: -major.y / L, y: major.x / L, z: 0 };
    return { center: c, majorAxis: scale(u, d), ratio: L / d };
  };
  const d = await getDistance(ctx, 'Spécifiez la distance par rapport à l’autre axe', {
    basePoint: c,
    allowZero: false,
    preview: (p) => {
      const e = make(dist(c, p));
      return [ellipsePoints(e.center, e.majorAxis, e.ratio)];
    },
  });
  app.addEntity({ type: 'ELLIPSE', ...make(d as number) });
});

// ---------------------------------------------------------------------------

const spline = cmd('SPLINE', 'SPLINE', ['SPL'], 'Crée une spline passant par des points (clic sur le premier point ou Clore : spline fermée)', async (ctx, app) => {
  const pts: Vec3[] = [await getPoint(ctx, 'Spécifiez le premier point')];
  // La spline est enregistrée au fil du tracé (comme la polyligne) : son premier point est
  // accrochable (Extrémité / Nodal) pour la refermer d'un clic.
  let handle: string | null = null;
  const commit = (closed = false) => {
    if (pts.length < 2) {
      if (handle) app.removeEntity(handle), (handle = null);
      return;
    }
    const ent = { type: 'SPLINE' as const, fitPoints: [...pts], closed };
    if (handle) app.doc.replaceEntity(handle, ent);
    else handle = app.addEntity(ent);
  };
  const closes = (p: Vec3) => pts.length >= 3 && endsMeet([...pts, p]);
  for (;;) {
    const keywords = [...(pts.length >= 3 ? [KW_CLOSE] : []), ...(pts.length >= 2 ? [KW_UNDO] : [])];
    const r = await getPointOrKeyword(ctx, pts.length < 2 ? 'Spécifiez le point suivant' : 'Spécifiez le point suivant (premier point = fermer) ou appuyez sur Entrée pour terminer', {
      basePoint: pts[pts.length - 1],
      planar: true,
      keywords,
      allowNone: true,
      noRubberBand: true,
      preview: (p) => [closes(p) ? splinePoints(pts, true) : splinePoints([...pts, p], false)],
    });
    if (r.none) break;
    if (r.keyword === 'Undo') {
      pts.pop();
      commit();
    } else if (r.keyword === 'Close' || (r.point && closes(r.point))) {
      if (pts.length < 3) continue;
      commit(true);
      ctx.print('Spline fermée.');
      return;
    } else if (r.point) {
      pts.push(r.point);
      commit();
    }
  }
  if (pts.length < 2 && handle) app.removeEntity(handle);
});

const point = cmd('POINT', 'POINT', ['PO'], 'Crée des points', async (ctx, app) => {
  for (;;) {
    const r = await getPointOrKeyword(ctx, 'Spécifiez un point (Entrée pour terminer)', { allowNone: true });
    if (!r.point) return;
    app.addEntity({ type: 'POINT', position: r.point });
  }
});

// ---------------------------------------------------------------------------

const PATTERNS: { kw: ReturnType<typeof kw>; value: HatchPattern }[] = [
  { kw: kw('SOLID', 'Plein', 'P', 'Remplissage uni'), value: 'SOLID' },
  { kw: kw('ANSI31', 'ANSI31', 'A31', 'Hachures à 45°'), value: 'ANSI31' },
  { kw: kw('ANSI37', 'ANSI37', 'A37', 'Quadrillage à 45°'), value: 'ANSI37' },
  { kw: kw('NET', 'Grille', 'G', 'Quadrillage orthogonal'), value: 'NET' },
  { kw: kw('GRADIENT', 'Dégradé', 'D', 'Dégradé de couleur'), value: 'GRADIENT' },
];

const hatch = cmd('HATCH', 'HACHURES', ['H', 'BHATCH'], 'Remplit une zone fermée de hachures, d’un aplat ou d’un dégradé', async (ctx, app) => {
  const sv = app.sysvars;
  let count = 0;
  for (;;) {
    const r = await getPointOrKeyword(ctx, `Choisissez un point interne (${sv.HPNAME}, échelle ${sv.HPSCALE}, angle ${sv.HPANG}°)`, {
      allowNone: true,
      noRubberBand: true,
      keywords: [kw('Select', 'Sélectionner des objets', 'S'), kw('Pattern', 'Motif', 'M'), kw('Scale', 'Échelle', 'E'), kw('Angle', 'Angle', 'A')],
    });
    if (r.none) break;
    if (r.keyword === 'Pattern') {
      const v = await getKeyword(ctx, 'Motif de hachures', PATTERNS.map((p) => p.kw), sv.HPNAME);
      sv.HPNAME = v as HatchPattern;
      continue;
    }
    if (r.keyword === 'Scale') {
      sv.HPSCALE = (await getNumber(ctx, 'Échelle du motif', { defaultValue: sv.HPSCALE, allowZero: false })) as number;
      continue;
    }
    if (r.keyword === 'Angle') {
      sv.HPANG = ((await getAngle(ctx, 'Angle du motif', { defaultValue: (sv.HPANG * Math.PI) / 180 })) as number) / DEG;
      continue;
    }
    let loops: Vec3[][] | null = null;
    if (r.keyword === 'Select') {
      const hs = await selectObjects(ctx, 'Choisissez des objets fermés', isClosedProfile);
      const closed = hs.map((h) => closedLoop(app.doc.get(h)!)).filter((l): l is Vec3[] => !!l);
      if (closed.length) loops = loopsFromClosed(closed);
    } else {
      loops = detectBoundary(r.point!, app.visible());
      if (!loops) {
        ctx.print('Contour fermé introuvable autour de ce point.');
        app.ui.toast('Aucun contour fermé autour de ce point.', 'error');
        continue;
      }
    }
    if (!loops) continue;
    app.addEntity({ type: 'HATCH', boundaries: loops, pattern: sv.HPNAME, scale: sv.HPSCALE, angle: sv.HPANG * DEG, color2: sv.HPNAME === 'GRADIENT' ? sv.HPCOLOR2 : undefined });
    count++;
  }
  if (count) ctx.print(`${count} zone(s) hachurée(s).`);
});

// ---------------------------------------------------------------------------

const text = cmd('TEXT', 'TEXTE', ['TX', 'DT', 'DTEXT'], 'Crée du texte sur une ligne', async (ctx, app) => {
  const sv = app.sysvars;
  let pos = await getPoint(ctx, 'Spécifiez le point de départ du texte');
  const h = (await getDistance(ctx, 'Spécifiez la hauteur', { defaultValue: sv.TEXTSIZE, basePoint: pos, allowZero: false })) as number;
  sv.TEXTSIZE = h;
  const rot = (await getAngle(ctx, 'Spécifiez l’angle de rotation du texte', { defaultValue: 0, basePoint: pos })) as number;
  for (;;) {
    const s = await getString(ctx, 'Entrez le texte (Entrée sur une ligne vide pour terminer)');
    if (!s) return;
    app.addEntity({ type: 'TEXT', position: pos, height: h, text: s, rotation: rot });
    pos = add(pos, scale({ x: Math.sin(rot), y: -Math.cos(rot), z: 0 }, h * 1.6));
  }
});

// ---------------------------------------------------------------------------

type Dim = Extract<Entity, { type: 'DIMENSION' }>;
const dimPreview = (d: Omit<Dim, 'handle' | 'layer'>) => dimensionGeometry({ ...d, handle: '', layer: '' } as Dim).lines;

const dimAligned = cmd('DIMALIGNED', 'COTALI', ['DAL', 'COTE'], 'Cote alignée entre deux points', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez l’origine de la première ligne d’attache ou <sélectionner l’objet>', { allowNone: true });
  let p1: Vec3, p2: Vec3;
  if (r.point) {
    p1 = r.point;
    p2 = await getPoint(ctx, 'Spécifiez l’origine de la deuxième ligne d’attache', { basePoint: p1 });
  } else {
    const { e } = await pickRequired(ctx, 'Choisissez l’objet à coter', is('LINE', 'ARC', 'CIRCLE', 'POLYLINE'));
    if (e.type === 'LINE') (p1 = e.start), (p2 = e.end);
    else if (e.type === 'ARC') (p1 = polar(e.center, e.radius, e.startAngle)), (p2 = polar(e.center, e.radius, e.endAngle));
    else if (e.type === 'CIRCLE') (p1 = polar(e.center, e.radius, Math.PI)), (p2 = polar(e.center, e.radius, 0));
    else (p1 = e.type === 'POLYLINE' ? e.points[0]! : p1!), (p2 = e.type === 'POLYLINE' ? e.points[1] ?? e.points[0]! : p1!);
  }
  const loc = await getPoint(ctx, 'Spécifiez l’emplacement de la ligne de cote', {
    noRubberBand: true,
    preview: (p) => dimPreview({ type: 'DIMENSION', dimType: 'aligned', p1, p2, offsetPoint: p }),
  });
  app.addEntity({ type: 'DIMENSION', dimType: 'aligned', p1, p2, offsetPoint: loc, textHeight: app.sysvars.DIMTXT });
});

const dimLinear = cmd('DIMLINEAR', 'COTLIN', ['DLI'], 'Cote linéaire horizontale ou verticale', async (ctx, app) => {
  const p1 = await getPoint(ctx, 'Spécifiez l’origine de la première ligne d’attache');
  const p2 = await getPoint(ctx, 'Spécifiez l’origine de la deuxième ligne d’attache', { basePoint: p1 });
  let forced: number | null = null;
  const autoRot = (p: Vec3) => {
    if (forced !== null) return forced;
    const inX = (p.x - p1.x) * (p.x - p2.x) <= 0;
    const inY = (p.y - p1.y) * (p.y - p2.y) <= 0;
    if (inX && !inY) return 0;
    if (inY && !inX) return Math.PI / 2;
    return Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y) ? 0 : Math.PI / 2;
  };
  for (;;) {
    const r = await getPointOrKeyword(ctx, 'Spécifiez l’emplacement de la ligne de cote', {
      noRubberBand: true,
      keywords: [kw('Horizontal', 'Horizontal', 'H'), kw('Vertical', 'Vertical', 'V'), kw('Rotated', 'Rotation', 'R')],
      preview: (p) => dimPreview({ type: 'DIMENSION', dimType: 'linear', p1, p2, offsetPoint: p, rotation: autoRot(p) }),
    });
    if (r.keyword === 'Horizontal') forced = 0;
    else if (r.keyword === 'Vertical') forced = Math.PI / 2;
    else if (r.keyword === 'Rotated') forced = (await getAngle(ctx, 'Spécifiez l’angle de la ligne de cote', { defaultValue: 0 })) as number;
    else if (r.point) {
      app.addEntity({ type: 'DIMENSION', dimType: 'linear', p1, p2, offsetPoint: r.point, rotation: autoRot(r.point), textHeight: app.sysvars.DIMTXT });
      return;
    }
  }
});

const radial = (diameter: boolean): CommandDefinition =>
  cmd(diameter ? 'DIMDIAMETER' : 'DIMRADIUS', diameter ? 'COTDIA' : 'COTRAYON', diameter ? ['DDI'] : ['DRA'], diameter ? 'Cote de diamètre' : 'Cote de rayon', async (ctx, app) => {
    const { e } = await pickRequired(ctx, 'Choisissez un arc ou un cercle', is('CIRCLE', 'ARC'));
    const c = (e as Extract<Entity, { type: 'CIRCLE' }>).center;
    const rad = (e as Extract<Entity, { type: 'CIRCLE' }>).radius;
    const make = (p: Vec3) => ({ type: 'DIMENSION' as const, dimType: diameter ? ('diameter' as const) : ('radius' as const), p1: c, p2: add(c, scale(norm(sub(p, c)), rad)), offsetPoint: p });
    const loc = await getPoint(ctx, 'Spécifiez l’emplacement de la ligne de cote', { noRubberBand: true, preview: (p) => dimPreview(make(p)) });
    app.addEntity({ ...make(loc), textHeight: app.sysvars.DIMTXT });
  });

export const drawCommands: CommandDefinition[] = [line, pline, circleCmd, arcCmd, rectangle, polygon, ellipse, spline, point, hatch, text, dimAligned, dimLinear, radial(false), radial(true)];

export { rectPoints, bulgeFromSweep };
