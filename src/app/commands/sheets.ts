/**
 * Mise en plan avancée : VUECOUPE (coupe hachurée), VUEDETAIL (détail agrandi), BULLE (numéro de
 * repère), NOMENCLATURE (tableau des pièces), RAPPELTROU (« M8 prof. 12 » d'après le perçage).
 */
import type { CommandContext, Vec3 } from '../../core/commands';
import type { DrawingSheet, DrawingView, Entity, NewEntity } from '../../core/document/Document';
import type { AppHost } from '../AppHost';
import { ensureDrawingLayers, LAYERS } from '../drawing';
import {
  bomEntities,
  bomRows,
  computeSection,
  cutLineEntities,
  detailEntities,
  detailMarks,
  holeAt,
  holeCallout,
  nextLetter,
  sectionEntities,
  sectionPlane,
  solidAt,
  viewAt,
  viewOfHandle,
} from '../drawingExtra';
import { cmd, fmt, getNumber, getPoint, getPointOrKeyword, getString, pickRequired } from './helpers';

const AXIS_EXT = 3;

async function pickView(ctx: CommandContext, app: AppHost, message: string): Promise<{ sheet: DrawingSheet; view: DrawingView; point: Vec3 }> {
  if (!app.doc.sheets.length) throw new Error('Aucune mise en plan dans ce dessin : lancez d’abord MISEENPLAN.');
  for (;;) {
    const p = await getPoint(ctx, message, { noRubberBand: true });
    const r = viewAt(app, p);
    if (r) return { ...r, point: p };
    ctx.print('Aucune vue de mise en plan à cet endroit.');
  }
}

function putView(app: AppHost, sheet: DrawingSheet, view: DrawingView): void {
  const cur = app.doc.sheet(sheet.id) ?? sheet;
  app.doc.putSheet({ ...cur, views: [...cur.views, view] });
}

const sectionView = cmd('SECTIONVIEW', 'VUECOUPE', ['VCO', 'COUPEMEP'], 'Vue en coupe hachurée : tracez le trait de coupe sur une vue, choisissez le côté regardé, placez la coupe', async (ctx, app) => {
  const { sheet, view, point } = await pickView(ctx, app, 'Premier point du trait de coupe (sur une vue de la mise en plan)');
  if (view.id.endsWith('.iso')) return ctx.print('Tracez la coupe sur une vue orthogonale, pas sur l’isométrique.');
  const a = point;
  const b = await getPoint(ctx, 'Second point du trait de coupe', { basePoint: a });
  const side = await getPoint(ctx, 'Côté regardé (la flèche pointe vers la matière gardée)', { noRubberBand: true, preview: (p) => {
    const pl = sectionPlane(view, a, b, p);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
    const L = Math.hypot(b.x - a.x, b.y - a.y) * 0.2;
    return [[a, b], [m, { x: m.x + pl.side2d.x * L, y: m.y + pl.side2d.y * L, z: 0 }]];
  } });
  const label = nextLetter(app);
  const pl = sectionPlane(view, a, b, side);
  await app.ensureKernel(ctx);
  ctx.print('Coupe du modèle…');
  const geom = await computeSection(app, view.sources, pl, pl.dir, pl.xDir, { smooth: view.smooth, axes: view.axes, ext: AXIS_EXT * sheet.k });
  if (!geom.extent) return ctx.print('Le trait ne coupe aucun solide de ce côté.');
  const e = geom.extent;
  const box = (o: Vec3): Vec3[][] => [[
    { x: o.x + e.min[0], y: o.y + e.min[1], z: 0 },
    { x: o.x + e.max[0], y: o.y + e.min[1], z: 0 },
    { x: o.x + e.max[0], y: o.y + e.max[1], z: 0 },
    { x: o.x + e.min[0], y: o.y + e.max[1], z: 0 },
    { x: o.x + e.min[0], y: o.y + e.min[1], z: 0 },
  ]];
  // placement : le centre de la coupe suit le curseur
  const c = { x: (e.min[0] + e.max[0]) / 2, y: (e.min[1] + e.max[1]) / 2 };
  const loc = await getPoint(ctx, 'Emplacement de la vue en coupe', { noRubberBand: true, preview: (p) => box({ x: p.x - c.x, y: p.y - c.y, z: 0 }) });
  const at = { x: loc.x - c.x, y: loc.y - c.y, z: 0 };
  ensureDrawingLayers(app);
  app.doc.transaction('Vue en coupe', () => {
    const marks = cutLineEntities(a, b, pl.side2d, label, sheet.k).map((x) => app.doc.addEntity(x));
    const handles = sectionEntities(geom, at, label, sheet.k).map((x) => app.doc.addEntity(x));
    putView(app, sheet, {
      id: `${sheet.id}.coupe${label}`,
      name: `Coupe ${label}-${label}`,
      sources: view.sources,
      dir: pl.dir,
      xDir: pl.xDir,
      at,
      hidden: false,
      smooth: view.smooth,
      axes: view.axes,
      handles,
      section: { origin: pl.origin, normal: pl.normal, label, parent: view.id, marks },
    });
  });
  ctx.print(`Coupe ${label}-${label} ajoutée (MAJVUES la régénère après une modification du modèle).`);
});

