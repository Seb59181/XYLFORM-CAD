/**
 * MISEENPLAN : vues 2D cotables générées depuis la 3D (face, dessus, côtés, isométrique) avec
 * lignes cachées, axes, cadre et cartouche ; MAJVUES : régénère les vues après modification du
 * modèle ; EXPORTPDF : impression vectorielle à l'échelle (feuille ou étendue du dessin).
 */
import type { CommandDefinition, Vec3 } from '../../core/commands';
import type { DrawingSheet, DrawingView, Entity, PaperFormat } from '../../core/document/Document';
import { curvePoints, dimensionGeometry, dimensionLabel, entityBBox, hatchSegments, textLayout } from '../../core/entities/geometry';
import { patternOf } from '../../core/linetypes';
import { writePdf, type PdfItem } from '../../io/pdf';
import { saveFile } from '../../io/fileAccess';
import type { AppHost } from '../AppHost';
import {
  autoScale,
  computeView,
  ensureDrawingLayers,
  frameEntities,
  LAYERS,
  laidExtent,
  layoutViews,
  materialLabel,
  newViewRecord,
  paperSize,
  SCALES,
  scaleLabel,
  usableArea,
  viewEntities,
  VIEWS,
  type LaidView,
  type ViewKind,
} from '../drawing';
import { cmd, fmt, getKeyword, getPointOrKeyword, kw, selectObjects } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const GAP = 18; // écart entre vues, mm papier
const AXIS_EXT = 3; // dépassement des axes, mm papier

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'Dessin';
}

const today = () => new Date().toLocaleDateString('fr-FR');

/** Rectangle (contour d'aperçu). */
const box = (x0: number, y0: number, x1: number, y1: number, z = 0): Vec3[] => [
  { x: x0, y: y0, z },
  { x: x1, y: y0, z },
  { x: x1, y: y1, z },
  { x: x0, y: y1, z },
  { x: x0, y: y0, z },
];

function viewBoxes(vs: LaidView[], dx: number, dy: number): Vec3[][] {
  return vs.map((v) => {
    const e = v.geom.extent!;
    return box(v.at.x + e.min[0] + dx, v.at.y + e.min[1] + dy, v.at.x + e.max[0] + dx, v.at.y + e.max[1] + dy);
  });
}

