/**
 * Menu Application et onglets Insertion / Sortie : nouveau, ouvrir, enregistrer (.xcad),
 * importer (DXF, DWG, STEP), exporter (DXF, STEP, STL, 3MF, SVG) et capture PNG.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, LayerDef, NewEntity } from '../../core/document/Document';
import { mergeMeshes, type IndexedMesh } from '../../core/mesh/IndexedMesh';
import { NonManifoldError } from '../../core/mesh/ManifoldCheck';
import { curvePoints, dimensionGeometry, dimensionLabel, hatchSegments, TEXT_CAP, textBox, textLayout } from '../../core/entities/geometry';
import { readDxf, writeDxf } from '../../io/dxf';
import { exportStlBinary } from '../../io/exporters/StlExporter';
import { exportThreeMf } from '../../io/exporters/ThreeMfExporter';
import type { LengthUnit } from '../../io/exporters/PrintPreparation';
import { desktop, fileFromDesktop, pathOf } from '../../io/desktop';
import { isMeshFile, readMeshFile } from '../../io/meshImport';
import { baseName, extension, saveFile } from '../../io/fileAccess';
import { cadText, underlayKind } from '../../io/underlays';
import { attachUnderlay } from './underlays';
import { loadProject, saveProject } from '../../io/project';
import { readAutosaves, type AutosaveRecord } from '../../io/autosave';
import { addRecent, removeRecent, type RecentFile } from '../../io/recent';
import type { SolidResult } from '../../kernel/protocol';
import type { AppHost, DocTab } from '../AppHost';
import { clipboardShapeIds } from './utility';
import { analyzeMeshes, describeChecks, drawingUnit, findOverlaps, overlapGroups, showAnalysis } from '../printCheck';
import { cmd, fmt, getDistance, getKeyword, getNumber, isBody, isSolid, kw, selectObjects } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const OPEN_ACCEPT = '.xcad,.sebcad,.ncad,.dxf,.dwg,.step,.stp,.stl,.3mf';
const IMPORT_ACCEPT = '.dxf,.dwg,.step,.stp,.stl,.3mf';

/** Unités possibles d'un STL (le format n'en porte pas) : facteur vers le mm. */
const STL_UNITS: Record<string, number> = { Millimeters: 1, Centimeters: 10, Meters: 1000, Inches: 25.4 };

/** Projet natif (.xcad ; .sebcad et .ncad des versions précédentes). */
const isProject = (name: string) => ['xcad', 'sebcad', 'ncad'].includes(extension(name));

/**
 * Ferme un onglet de dessin : s'il a des modifications, propose Enregistrer / Ne pas
 * enregistrer / Annuler. Renvoie false si l'utilisateur annule.
 */
export async function closeTab(app: AppHost, tab: DocTab, print: (m: string) => void = (m) => app.log(m)): Promise<boolean> {
  if (!app.docs.includes(tab)) return true;
  if (tab.doc.dirty && tab.doc.size > 0) {
    if (tab !== app.tab) app.activate(tab);
    const c = await app.ui.choose(`Enregistrer les modifications de « ${tab.doc.fileName} » avant de le fermer ?`, 'Fermer le dessin', ['Enregistrer', 'Ne pas enregistrer', 'Annuler']);
    if (c === 2) return false;
    if (c === 0 && !(await saveActive(app, false, print))) return false;
  }
  app.autosave?.forget(tab);
  app.removeTab(tab, clipboardShapeIds());
  return true;
}

/** Chemin du fichier d'un onglet (version bureau). */
const tabPath = (t: DocTab) => (t.fileHandle && 'path' in t.fileHandle ? t.fileHandle.path : undefined);

/**
 * Ouvre un fichier dans un nouvel onglet (ou dans le dessin vierge du démarrage). Un fichier
 * déjà ouvert est simplement affiché.
 */
export async function openInTab(ctx: CommandContext, app: AppHost, file: File): Promise<void> {
  const path = pathOf(file);
  const already = path && app.docs.find((t) => tabPath(t)?.toLowerCase() === path.toLowerCase());
  if (already) {
    app.activate(already);
    ctx.print(`« ${file.name} » est déjà ouvert.`);
    return;
  }
  const prev = app.tab;
  const reuse = app.isBlank();
  const tab = reuse ? app.tab : app.newTab(isProject(file.name) ? file.name : `${baseName(file.name)}.xcad`);
  app.showStart(false);
  try {
    await openFile(ctx, app, file);
    addRecent(file.name, path);
    app.emit('tabs');
  } catch (e) {
    if (!reuse) {
      app.removeTab(tab);
      app.activate(prev);
    }
    throw e;
  }
}