const detailView = cmd('DETAILVIEW', 'VUEDETAIL', ['VDE', 'DETAIL'], 'Vue de détail : cercle sur une vue, agrandi à l’échelle choisie', async (ctx, app) => {
  const { sheet, view, point } = await pickView(ctx, app, 'Centre du détail (sur une vue de la mise en plan)');
  const radius = await getNumber(ctx, 'Rayon du cercle de détail', { basePoint: point });
  if (typeof radius !== 'number' || radius <= 0) return;
  const s = await getNumber(ctx, 'Agrandissement (2 = 2 : 1)', { defaultValue: 2 });
  const scale = typeof s === 'number' && s > 0 ? s : 2;
  const label = nextLetter(app);
  const loc = await getPoint(ctx, 'Emplacement de la vue de détail', { noRubberBand: true, preview: (p) => [Array.from({ length: 49 }, (_, i) => ({ x: p.x + radius * scale * Math.cos((i / 48) * 2 * Math.PI), y: p.y + radius * scale * Math.sin((i / 48) * 2 * Math.PI), z: 0 }))] });
  ensureDrawingLayers(app);
  const d = { center: { ...point, z: 0 }, radius, scale, label };
  app.doc.transaction('Vue de détail', () => {
    const marks = detailMarks(d.center, radius, label, sheet.k).map((x) => app.doc.addEntity(x));
    const handles = detailEntities(app, view, d, loc, sheet.k).map((x) => app.doc.addEntity(x));
    putView(app, sheet, { id: `${sheet.id}.detail${label}`, name: `Détail ${label}`, sources: view.sources, dir: view.dir, xDir: view.xDir, at: loc, hidden: view.hidden, smooth: view.smooth, axes: view.axes, handles, detail: { parent: view.id, ...d, marks } });
  });
  ctx.print(`Détail ${label} à ${fmt(scale)} : 1 ajouté.`);
});

const balloon = cmd('BALLOON', 'BULLE', ['BUL', 'REPEREPIECE'], 'Bulle de repère : numéro de la pièce dans la nomenclature, mis à jour automatiquement', async (ctx, app) => {
  const { view, point } = await pickView(ctx, app, 'Pointez la pièce sur une vue');
  const s = solidAt(app, view, point);
  if (!s) return ctx.print('Aucune pièce sous ce point.');
  const p2 = await getPoint(ctx, 'Emplacement de la bulle', { basePoint: point });
  app.addEntity({ type: 'DIMENSION', dimType: 'leader', layer: LAYERS.dims.name, p1: point, p2, offsetPoint: p2, balloon: true, label: 'item', labelOf: s.handle, textHeight: app.sysvars.DIMTXT } as NewEntity);
});

