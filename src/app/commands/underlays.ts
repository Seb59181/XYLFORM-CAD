/**
 * Fonds de plan (références externes) : ATTACHER un DWG, DXF, PDF ou une image, palette de
 * gestion (REFEXT), estompage (XDWGFADECTL), rechargement, déchargement, détachement et liaison.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, LayerDef, NewEntity, UnderlayDef } from '../../core/document/Document';
import { transformEntity, underlayFrame, underlayMatrix } from '../../core/entities/geometry';
import { UNIT_NAME, unitScale, uniqueUnderlayName } from '../../core/entities/underlay';
import { desktop, pathOf } from '../../io/desktop';
import { baseName } from '../../io/fileAccess';
import { loadUnderlay, UNDERLAY_ACCEPT, type UnderlayContent } from '../../io/underlays';
import type { AppHost } from '../AppHost';
import { cmd, DEG, fmt, getAngle, getNumber, getPoint } from './helpers';

type Underlay = Extract<Entity, { type: 'UNDERLAY' }>;

export const UNDERLAY_LAYER = 'Fonds de plan';
const DEFAULT_FADE = 50;

const KIND_LABEL: Record<UnderlayDef['kind'], string> = { dwg: 'DWG', dxf: 'DXF', pdf: 'PDF', image: 'Image' };
export const underlayKindLabel = (d: UnderlayDef) => KIND_LABEL[d.kind];

let nextId = 1;
function newId(app: AppHost): string {
  while (app.doc.underlays[`U${nextId}`]) nextId++;
  return `U${nextId++}`;
}

function ensureLayer(app: AppHost): void {
  if (!app.doc.layer(UNDERLAY_LAYER)) app.doc.addLayer(UNDERLAY_LAYER, '#8b949e');
}

async function readContent(ctx: CommandContext, app: AppHost, file: File, page?: number): Promise<UnderlayContent> {
  return loadUnderlay(file.name, new Uint8Array(await file.arrayBuffer()), {
    print: (m) => ctx.print(m),
    hostUnits: app.sysvars.INSUNITS,
    page,
    choosePage: async (n) => {
      const r = await getNumber(ctx, `Le PDF contient ${n} pages. Numéro de la page à attacher`, { integer: true, defaultValue: 1 });
      return typeof r === 'number' ? r : 1;
    },
  });
}

/** ATTACHER : charge le fichier, puis demande point d'insertion, échelle et rotation. */
export async function attachUnderlay(ctx: CommandContext, app: AppHost, file: File): Promise<void> {
  const content = await readContent(ctx, app, file);
  const wasEmpty = app.doc.size === 0;
  const def: UnderlayDef = {
    id: newId(app),
    name: uniqueUnderlayName(baseName(file.name), Object.values(app.doc.underlays).map((u) => u.name)),
    fileName: file.name,
    path: pathOf(file),
    loaded: true,
    fade: DEFAULT_FADE,
    monochrome: false,
    loadedAt: Date.now(),
    ...content,
  };
  delete (def as { pages?: number }).pages;
  const autoScale = def.kind === 'dwg' || def.kind === 'dxf' ? unitScale(def.units, app.sysvars.INSUNITS) : 1;
  if (def.entities) ctx.print(`${def.entities.length} objet(s), ${def.layers?.length ?? 0} calque(s).`);
  if (autoScale !== 1) ctx.print(`Unités du fond : ${UNIT_NAME[def.units ?? 0] ?? def.units} → échelle ${fmt(autoScale)} pour le dessin en ${UNIT_NAME[app.sysvars.INSUNITS] ?? 'unités'}.`);
  if (def.kind === 'pdf') ctx.print(`Page ${def.page} à l’échelle 1:1 (${fmt(def.bounds.max.x, 1)} × ${fmt(def.bounds.max.y, 1)}).`);

  const inst = { type: 'UNDERLAY' as const, handle: '', layer: '', ref: def.id, position: { x: 0, y: 0, z: 0 }, scale: autoScale, rotation: 0, bounds: def.bounds };
  const frame = (p: Partial<Underlay>) => [underlayFrame({ ...inst, ...p })];
  const position = await getPoint(ctx, 'Point d’insertion', { defaultValue: inst.position, preview: (p) => frame({ position: p }), noRubberBand: true });
  const s = await getNumber(ctx, 'Facteur d’échelle', { defaultValue: autoScale });
  const scale = typeof s === 'number' && s > 0 ? s : autoScale;
  const a = await getAngle(ctx, 'Angle de rotation', { defaultValue: 0, basePoint: position, preview: (p) => frame({ position, scale, rotation: Math.atan2(p.y - position.y, p.x - position.x) }) });
  const rotation = typeof a === 'number' ? a : 0;

  ensureLayer(app);
  app.doc.transaction(`Attacher ${def.name}`, () => {
    app.doc.setUnderlayDef(def);
    app.doc.addEntity({ type: 'UNDERLAY', ref: def.id, position, scale, rotation, bounds: def.bounds, layer: UNDERLAY_LAYER });
  });
  ctx.print(`Fond de plan « ${def.name} » attaché (${KIND_LABEL[def.kind]}, échelle ${fmt(scale)}${rotation ? `, rotation ${fmt(rotation / DEG, 2)}°` : ''}).`);
  app.ui.toast(`Fond de plan « ${def.name} » attaché`, 'success');
  if (app.settings.panel !== 'underlays') app.set('panel', 'underlays');
  if (wasEmpty) setTimeout(() => app.viewport?.zoomExtents(), 50);
}

