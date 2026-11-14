/**
 * Cotes complémentaires (onglet Annoter › Cotes) : angulaire (COTANG), longueur d'arc (COTARC),
 * ordonnée (COTORD), cotes en série (COTCONTINUE) et depuis une ligne de base (COTLIGNEBASE).
 * Elles s'utilisent comme les autres cotes, sur le dessin comme sur une mise en plan.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { DimStyleDef, Entity, NewEntity } from '../../core/document/Document';
import { dimensionGeometry } from '../../core/entities/geometry';
import { bulgeArc, isArcBulge } from '../../core/entities/bulge';
import { add, dist, polar, scale, sub } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, fmt, getKeyword, getPoint, getPointOrKeyword, is, kw, pickEntity, pickRequired } from './helpers';

type Dim = Extract<Entity, { type: 'DIMENSION' }>;
type NewDim = Omit<Dim, 'handle' | 'layer'>;

const preview = (d: NewDim) => {
  try {
    return dimensionGeometry({ ...d, handle: '', layer: '' } as Dim).lines;
  } catch {
    return [];
  }
};

/** Segment droit désigné : ligne, ou côté de polyligne le plus proche du point cliqué. */
function straightSegment(e: Entity, at: Vec3): [Vec3, Vec3] | null {
  if (e.type === 'LINE') return [e.start, e.end];
  if (e.type !== 'POLYLINE') return null;
  const n = e.points.length;
  let best: [Vec3, Vec3] | null = null;
  let bd = Infinity;
  for (let i = 0; i < (e.closed ? n : n - 1); i++) {
    if (isArcBulge(e.bulges?.[i])) continue;
    const a = e.points[i]!, b = e.points[(i + 1) % n]!;
    const ab = sub(b, a);
    const L2 = ab.x * ab.x + ab.y * ab.y;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * ab.x + (at.y - a.y) * ab.y) / L2)) : 0;
    const d = dist(at, add(a, scale(ab, t)));
    if (d < bd) (bd = d), (best = [a, b]);
  }
  return best;
}

/** Arc désigné : entité ARC, ou arc d'une polyligne le plus proche du point cliqué. */
function pickedArc(e: Entity, at: Vec3): { center: Vec3; radius: number; start: Vec3; end: Vec3 } | null {
  if (e.type === 'ARC') return { center: e.center, radius: e.radius, start: polar(e.center, e.radius, e.startAngle), end: polar(e.center, e.radius, e.endAngle) };
  if (e.type !== 'POLYLINE' || !e.bulges) return null;
  const n = e.points.length;
  let best: { center: Vec3; radius: number; start: Vec3; end: Vec3 } | null = null;
  let bd = Infinity;
  for (let i = 0; i < (e.closed ? n : n - 1); i++) {
    const bu = e.bulges[i];
    if (!isArcBulge(bu)) continue;
    const a = e.points[i]!, b = e.points[(i + 1) % n]!;
    const arc = bulgeArc(a, b, bu);
    const d = Math.abs(dist(at, arc.center) - arc.radius);
    // arc parcouru dans le sens trigonométrique : de a à b si le renflement est positif
    if (d < bd) (bd = d), (best = { center: arc.center, radius: arc.radius, start: bu > 0 ? a : b, end: bu > 0 ? b : a });
  }
  return best;
}

/** Intersection des droites (a1, a2) et (b1, b2) dans le plan XY ; null si parallèles. */
function lineIntersection(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): Vec3 | null {
  const d1 = sub(a2, a1), d2 = sub(b2, b1);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-12 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) return null;
  const t = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t, z: a1.z };
}

const far = (c: Vec3, a: Vec3, b: Vec3) => (dist(c, a) >= dist(c, b) ? a : b);

async function place(ctx: CommandContext, app: AppHost, d: Omit<NewDim, 'offsetPoint'>, message = 'Spécifiez l’emplacement de l’arc de cote'): Promise<void> {
  const loc = await getPoint(ctx, message, { noRubberBand: true, preview: (p) => preview({ ...d, offsetPoint: p } as NewDim) });
  app.addEntity({ ...d, offsetPoint: loc, textHeight: app.sysvars.DIMTXT } as NewEntity);
}