/** Lit un fichier DXF, DWG ou STEP en entités (sans les ajouter au dessin). */
async function readForeign(app: AppHost, ctx: CommandContext, file: File): Promise<{ entities: NewEntity[]; layers: LayerDef[] }> {
  const ext = extension(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === 'dxf' || ext === 'dwg') {
    const r = readDxf(await cadText(bytes, ext, (m) => ctx.print(m)));
    const skipped = Object.entries(r.skipped);
    ctx.print(`${r.entities.length} objet(s) lu(s), ${r.layers.length} calque(s).`);
    if (skipped.length) ctx.print(`Non importés : ${skipped.map(([k, n]) => `${k} ×${n}`).join(', ')}`);
    return { entities: r.entities, layers: r.layers };
  }
  if (ext === 'step' || ext === 'stp') {
    await app.ensureKernel(ctx);
    ctx.print('Lecture STEP…');
    const results = await app.kernel.call<SolidResult[]>({ op: 'importStep', data: bytes });
    const entities: NewEntity[] = results.map((r, i) => ({ type: '3DSOLID', name: `${baseName(file.name)}${results.length > 1 ? ` ${i + 1}` : ''}`, shapeId: r.shapeId, display: r.display }));
    ctx.print(`${entities.length} corps importé(s).`);
    return { entities, layers: [] };
  }
  if (isMeshFile(file.name)) return { entities: await readMesh(app, ctx, file.name, bytes), layers: [] };
  throw new Error(`Format non pris en charge : .${ext}`);
}

/**
 * STL / 3MF : chaque objet devient un corps maillé (modifiable : déplacer, pivoter, échelle,
 * miroir, booléens avec les autres solides, coupe, export). CONVSOLIDE le change en solide B-rep.
 */
async function readMesh(app: AppHost, ctx: CommandContext, name: string, bytes: Uint8Array): Promise<NewEntity[]> {
  let scale = 1;
  if (extension(name) === 'stl') {
    const u = await getKeyword(
      ctx,
      'Unités du fichier STL',
      [kw('Millimeters', 'Millimètres', 'MM'), kw('Centimeters', 'Centimètres', 'CM'), kw('Meters', 'Mètres', 'M'), kw('Inches', 'Pouces', 'PO')],
      'Millimeters',
    );
    scale = STL_UNITS[u] ?? 1;
  }
  ctx.print(`Lecture de ${name}…`);
  const objects = readMeshFile(name, bytes, scale);
  await app.ensureKernel(ctx);
  const out: NewEntity[] = [];
  for (const o of objects) {
    const r = await app.kernel.call<SolidResult>({ op: 'meshBody', positions: o.mesh.positions, indices: o.mesh.indices, closed: o.closed });
    o.warnings.forEach((w) => ctx.print(`${o.name} : ${w}`));
    out.push({ type: '3DSOLID', name: o.name, shapeId: r.shapeId, display: r.display, ...(o.color ? { color: o.color } : {}) });
    ctx.print(`${o.name} : ${o.triangles} triangles${o.closed ? `, volume ${fmt(r.display.volume, 2)} mm³` : ' (surface ouverte)'}.`);
  }
  return out;
}

function mergeLayers(app: AppHost, layers: LayerDef[], entities: NewEntity[]): LayerDef[] {
  const out = [...app.doc.layers];
  const add = (l: LayerDef) => {
    if (!out.some((k) => k.name === l.name)) out.push(l);
  };
  layers.forEach(add);
  for (const e of entities) if (e.layer) add({ name: e.layer, color: '#ffffff', lineweight: 0.25, visible: true, frozen: false, locked: false });
  return out;
}

async function openFile(ctx: CommandContext, app: AppHost, file: File): Promise<void> {
  const ext = extension(file.name);
  app.fileHandle = null;
  if (isProject(file.name)) {
    await loadProject(app, new Uint8Array(await file.arrayBuffer()), file.name, (m) => ctx.print(m));
    // version bureau : « Enregistrer » réécrit le fichier ouvert
    const path = pathOf(file);
    if (path && extension(file.name) === 'xcad') app.fileHandle = { path, name: file.name };
  } else {
    const { entities, layers } = await readForeign(app, ctx, file);
    const merged = [...layers];
    for (const e of entities) if (e.layer && !merged.some((l) => l.name === e.layer)) merged.push({ name: e.layer, color: '#ffffff', lineweight: 0.25, visible: true, frozen: false, locked: false });
    const withHandles = entities.map((e, i) => ({ ...e, layer: e.layer ?? '0', handle: (0x100 + i).toString(16).toUpperCase() }) as Entity);
    app.doc.load({ entities: withHandles, layers: merged, constraints: [], fileName: `${baseName(file.name)}.xcad` });
  }
  app.selection.clear();
  ctx.print(`« ${file.name} » ouvert : ${app.doc.size} objet(s).`);
  setTimeout(() => app.viewport?.zoomExtents(), 50);
}

