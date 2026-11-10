/**
 * Onglet Paramétrique : contraintes géométriques, cotes pilotées, contraintes automatiques,
 * suppression, affichage et gestionnaire de paramètres.
 */
import type { CommandContext, CommandDefinition, Keyword, Vec3 } from '../../core/commands';
import { evaluateParameters, measure } from '../../core/constraints/Solver';
import type { Constraint, NewConstraint, PartRef } from '../../core/constraints/types';
import type { Entity } from '../../core/document/Document';
import { partAt, partPosition, partSegment, type PartWant } from '../../core/entities/edit';
import { arcSweep } from '../../core/entities/geometry';
import { add, dist, lerp, norm, polar, scale, sub } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, fmt, getKeyword, getPoint, getString, kw, pickEntity, pickRequired, selectObjects } from './helpers';

const accepts: Record<PartWant, (e: Entity) => boolean> = {
  point: (e) => ['LINE', 'ARC', 'CIRCLE', 'POLYLINE', 'POINT', 'ELLIPSE'].includes(e.type),
  line: (e) => e.type === 'LINE' || e.type === 'POLYLINE',
  circle: (e) => e.type === 'CIRCLE' || e.type === 'ARC',
  any: (e) => ['LINE', 'ARC', 'CIRCLE', 'POLYLINE'].includes(e.type),
};

async function pickPart(ctx: CommandContext, message: string, want: PartWant, exclude?: PartRef): Promise<PartRef>;
async function pickPart(ctx: CommandContext, message: string, want: PartWant, exclude: PartRef | undefined, keywords: Keyword[]): Promise<PartRef | string>;
async function pickPart(ctx: CommandContext, message: string, want: PartWant, exclude?: PartRef, keywords?: Keyword[]): Promise<PartRef | string> {
  for (;;) {
    const r = await pickEntity(ctx, message, { filter: accepts[want], keywords });
    if (typeof r === 'string') return r;
    const e = r ? (ctx.document as AppHost).doc.get(r.handle) : undefined;
    if (!r || !e) continue;
    const part = partAt(e, r.point, want);
    if (!part) {
      ctx.print('Cet objet ne convient pas pour cette contrainte.');
      continue;
    }
    if (exclude && exclude.handle === e.handle && exclude.part === part) {
      ctx.print('Choisissez un autre objet.');
      continue;
    }
    return { handle: e.handle, part };
  }
}

function geometric(name: string, local: string, aliases: string[], description: string, type: Constraint['type'], wants: PartWant[], prompts: string[]): CommandDefinition {
  return cmd(name, local, aliases, description, async (ctx, app) => {
    const refs: PartRef[] = [];
    for (let i = 0; i < wants.length; i++) refs.push(await pickPart(ctx, prompts[i]!, wants[i]!, refs[0]));
    if (type === 'tangent' || type === 'equal') {
      const kinds = refs.map((r) => (r.part === 'circle' ? 'c' : 'l'));
      if (type === 'tangent' && kinds.every((k) => k === 'l')) throw new Error('La tangence nécessite au moins un cercle ou un arc.');
      if (type === 'equal' && kinds[0] !== kinds[1]) throw new Error('Choisissez deux lignes ou deux cercles.');
    }
    let c: NewConstraint;
    if (type === 'fix') {
      const e = app.doc.get(refs[0]!.handle)!;
      c = { type: 'fix', refs, at: partPosition(e, refs[0]!.part) ?? { x: 0, y: 0, z: 0 } };
    } else c = { type, refs } as NewConstraint;
    app.doc.addConstraint(c);
    ctx.print(`Contrainte ${local.replace(/^CG/, '').toLowerCase()} appliquée.`);
  });
}

/** Ligne, segment de polyligne, ou ligne/segment désigné pour une contrainte « ligne ». */
const lineWant: PartWant = 'line';