// ---------------------------------------------------------------------------------------------

const dimAngular = cmd('DIMANGULAR', 'COTANG', ['DAN', 'COTEANGLE'], 'Cote angulaire entre deux lignes, d’un arc, d’un cercle ou par trois points', async (ctx, app) => {
  const r = await pickEntity(ctx, 'Choisissez un arc, un cercle, une ligne ou <spécifier le sommet>', { filter: is('LINE', 'POLYLINE', 'ARC', 'CIRCLE'), allowNone: true });
  if (r && typeof r !== 'string') {
    const e = app.doc.get(r.handle)!;
    const arc = pickedArc(e, r.point);
    if (arc && (e.type === 'ARC' || !straightSegment(e, r.point) || Math.abs(dist(r.point, arc.center) - arc.radius) < dist(r.point, straightSegmentPoint(e, r.point)))) {
      return place(ctx, app, { type: 'DIMENSION', dimType: 'angular', center: arc.center, p1: arc.start, p2: arc.end });
    }
    if (e.type === 'CIRCLE') {
      const p1 = polar(e.center, e.radius, Math.atan2(r.point.y - e.center.y, r.point.x - e.center.x));
      const p2 = await getPoint(ctx, 'Spécifiez la seconde extrémité de l’angle', { basePoint: e.center });
      return place(ctx, app, { type: 'DIMENSION', dimType: 'angular', center: e.center, p1, p2 });
    }
    const s1 = straightSegment(e, r.point);
    if (!s1) throw new Error('Objet non coté.');
    const { e: e2, pick } = await pickRequired(ctx, 'Choisissez la seconde ligne', is('LINE', 'POLYLINE'));
    const s2 = straightSegment(e2, pick.point);
    if (!s2) throw new Error('Choisissez une ligne ou un côté droit de polyligne.');
    const c = lineIntersection(s1[0], s1[1], s2[0], s2[1]);
    if (!c) throw new Error('Les lignes sont parallèles : pas d’angle à coter.');
    return place(ctx, app, { type: 'DIMENSION', dimType: 'angular', angLines: true, center: c, p1: far(c, s1[0], s1[1]), p2: far(c, s2[0], s2[1]) });
  }
  const c = await getPoint(ctx, 'Spécifiez le sommet de l’angle');
  const p1 = await getPoint(ctx, 'Spécifiez la première extrémité de l’angle', { basePoint: c });
  const p2 = await getPoint(ctx, 'Spécifiez la seconde extrémité de l’angle', { basePoint: c });
  await place(ctx, app, { type: 'DIMENSION', dimType: 'angular', center: c, p1, p2 });
});

function straightSegmentPoint(e: Entity, at: Vec3): Vec3 {
  const s = straightSegment(e, at);
  if (!s) return { x: Infinity, y: Infinity, z: 0 };
  const ab = sub(s[1], s[0]);
  const L2 = ab.x * ab.x + ab.y * ab.y;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((at.x - s[0].x) * ab.x + (at.y - s[0].y) * ab.y) / L2)) : 0;
  return add(s[0], scale(ab, t));
}

const dimArc = cmd('DIMARC', 'COTARC', ['DAR', 'COTLONGARC'], 'Cote de longueur d’arc (arc ou arc de polyligne)', async (ctx, app) => {
  const { e, pick } = await pickRequired(ctx, 'Choisissez un arc ou un arc de polyligne', is('ARC', 'POLYLINE'));
  const arc = pickedArc(e, pick.point);
  if (!arc) throw new Error('Cette polyligne n’a pas d’arc.');
  await place(ctx, app, { type: 'DIMENSION', dimType: 'arclength', center: arc.center, p1: arc.start, p2: arc.end }, 'Spécifiez l’emplacement de la cote de longueur d’arc');
});

/** Origine des cotes ordonnées du dessin (variables ORDBASEX / ORDBASEY, 0,0 par défaut). */
const ordOrigin = (app: AppHost): Vec3 => ({ x: app.sysvars.ORDBASEX, y: app.sysvars.ORDBASEY, z: 0 });