/**
 * Fichier déposé sur la fenêtre : un .xcad (ou .sebcad) est ouvert, un DXF/DWG/STEP est inséré dans le
 * dessin, un PDF ou une image est attaché comme fond de plan.
 */
export async function openDroppedFile(app: AppHost, file: File): Promise<void> {
  const project = isProject(file.name);
  const kind = underlayKind(file.name);
  if (kind === 'pdf' || kind === 'image') {
    await app.processor.run(cmd('ATTACH', 'ATTACHER', [], '', async (ctx, a) => attachUnderlay(ctx, a, file)));
    return;
  }
  const def = cmd(project ? 'OPEN' : 'IMPORT', project ? 'OUVRIR' : 'IMPORTER', [], '', async (ctx, a) => {
    if (project) await openInTab(ctx, a, file);
    else await importFile(ctx, a, file);
  });
  await app.processor.run(def);
}

/** Ouvre un dessin reçu de l'Explorateur Windows (version bureau), dans un nouvel onglet. */
export async function openDesktopFile(app: AppHost, file: File): Promise<void> {
  const kind = underlayKind(file.name);
  if (kind === 'pdf' || kind === 'image') return openDroppedFile(app, file);
  if (!isProject(file.name) && !kind && !['step', 'stp', 'stl', '3mf'].includes(extension(file.name))) return;
  if (!(await app.leaveCommand())) return;
  await app.processor.run(cmd('OPEN', 'OUVRIR', [], '', async (ctx, a) => openInTab(ctx, a, file)));
}

/** Rouvre un dessin récent (page Démarrage) : par son chemin en version bureau, sinon boîte Ouvrir. */
export async function openRecent(app: AppHost, r: RecentFile): Promise<void> {
  if (!(await app.leaveCommand())) return;
  if (!r.path || !desktop) {
    app.run('OUVRIR');
    return;
  }
  let data: Uint8Array;
  try {
    data = await desktop.readFile(r.path);
  } catch {
    removeRecent(r);
    app.ui.toast(`« ${r.name} » est introuvable (déplacé ou supprimé) : retiré des récents.`, 'error');
    app.emit('tabs');
    return;
  }
  await openDesktopFile(app, fileFromDesktop({ name: r.name, path: r.path, data }));
}

async function importFile(ctx: CommandContext, app: AppHost, file: File): Promise<void> {
  const { entities, layers } = await readForeign(app, ctx, file);
  app.doc.layers = mergeLayers(app, layers, entities);
  const hs: string[] = [];
  app.doc.transaction(`Importer ${file.name}`, () => entities.forEach((e) => hs.push(app.doc.addEntity(e))));
  ctx.print(`${hs.length} objet(s) importé(s) depuis « ${file.name} ».`);
  setTimeout(() => app.viewport?.zoomExtents(), 50);
}

// ---------------------------------------------------------------------------

const newDoc = cmd('NEW', 'NOUVEAU', ['NV', 'QNEW'], 'Nouveau dessin dans un nouvel onglet (Ctrl+N)', async (ctx, app) => {
  app.newTab();
  ctx.print(`Nouveau dessin : ${app.doc.fileName}`);
});

const open = cmd('OPEN', 'OUVRIR', ['OU'], 'Ouvre un dessin .xcad (ou .sebcad), DXF, DWG, STEP, STL ou 3MF dans un nouvel onglet (Ctrl+O)', async (ctx, app) => {
  const file = await app.ui.openFile(OPEN_ACCEPT);
  if (!file) return;
  await openInTab(ctx, app, file);
});

/** Enregistre le dessin actif ; false si annulé. */
async function saveActive(app: AppHost, ask: boolean, print: (m: string) => void): Promise<boolean> {
  print(`Enregistrement de « ${app.doc.fileName} »…`);
  const data = await saveProject(app);
  const name = app.doc.fileName.toLowerCase().endsWith('.xcad') ? app.doc.fileName : `${baseName(app.doc.fileName)}.xcad`;
  const target = await saveFile(data, { name, mime: 'application/zip', description: 'Dessin Xylform CAD', extensions: ['.xcad'], handle: ask ? null : app.fileHandle });
  if (!target) {
    print('Enregistrement annulé.');
    return false;
  }
  app.fileHandle = target.handle ?? null;
  app.doc.fileName = target.name;
  app.doc.dirty = false;
  if (target.handle && 'path' in target.handle) addRecent(target.name, target.handle.path);
  app.emit('doc');
  app.emit('tabs');
  print(`Dessin enregistré : ${target.name} (${fmt(data.length / 1024, 1)} Ko)`);
  app.ui.toast(`Enregistré : ${target.name}`, 'success');
  return true;
}

