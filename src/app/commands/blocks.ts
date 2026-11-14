/**
 * Blocs et composants : BLOC regroupe des objets 2D sous un nom (point de base) ; INSERER pose des
 * copies liées : redéfinir le bloc (BLOC du même nom, ou MODIFBLOC puis FERMERBLOC) met à jour
 * toutes ses copies. MESCOMPOSANTS garde des blocs dans une bibliothèque personnelle, réutilisable
 * d'un dessin à l'autre. DECOMPOS rend une copie indépendante.
 */
import type { CommandContext, Vec3 } from '../../core/commands';
import type { Entity, NewEntity, UnderlayDef } from '../../core/document/Document';
import { curvePoints, transformEntity, underlayMatrix } from '../../core/entities/geometry';
import { boundsOf, underlayEntities } from '../../core/entities/underlay';
import { translation } from '../../core/math/affine';
import type { AppHost } from '../AppHost';
import { cmd, DEG, getAngle, getNumber, getPoint, getString, selectObjects } from './helpers';

type Insert = Extract<Entity, { type: 'UNDERLAY' }>;

/** Bibliothèque « Mes composants » (stockage local de l'application). */
const LIB_KEY = 'xylform.components';

export interface StoredComponent {
  name: string;
  entities: NewEntity[];
  layers: { name: string; color: string; visible: boolean }[];
  savedAt: number;
}

export function readLibrary(): StoredComponent[] {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    return raw ? (JSON.parse(raw) as StoredComponent[]) : [];
  } catch {
    return [];
  }
}

