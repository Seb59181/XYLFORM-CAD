/**
 * TEXTE3D : texte en relief (polices Droid, accents) posé sur le plan de travail, gravé dans une
 * face plane d'un solide ou embossé dessus. Idéal pour marquer une pièce imprimée (nom, numéro, version).
 */
import type { CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { FONT_LABEL, loadFont, regionsSize, textRegions, type FontName, type Pt2, type Region2D } from '../../core/geometry/text3d';
import { add, cross, norm, scale } from '../../core/math/affine';
import type { SolidResult } from '../../kernel/protocol';
import { booleanStep, createStep, extend } from '../history';
import { cmd, fmt, getAngle, getDistance, getKeyword, getPointOrKeyword, getString, kw, pickEntity } from './helpers';
import { faceNormalAt } from './measure';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

/** Réglages mémorisés d'un appel à l'autre. */
const opts = { text: 'Xylform', height: 10, depth: 1, font: 'sans' as FontName, rotation: 0 };

/** Repère du texte : origine, axe de lecture (x) et axe vertical des lettres (y). */
interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
}

/** Repère sur une face de normale n : lecture horizontale (ou selon X sur une face de dessus/dessous). */
function faceFrame(o: Vec3, n: Vec3, rotation: number): Frame {
  let x = Math.abs(n.z) > 0.9 ? { x: 1, y: 0, z: 0 } : norm(cross({ x: 0, y: 0, z: 1 }, n));
  if (n.z < -0.9) x = { x: 1, y: 0, z: 0 };
  let y = norm(cross(n, x));
  if (rotation) {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    [x, y] = [add(scale(x, c), scale(y, s)), add(scale(x, -s), scale(y, c))];
  }
  return { o, x, y };
}

const to3 = (f: Frame) => (p: Pt2): Vec3 => add(f.o, add(scale(f.x, p[0]), scale(f.y, p[1])));

function placed(regions: Region2D[], f: Frame): { outer: Vec3[]; holes: Vec3[][] }[] {
  const t = to3(f);
  return regions.map((r) => ({ outer: r.outer.map(t), holes: r.holes.map((h) => h.map(t)) }));
}

/** Contours d'aperçu (fermés). */
function outline(regions: Region2D[], f: Frame): Vec3[][] {
  const t = to3(f);
  return regions.flatMap((r) => [r.outer, ...r.holes].map((pl) => [...pl.map(t), t(pl[0]!)]));
}