async function save(ctx: CommandContext, app: AppHost, ask: boolean): Promise<void> {
  await saveActive(app, ask, (m) => ctx.print(m));
}

const closeCmd = cmd('CLOSE', 'FERMER', ['FERMERDESSIN'], 'Ferme le dessin courant (Ctrl+F4)', async (ctx, app) => {
  await closeTab(app, app.tab, (m) => ctx.print(m));
});

const closeAll = cmd('CLOSEALL', 'FERMERTOUT', [], 'Ferme tous les dessins ouverts', async (ctx, app) => {
  for (const t of [...app.docs]) if (!(await closeTab(app, t, (m) => ctx.print(m)))) return ctx.print('Fermeture interrompue.');
});

const saveAll = cmd('SAVEALL', 'ENREGTOUT', ['ENRTOUT'], 'Enregistre tous les dessins modifiés', async (ctx, app) => {
  const start = app.tab;
  let n = 0;
  for (const t of [...app.docs]) {
    if (!t.doc.dirty || !t.doc.size) continue;
    app.activate(t);
    if (!(await saveActive(app, false, (m) => ctx.print(m)))) break;
    n++;
  }
  if (app.docs.includes(start)) app.activate(start);
  ctx.print(n ? `${n} dessin(s) enregistré(s).` : 'Aucun dessin à enregistrer.');
});

const saveCmd = cmd('SAVE', 'ENREG', ['QSAVE', 'ENR'], 'Enregistre le dessin (Ctrl+S)', async (ctx, app) => save(ctx, app, false));
const saveAs = cmd('SAVEAS', 'ENREGSOUS', ['ES'], 'Enregistre le dessin sous un autre nom (Ctrl+Maj+S)', async (ctx, app) => save(ctx, app, true));