/**
 * Recharge une définition depuis son fichier : chemin connu (version bureau) ou fichier
 * redemandé. Les instances gardent leur position, échelle et rotation.
 */
export async function reloadUnderlay(app: AppHost, id: string, pick = false): Promise<void> {
  const def = app.doc.underlays[id];
  if (!def) return;
  let file: File | null = null;
  if (desktop && def.path && !pick) {
    try {
      file = new File([(await desktop.readFile(def.path)) as Uint8Array<ArrayBuffer>], def.fileName);
    } catch {
      app.ui.toast(`« ${def.path} » introuvable : choisissez le fichier.`, 'error');
    }
  }
  file ??= await app.ui.openFile(UNDERLAY_ACCEPT);
  if (!file) return;
  const chosen = file;
  await app.processor.run(
    cmd('RELOAD', 'RECHARGER', [], '', async (ctx, a) => {
      const content = await readContent(ctx, a, chosen, def.page);
      const { pages: _p, ...rest } = content;
      const next: UnderlayDef = { ...def, ...rest, fileName: chosen.name, path: pathOf(chosen) ?? def.path, loaded: true, loadedAt: Date.now() };
      if (!rest.entities) delete next.entities, delete next.layers;
      if (!rest.image) delete next.image;
      // calques masqués conservés
      if (next.layers && def.layers) next.layers = next.layers.map((l) => ({ ...l, visible: def.layers!.find((o) => o.name === l.name)?.visible ?? l.visible }));
      a.doc.setUnderlayDef(next, `Recharger ${def.name}`);
      ctx.print(`Fond de plan « ${def.name} » rechargé.`);
    }),
  );
}

/** Lier : remplace chaque instance par des objets ordinaires du dessin (calques `nom$0$calque`). */
export function bindUnderlay(app: AppHost, id: string): number {
  const def = app.doc.underlays[id];
  if (!def?.entities) return 0;
  const layers = new Map((def.layers ?? []).map((l) => [l.name, l]));
  const prefix = `${def.name}$0$`;
  let count = 0;
  app.doc.transaction(`Lier ${def.name}`, () => {
    const extra: LayerDef[] = [];
    for (const l of def.layers ?? []) if (!app.doc.layer(prefix + l.name)) extra.push({ name: prefix + l.name, color: l.color, lineweight: 0.25, visible: l.visible, frozen: false, locked: false });
    if (extra.length) app.doc.layers = [...app.doc.layers, ...extra];
    for (const inst of app.doc.underlayInstances(id)) {
      const m = underlayMatrix(inst);
      for (const ne of def.entities!) {
        const layer = prefix + (ne.layer ?? '0');
        if (!layers.has(ne.layer ?? '0') && !app.doc.layer(layer)) app.doc.layers = [...app.doc.layers, { name: layer, color: '#ffffff', lineweight: 0.25, visible: true, frozen: false, locked: false }];
        const local = { ...ne, handle: '', layer } as Entity;
        const { handle: _h, ...placed } = { ...local, ...transformEntity(local, m) } as Entity;
        app.doc.addEntity(placed as NewEntity);
        count++;
      }
    }
    app.doc.removeUnderlayDef(id);
  });
  return count;
}

/** Zoom sur l'emprise des instances d'un fond de plan. */
export function zoomUnderlay(app: AppHost, id: string): void {
  const pts: Vec3[] = app.doc.underlayInstances(id).flatMap((e) => underlayFrame(e));
  if (!pts.length || !app.viewport) return;
  app.viewport.zoomToPoints(pts);
}

// ---------------------------------------------------------------------------

const attach = cmd('ATTACH', 'ATTACHER', ['XATTACH', 'XA', 'ATTACHERX', 'FONDPLAN', 'IMAGEATTACH', 'PDFATTACH', 'DWGATTACH'], 'Attache un DWG, DXF, PDF ou une image comme fond de plan (non modifiable)', async (ctx, app) => {
  const file = await app.ui.openFile(UNDERLAY_ACCEPT);
  if (!file) return ctx.print('*Annuler*');
  await attachUnderlay(ctx, app, file);
});

const palette = cmd('EXTERNALREFERENCES', 'REFEXT', ['XREF', 'XR', 'ER', 'FONDSDEPLAN', 'IMAGE', 'PDFUNDERLAY'], 'Ouvre la palette de gestion des fonds de plan', async (ctx, app) => {
  app.set('panel', 'underlays');
  const n = Object.keys(app.doc.underlays).length;
  ctx.print(n ? `${n} fond(s) de plan dans le dessin.` : 'Aucun fond de plan : utilisez ATTACHER.');
});

const fadeCmd = cmd('XDWGFADECTL', 'ESTOMPAGE', ['XFADE', 'PDFFADE', 'ESTOMPERREF'], 'Estompage des fonds de plan (0 à 90 %)', async (ctx, app) => {
  const defs = Object.values(app.doc.underlays);
  const current = defs[0]?.fade ?? DEFAULT_FADE;
  const v = await getNumber(ctx, 'Estompage des fonds de plan en % (0 à 90)', { integer: true, defaultValue: current, allowZero: true });
  if (typeof v !== 'number') return;
  const fade = Math.max(0, Math.min(90, Math.round(v)));
  app.doc.transaction('Estompage des fonds de plan', () => defs.forEach((d) => app.doc.updateUnderlayDef(d.id, { fade })));
  ctx.print(`Estompage : ${fade} % (${defs.length} fond(s) de plan).`);
});

export const underlayCommands: CommandDefinition[] = [attach, palette, fadeCmd];