function writeLibrary(list: StoredComponent[]): boolean {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const blockable = (e: Entity) => e.type !== '3DSOLID' && e.type !== 'UNDERLAY' && !(e.type === 'LINE' && e.guide);

export const blockDefs = (app: AppHost) => Object.values(app.doc.underlays).filter((d) => d.kind === 'block');
const blockByName = (app: AppHost, name: string) => blockDefs(app).find((d) => d.name.toLowerCase() === name.trim().toLowerCase());

function newBlockId(app: AppHost): string {
  let i = 1;
  while (app.doc.underlays[`B${i}`]) i++;
  return `B${i}`;
}

/** Définition (création ou remplacement) d'un bloc à partir d'entités déjà ramenées au point de base. */
export function defineBlock(app: AppHost, name: string, entities: NewEntity[]): UnderlayDef {
  const old = blockByName(app, name);
  const used = new Set(entities.map((e) => e.layer ?? '0'));
  const layers = app.doc.layers.filter((l) => used.has(l.name)).map((l) => ({ name: l.name, color: l.color, visible: true }));
  const def: UnderlayDef = {
    id: old?.id ?? newBlockId(app),
    name: old?.name ?? name.trim(),
    kind: 'block',
    fileName: '',
    loaded: true,
    fade: 0,
    monochrome: false,
    entities,
    layers,
    bounds: boundsOf(entities),
    loadedAt: Date.now(),
  };
  app.doc.setUnderlayDef(def, old ? 'Redéfinir le bloc' : 'Bloc');
  return def;
}

const localOf = (app: AppHost, hs: string[], base: Vec3): NewEntity[] =>
  hs.map((h) => app.doc.get(h)!).filter((e) => !!e && blockable(e)).map((e) => {
    const { handle: _h, ...rest } = e as Entity;
    return { ...rest, ...transformEntity(e, translation({ x: -base.x, y: -base.y, z: -base.z })) } as NewEntity;
  });

function insertBlock(app: AppHost, def: UnderlayDef, position: Vec3, scale = 1, rotation = 0, layer?: string): string {
  return app.addEntity({ type: 'UNDERLAY', ref: def.id, position, scale, rotation, bounds: def.bounds, ...(layer ? { layer } : {}) } as NewEntity);
}

const preview = (def: UnderlayDef, scale = 1, rotation = 0) => (p: Vec3) =>
  underlayEntities({ type: 'UNDERLAY', handle: '', layer: '', ref: def.id, position: p, scale, rotation, bounds: def.bounds }, def).flatMap((e) => {
    try {
      return curvePoints(e);
    } catch {
      return [];
    }
  });

const block = cmd('BLOCK', 'BLOC', ['B', 'CREERBLOC', 'COMPOSANT'], 'Bloc / composant : regroupe des objets 2D sous un nom ; ses copies (INSERER) restent liées à la définition', async (ctx, app) => {
  const name = (await getString(ctx, 'Nom du bloc (un nom existant le redéfinit : toutes ses copies suivent)'))?.trim();
  if (!name) return;
  const base = await getPoint(ctx, 'Point de base (point d’insertion des copies)');
  const hs = (await selectObjects(ctx, 'Choisissez les objets du bloc', blockable)).filter((h) => blockable(app.doc.get(h)!));
  if (!hs.length) return ctx.print('Aucun objet 2D choisi (les solides 3D ne vont pas dans un bloc).');
  const redefine = !!blockByName(app, name);
  app.doc.transaction(redefine ? 'Redéfinir le bloc' : 'Bloc', () => {
    const layer = app.doc.get(hs[0]!)!.layer;
    const def = defineBlock(app, name, localOf(app, hs, base));
    hs.forEach((h) => app.doc.removeEntity(h));
    if (!redefine) insertBlock(app, def, base, 1, 0, layer);
  });
  const n = app.doc.underlayInstances(blockByName(app, name)!.id).length;
  ctx.print(redefine ? `Bloc « ${name} » redéfini : ${n} copie(s) mise(s) à jour.` : `Bloc « ${name} » créé (${hs.length} objet(s)). INSERER pour poser des copies liées.`);
});

async function chooseBlock(ctx: CommandContext, app: AppHost, message: string): Promise<UnderlayDef | null> {
  const defs = blockDefs(app);
  if (!defs.length) {
    ctx.print('Aucun bloc dans ce dessin (BLOC, ou MESCOMPOSANTS pour en prendre un dans la bibliothèque).');
    return null;
  }
  if (app.ui.form && defs.length > 1) {
    const v = await app.ui.form({ title: message, fields: [{ key: 'b', label: 'Bloc', type: 'select', value: defs[0]!.id, options: defs.map((d) => ({ value: d.id, label: `${d.name} (${app.doc.underlayInstances(d.id).length} copie(s))` })) }], ok: 'Choisir' });
    return v ? (app.doc.underlays[String(v.b)] ?? null) : null;
  }
  if (defs.length === 1) return defs[0]!;
  const n = await getString(ctx, `${message} (${defs.map((d) => d.name).join(', ')})`, defs[0]!.name);
  return n ? (blockByName(app, n) ?? null) : null;
}

const insert = cmd('INSERT', 'INSERER', ['I', 'INSERERBLOC'], 'Pose une copie liée d’un bloc : point, échelle, rotation', async (ctx, app) => {
  const def = await chooseBlock(ctx, app, 'Bloc à insérer');
  if (!def) return;
  for (;;) {
    const r = await getPoint(ctx, `Point d’insertion de « ${def.name} »`, { noRubberBand: true, preview: preview(def) });
    const s = await getNumber(ctx, 'Échelle', { defaultValue: 1, allowZero: false });
    const scale = typeof s === 'number' && s > 0 ? s : 1;
    const a = await getAngle(ctx, 'Rotation (°)', { basePoint: r, defaultValue: 0 });
    insertBlock(app, def, r, scale, typeof a === 'number' ? a : 0);
    ctx.print(`Copie de « ${def.name} » posée (échelle ${scale}${typeof a === 'number' && a ? `, ${+(a / DEG).toFixed(2)}°` : ''}). Échap pour terminer.`);
  }
});

/** Édition d'un bloc sur place : ses objets sont posés dans le dessin, FERMERBLOC redéfinit le bloc. */
let editing: { def: string; instance: string; handles: string[] } | null = null;

const editBlock = cmd('BEDIT', 'MODIFBLOC', ['BE', 'EDITERBLOC'], 'Modifie un bloc sur place (toutes ses copies suivront à FERMERBLOC)', async (ctx, app) => {
  if (editing) return ctx.print('Un bloc est déjà en cours de modification : FERMERBLOC pour l’enregistrer.');
  const hs = await selectObjects(ctx, 'Choisissez une copie du bloc', (e) => e.type === 'UNDERLAY' && app.doc.underlays[e.ref]?.kind === 'block');
  const inst = hs.map((h) => app.doc.get(h)).find((e): e is Insert => e?.type === 'UNDERLAY');
  const def = inst && app.doc.underlays[inst.ref];
  if (!inst || !def) return;
  let handles: string[] = [];
  app.doc.transaction('Modifier le bloc', () => {
    handles = underlayEntities(inst, def).map((e) => {
      const { handle: _h, ...rest } = e;
      return app.doc.addEntity(rest as NewEntity);
    });
    app.doc.replaceEntity(inst.handle, { hidden: true });
  });
  editing = { def: def.id, instance: inst.handle, handles };
  ctx.print(`Modification de « ${def.name} » : modifiez, ajoutez ou effacez des objets, puis FERMERBLOC.`);
});

const closeBlock = cmd('BCLOSE', 'FERMERBLOC', ['BC', 'FINBLOC'], 'Termine MODIFBLOC : le bloc est redéfini et toutes ses copies suivent', async (ctx, app) => {
  if (!editing) return ctx.print('Aucun bloc en cours de modification (MODIFBLOC).');
  const ed = editing;
  const inst = app.doc.get(ed.instance) as Insert | undefined;
  const def = app.doc.underlays[ed.def];
  if (!inst || !def) {
    editing = null;
    return ctx.print('La copie modifiée a disparu : modification abandonnée.');
  }
  const pre = ed.handles.filter((h) => app.doc.get(h));
  app.selection.set(pre);
  const hs = await selectObjects(ctx, 'Objets du bloc (la sélection propose ceux de départ ; ajoutez les nouveaux)', blockable);
  editing = null;
  // repère du bloc : inverse du placement de la copie modifiée
  const inv = invertAffine(underlayMatrix(inst));
  app.doc.transaction('Redéfinir le bloc', () => {
    const ents = hs.map((h) => app.doc.get(h)!).filter((e) => !!e && blockable(e)).map((e) => {
      const { handle: _h, ...rest } = e;
      return { ...rest, ...transformEntity(e, inv) } as NewEntity;
    });
    defineBlock(app, def.name, ents);
    hs.forEach((h) => app.doc.removeEntity(h));
    ed.handles.forEach((h) => app.doc.get(h) && app.doc.removeEntity(h));
    app.doc.replaceEntity(inst.handle, { hidden: undefined });
  });
  ctx.print(`Bloc « ${def.name} » redéfini : ${app.doc.underlayInstances(def.id).length} copie(s) à jour.`);
});

const library = cmd('MYCOMPONENTS', 'MESCOMPOSANTS', ['MCO', 'BIBLIOBLOCS', 'COMPOSANTS'], 'Mes composants : bibliothèque personnelle de blocs (ajouter un bloc du dessin, insérer, supprimer)', async (ctx, app) => {
  const lib = readLibrary();
  const defs = blockDefs(app);
  const v = await app.ui.form({
    title: 'Mes composants',
    intro: `${lib.length} composant(s) dans la bibliothèque, ${defs.length} bloc(s) dans ce dessin. La bibliothèque est gardée sur cet ordinateur et servira dans tous vos dessins.`,
    fields: [
      {
        key: 'action',
        label: 'Action',
        type: 'select',
        value: lib.length ? 'insert' : 'add',
        options: [
          { value: 'insert', label: 'Insérer un composant de la bibliothèque' },
          { value: 'add', label: 'Ajouter un bloc du dessin à la bibliothèque' },
          { value: 'delete', label: 'Retirer un composant de la bibliothèque' },
        ],
      },
      { key: 'lib', label: 'Composant (bibliothèque)', type: 'select', value: lib[0]?.name ?? '', options: lib.map((c) => ({ value: c.name, label: c.name })) },
      { key: 'block', label: 'Bloc du dessin (ajout)', type: 'select', value: defs[0]?.id ?? '', options: defs.map((d) => ({ value: d.id, label: d.name })) },
    ],
    ok: 'Valider',
  });
  if (!v) return;
  if (v.action === 'add') {
    const def = app.doc.underlays[String(v.block)];
    if (!def?.entities) return ctx.print('Choisissez un bloc du dessin (BLOC pour en créer un).');
    const next = [...lib.filter((c) => c.name.toLowerCase() !== def.name.toLowerCase()), { name: def.name, entities: def.entities, layers: def.layers ?? [], savedAt: Date.now() }];
    return ctx.print(writeLibrary(next) ? `« ${def.name} » ajouté à Mes composants.` : 'Bibliothèque pleine ou indisponible.');
  }
  const c = lib.find((x) => x.name === v.lib);
  if (!c) return ctx.print('La bibliothèque est vide : ajoutez d’abord un bloc.');
  if (v.action === 'delete') {
    writeLibrary(lib.filter((x) => x !== c));
    return ctx.print(`« ${c.name} » retiré de Mes composants.`);
  }
  for (const l of c.layers) if (!app.doc.layer(l.name)) app.doc.addLayer(l.name, l.color);
  const def = blockByName(app, c.name) ?? defineBlock(app, c.name, c.entities);
  const p = await getPoint(ctx, `Point d’insertion de « ${c.name} »`, { noRubberBand: true, preview: preview(def) });
  insertBlock(app, def, p);
  ctx.print(`« ${c.name} » inséré (INSERER pour d’autres copies).`);
});

/** Inverse d'une transformation affine (3 × 4, lignes). */
function invertAffine(m: number[]): [number, number, number, number, number, number, number, number, number, number, number, number] {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m as [number, number, number, number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det) as number[];
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = r as [number, number, number, number, number, number, number, number, number];
  return [r0, r1, r2, -(r0 * tx + r1 * ty + r2 * tz), r3, r4, r5, -(r3 * tx + r4 * ty + r5 * tz), r6, r7, r8, -(r6 * tx + r7 * ty + r8 * tz)];
}

export const blockCommands = [block, insert, editBlock, closeBlock, library];