const horizontal = geometric('GCHORIZONTAL', 'CGHORIZONTAL', ['GCH'], 'Contraint une ligne à être horizontale', 'horizontal', [lineWant], ['Choisissez une ligne']);
const vertical = geometric('GCVERTICAL', 'CGVERTICAL', ['GCV'], 'Contraint une ligne à être verticale', 'vertical', [lineWant], ['Choisissez une ligne']);
const parallel = geometric('GCPARALLEL', 'CGPARALLELE', ['GCPA'], 'Rend deux lignes parallèles', 'parallel', [lineWant, lineWant], ['Choisissez le premier objet', 'Choisissez le deuxième objet']);
const perpendicular = geometric('GCPERPENDICULAR', 'CGPERPENDICULAIRE', ['GCPE'], 'Rend deux lignes perpendiculaires', 'perpendicular', [lineWant, lineWant], ['Choisissez le premier objet', 'Choisissez le deuxième objet']);
const coincident = geometric('GCCOINCIDENT', 'CGCOINCIDENT', ['GCC'], 'Fait coïncider deux points', 'coincident', ['point', 'point'], ['Choisissez le premier point (près d’une extrémité)', 'Choisissez le deuxième point']);
const concentric = geometric('GCCONCENTRIC', 'CGCONCENTRIQUE', ['GCCO'], 'Rend deux cercles/arcs concentriques', 'concentric', ['circle', 'circle'], ['Choisissez le premier cercle ou arc', 'Choisissez le deuxième cercle ou arc']);
const tangent = geometric('GCTANGENT', 'CGTANGENT', ['GCT'], 'Rend une ligne et un cercle, ou deux cercles, tangents', 'tangent', ['any', 'any'], ['Choisissez le premier objet', 'Choisissez le deuxième objet']);
const equal = geometric('GCEQUAL', 'CGEGAL', ['GCE'], 'Égalise deux longueurs ou deux rayons', 'equal', ['any', 'any'], ['Choisissez le premier objet', 'Choisissez le deuxième objet']);
const fix = geometric('GCFIX', 'CGFIXE', ['GCF'], 'Fixe un point à sa position actuelle', 'fix', ['point'], ['Choisissez un point (extrémité, centre, sommet)']);

// ---------------------------------------------------------------------------
// Cotes pilotées
// ---------------------------------------------------------------------------