const text3d = cmd(
  'TEXT3D',
  'TEXTE3D',
  ['T3D', 'GRAVER', 'EMBOSSER'],
  'Texte en relief : posé sur le plan de travail, gravé dans une face ou embossé sur une face',
  async (ctx, app) => {
    const s = await getString(ctx, 'Entrez le texte', opts.text);
    if (s === null) return;
    if (s.trim()) opts.text = s;
    let font = await loadFont(opts.font);
    let regions = textRegions(font, opts.text, opts.height);
    if (!regions.length) return ctx.print('Aucune lettre à construire.');
    for (;;) {
      const size = regionsSize(regions);
      ctx.print(`Texte « ${opts.text} » : ${FONT_LABEL[opts.font]}, hauteur ${fmt(opts.height)}, profondeur ${fmt(opts.depth)}, ${fmt(size.w, 2)} × ${fmt(size.h, 2)}.`);
      const r = await getPointOrKeyword(ctx, 'Spécifiez le centre du texte sur le plan de travail', {
        keywords: [
          kw('Engrave', 'Graver', 'G', 'Creuse le texte dans une face plane'),
          kw('Emboss', 'Embosser', 'E', 'Texte en relief sur une face plane'),
          kw('Height', 'Hauteur', 'H', 'Hauteur des majuscules'),
          kw('Depth', 'Profondeur', 'P', 'Épaisseur des lettres ou profondeur de gravure'),
          kw('Font', 'Police', 'PO'),
          kw('Rotation', 'Rotation', 'R'),
        ],
        noRubberBand: true,
        preview: (p) => outline(regions, faceFrame(p, { x: 0, y: 0, z: 1 }, opts.rotation)),
      });
      if (r.none) return;
      if (r.keyword === 'Height') {
        opts.height = (await getDistance(ctx, 'Hauteur des majuscules', { defaultValue: opts.height, allowZero: false })) as number;
        regions = textRegions(font, opts.text, opts.height);
        continue;
      }
      if (r.keyword === 'Depth') {
        opts.depth = (await getDistance(ctx, 'Profondeur', { defaultValue: opts.depth, allowZero: false })) as number;
        continue;
      }
      if (r.keyword === 'Rotation') {
        opts.rotation = (await getAngle(ctx, 'Angle du texte', { defaultValue: opts.rotation })) as number;
        continue;
      }
      if (r.keyword === 'Font') {
        const names = Object.keys(FONT_LABEL) as FontName[];
        const k = await getKeyword(ctx, 'Police', [kw('Sans', 'Sans', 'S'), kw('SansBold', 'Gras', 'G'), kw('Serif', 'Serif', 'SE'), kw('Mono', 'Mono', 'M')], ['Sans', 'SansBold', 'Serif', 'Mono'][names.indexOf(opts.font)]);
        opts.font = ({ Sans: 'sans', SansBold: 'sans-bold', Serif: 'serif', Mono: 'mono' } as const)[k as 'Sans'] ?? 'sans';
        font = await loadFont(opts.font);
        regions = textRegions(font, opts.text, opts.height);
        continue;
      }
      if (r.point) {
        // texte libre : lettres debout sur le plan de travail
        const f = faceFrame(r.point, { x: 0, y: 0, z: 1 }, opts.rotation);
        const op = { op: 'extrudeRegions', regions: placed(regions, f), direction: { x: 0, y: 0, z: opts.depth } } as const;
        const res = await app.solid(ctx, op);
        app.addSolid(res, `Texte « ${opts.text} »`, undefined, ctx, createStep(op, `Texte « ${opts.text} »`));
        return;
      }
      // gravure / embossage sur une face plane
      const engrave = r.keyword === 'Engrave';
      const pick = await pickEntity(ctx, `Cliquez la face à l’endroit du texte (${engrave ? 'gravure' : 'relief'} centré sur le clic)`, { filter: (e) => e.type === '3DSOLID', pickMode: 'face' });
      if (!pick || typeof pick === 'string' || pick.sub === undefined) return;
      const target = app.doc.get(pick.handle) as Solid3D | undefined;
      if (!target) return;
      const n = faceNormalAt(target, pick.sub, pick.point);
      if (!n) return ctx.print('Face introuvable.');
      // les lettres débordent légèrement de la face (pas de faces coplanaires dans le booléen)
      const over = Math.min(opts.depth * 0.05, 0.05);
      const start = add(pick.point, scale(n, engrave ? over : -over));
      const f = faceFrame(start, n, opts.rotation);
      const dir = scale(n, engrave ? -(opts.depth + over) : opts.depth + over);
      ctx.print(`${engrave ? 'Gravure' : 'Embossage'} de « ${opts.text} »…`);
      const lettersOp = { op: 'extrudeRegions', regions: placed(regions, f), direction: dir } as const;
      const letters = await app.solid(ctx, lettersOp);
      let res: SolidResult;
      try {
        res = await app.solid(ctx, { op: 'boolean', kind: engrave ? 'subtract' : 'union', targets: [target.shapeId], tools: [letters.shapeId] });
      } finally {
        void app.kernel.call({ op: 'release', shapeIds: [letters.shapeId] });
      }
      res.warnings.forEach((w) => ctx.print(w));
      const step = booleanStep(engrave ? 'subtract' : 'union', [createStep(lettersOp, `Lettres « ${opts.text} »`)], `${engrave ? 'Gravure' : 'Embossage'} « ${opts.text} »`);
      app.doc.replaceEntity(target.handle, { shapeId: res.shapeId, display: res.display, history: extend(target.history, step) });
      ctx.print(`Texte ${engrave ? 'gravé' : 'embossé'} sur ${target.name || 'le solide'} (${fmt(opts.depth)} de profondeur).`);
      return;
    }
  },
);

export const text3dCommands: CommandDefinition[] = [text3d];
