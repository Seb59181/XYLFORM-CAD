/**
 * Repères, étiquettes et cote 3D. Les repères sont des cotes de type « leader » : ils ont les
 * flèches du style de cote et sortent sur l'écran, le PDF, le SVG et le DXF comme les cotes.
 */
import type { CommandContext, Vec3 } from '../../core/commands';
import type { Entity, LabelKind, NewEntity } from '../../core/document/Document';
import { dimensionGeometry } from '../../core/entities/geometry';
import type { AppHost } from '../AppHost';
import { cmd, getPoint, getString, kw, pickEntity } from './helpers';

type Dim = Extract<Entity, { type: 'DIMENSION' }>;
type NewDim = Omit<Dim, 'handle' | 'layer'>;

const preview = (d: NewDim) => {
  try {
    return dimensionGeometry({ ...d, handle: '', layer: '' } as Dim).lines;
  } catch {
    return [];
  }
};

const in3d = (a: Vec3, b: Vec3) => (Math.abs(a.z - b.z) > 1e-9 ? { dim3d: true } : {});

/** Coude du repère : point cliqué (aperçu du repère complet). */
async function elbow(ctx: CommandContext, app: AppHost, base: NewDim, message: string): Promise<Vec3> {
  return getPoint(ctx, message, {
    basePoint: base.p1,
    noRubberBand: true,
    preview: (p) => preview({ ...base, p2: p, offsetPoint: p, ...in3d(base.p1, p), textHeight: app.sysvars.DIMTXT }),
  });
}

const leader = cmd('LEADER', 'REPERE', ['LE', 'MLEADER', 'LIGNEREPERE'], 'Repère : flèche, ligne de rappel et texte (plusieurs lignes avec « \\n »)', async (ctx, app) => {
  const p1 = await getPoint(ctx, 'Spécifiez la pointe de la flèche');
  const base: NewDim = { type: 'DIMENSION', dimType: 'leader', p1, p2: p1, offsetPoint: p1, textOverride: 'Texte' };
  const p2 = await elbow(ctx, app, base, 'Spécifiez le coude du repère');
  const text = (await getString(ctx, 'Texte du repère'))?.trim();
  if (!text) return ctx.print('Repère annulé (texte vide).');
  app.addEntity({ ...base, p2, offsetPoint: p2, textOverride: text.replace(/\\n/g, '\n'), textHeight: app.sysvars.DIMTXT, ...in3d(p1, p2) } as NewEntity);
});

const LABEL_KWS = [
  kw('Auto', 'Auto', 'AU', 'Aire si fermé, sinon longueur ; nom, volume et aire pour un solide'),
  kw('Area', 'Aire', 'AI'),
  kw('Length', 'Longueur', 'LO'),
  kw('Volume', 'Volume', 'VO'),
  kw('Radius', 'Rayon', 'RA'),
  kw('Name', 'Nom', 'NO'),
  kw('Coords', 'Coordonnées', 'CO'),
];
const LABEL_NAME: Record<LabelKind, string> = { auto: 'automatique', area: 'aire', length: 'longueur', volume: 'volume', radius: 'rayon', name: 'nom', coords: 'coordonnées', item: 'repère' };
const KIND: Record<string, LabelKind> = { Auto: 'auto', Area: 'area', Length: 'length', Volume: 'volume', Radius: 'radius', Name: 'name', Coords: 'coords' };

const label = cmd('LABEL', 'ETIQUETTE', ['ETI', 'TEXTEETIQUETTE'], 'Étiquette : aire, longueur, volume ou nom de l’objet désigné, mis à jour s’il change', async (ctx, app) => {
  let what: LabelKind = 'auto';
  let target: { e?: Entity; point: Vec3 } | null = null;
  while (!target) {
    const r = await pickEntity(ctx, `Désignez l’objet à étiqueter (${LABEL_NAME[what]})`, { keywords: LABEL_KWS });
    if (r === null) return;
    if (typeof r === 'string') {
      what = KIND[r] ?? 'auto';
      if (what === 'coords') target = { point: await getPoint(ctx, 'Spécifiez le point à étiqueter') };
      continue;
    }
    const e = app.doc.get(r.handle);
    if (e) target = { e, point: r.point };
  }
  const base: NewDim = { type: 'DIMENSION', dimType: 'leader', p1: target.point, p2: target.point, offsetPoint: target.point, label: what, ...(target.e ? { labelOf: target.e.handle } : {}) };
  const p2 = await elbow(ctx, app, base, 'Spécifiez l’emplacement de l’étiquette');
  const text = (await getString(ctx, 'Texte imposé (« <> » = valeur) ou Entrée pour la valeur calculée'))?.trim();
  app.addEntity({ ...base, p2, offsetPoint: p2, textHeight: app.sysvars.DIMTXT, ...(text ? { textOverride: text.replace(/\\n/g, '\n') } : {}), ...in3d(base.p1, p2), ...(target.e?.type === '3DSOLID' ? { dim3d: true } : {}) } as NewEntity);
});

const dim3d = cmd('DIM3D', 'COT3D', ['D3', 'COTE3D'], 'Cote dans l’espace entre deux points (arêtes, sommets de solides), texte toujours lisible', async (ctx, app) => {
  const p1 = await getPoint(ctx, 'Spécifiez le premier point');
  const p2 = await getPoint(ctx, 'Spécifiez le second point', { basePoint: p1 });
  const base: NewDim = { type: 'DIMENSION', dimType: 'aligned', p1, p2, offsetPoint: p2, dim3d: true, textHeight: app.sysvars.DIMTXT };
  const loc = await getPoint(ctx, 'Spécifiez l’emplacement de la ligne de cote', { noRubberBand: true, preview: (p) => preview({ ...base, offsetPoint: p }) });
  app.addEntity({ ...base, offsetPoint: loc } as NewEntity);
});

export const annotateCommands = [leader, label, dim3d];