function nextName(app: AppHost, prefix: string): string {
  const used = new Set([...app.doc.constraints.flatMap((c) => ('name' in c ? [c.name] : [])), ...Object.keys(app.doc.parameters)]);
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

async function askExpression(ctx: CommandContext, app: AppHost, draft: NewConstraint & { name: string; expression: string }): Promise<string> {
  for (;;) {
    const s = (await getString(ctx, `Entrez la valeur ou l’expression de ${draft.name}`, draft.expression)) ?? draft.expression;
    try {
      const all = [...app.doc.constraints, { ...draft, id: '_new', expression: s } as Constraint];
      evaluateParameters(all, app.doc.parameters);
      return s;
    } catch (e) {
      ctx.print((e as Error).message);
    }
  }
}

function dimensional(name: string, local: string, aliases: string[], description: string, kind: 'aligned' | 'horizontal' | 'vertical' | 'radius' | 'diameter' | 'angle'): CommandDefinition {
  return cmd(name, local, aliases, description, async (ctx, app) => {
    let refs: PartRef[];
    let anchor: Vec3;
    if (kind === 'radius' || kind === 'diameter') {
      refs = [await pickPart(ctx, 'Choisissez un arc ou un cercle', 'circle')];
      const e = app.doc.get(refs[0]!.handle) as Extract<Entity, { type: 'CIRCLE' }>;
      anchor = e.center;
    } else if (kind === 'angle') {
      refs = [await pickPart(ctx, 'Choisissez la première ligne', 'line'), await pickPart(ctx, 'Choisissez la deuxième ligne', 'line')];
      const s = partSegment(app.doc.get(refs[0]!.handle)!, refs[0]!.part)!;
      anchor = s[0];
    } else {
      const r = await pickPart(ctx, 'Choisissez une ligne ou un segment de polyligne', 'line', undefined, [kw('Points', '2Points', '2', 'Deux points d’objets')]);
      if (typeof r === 'string') {
        refs = [await pickPart(ctx, 'Choisissez le premier point (près d’une extrémité)', 'point')];
        refs.push(await pickPart(ctx, 'Choisissez le deuxième point', 'point', refs[0]));
      } else refs = [r];
      anchor = partPosition(app.doc.get(refs[0]!.handle)!, refs[0]!.part) ?? { x: 0, y: 0, z: 0 };
    }
    const type = kind === 'aligned' || kind === 'horizontal' || kind === 'vertical' ? 'distance' : kind;
    const axis = kind === 'horizontal' ? 'x' : kind === 'vertical' ? 'y' : undefined;
    const prefix = type === 'distance' ? 'd' : type === 'radius' ? 'rad' : type === 'diameter' ? 'dia' : 'ang';
    const draft = { type, refs, name: nextName(app, prefix), expression: '0', axis } as NewConstraint & { name: string; expression: string };
    const value = Math.abs(measure((h) => app.doc.get(h), draft as Extract<Constraint, { name: string }>));
    const labelAt = await getPoint(ctx, 'Spécifiez l’emplacement de la cote', { basePoint: anchor });
    draft.expression = fmt(value, 4);
    const expression = await askExpression(ctx, app, draft);
    app.doc.addConstraint({ ...draft, expression, labelAt } as NewConstraint);
    ctx.print(`Cote pilotée ${draft.name} = ${expression}`);
  });
}

const dcAligned = dimensional('DCALIGNED', 'CDALIGNEE', ['DCA', 'CDLONGUEUR'], 'Cote pilotée : longueur ou distance vraie', 'aligned');
const dcHorizontal = dimensional('DCHORIZONTAL', 'CDHORIZONTALE', ['DCH', 'CDLINEAIRE'], 'Cote pilotée : distance horizontale', 'horizontal');
const dcVertical = dimensional('DCVERTICAL', 'CDVERTICALE', ['DCV'], 'Cote pilotée : distance verticale', 'vertical');
const dcRadius = dimensional('DCRADIUS', 'CDRAYON', ['DCR'], 'Cote pilotée : rayon', 'radius');
const dcDiameter = dimensional('DCDIAMETER', 'CDDIAMETRE', ['DCD'], 'Cote pilotée : diamètre', 'diameter');
const dcAngular = dimensional('DCANGULAR', 'CDANGULAIRE', ['DCAN'], 'Cote pilotée : angle entre deux lignes', 'angle');

// ---------------------------------------------------------------------------

const autoConstrain = cmd('AUTOCONSTRAIN', 'CONTAUTO', ['AUTOC', 'CONTRAINTEAUTO', 'AUTOCONTRAINTE'], 'Ajoute les contraintes évidentes (coïncidences, horizontales, verticales)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets', (e) => e.type === 'LINE' || e.type === 'POLYLINE' || e.type === 'ARC');
  const tol = 1e-6;
  const existing = (type: string, refs: PartRef[]) =>
    app.doc.constraints.some((c) => c.type === type && c.refs.length === refs.length && c.refs.every((r, i) => r.handle === refs[i]!.handle && r.part === refs[i]!.part));
  const points: { ref: PartRef; p: Vec3 }[] = [];
  const lines: PartRef[] = [];
  for (const h of hs) {
    const e = app.doc.get(h)!;
    if (e.type === 'LINE') {
      points.push({ ref: { handle: h, part: 'start' }, p: e.start }, { ref: { handle: h, part: 'end' }, p: e.end });
      lines.push({ handle: h, part: 'line' });
    } else if (e.type === 'ARC') {
      points.push({ ref: { handle: h, part: 'start' }, p: polar(e.center, e.radius, e.startAngle) }, { ref: { handle: h, part: 'end' }, p: polar(e.center, e.radius, e.endAngle) });
      void arcSweep;
    } else if (e.type === 'POLYLINE') {
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) if (!e.bulges?.[i]) lines.push({ handle: h, part: `seg:${i}` });
      // sommets partagés à l'intérieur d'une même polyligne : déjà liés
      points.push({ ref: { handle: h, part: 'v:0' }, p: e.points[0]! }, { ref: { handle: h, part: `v:${n - 1}` }, p: e.points[n - 1]! });
    }
  }
  const add_: NewConstraint[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!;
      if (a.ref.handle === b.ref.handle || dist(a.p, b.p) > tol) continue;
      if (!existing('coincident', [a.ref, b.ref])) add_.push({ type: 'coincident', refs: [a.ref, b.ref] });
    }
  for (const l of lines) {
    const seg = partSegment(app.doc.get(l.handle)!, l.part);
    if (!seg) continue;
    const d = sub(seg[1], seg[0]);
    if (Math.abs(d.y) < tol * Math.max(1, Math.abs(d.x)) && !existing('horizontal', [l])) add_.push({ type: 'horizontal', refs: [l] });
    else if (Math.abs(d.x) < tol * Math.max(1, Math.abs(d.y)) && !existing('vertical', [l])) add_.push({ type: 'vertical', refs: [l] });
  }
  app.doc.transaction('Contraintes automatiques', () => add_.forEach((c) => app.doc.addConstraint(c)));
  ctx.print(`${add_.length} contrainte(s) ajoutée(s).`);
});

const delConstraint = cmd('DELCONSTRAINT', 'SUPPRCONT', ['DELCON'], 'Supprime les contraintes des objets sélectionnés', async (ctx, app) => {
  const hs = new Set(await selectObjects(ctx));
  const ids = app.doc.constraints.filter((c) => c.refs.some((r) => hs.has(r.handle))).map((c) => c.id);
  app.doc.transaction('Supprimer les contraintes', () => ids.forEach((id) => app.doc.removeConstraint(id)));
  ctx.print(`${ids.length} contrainte(s) supprimée(s).`);
});