const importCmd = cmd('IMPORT', 'IMPORTER', ['IMP'], 'Insère un fichier DXF, DWG, STEP, STL ou 3MF dans le dessin', async (ctx, app) => {
  const file = await app.ui.openFile(IMPORT_ACCEPT);
  if (file) await importFile(ctx, app, file);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Objets à exporter : sélection courante sinon tout le visible. */
function exportSet(app: AppHost, accept: (e: Entity) => boolean): Entity[] {
  // les fonds de plan restent des références ; les lignes de construction ne sortent pas
  const filter = (e: Entity) => e.type !== 'UNDERLAY' && !(e.type === 'LINE' && e.guide) && accept(e);
  const pre = app.takePreselection().map((h) => app.doc.get(h)).filter((e): e is Entity => !!e && filter(e));
  return pre.length ? pre : app.visible().filter(filter);
}

const exportDxf = cmd('EXPORTDXF', 'EXPORTDXF', ['DXFOUT', 'EDXF'], 'Exporte le dessin en DXF (R12)', async (ctx, app) => {
  const es = exportSet(app, () => true);
  if (!es.length) return ctx.print('Rien à exporter.');
  const text = writeDxf(es, app.doc.layers, app.sysvars.INSUNITS, app.sysvars.LTSCALE);
  const t = await saveFile(text, { name: `${baseName(app.doc.fileName)}.dxf`, mime: 'application/dxf', description: 'Dessin DXF', extensions: ['.dxf'] });
  if (t) ctx.print(`${es.length} objet(s) exporté(s) dans ${t.name}.`);
});

const exportStep = cmd('EXPORTSTEP', 'EXPORTSTEP', ['STEPOUT', 'ESTEP'], 'Exporte les solides en STEP (B-rep exact)', async (ctx, app) => {
  const es = exportSet(app, isBody) as Solid3D[];
  if (!es.length) return ctx.print('Aucun solide à exporter.');
  await app.ensureKernel(ctx);
  const exact = await app.exactShapes(es, ctx);
  let data: Uint8Array;
  try {
    data = await app.kernel.call<Uint8Array>({ op: 'exportStep', shapeIds: exact.ids });
  } finally {
    exact.release();
  }
  const t = await saveFile(data, { name: `${baseName(app.doc.fileName)}.step`, mime: 'application/step', description: 'Modèle STEP', extensions: ['.step', '.stp'] });
  if (t) ctx.print(`${es.length} corps exporté(s) dans ${t.name}.`);
});

async function meshExport(ctx: CommandContext, app: AppHost, format: 'stl' | '3mf'): Promise<void> {
  const es = exportSet(app, isSolid) as Solid3D[];
  if (!es.length) {
    ctx.print('Aucun solide fermé à exporter (les surfaces ne sont pas imprimables : utilisez EPAISSIR).');
    return;
  }
  const opts = await app.ui.meshExport(format, es.length, drawingUnit(app.sysvars.INSUNITS));
  if (!opts) return ctx.print('Export annulé.');
  await app.ensureKernel(ctx);
  const exact = await app.exactShapes(es, ctx);
  // objets à écrire : un par solide, ou par groupe de solides fusionnés (chevauchements)
  let items = es.map((s, i) => ({ name: s.name || `Solide ${s.handle}`, id: exact.ids[i]!, color: app.doc.colorOf(s) }));
  const temp: string[] = [];
  let meshes: IndexedMesh[];
  try {
    if (opts.check && es.length > 1) {
      ctx.print('Contrôle des chevauchements entre solides…');
      const overlaps = await findOverlaps(app, es, exact.ids, ctx);
      if (overlaps.length) {
        for (const o of overlaps) ctx.print(`Chevauchement : ${items[o.a]!.name} ↔ ${items[o.b]!.name} (${fmt(o.volume, 3)} unités³ en commun).`);
        const groups = overlapGroups(es.length, overlaps);
        const fuse = await app.ui.confirm(
          `${overlaps.length} paire(s) de solides se chevauchent. Dans le fichier, ils resteraient superposés sans être fusionnés : les trancheurs les impriment mal (parois en double, couches erronées).\n\nFusionner ces solides pour l’export ? (Le dessin n’est pas modifié.)`,
          'Solides qui se chevauchent',
          { ok: 'Fusionner pour l’export', cancel: 'Laisser tels quels' },
        );
        if (fuse) {
          const merged = new Set(groups.flat());
          const next = items.filter((_, i) => !merged.has(i));
          for (const g of groups) {
            const r = await app.solid(ctx, { op: 'boolean', kind: 'union', targets: g.map((i) => items[i]!.id), tools: [], lazy: true });
            temp.push(r.shapeId);
            next.push({ name: g.map((i) => items[i]!.name).join(' + '), id: r.shapeId, color: items[g[0]!]!.color });
          }
          items = next;
          ctx.print(`${groups.length} groupe(s) de solides fusionné(s) pour l’export.`);
        }
      }
    }
    ctx.print(`Maillage : flèche ${opts.linearDeflection} mm, angle ${opts.angularDeflection}°…`);
    meshes = await app.kernel.exportMesh(items.map((it) => it.id), opts.linearDeflection, opts.angularDeflection);
  } finally {
    exact.release();
    if (temp.length) void app.kernel.call({ op: 'release', shapeIds: temp }).catch(() => undefined);
  }
  if (opts.check) {
    const minWall = opts.minWall ?? 0.8, overhang = opts.overhang ?? 45;
    // 3MF à objets séparés : le trancheur pose chaque objet sur le plateau
    const checks = analyzeMeshes(meshes, opts.unit as LengthUnit, minWall, overhang, !(format === '3mf' && opts.separate));
    const lines = describeChecks(items.map((it) => it.name), checks, opts.unit as LengthUnit, minWall, overhang);
    if (lines.length) {
      lines.forEach((l) => ctx.print(l));
      const shown = showAnalysis(app, checks);
      if (shown) ctx.print('Dans la vue : porte-à-faux en rouge, parois fines en orange (effacé à la prochaine modification, ou IMPRIMABILITE › Effacer).');
      const go = await app.ui.confirm(`${lines.join('\n')}\n\nExporter quand même ?`, 'Contrôle d’imprimabilité', { ok: 'Exporter', cancel: 'Annuler' });
      if (!go) return ctx.print('Export annulé : corrigez les zones signalées (colorées dans la vue).');
    } else ctx.print(`Imprimabilité : ni paroi de moins de ${fmt(minWall, 2)} mm, ni porte-à-faux de plus de ${fmt(overhang, 0)}°.`);
  }
  const run = (allowNonManifold: boolean) => {
    const common = { sourceUnit: opts.unit as LengthUnit, autoRepair: opts.repair, allowNonManifold };
    if (format === 'stl') {
      const r = exportStlBinary(meshes, common);
      return { data: r.data, warnings: r.prepared.warnings, triangles: r.prepared.mesh.indices.length / 3, volume: r.prepared.manifold.volume };
    }
    const objects = opts.separate
      ? items.map((it, i) => ({ name: it.name, mesh: meshes[i]!, color: it.color }))
      : [{ name: baseName(app.doc.fileName), mesh: mergeMeshes(meshes as IndexedMesh[]), color: items[0]!.color }];
    const r = exportThreeMf(objects, { ...common, title: baseName(app.doc.fileName), application: 'Xylform CAD, by Seb.' });
    return {
      data: r.data,
      warnings: r.objects.flatMap((o) => o.prepared.warnings.map((w) => `${o.name} : ${w}`)),
      triangles: r.objects.reduce((n, o) => n + o.prepared.mesh.indices.length / 3, 0),
      volume: r.objects.reduce((v, o) => v + o.prepared.manifold.volume, 0),
    };
  };
  let res: ReturnType<typeof run>;
  try {
    res = run(false);
  } catch (e) {
    if (!(e instanceof NonManifoldError)) throw e;
    ctx.print(e.message);
    if (!(await app.ui.confirm(`${e.message}\n\nLe fichier risque d’être mal tranché. Exporter quand même ?`, 'Maillage non étanche'))) return;
    res = run(true);
  }
  res.warnings.forEach((w) => ctx.print(w));
  const name = `${baseName(app.doc.fileName)}.${format}`;
  const t = await saveFile(res.data, {
    name,
    mime: format === 'stl' ? 'model/stl' : 'model/3mf',
    description: format === 'stl' ? 'Maillage STL' : 'Paquet 3MF',
    extensions: [`.${format}`],
  });
  if (!t) return;
  ctx.print(`${t.name} : ${es.length} solide(s), ${res.triangles} triangles, volume ${fmt(res.volume, 2)} mm³, ${fmt(res.data.length / 1024, 1)} Ko.`);
  app.ui.toast(`Export ${format.toUpperCase()} terminé : ${res.triangles} triangles`, 'success');
}

/** Réglages du contrôle d'imprimabilité (repris d'une fois sur l'autre). */
const printCheck = { minWall: 0.8, overhang: 45 };

const printability = cmd('PRINTCHECK', 'IMPRIMABILITE', ['ANALYSEIMPRESSION', 'CONTROLEIMPRESSION'], 'Contrôle d’imprimabilité : chevauchements, parois trop fines, porte-à-faux (zones colorées)', async (ctx, app) => {
  for (;;) {
    const r = await getKeyword(
      ctx,
      `Contrôle d’imprimabilité (paroi minimale ${fmt(printCheck.minWall, 2)} mm, porte-à-faux ${fmt(printCheck.overhang, 0)}°)`,
      [
        kw('Run', 'Analyser', 'A', 'Analyse les solides choisis (Entrée)'),
        kw('Wall', 'Paroi', 'P', 'Épaisseur de paroi minimale (mm)'),
        kw('Overhang', 'Porte-a-faux', 'PF', 'Inclinaison maximale sans support, depuis la verticale'),
        kw('Clear', 'Effacer', 'E', 'Efface les zones colorées'),
      ],
      'Run',
    );
    if (r === 'Clear') {
      app.viewport?.setAnalysis(null);
      return ctx.print('Zones colorées effacées.');
    }
    if (r === 'Wall') {
      printCheck.minWall = (await getDistance(ctx, 'Épaisseur de paroi minimale en mm (≈ 2 largeurs de ligne)', { defaultValue: printCheck.minWall, allowZero: true })) as number;
      continue;
    }
    if (r === 'Overhang') {
      printCheck.overhang = Math.max(1, Math.min(89, (await getNumber(ctx, 'Porte-à-faux maximal sans support (° depuis la verticale)', { defaultValue: printCheck.overhang, allowZero: false })) as number));
      continue;
    }
    break;
  }
  const hs = await selectObjects(ctx, 'Choisissez les solides à contrôler (Entrée = tous)', isSolid, true);
  const es = (hs.length ? hs.map((h) => app.doc.get(h)) : app.visible().filter(isSolid)) as Solid3D[];
  if (!es.length) return ctx.print('Aucun solide à contrôler.');
  await app.ensureKernel(ctx);
  const unit = drawingUnit(app.sysvars.INSUNITS) as LengthUnit;
  const names = es.map((s) => s.name || `Solide ${s.handle}`);
  if (es.length > 1) {
    const overlaps = await findOverlaps(app, es, es.map((s) => s.shapeId), ctx);
    for (const o of overlaps) ctx.print(`Chevauchement : ${names[o.a]} ↔ ${names[o.b]} (${fmt(o.volume, 3)} unités³ en commun) : à fusionner (UNION) ou à écarter.`);
    if (!overlaps.length) ctx.print('Aucun chevauchement entre les solides.');
  }
  const meshes = await app.kernel.exportMesh(es.map((s) => s.shapeId), 0.05, 15);
  const checks = analyzeMeshes(meshes, unit, printCheck.minWall, printCheck.overhang);
  const lines = describeChecks(names, checks, unit, printCheck.minWall, printCheck.overhang);
  if (!lines.length) {
    showAnalysis(app, null);
    ctx.print(`Imprimabilité : ni paroi de moins de ${fmt(printCheck.minWall, 2)} mm, ni porte-à-faux de plus de ${fmt(printCheck.overhang, 0)}°.`);
    app.ui.toast('Rien à signaler pour l’impression', 'success');
    return;
  }
  lines.forEach((l) => ctx.print(l));
  showAnalysis(app, checks);
  ctx.print('Dans la vue : porte-à-faux en rouge, parois fines en orange (effacé à la prochaine modification, ou IMPRIMABILITE › Effacer). Une face posée à plat sur le plateau ne compte pas.');
});

const exportStl = cmd('EXPORTSTL', 'EXPORTSTL', ['STLOUT', 'ESTL'], 'Exporte les solides en STL pour l’impression 3D', async (ctx, app) => meshExport(ctx, app, 'stl'));
const export3mf = cmd('EXPORT3MF', 'EXPORT3MF', ['3MFOUT', 'E3MF'], 'Exporte les solides en 3MF (unités, couleurs, objets)', async (ctx, app) => meshExport(ctx, app, '3mf'));

function svgOf(app: AppHost, es: Entity[]): string {
  const paths: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p: Vec3) => {
    minX = Math.min(minX, p.x), minY = Math.min(minY, p.y), maxX = Math.max(maxX, p.x), maxY = Math.max(maxY, p.y);
  };
  const pathOf = (pl: Vec3[]) => pl.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x, 4)} ${fmt(-p.y, 4)}`).join('');
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  for (const e of es) {
    const color = app.doc.colorOf(e);
    const lw = app.doc.layer(e.layer)?.lineweight ?? 0.25;
    if (e.type === '3DSOLID') {
      const d = e.display;
      for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
        const pts: Vec3[] = [];
        for (let k = d.edgeOffsets[i]!; k < d.edgeOffsets[i + 1]!; k++) pts.push({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: 0 });
        pts.forEach(grow);
        paths.push(`<path d="${pathOf(pts)}" stroke="${color}" stroke-width="${lw}" fill="none"/>`);
      }
      continue;
    }
    if (e.type === 'TEXT') {
      textBox(e).forEach(grow);
      const L = textLayout(e);
      const anchor = e.align === 'center' ? 'middle' : e.align === 'right' ? 'end' : 'start';
      const x = e.position.x, y = -e.position.y;
      const tspans = L.lines.map((l, k) => `<tspan x="0" y="${fmt(-(L.base0 - k * L.pitch))}">${esc(l)}</tspan>`).join('');
      paths.push(
        `<text font-size="${fmt(e.height / TEXT_CAP)}" font-family="Arial" fill="${color}" text-anchor="${anchor}" transform="translate(${fmt(x)} ${fmt(y)}) rotate(${fmt((-e.rotation * 180) / Math.PI)}) scale(${fmt(e.widthFactor ?? 1)} 1)">${tspans}</text>`,
      );
      continue;
    }
    if (e.type === 'HATCH') {
      const d = e.boundaries.map((b) => pathOf([...b, b[0]!]) + 'Z').join('');
      e.boundaries.flat().forEach(grow);
      if (e.pattern === 'SOLID' || e.pattern === 'GRADIENT') paths.push(`<path d="${d}" fill="${color}" fill-rule="evenodd" stroke="none"/>`);
      else for (const s of hatchSegments(e.boundaries, e.pattern, e.scale, e.angle)) paths.push(`<path d="${pathOf(s)}" stroke="${color}" stroke-width="${lw * 0.5}" fill="none"/>`);
      continue;
    }
    if (e.type === 'DIMENSION') {
      const g = dimensionGeometry(e, app.sysvars.DIMASZ);
      const h = e.textHeight ?? app.sysvars.DIMTXT;
      const lab = dimensionLabel(e, h, app.sysvars.DIMASZ, app.sysvars.DIMDEC);
      [...g.lines, ...lab.lines].forEach((l) => (l.forEach(grow), paths.push(`<path d="${pathOf(l)}" stroke="${color}" stroke-width="${lw}" fill="none"/>`)));
      for (const f of g.fills) paths.push(`<path d="${pathOf([...f, f[0]!])}" fill="${color}" stroke="none"/>`);
      for (const { at: t, text, height } of lab.texts)
        paths.push(`<text x="${fmt(t.x)}" y="${fmt(-t.y)}" font-size="${fmt(height * 1.4)}" font-family="Arial" fill="${color}" text-anchor="middle" transform="rotate(${fmt((-lab.angle * 180) / Math.PI)} ${fmt(t.x)} ${fmt(-t.y)})">${esc(text)}</text>`);
      continue;
    }
    for (const pl of curvePoints(e)) {
      pl.forEach(grow);
      paths.push(`<path d="${pathOf(pl)}" stroke="${color}" stroke-width="${lw}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  if (!Number.isFinite(minX)) minX = minY = 0, maxX = maxY = 100;
  const m = Math.max(maxX - minX, maxY - minY) * 0.03 + 1;
  const w = maxX - minX + 2 * m, h = maxY - minY + 2 * m;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, 2)}mm" height="${fmt(h, 2)}mm" viewBox="${fmt(minX - m)} ${fmt(-maxY - m)} ${fmt(w)} ${fmt(h)}">
