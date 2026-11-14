/**
 * Format natif `.xcad` (anciennement `.sebcad`, toujours lu) : archive ZIP contenant `document.json` (entités, calques, contraintes,
 * paramètres, variables) et un fichier B-rep binaire OpenCascade par solide (`solids/<handle>.brep`).
 * Les maillages d'affichage ne sont pas stockés : ils sont recalculés à l'ouverture.
 * Les fonds de plan sont embarqués (`underlays/<id>.json` ou image) : le dessin reste lisible
 * même si le fichier source a été déplacé.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Entity, DrawingSheet, Joint, NamedView, LayerDef, UnderlayDef } from '../core/document/Document';
import type { Constraint } from '../core/constraints/types';
import type { AppHost } from '../app/AppHost';
import type { DisplayMesh, SolidResult } from '../kernel/protocol';
import { hasRealThread } from '../app/history';

interface ProjectJson {
  format: 'xcad' | 'sebcad' | 'novacad';
  version: 1;
  /** Filetages réels en aperçu cosmétique possible (SebCad ≥ 1.10, Xylform CAD). */
  threadPreview?: boolean;
  fileName: string;
  entities: (Entity | (Omit<Extract<Entity, { type: '3DSOLID' }>, 'display' | 'shapeId'> & { brep: string }))[];
  layers: LayerDef[];
  currentLayer: string;
  constraints: Constraint[];
  layerStates: Record<string, LayerDef[]>;
  parameters: Record<string, string>;
  sysvars: Record<string, unknown>;
  underlays?: StoredUnderlay[];
  joints?: Joint[];
  sheets?: DrawingSheet[];
  namedViews?: NamedView[];
}

type StoredUnderlay = Omit<UnderlayDef, 'entities' | 'layers' | 'image'> & {
  /** Contenu vectoriel (entités + calques) ou image. */
  content?: string;
  image?: Omit<NonNullable<UnderlayDef['image']>, 'data'>;
};

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/** `doc` : dessin à écrire (par défaut le dessin actif ; la sauvegarde automatique écrit aussi les autres onglets). */
export async function saveProject(app: AppHost, doc: AppHost['doc'] = app.doc): Promise<Uint8Array> {
  const files: Zippable = {};
  const entities: ProjectJson['entities'] = [];
  for (const e of doc.all()) {
    if (e.type === '3DSOLID') {
      await app.ensureKernel();
      // copie de secours déjà prête (tâche de fond), sinon demandée au noyau
      const data = app.brepCache?.get(e.shapeId) ?? (await app.kernel.call<Uint8Array>({ op: 'saveBrep', shapeId: e.shapeId }));
      const path = `solids/${e.handle}.brep`;
      files[path] = data;
      const { display: _d, shapeId: _s, ...rest } = e;
      entities.push({ ...rest, brep: path });
    } else entities.push(e);
  }
  const json: ProjectJson = {
    format: 'xcad',
    version: 1,
    threadPreview: true,
    fileName: doc.fileName,
    entities,
    layers: doc.layers,
    currentLayer: doc.currentLayer,
    constraints: doc.constraints,
    layerStates: doc.layerStates,
    parameters: doc.parameters,
    sysvars: { ...doc.sysvars },
    ...(doc.joints.length ? { joints: doc.joints } : {}),
    ...(doc.sheets.length ? { sheets: doc.sheets } : {}),
    ...(doc.namedViews.length ? { namedViews: doc.namedViews } : {}),
  };
  const underlays = Object.values(doc.underlays);
  if (underlays.length) {
    json.underlays = underlays.map((u) => {
      const { entities: ents, layers, image, ...meta } = u;
      const out: StoredUnderlay = { ...meta };
      if (image) {
        const { data, ...rest } = image;
        out.content = `underlays/${u.id}.${IMAGE_EXT[image.mime] ?? 'bin'}`;
        out.image = rest;
        files[out.content] = [data, { level: 0 }]; // déjà compressée
      } else if (ents) {
        out.content = `underlays/${u.id}.json`;
        files[out.content] = strToU8(JSON.stringify({ entities: ents, layers: layers ?? [] }));
      }
      return out;
    });
  }
  files['document.json'] = strToU8(JSON.stringify(json));
  return zipSync(files, { level: 6 });
}

export async function loadProject(app: AppHost, data: Uint8Array, fileName: string, log: (m: string) => void = () => undefined): Promise<void> {
  const files = unzipSync(data);
  const raw = files['document.json'];
  if (!raw) throw new Error('Fichier de dessin invalide (document.json absent).');
  const json = JSON.parse(strFromU8(raw)) as ProjectJson;
  if (!['xcad', 'sebcad', 'novacad'].includes(json.format)) throw new Error('Ce fichier n’est pas un dessin Xylform CAD.');
  const entities: Entity[] = [];
  const solids = json.entities.filter((e) => 'brep' in e);
  if (solids.length) {
    log(`Chargement de ${solids.length} solide(s)…`);
    await app.ensureKernel();
  }
  for (const e of json.entities) {
    if ('brep' in e) {
      const bin = files[e.brep];
      if (!bin) {
        log(`Solide ${e.handle} : données B-rep absentes, ignoré.`);
        continue;
      }
      const r = await app.kernel.call<SolidResult>({ op: 'loadBrep', data: bin });
      app.brepCache?.set(r.shapeId, bin);
      const { brep: _b, ...rest } = e;
      // dessins antérieurs à la 1.10 : les filetages réels étaient toujours construits exacts
      const old = !json.threadPreview && hasRealThread(rest.history) ? { threadsReal: true } : {};
      entities.push({ ...rest, ...old, type: '3DSOLID', shapeId: r.shapeId, display: r.display as DisplayMesh });
    } else entities.push(e as Entity);
  }
  const underlays: Record<string, UnderlayDef> = {};
  for (const u of json.underlays ?? []) {
    const { content, image, ...meta } = u;
    const def: UnderlayDef = { ...meta };
    const bin = content ? files[content] : undefined;
    if (image && bin) def.image = { ...image, data: bin };
    else if (bin) Object.assign(def, JSON.parse(strFromU8(bin)) as Pick<UnderlayDef, 'entities' | 'layers'>);
    else {
      log(`Fond de plan « ${u.name} » : contenu absent, à recharger.`);
      def.loaded = false;
    }
    underlays[def.id] = def;
  }
  Object.assign(app.doc.sysvars, json.sysvars ?? {});
  app.doc.load({
    entities,
    layers: json.layers,
    constraints: json.constraints ?? [],
    currentLayer: json.currentLayer,
    fileName,
    layerStates: json.layerStates,
    parameters: json.parameters,
    underlays,
    joints: json.joints,
    sheets: json.sheets,
    namedViews: json.namedViews,
  });
}