const showConstraints = cmd('CONSTRAINTBAR', 'CONTRAINTES', ['CBAR'], 'Affiche ou masque les contraintes', async (_ctx, app) => app.toggle('showConstraints'));
const params = cmd('PARAMETERS', 'PARAMETRES', ['PARAM', 'PAR'], 'Gestionnaire de paramètres', async (_ctx, app) => app.set('panel', 'params'), { transparent: true });

/** Modification d'une cote pilotée (double-clic ou gestionnaire de paramètres). */
export async function editConstraintExpression(app: AppHost, id: string): Promise<void> {
  const c = app.doc.constraints.find((k) => k.id === id);
  if (!c || !('name' in c)) return;
  const v = await app.ui.prompt(`Cote pilotée ${c.name}`, c.expression, 'Valeur ou expression (ex. 40, largeur/2, d1*2)');
  if (v === null || v === c.expression) return;
  try {
    evaluateParameters(app.doc.constraints.map((k) => (k.id === id ? ({ ...k, expression: v } as Constraint) : k)), app.doc.parameters);
  } catch (e) {
    app.ui.toast((e as Error).message, 'error');
    return;
  }
  app.doc.updateConstraint(id, { expression: v });
}

/** Géométrie d'affichage d'une cote pilotée : segments + position et texte. */
export function constraintDisplay(app: AppHost, c: Extract<Constraint, { name: string }>): { lines: Vec3[][]; text: string; at: Vec3; angle: number } | null {
  const get = (r: PartRef) => app.doc.get(r.handle);
  let value: number;
  try {
    value = evaluateParameters(app.doc.constraints, app.doc.parameters).get(c.name) ?? 0;
  } catch {
    value = NaN;
  }
  const isNumeric = /^[\d.\s+\-*/()]+$/.test(c.expression);
  const text = isNumeric ? `${c.name}=${fmt(value, 2)}` : `${c.name}=${c.expression}`;
  if (c.type === 'radius' || c.type === 'diameter') {
    const e = get(c.refs[0]!) as Extract<Entity, { type: 'CIRCLE' }> | undefined;
    if (!e) return null;
    const at = c.labelAt ?? polar(e.center, e.radius * 1.4, Math.PI / 4);
    const dir = norm(sub(at, e.center));
    const tip = add(e.center, scale(dir, e.radius));
    const start = c.type === 'diameter' ? sub(e.center, scale(dir, e.radius)) : e.center;
    return { lines: [[start, tip], [tip, at]], text, at, angle: 0 };
  }
  if (c.type === 'angle') {
    const s1 = partSegment(get(c.refs[0]!)!, c.refs[0]!.part), s2 = partSegment(get(c.refs[1]!)!, c.refs[1]!.part);
    if (!s1 || !s2) return null;
    const at = c.labelAt ?? lerp(s1[1], s2[1], 0.5);
    return { lines: [], text, at, angle: 0 };
  }
  // distance
  let a: Vec3 | null, b: Vec3 | null;
  if (c.refs.length === 1) {
    const s = partSegment(get(c.refs[0]!)!, c.refs[0]!.part);
    if (!s) return null;
    [a, b] = s;
  } else {
    a = partPosition(get(c.refs[0]!)!, c.refs[0]!.part);
    b = partPosition(get(c.refs[1]!)!, c.refs[1]!.part);
  }
  if (!a || !b) return null;
  const at = c.labelAt ?? add(lerp(a, b, 0.5), { x: 0, y: 5, z: 0 });
  let u: Vec3;
  if (c.axis === 'x') u = { x: 1, y: 0, z: 0 };
  else if (c.axis === 'y') u = { x: 0, y: 1, z: 0 };
  else u = norm(sub(b, a));
  const n = { x: -u.y, y: u.x, z: 0 };
  const off = (p: Vec3) => (at.x - p.x) * n.x + (at.y - p.y) * n.y;
  const pa = add(a, scale(n, off(a))), pb = add(b, scale(n, off(b)));
  return { lines: [[a, pa], [b, pb], [pa, pb]], text, at: lerp(pa, pb, 0.5), angle: Math.atan2(u.y, u.x) };
}

export const constraintCommands: CommandDefinition[] = [
  horizontal,
  vertical,
  parallel,
  perpendicular,
  coincident,
  concentric,
  tangent,
  equal,
  fix,
  dcAligned,
  dcHorizontal,
  dcVertical,
  dcRadius,
  dcDiameter,
  dcAngular,
  autoConstrain,
  delConstraint,
  showConstraints,
  params,
];