const bom = cmd('BOM', 'NOMENCLATURE', ['NOM', 'PARTSLIST', 'LISTEPIECES'], 'Nomenclature de la mise en plan : repère, quantité, désignation (nom du solide), matière', async (ctx, app) => {
  const sheets = app.doc.sheets;
  if (!sheets.length) return ctx.print('Aucune mise en plan dans ce dessin : lancez d’abord MISEENPLAN.');
  let sheet = sheets[sheets.length - 1]!;
  if (sheets.length > 1) {
    const r = await getString(ctx, `Feuille (${sheets.map((s) => s.id).join(', ')})`, sheet.id);
    sheet = sheets.find((s) => s.id.toUpperCase() === (r ?? '').trim().toUpperCase()) ?? sheet;
  }
  const rows = bomRows(app, sheet);
  if (!rows.length) return ctx.print('Aucune pièce dans les vues de cette feuille.');
  const k = sheet.k;
  // par défaut au-dessus du cartouche, aligné à droite du cadre
  const W = 154 * k, H = (rows.length + 1) * 7 * k;
  const def = sheet.format ? { x: sheet.origin.x + (sheet.landscape ? ({ A4: 297, A3: 420, A2: 594, A1: 841, A0: 1189 } as const)[sheet.format] : ({ A4: 210, A3: 297, A2: 420, A1: 594, A0: 841 } as const)[sheet.format]) * k - 10 * k - W, y: sheet.origin.y + 42 * k, z: 0 } : null;
  const r = await getPointOrKeyword(ctx, def ? 'Coin inférieur gauche du tableau (Entrée = au-dessus du cartouche)' : 'Coin inférieur gauche du tableau', {
    allowNone: !!def,
    noRubberBand: true,
    preview: (p) => [[p, { x: p.x + W, y: p.y, z: 0 }, { x: p.x + W, y: p.y + H, z: 0 }, { x: p.x, y: p.y + H, z: 0 }, p]],
  });
  const at = r.point ?? def;
  if (!at) return;
  app.doc.transaction('Nomenclature', () => {
    for (const h of sheet.bom?.handles ?? []) if (app.doc.get(h)) app.doc.removeEntity(h);
    const handles = bomEntities(rows, at, k).map((e) => app.doc.addEntity(e));
    app.doc.putSheet({ ...(app.doc.sheet(sheet.id) ?? sheet), bom: { at, handles } });
  });
  ctx.print(`Nomenclature : ${rows.length} repère(s). BULLE numérote les pièces sur les vues.`);
});

const holeNote = cmd('HOLENOTE', 'RAPPELTROU', ['RTR', 'NOTETROU', 'HOLECALLOUT'], 'Rappel de perçage : désignez un trou sur une vue (« 4× M8 prof. 12 », lamage, fraisure)', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Désignez le cercle d’un trou sur une vue de la mise en plan', (x: Entity) => x.type === 'CIRCLE' || x.type === 'ARC');
  if (e.type !== 'CIRCLE' && e.type !== 'ARC') return;
  const owner = viewOfHandle(app, e.handle);
  const hole = owner ? holeAt(app, owner.view, e.center, Math.max(0.05, e.radius * 0.05)) : null;
  const text = hole ? holeCallout(hole.spec, hole.count) : `Ø${fmt(e.radius * 2, 2)}`;
  if (!hole) ctx.print('Trou sans perçage de l’assistant (PERCAGE) : seul le diamètre est indiqué.');
  const p1 = { x: e.center.x + e.radius * Math.SQRT1_2, y: e.center.y + e.radius * Math.SQRT1_2, z: 0 };
  const p2 = await getPoint(ctx, 'Emplacement du rappel', { basePoint: p1 });
  app.addEntity({ type: 'DIMENSION', dimType: 'leader', layer: owner ? LAYERS.dims.name : undefined, p1, p2, offsetPoint: p2, textOverride: text, textHeight: app.sysvars.DIMTXT } as NewEntity);
});

export const sheetCommands = [sectionView, detailView, balloon, bom, holeNote];