<rect x="${fmt(minX - m)}" y="${fmt(-maxY - m)}" width="${fmt(w)}" height="${fmt(h)}" fill="#ffffff"/>
<g stroke-linecap="round">${paths.join('\n').replace(/#ffffff|#e6e9ee/gi, '#000000')}</g>
</svg>`;
}

const exportSvg = cmd('EXPORTSVG', 'EXPORTSVG', ['SVGOUT'], 'Exporte la vue de dessus en SVG (impression, découpe laser)', async (ctx, app) => {
  const es = exportSet(app, () => true);
  if (!es.length) return ctx.print('Rien à exporter.');
  const t = await saveFile(svgOf(app, es), { name: `${baseName(app.doc.fileName)}.svg`, mime: 'image/svg+xml', description: 'Image SVG', extensions: ['.svg'] });
  if (t) ctx.print(`${es.length} objet(s) exporté(s) dans ${t.name} (échelle 1:1 en mm).`);
});

const pngOut = cmd('PNGOUT', 'CAPTURE', ['PNG', 'PNGOUT'], 'Enregistre une image PNG du viewport', async (ctx, app) => {
  const blob = await app.viewport?.screenshot();
  if (!blob) return ctx.print('Capture impossible.');
  const t = await saveFile(blob, { name: `${baseName(app.doc.fileName)}.png`, mime: 'image/png', description: 'Image PNG', extensions: ['.png'] });
  if (t) ctx.print(`Image enregistrée : ${t.name}`);
});

const saveTime = cmd('SAVETIME', 'TEMPSSAUV', ['SAUVAUTO'], 'Sauvegarde automatique : intervalle en minutes (0 = désactivée)', async (ctx, app) => {
  const cur = app.settings.autosaveMinutes;
  ctx.print(`Sauvegarde automatique : ${cur ? `toutes les ${cur} min` : 'désactivée'}. Une copie de secours du dessin non enregistré est proposée au démarrage suivant.`);
  const r = await getNumber(ctx, 'Intervalle en minutes (0 = désactivée)', { integer: true, allowZero: true, defaultValue: cur, keywords: [kw('Now', 'Maintenant', 'M', 'Copie de secours immédiate')] });
  if (r === 'Now') {
    const ok = await app.autosave?.saveNow(true);
    ctx.print(ok ? 'Copie de secours enregistrée.' : 'Rien à sauvegarder.');
    return;
  }
  const v = Math.max(0, Math.min(120, Math.round(r as number)));
  app.set('autosaveMinutes', v);
  ctx.print(v ? `Sauvegarde automatique toutes les ${v} min.` : 'Sauvegarde automatique désactivée.');
});

const recover = cmd('DRAWINGRECOVERY', 'RECUPDESSIN', ['RECUPERER', 'RECOVER'], 'Récupère les copies de secours (sauvegarde automatique), chacune dans un onglet', async (ctx, app) => {
  const records = await readAutosaves();
  if (!records.length) return ctx.print('Aucune copie de secours : les derniers dessins ont été enregistrés.');
  for (const r of records) await recoverRecord(app, r, (m) => ctx.print(m));
});

/** Ouvre une copie de secours dans un onglet (le dessin vierge du démarrage est réutilisé). */
export async function recoverRecord(app: AppHost, r: AutosaveRecord & { key: string }, print: (m: string) => void): Promise<void> {
  if (!app.isBlank()) app.newTab(r.name);
  await loadProject(app, r.data, r.name, print);
  app.fileHandle = null;
  app.doc.dirty = true;
  app.autosave?.markRecovered(app.tab, r.key);
  app.emit('doc');
  app.emit('tabs');
  app.viewport?.zoomExtents();
  print(`Dessin « ${r.name} » récupéré (copie du ${new Date(r.time).toLocaleString('fr-FR')}) : enregistrez-le.`);
}

export const fileCommands: CommandDefinition[] = [saveTime, recover, newDoc, open, closeCmd, closeAll, saveAll, saveCmd, saveAs, importCmd, exportDxf, exportStep, exportStl, export3mf, printability, exportSvg, pngOut];