const drawing = cmd('DRAWING', 'MISEENPLAN', ['MEP', 'VUESBASE', 'VIEWBASE', 'PLAN2D'], 'Mise en plan : vues 2D (face, dessus, côtés, iso) cotables générées depuis la 3D, cadre et cartouche', async (ctx, app) => {
  let hs = await selectObjects(ctx, 'Choisissez les solides à mettre en plan (Entrée = tous)', (e) => e.type === '3DSOLID', true);
  if (!hs.length) hs = app.doc.all().filter((e) => e.type === '3DSOLID' && app.doc.isVisible(e)).map((e) => e.handle);
  const solids = hs.map((h) => app.doc.get(h)).filter((e): e is Solid3D => e?.type === '3DSOLID');
  const meshOnly = solids.filter((s) => s.display.meshTriangles);
  if (meshOnly.length) ctx.print(`${meshOnly.length} corps maillé(s) ignoré(s) (STL/3MF) : convertissez-les avec CONVSOLIDE pour les mettre en plan.`);
  const src = solids.filter((s) => !s.display.meshTriangles);
  if (!src.length) return ctx.print('Aucun solide à mettre en plan.');
  const title = src.length === 1 && src[0]!.name ? src[0]!.name : baseName(app.doc.fileName);
  const v = await app.ui.form({
    title: 'Mise en plan',
    intro: `${src.length} solide(s). Les vues sont tracées en vraie grandeur (les cotes donnent les vraies dimensions) ; le cadre est agrandi selon l’échelle.`,
    fields: [
      { key: 'front', label: 'Vue de face', type: 'checkbox', value: true },
      { key: 'top', label: 'Vue de dessus', type: 'checkbox', value: true },
      { key: 'left', label: 'Vue de gauche', type: 'checkbox', value: true },
      { key: 'right', label: 'Vue de droite', type: 'checkbox', value: false },
      { key: 'bottom', label: 'Vue de dessous', type: 'checkbox', value: false },
      { key: 'back', label: 'Vue arrière', type: 'checkbox', value: false },
      { key: 'iso', label: 'Vue isométrique', type: 'checkbox', value: true },
      {
        key: 'proj',
        label: 'Disposition',
        type: 'select',
        value: 'eu',
        options: [
          { value: 'eu', label: 'Européenne (ISO, dessus sous la face)' },
          { value: 'us', label: 'Américaine (dessus au-dessus de la face)' },
        ],
      },
      {
        key: 'format',
        label: 'Cadre',
        type: 'select',
        value: 'A3',
        options: [
          { value: 'A4', label: 'A4 (297 × 210)' },
          { value: 'A3', label: 'A3 (420 × 297)' },
          { value: 'A2', label: 'A2 (594 × 420)' },
          { value: 'A1', label: 'A1 (841 × 594)' },
          { value: 'A0', label: 'A0 (1189 × 841)' },
          { value: 'none', label: 'Sans cadre (vues seules)' },
        ],
      },
      {
        key: 'orient',
        label: 'Orientation',
        type: 'select',
        value: 'landscape',
        options: [
          { value: 'landscape', label: 'Paysage' },
          { value: 'portrait', label: 'Portrait' },
        ],
      },
      { key: 'scale', label: 'Échelle', type: 'select', value: 'auto', options: [{ value: 'auto', label: 'Automatique (la plus grande qui tient)' }, ...SCALES.map((s) => ({ value: String(s.k), label: s.label }))] },
      { key: 'title', label: 'Titre du cartouche', type: 'text', value: title },
      { key: 'hidden', label: 'Lignes cachées (tirets)', type: 'checkbox', value: true },
      { key: 'axes', label: 'Axes et centres des perçages', type: 'checkbox', value: true },
      { key: 'smooth', label: 'Arêtes tangentes (raccords)', type: 'checkbox', value: false },
    ],
    ok: 'Projeter',
  });
  if (!v) return;
  const kinds = (Object.keys(VIEWS) as ViewKind[]).filter((k) => v[k]);
  if (!kinds.length) return ctx.print('Aucune vue choisie.');
  const european = v.proj !== 'us';
  const format = v.format === 'none' ? null : (String(v.format) as PaperFormat);
  const landscape = v.orient !== 'portrait';
  const opts = { hidden: !!v.hidden, smooth: !!v.smooth, axes: !!v.axes };
  await app.ensureKernel(ctx);
  const sources = src.map((s) => s.handle);
  // première passe à l'échelle 1 pour l'emprise, l'échelle n'affecte que les dépassements d'axes
  const geoms: { kind: ViewKind; geom: ViewGeom }[] = [];
  for (const k of kinds) {
    ctx.print(`Projection : vue ${VIEWS[k].name.toLowerCase()}…`);
    const t = performance.now();
    geoms.push({ kind: k, geom: await computeView(app, sources, VIEWS[k].dir, VIEWS[k].xDir, { ...opts, hidden: k !== 'iso' && opts.hidden, axes: k !== 'iso' && opts.axes, ext: AXIS_EXT }) });
    if (performance.now() - t > 4000) ctx.print('(projection lente : pièce complexe, filetages réels…)');
  }
  const unit = layoutViews(geoms, european, 0, [0, 0]);
  const raw = laidExtent(unit);
  let k = v.scale === 'auto' ? 1 : Number(v.scale);
  if (format && v.scale === 'auto') {
    // écarts entre vues (mm papier) : au plus deux entre trois colonnes / rangées
    const cols = new Set(unit.map((x) => Math.round(x.at.x * 1e3))).size, rows = new Set(unit.map((x) => Math.round(x.at.y * 1e3))).size;
    k = autoScale(raw.w, raw.h, [GAP * Math.max(0, cols - 1), GAP * Math.max(0, rows - 1)], usableArea(format, landscape));
  }
  // les axes dépassent de 3 mm papier : on les recalcule à l'échelle choisie
  if (opts.axes && Math.abs(k - 1) > 1e-9)
    for (const g of geoms) {
      if (g.kind === 'iso') continue;
      g.geom = await computeView(app, sources, VIEWS[g.kind].dir, VIEWS[g.kind].xDir, { ...opts, axes: true, ext: AXIS_EXT * k });
    }
  const laid = layoutViews(geoms, european, GAP * k, [0, 0]);
  const ext = laidExtent(laid);
  // aperçu et placement
  const bb = src.reduce(
    (m, s) => ({ minX: Math.min(m.minX, s.display.bbox.min.x), minY: Math.min(m.minY, s.display.bbox.min.y), maxX: Math.max(m.maxX, s.display.bbox.max.x) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity },
  );
  let origin: Vec3;
  let centerOf: (o: Vec3) => [number, number];
  let outline: (o: Vec3) => Vec3[][];
  if (format) {
    const [W, H] = paperSize(format, landscape);
    const area = usableArea(format, landscape);
    centerOf = (o) => [o.x + ((area.x0 + area.x1) / 2) * k, o.y + ((area.y0 + area.y1) / 2) * k];
    outline = (o) => [box(o.x, o.y, o.x + W * k, o.y + H * k), box(o.x + (W - 10 - 180) * k, o.y + 10 * k, o.x + (W - 10) * k, o.y + 42 * k)];
    origin = { x: bb.maxX + 30 * k, y: bb.minY, z: 0 };
    ctx.print(`Feuille ${format} ${landscape ? 'paysage' : 'portrait'} à l’échelle ${scaleLabel(k)} (${fmt(W * k)} × ${fmt(H * k)} dans le dessin).`);
    if (ext.w > (area.x1 - area.x0) * k || ext.h > (area.y1 - area.y0) * k) ctx.print('Attention : les vues dépassent du cadre à cette échelle.');
  } else {
    centerOf = (o) => [o.x, o.y];
    outline = () => [];
    origin = { x: bb.maxX + 30 + ext.w / 2, y: bb.minY + ext.h / 2, z: 0 };
  }
  const preview = (p: Vec3) => {
    const [cx, cy] = centerOf(p);
    return [...outline(p), ...viewBoxes(laid, cx, cy)];
  };
  const r = await getPointOrKeyword(ctx, format ? 'Coin inférieur gauche de la feuille (Entrée = à droite du modèle)' : 'Centre des vues (Entrée = à droite du modèle)', { allowNone: true, noRubberBand: true, preview });
  if (r.point) origin = { ...r.point, z: 0 };
  const [cx, cy] = centerOf(origin);
  const id = app.doc.nextSheetId();
  ensureDrawingLayers(app);
  const sheet: DrawingSheet = { id, name: `Mise en plan ${id}`, format, landscape, k, origin, title: String(v.title ?? ''), frame: [], views: [] };
  app.doc.transaction('Mise en plan', () => {
    for (const lv of laid) {
      const at = { x: lv.at.x + cx, y: lv.at.y + cy, z: 0 };
      const handles = viewEntities(lv.geom, at).map((e) => app.doc.addEntity(e));
      sheet.views.push(newViewRecord(`${id}.${lv.kind}`, lv.kind, sources, at, opts, handles));
    }
    sheet.frame = frameEntities(sheet, { material: materialLabel(app, sources), date: today(), sheetId: id, european }).map((e) => app.doc.addEntity(e));
    app.doc.putSheet(sheet);
  });
  // échelle des annotations : tirets, cotes et textes lisibles une fois imprimés
  if (format) {
    Object.assign(app.sysvars, { LTSCALE: k, DIMTXT: 3.5 * k, DIMASZ: 3 * k, TEXTSIZE: 3.5 * k });
  }
  app.viewport?.rebuild();
  if (app.doc.layer(LAYERS.dims.name)) app.doc.setCurrentLayer(LAYERS.dims.name);
  const n = sheet.views.reduce((s, x) => s + x.handles.length, 0);
  ctx.print(`${sheet.name} : ${laid.length} vue(s), ${n} trait(s)${format ? `, cadre ${format} au ${scaleLabel(k)}` : ''}. Calque courant : ${LAYERS.dims.name}.`);
  ctx.print('Cotez avec COTLIN, COTALI, COTDIA, COTRAYON (accrochage aux extrémités et centres) ; MAJVUES après une modification du modèle ; EXPORTPDF pour imprimer.');
  if (app.settings.workspace !== '2d') {
    app.set('workspace', '2d');
    await new Promise((r) => setTimeout(r, 700)); // fin de l'animation vers la vue de dessus
  }
  const corner = format ? paperSize(format, landscape) : null;
  if (corner) app.viewport?.zoomWindow(origin, { x: origin.x + corner[0] * k, y: origin.y + corner[1] * k, z: 0 });
  else app.viewport?.zoomWindow({ x: cx - ext.w * 0.6, y: cy - ext.h * 0.6, z: 0 }, { x: cx + ext.w * 0.6, y: cy + ext.h * 0.6, z: 0 });
});

type ViewGeom = Awaited<ReturnType<typeof computeView>>;

/** Nouvelle projection d'une vue d'après le modèle actuel (mêmes position et options). */
async function regenerate(app: AppHost, sheet: DrawingSheet, view: DrawingView): Promise<{ id: string; sources: string[]; geom: ViewGeom } | null> {
  const sources = view.sources.filter((h) => app.doc.get(h)?.type === '3DSOLID');
  if (!sources.length) return null;
  const geom = await computeView(app, sources, view.dir, view.xDir, { hidden: view.hidden, smooth: view.smooth, axes: view.axes, ext: AXIS_EXT * sheet.k });
  return { id: view.id, sources, geom };
}

const updateViews = cmd('VIEWUPDATE', 'MAJVUES', ['MAJMEP', 'ACTUALISERVUES', 'VIEWUPD'], 'Met à jour les vues des mises en plan d’après le modèle 3D modifié', async (ctx, app) => {
  const sheets = app.doc.sheets;
  if (!sheets.length) return ctx.print('Aucune mise en plan dans ce dessin (MISEENPLAN).');
  await app.ensureKernel(ctx);
  ctx.print('Mise à jour des vues…');
  const plans: { sheet: DrawingSheet; views: { id: string; sources: string[]; geom: ViewGeom }[] }[] = [];
  for (const s of sheets) {
    const views: { id: string; sources: string[]; geom: ViewGeom }[] = [];
    for (const v of s.views) {
      const r = await regenerate(app, s, v);
      if (r) views.push(r);
      else ctx.print(`${s.name} : vue ${v.name.toLowerCase()} sans modèle (solide supprimé), laissée telle quelle.`);
    }
    plans.push({ sheet: s, views });
  }
  let n = 0;
  app.doc.transaction('Mettre à jour les vues', () => {
    for (const { sheet, views } of plans) {
      const next: DrawingView[] = sheet.views.map((old) => {
        const r = views.find((x) => x.id === old.id);
        if (!r) return old;
        for (const h of old.handles) if (app.doc.get(h)) app.doc.removeEntity(h);
        const handles = viewEntities(r.geom, old.at).map((e) => app.doc.addEntity(e));
        n++;
        return { ...old, sources: r.sources, handles };
      });
      app.doc.putSheet({ ...sheet, views: next });
    }
  });
  ctx.print(`${n} vue(s) mise(s) à jour. Les cotes ne suivent pas : vérifiez-les si le modèle a changé de taille.`);
});

// ---------------------------------------------------------------------------------------------
// Export PDF
// ---------------------------------------------------------------------------------------------

/** Éléments PDF des entités, dans le repère papier (mm) : p_papier = (p − o) / k. */
function pdfItems(app: AppHost, es: Entity[], o: Vec3, k: number, mono: boolean): PdfItem[] {
  const items: PdfItem[] = [];
  const P = (p: Vec3): [number, number] => [(p.x - o.x) / k, (p.y - o.y) / k];
  const colorOf = (e: Entity) => {
    const c = app.doc.colorOf(e).toLowerCase();
    if (mono) return '#000000';
    // blanc / gris très clair (écran sombre) → noir sur papier
    const v = parseInt(c.slice(1), 16);
    const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
    return lum > 200 ? '#000000' : c;
  };
  for (const e of es) {
    if (e.type === '3DSOLID' || e.type === 'UNDERLAY') continue;
    const layer = app.doc.layer(e.layer);
    const color = colorOf(e);
    const width = Math.max(0.1, layer?.lineweight ?? 0.25);
    const dash = layer?.linetype ? patternOf(layer.linetype, 1).map(Math.abs) : undefined;
    if (e.type === 'TEXT') {
      const L = textLayout(e);
      const ca = Math.cos(e.rotation), sa = Math.sin(e.rotation);
      L.lines.forEach((line, i) => {
        const y = L.base0 - i * L.pitch;
        const p = P({ x: e.position.x - sa * y, y: e.position.y + ca * y, z: 0 });
        items.push({ kind: 'text', x: p[0], y: p[1], size: e.height / 0.716 / k, text: line, angle: e.rotation, align: e.align ?? 'left', color, widthFactor: e.widthFactor });
      });
      continue;
    }
    if (e.type === 'DIMENSION') {
      const g = dimensionGeometry(e, app.sysvars.DIMASZ);
      const h = e.textHeight ?? app.sysvars.DIMTXT;
      const lab = dimensionLabel(e, h, app.sysvars.DIMASZ, app.sysvars.DIMDEC);
      for (const l of [...g.lines, ...lab.lines]) items.push({ kind: 'path', pts: l.map(P), stroke: color, width: 0.18 });
      const at = P(lab.at);
      items.push({ kind: 'text', x: at[0], y: at[1], size: h / 0.716 / k, text: lab.text, angle: lab.angle, align: 'center', color });
      continue;
    }
    if (e.type === 'HATCH') {
      if (e.pattern === 'SOLID' || e.pattern === 'GRADIENT') {
        for (const b of e.boundaries) items.push({ kind: 'path', pts: b.map(P), closed: true, fill: color });
      } else for (const s of hatchSegments(e.boundaries, e.pattern, e.scale, e.angle)) items.push({ kind: 'path', pts: s.map(P), stroke: color, width: 0.13 });
      continue;
    }
    for (const pl of curvePoints(e)) items.push({ kind: 'path', pts: pl.map(P), stroke: color, width, dash: dash?.length ? dash : undefined });
  }
  return items;
}

function inWindow(e: Entity, x0: number, y0: number, x1: number, y1: number): boolean {
  const b = entityBBox(e);
  if (!b) return false;
  return b.max.x >= x0 && b.min.x <= x1 && b.max.y >= y0 && b.min.y <= y1;
}

const exportPdf = cmd('EXPORTPDF', 'EXPORTPDF', ['PDF', 'PDFOUT', 'TRACER', 'PLOT', 'IMPRIMER'], 'Exporte une mise en plan (ou le dessin 2D) en PDF vectoriel à l’échelle', async (ctx, app) => {
  const framed = app.doc.sheets.filter((s) => s.format);
  let o: Vec3, k: number, W: number, H: number, name: string;
  let pool: Entity[] = app.visible().filter((e) => e.type !== '3DSOLID' && e.type !== 'UNDERLAY');
  let mono = true;
  if (framed.length) {
    const opts = [...framed.map((s) => ({ value: s.id, label: `${s.name} : ${s.format} ${s.landscape ? 'paysage' : 'portrait'}, ${scaleLabel(s.k)}${s.title ? ` (${s.title})` : ''}` })), { value: 'ext', label: 'Étendue du dessin 2D (ajustée au papier)' }];
    const v = await app.ui.form({
      title: 'Export PDF',
      fields: [
        { key: 'sheet', label: 'Feuille', type: 'select', value: framed[framed.length - 1]!.id, options: opts },
        { key: 'paper', label: 'Papier (étendue seulement)', type: 'select', value: 'A3', options: (['A4', 'A3', 'A2', 'A1', 'A0'] as const).map((f) => ({ value: f, label: f })) },
        { key: 'color', label: 'Couleurs', type: 'select', value: 'mono', options: [{ value: 'mono', label: 'Noir et blanc (plan technique)' }, { value: 'color', label: 'Couleurs des calques' }] },
      ],
      ok: 'Exporter',
    });
    if (!v) return;
    mono = v.color === 'mono';
    const s = framed.find((x) => x.id === v.sheet);
    if (s) {
      [W, H] = paperSize(s.format!, s.landscape);
      k = s.k;
      o = s.origin;
      name = `${baseName(app.doc.fileName)}-${s.id}${s.title ? `-${s.title}` : ''}`;
      pool = pool.filter((e) => inWindow(e, o.x, o.y, o.x + W * k, o.y + H * k));
    } else ({ o, k, W, H, name } = fitExtents(app, pool, String(v.paper) as PaperFormat));
  } else {
    const r = await getKeyword(ctx, 'Format du papier', (['A4', 'A3', 'A2', 'A1', 'A0'] as const).map((f) => kw(f, f, f)), 'A4');
    const pre = app.takePreselection().map((h) => app.doc.get(h)).filter((e): e is Entity => !!e && e.type !== '3DSOLID' && e.type !== 'UNDERLAY');
    if (pre.length) pool = pre;
    ({ o, k, W, H, name } = fitExtents(app, pool, r as PaperFormat));
  }
  if (!pool.length) return ctx.print('Rien à imprimer (les solides 3D ne sont pas imprimés : utilisez MISEENPLAN).');
  const items = pdfItems(app, pool, o!, k!, mono);
  const data = writePdf([{ w: W!, h: H!, items }], name!);
  const t = await saveFile(data, { name: `${name!.replace(/[\\/:*?"<>|]/g, '_')}.pdf`, mime: 'application/pdf', description: 'Document PDF', extensions: ['.pdf'] });
  if (t) ctx.print(`PDF ${fmt(W!)} × ${fmt(H!)} mm à l’échelle ${scaleLabel(k!)} : ${pool.length} objet(s), ${t.name}.`);
});

/** Étendue des objets 2D centrée sur le papier, à la plus grande échelle normalisée. */
function fitExtents(app: AppHost, es: Entity[], format: PaperFormat): { o: Vec3; k: number; W: number; H: number; name: string } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of es) {
    const b = entityBBox(e);
    if (!b) continue;
    (minX = Math.min(minX, b.min.x)), (minY = Math.min(minY, b.min.y)), (maxX = Math.max(maxX, b.max.x)), (maxY = Math.max(maxY, b.max.y));
  }
  if (!Number.isFinite(minX)) (minX = minY = 0), (maxX = maxY = 100);
  const w = maxX - minX, h = maxY - minY;
  const [W, H] = paperSize(format, w >= h);
  const area = { x0: 10, y0: 10, x1: W - 10, y1: H - 10 };
  const k = autoScale(w, h, [0, 0], area);
  const o = { x: (minX + maxX) / 2 - (W / 2) * k, y: (minY + maxY) / 2 - (H / 2) * k, z: 0 };
  return { o, k, W, H, name: baseName(app.doc.fileName) };
}


export const drawingCommands: CommandDefinition[] = [drawing, updateViews, exportPdf];