/** Axe automatique d'une cote ordonnée : repère plutôt vertical = cote en X. */
const autoAxis = (p: Vec3, q: Vec3): 'x' | 'y' => (Math.abs(q.y - p.y) >= Math.abs(q.x - p.x) ? 'x' : 'y');

const dimOrdinate = cmd('DIMORDINATE', 'COTORD', ['DOR', 'COTEORDONNEE'], 'Cote ordonnée : abscisse ou ordonnée d’un point depuis une origine', async (ctx, app) => {
  for (;;) {
    const o = ordOrigin(app);
    const r = await getPointOrKeyword(ctx, `Spécifiez le point à coter (origine ${fmt(o.x)},${fmt(o.y)})`, { keywords: [kw('Origin', 'Origine', 'O', 'Point zéro des cotes ordonnées')] });
    if (r.keyword === 'Origin') {
      const p = await getPoint(ctx, 'Spécifiez l’origine des cotes ordonnées (par exemple le coin de la pièce)');
      app.sysvars.ORDBASEX = p.x;
      app.sysvars.ORDBASEY = p.y;
      ctx.print(`Origine des cotes ordonnées : ${fmt(p.x)},${fmt(p.y)}.`);
      continue;
    }
    const p1 = r.point!;
    let forced: 'x' | 'y' | null = null;
    for (;;) {
      const make = (q: Vec3): NewDim => ({ type: 'DIMENSION', dimType: 'ordinate', center: o, p1, p2: p1, ordAxis: forced ?? autoAxis(p1, q), offsetPoint: q });
      const q = await getPointOrKeyword(ctx, 'Spécifiez l’extrémité de la ligne de repère', {
        basePoint: p1,
        noRubberBand: true,
        keywords: [kw('X', 'Xdonnée', 'X', 'Mesure l’abscisse (repère vertical)'), kw('Y', 'Ydonnée', 'Y', 'Mesure l’ordonnée (repère horizontal)')],
        preview: (p) => preview(make(p)),
      });
      if (q.keyword === 'X' || q.keyword === 'Y') {
        forced = q.keyword === 'X' ? 'x' : 'y';
        continue;
      }
      app.addEntity({ ...make(q.point!), textHeight: app.sysvars.DIMTXT } as NewEntity);
      return;
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Cotes en série et depuis une ligne de base
// ---------------------------------------------------------------------------------------------

const CHAINABLE = new Set(['aligned', 'linear', 'ordinate', 'angular']);
const chainable = (e: Entity): e is Dim => e.type === 'DIMENSION' && CHAINABLE.has(e.dimType ?? 'aligned');

/** Dernière cote linéaire, alignée, ordonnée ou angulaire créée (handle le plus élevé). */
function lastDimension(app: AppHost): Dim | null {
  let best: Dim | null = null;
  for (const e of app.doc.all()) if (chainable(e) && (!best || parseInt(e.handle, 16) > parseInt(best.handle, 16))) best = e;
  return best;
}

/** Cote alignée convertie en linéaire de même direction (les cotes enchaînées restent parallèles). */
function asLinear(d: Dim): Dim {
  if (d.dimType === 'linear' || d.rotation !== undefined || (d.dimType && d.dimType !== 'aligned')) return d;
  return { ...d, dimType: 'linear', rotation: Math.atan2(d.p2.y - d.p1.y, d.p2.x - d.p1.x) };
}

/** Écart entre deux cotes empilées depuis la ligne de base (≈ 2 hauteurs de texte, comme DIMDLI). */
const spacing = (app: AppHost, d: Dim) => app.sysvars.DIMDLI > 0 ? app.sysvars.DIMDLI : 2.2 * (d.textHeight ?? app.sysvars.DIMTXT);

function nextChained(app: AppHost, base: Dim, prev: Dim, p: Vec3, baseline: boolean): NewDim {
  const { handle: _h, layer: _l, ...b } = prev;
  if (base.dimType === 'ordinate') {
    // même origine, même axe ; extrémité du repère alignée sur la précédente
    const axis = base.ordAxis ?? 'x';
    const q = axis === 'x' ? { x: p.x, y: prev.offsetPoint.y, z: p.z } : { x: prev.offsetPoint.x, y: p.y, z: p.z };
    return { ...b, p1: p, p2: p, offsetPoint: q };
  }
  if (base.dimType === 'angular') {
    const c = base.center!;
    const R = dist(c, prev.offsetPoint) + (baseline ? spacing(app, prev) : 0);
    const first = baseline ? base.p1 : prev.p2;
    // emplacement de l'arc : au milieu du nouveau secteur, sens trigonométrique de `first` vers p
    const a1 = Math.atan2(first.y - c.y, first.x - c.x), a2 = Math.atan2(p.y - c.y, p.x - c.x);
    const sweep = (((a2 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return { ...b, angLines: false, p1: first, p2: p, offsetPoint: polar(c, R, a1 + sweep / 2) };
  }
  const L = asLinear(base);
  const r = L.rotation ?? 0;
  const n = { x: -Math.sin(r), y: Math.cos(r), z: 0 };
  const lin = asLinear(prev);
  const { handle: _h2, layer: _l2, ...pl } = lin;
  if (!baseline) return { ...pl, p1: lin.p2, p2: p, offsetPoint: lin.offsetPoint };
  // côté de la ligne de cote par rapport au point d'origine : on s'écarte encore de la pièce
  const side = Math.sign((lin.offsetPoint.x - L.p1.x) * n.x + (lin.offsetPoint.y - L.p1.y) * n.y) || 1;
  return { ...pl, p1: L.p1, p2: p, offsetPoint: add(lin.offsetPoint, scale(n, side * spacing(app, lin))) };
}

const chained = (baseline: boolean): CommandDefinition =>
  cmd(
    baseline ? 'DIMBASELINE' : 'DIMCONTINUE',
    baseline ? 'COTLIGNEBASE' : 'COTCONTINUE',
    baseline ? ['DBA', 'COTBASE'] : ['DCO', 'COTSERIE'],
    baseline ? 'Cotes depuis la même ligne de base que la cote précédente (empilées)' : 'Cotes en série, à la suite de la cote précédente',
    async (ctx, app) => {
      let base = lastDimension(app);
      const choose = async () => {
        const { e } = await pickRequired(ctx, baseline ? 'Choisissez la cote de base' : 'Choisissez la cote à continuer', chainable);
        return e as Dim;
      };
      if (!base) base = await choose();
      // cotes créées par cette commande (Annuler les retire une à une)
      const made: Dim[] = [];
      const prev = () => made[made.length - 1] ?? base!;
      for (;;) {
        const r = await getPointOrKeyword(ctx, 'Spécifiez l’origine de la ligne d’attache suivante ou [Sélectionner/Annuler] <terminer>', {
          allowNone: true,
          noRubberBand: true,
          keywords: [kw('Select', 'Sélectionner', 'S', 'Autre cote de départ'), kw('Undo', 'Annuler', 'A', 'Retire la dernière cote')],
          preview: (p) => preview(nextChained(app, base!, prev(), p, baseline)),
        });
        if (r.none) return;
        if (r.keyword === 'Select') {
          base = await choose();
          made.length = 0;
          continue;
        }
        if (r.keyword === 'Undo') {
          const back = made.pop();
          if (back) app.doc.transaction('Annuler la cote', () => app.doc.removeEntity(back.handle));
          else ctx.print('Rien à annuler.');
          continue;
        }
        const h = app.addEntity(nextChained(app, base, prev(), r.point!, baseline) as NewEntity);
        const d = app.doc.get(h);
        if (d?.type === 'DIMENSION') made.push(d);
      }
    },
  );


const ARROWS = [
  { value: 'closed', label: 'Pleine (fermée)' },
  { value: 'open', label: 'Ouverte' },
  { value: 'oblique', label: 'Oblique (trait)' },
  { value: 'dot', label: 'Point' },
  { value: 'none', label: 'Aucune' },
];
const TOLS = [
  { value: 'none', label: 'Aucune' },
  { value: 'symmetric', label: 'Symétrique (± 0.1)' },
  { value: 'deviation', label: 'Écarts (+0.1 / −0.05)' },
  { value: 'limits', label: 'Limites (max / min)' },
];

/** Crée ou modifie un style de cote ; le style choisi devient courant. */
const dimStyle = cmd('DIMSTYLE', 'STYLECOTE', ['DST', 'STYLESCOTE'], 'Styles de cote : flèches, décimales, séparateur, préfixe/suffixe, tolérances', async (ctx, app) => {
  const doc = app.doc;
  const names = Object.keys(doc.dimStyles);
  const pick = await app.ui.form({
    title: 'Styles de cote',
    intro: 'Choisissez le style à modifier, ou « Nouveau style ». Le style devient le style courant des nouvelles cotes.',
    fields: [
      { key: 'name', label: 'Style', type: 'select', value: doc.currentDimStyle, options: [...names.map((n) => ({ value: n, label: n })), { value: '*new', label: 'Nouveau style…' }] },
    ],
    ok: 'Suivant',
  });
  if (!pick) return;
  let name = String(pick.name);
  if (name === '*new') {
    const n = (await app.ui.prompt('Nouveau style de cote', `Style ${names.length + 1}`, 'Nom'))?.trim();
    if (!n) return;
    name = n;
  }
  const st: DimStyleDef = doc.dimStyles[name] ?? { ...doc.dimStyles[doc.currentDimStyle], name };
  const v = await app.ui.form({
    title: `Style de cote « ${name} »`,
    fields: [
      { key: 'arrow', label: 'Flèches', type: 'select', value: st.arrow ?? 'closed', options: ARROWS },
      { key: 'arrowSize', label: 'Taille des flèches', type: 'number', value: st.arrowSize ?? app.sysvars.DIMASZ, min: 0, step: 0.5 },
      { key: 'decimals', label: 'Décimales', type: 'number', value: st.decimals ?? app.sysvars.DIMDEC, min: 0, max: 8, step: 1 },
      { key: 'sep', label: 'Séparateur décimal', type: 'select', value: st.sep ?? '.', options: [{ value: '.', label: 'Point (12.5)' }, { value: ',', label: 'Virgule (12,5)' }] },
      { key: 'prefix', label: 'Préfixe', type: 'text', value: st.prefix ?? '', hint: 'ex. « Ø », « 4× »' },
      { key: 'suffix', label: 'Suffixe', type: 'text', value: st.suffix ?? '', hint: 'ex. « mm », « H7 »' },
      { key: 'tol', label: 'Tolérance', type: 'select', value: st.tol ?? 'none', options: TOLS },
      { key: 'tolPlus', label: 'Écart supérieur', type: 'number', value: st.tolPlus ?? 0.1, step: 0.01 },
      { key: 'tolMinus', label: 'Écart inférieur', type: 'number', value: st.tolMinus ?? 0.1, step: 0.01, hint: 'valeur positive = en dessous de la cote' },
    ],
    ok: 'Enregistrer',
  });
  if (!v) return;
  doc.putDimStyle({
    name,
    arrow: v.arrow as DimStyleDef['arrow'],
    arrowSize: Number(v.arrowSize),
    decimals: Math.round(Number(v.decimals)),
    sep: v.sep as '.' | ',',
    prefix: String(v.prefix) || undefined,
    suffix: String(v.suffix) || undefined,
    tol: v.tol as DimStyleDef['tol'],
    tolPlus: Number(v.tolPlus),
    tolMinus: Number(v.tolMinus),
  });
  doc.currentDimStyle = name;
  doc.changed();
  ctx.print(`Style de cote courant : ${name}.`);
});

const dimAssoc = cmd('DIMASSOC', 'COTASSOC', ['CASSOC'], 'Cotes associatives : les nouvelles cotes suivent les objets cotés quand ils changent', async (ctx, app) => {
  const v = await getKeyword(ctx, 'Cotes associatives', [kw('On', 'Activé', 'A', 'Les cotes suivent les objets'), kw('Off', 'Désactivé', 'D', 'Cotes figées')], app.settings.dimAssoc ? 'On' : 'Off');
  app.set('dimAssoc', v === 'On');
  ctx.print(v === 'On' ? 'Les nouvelles cotes suivent les objets cotés.' : 'Les nouvelles cotes restent figées.');
});

export const dimensionCommands: CommandDefinition[] = [dimStyle, dimAssoc, dimAngular, dimArc, dimOrdinate, chained(false), chained(true)];
