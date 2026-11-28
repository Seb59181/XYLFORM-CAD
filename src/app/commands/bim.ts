/**
 * BIM : échange avec les logiciels du bâtiment par le format ouvert IFC.
 *   EXPORTIFC : solides → éléments IFC (mur, dalle, poteau…) avec calque, matériau, couleur,
 *               dimensions et quantités ; boîtes écrites en extrusions modifiables.
 *   IMPORTIFC : maquette IFC → corps maillés (un par élément), rangés par classe dans des calques.
 *   CLASSEIFC : choisit la classe IFC des solides (sinon classement automatique à l'export).
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, LayerDef, NewEntity } from '../../core/document/Document';
import { classFromType, classify, IFC_CLASSES, ifcLabel, isIfcGuid, layerForClass, type IfcClass } from '../../core/bim';
import { materialById } from '../../core/materials';
import { cleanMesh } from '../../core/mesh/MeshCleaner';
import { libraryTexture } from '../../core/textureLibrary';
import { MM_PER_UNIT, type LengthUnit } from '../../io/exporters/PrintPreparation';
import { baseName, saveFile } from '../../io/fileAccess';
import { renderMaterialFor } from '../../io/ifc/IfcReader';
import { isClosed, writeIfc, type IfcBox, type IfcElementInput, type IfcSchema } from '../../io/ifc/IfcWriter';
import type { SolidResult } from '../../kernel/protocol';
import type { AppHost } from '../AppHost';
import { drawingUnit } from '../printCheck';
import { cmd, exportSet, fmt, getKeyword, isBody, kw, selectObjects } from './helpers';

type Solid = Extract<Entity, { type: '3DSOLID' }>;

/** Réglages de l'export, repris d'une fois sur l'autre. */
const ifcSettings = { schema: 'IFC4' as IfcSchema, building: 'Bâtiment', storey: 'Rez-de-chaussée', auto: true, boxes: true, deflection: 1 };

const unitOf = (app: AppHost): LengthUnit => drawingUnit(app.sysvars.INSUNITS) as LengthUnit;

/** Nom du matériau d'un solide : matière de la bibliothèque, image plaquée, ou matériau de rendu. */
export function materialName(app: AppHost, s: Solid): string | undefined {
  if (s.texture) {
    const def = app.doc.textures[s.texture.ref];
    const lib = libraryTexture(def?.library);
    if (lib) return lib.label;
    if (def?.name) return baseName(def.name);
  }
  return materialById(s.material)?.label ?? s.bim?.material;
}

const apply = (m: number[] | undefined, p: Vec3): Vec3 =>
  m ? { x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!, y: m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]!, z: m[8]! * p.x + m[9]! * p.y + m[10]! * p.z + m[11]! } : p;
const rot = (m: number[] | undefined, v: Vec3): Vec3 => (m ? { x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z, y: m[4]! * v.x + m[5]! * v.y + m[6]! * v.z, z: m[8]! * v.x + m[9]! * v.y + m[10]! * v.z } : v);

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const unit = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
/** Un vecteur unitaire perpendiculaire à `z`. */
const perp = (z: Vec3): Vec3 => unit(Math.abs(z.z) < 0.9 ? { x: -z.y, y: z.x, z: 0 } : { x: 1, y: 0, z: 0 });

/**
 * Extrusion (en mm) d'un solide resté une simple boîte ou un simple cylindre (primitive sans
 * autre étape, éventuellement déplacée ou tournée, volume cohérent) ; null sinon.
 */
export function boxOf(s: Solid, k: number): IfcBox | null {
  const op = s.primitive?.op;
  if (!op) return null;
  const m = s.primitive!.matrix as number[] | undefined;
  if (op.op === 'box') {
    const lo = { x: Math.min(op.corner.x, op.corner.x + op.size.x), y: Math.min(op.corner.y, op.corner.y + op.size.y), z: Math.min(op.corner.z, op.corner.z + op.size.z) };
    const L = { x: Math.abs(op.size.x), y: Math.abs(op.size.y), z: Math.abs(op.size.z) };
    const vol = L.x * L.y * L.z;
    if (!(vol > 0) || Math.abs(s.display.volume - vol) > 1e-3 * vol) return null;
    const X = rot(m, { x: 1, y: 0, z: 0 }), Y = rot(m, { x: 0, y: 1, z: 0 }), Z = rot(m, { x: 0, y: 0, z: 1 });
    // symétrie (repère indirect) : on part du coin opposé en Y, axe Y retourné
    const det = X.x * (Y.y * Z.z - Y.z * Z.y) - X.y * (Y.x * Z.z - Y.z * Z.x) + X.z * (Y.x * Z.y - Y.y * Z.x);
    const o = apply(m, det < 0 ? { ...lo, y: lo.y + L.y } : lo);
    return { origin: { x: o.x * k, y: o.y * k, z: o.z * k }, xAxis: unit(X), zAxis: unit(Z), size: { x: L.x * k, y: L.y * k, z: L.z * k } };
  }
  if (op.op === 'cylinder') {
    const h = op.height, r = op.radius;
    const vol = Math.PI * r * r * Math.abs(h);
    // le maillage du cylindre sous-estime un peu son volume : tolérance de 2 %
    if (!(vol > 0) || Math.abs(s.display.volume - vol) > 0.02 * vol) return null;
    const ax = unit(op.axis ?? { x: 0, y: 0, z: 1 });
    // base et sommet dans le dessin ; une hauteur négative part vers le bas
    const a = apply(m, op.center);
    const b = apply(m, { x: op.center.x + ax.x * h, y: op.center.y + ax.y * h, z: op.center.z + ax.z * h });
    const d = sub(b, a);
    const lo = h >= 0 ? a : b;
    const Z = unit(h >= 0 ? d : sub(a, b));
    return { origin: { x: lo.x * k, y: lo.y * k, z: lo.z * k }, xAxis: perp(Z), zAxis: Z, size: { x: 2 * r * k, y: 2 * r * k, z: len(d) * k }, radius: r * k };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportIfc = cmd('EXPORTIFC', 'EXPORTIFC', ['IFCOUT', 'EIFC', 'EXPORTBIM'], 'Exporte les solides en IFC pour les logiciels BIM (murs, dalles, poteaux… avec calques, matériaux et dimensions)', async (ctx, app) => {
  const es = exportSet(app, isBody) as Solid[];
  if (!es.length) return ctx.print('Aucun solide à exporter en IFC.');
  const unit = unitOf(app);
  const k = MM_PER_UNIT[unit];
  const v = await app.ui.form({
    title: 'Exporter en IFC (BIM)',
    intro: `${es.length} solide(s). Chaque solide devient un élément de la maquette (mur, dalle, poteau…) avec son calque, son matériau, sa couleur et ses dimensions, rangé dans un niveau du bâtiment. Choisissez la classe d’un solide avec CLASSEIFC ou dans la palette Propriétés.`,
    fields: [
      {
        key: 'schema',
        label: 'Version IFC',
        type: 'select',
        value: ifcSettings.schema,
        options: [
          { value: 'IFC4', label: 'IFC4 (recommandé)' },
          { value: 'IFC2X3', label: 'IFC2X3 (logiciels plus anciens)' },
        ],
      },
      { key: 'project', label: 'Projet', type: 'text', value: baseName(app.doc.fileName) },
      { key: 'building', label: 'Bâtiment', type: 'text', value: ifcSettings.building },
      { key: 'storey', label: 'Niveau', type: 'text', value: ifcSettings.storey },
      { key: 'auto', label: 'Classer automatiquement (nom, calque, forme)', type: 'checkbox', value: ifcSettings.auto, hint: 'Sinon, les solides sans classe sont des éléments génériques' },
      { key: 'boxes', label: 'Boîtes et cylindres en extrusions modifiables', type: 'checkbox', value: ifcSettings.boxes, hint: 'Les boîtes (murs, dalles) et cylindres (poteaux) restent des volumes extrudés que le logiciel BIM sait modifier' },
      { key: 'deflection', label: `Précision des courbes (${unit})`, type: 'number', value: ifcSettings.deflection / k, min: 0.001, step: 0.1, hint: 'Écart maximal des facettes (les autres solides sont écrits en facettes)' },
    ],
    ok: 'Exporter',
  });
  if (!v) return ctx.print('Export annulé.');
  ifcSettings.schema = v.schema === 'IFC2X3' ? 'IFC2X3' : 'IFC4';
  ifcSettings.building = String(v.building || 'Bâtiment');
  ifcSettings.storey = String(v.storey || 'Rez-de-chaussée');
  ifcSettings.auto = !!v.auto;
  ifcSettings.boxes = !!v.boxes;
  const defl = Math.max(0.001, Number(v.deflection) || 1);
  ifcSettings.deflection = defl * k;

  const end = app.ui.busy('Export IFC…');
  let ok = false;
  try {
    await app.ensureKernel(ctx);
    const boxes = es.map((s) => (ifcSettings.boxes ? boxOf(s, k) : null));
    const meshed = es.filter((_, i) => !boxes[i]);
    const exact = await app.exactShapes(meshed, ctx);
    let meshes;
    try {
      if (meshed.length) ctx.print(`Facettes : précision ${fmt(defl, 3)} ${unit} (${meshed.length} solide(s))…`);
      meshes = meshed.length ? await app.kernel.exportMesh(exact.ids, defl, 15) : [];
    } finally {
      exact.release();
    }
    const counts = new Map<IfcClass, number>();
    let mi = 0;
    const elements: IfcElementInput[] = es.map((s, i) => {
      const b = s.display.bbox;
      const dx = (b.max.x - b.min.x) * k, dy = (b.max.y - b.min.y) * k, dz = (b.max.z - b.min.z) * k;
      const box = boxes[i];
      // dimensions propres d'une boîte tournée autour de la verticale, sinon hors tout
      const size = box && Math.abs(box.zAxis.z) > 0.999 ? { a: box.size.x, b: box.size.y, h: box.size.z } : { a: dx, b: dy, h: dz };
      const fill = box ? 1 : s.display.solidCount && dx * dy * dz > 0 ? (s.display.volume * k ** 3) / (dx * dy * dz) : 0;
      const cls = s.bim?.cls ?? (ifcSettings.auto ? classify({ name: s.name, layer: s.layer, size, fill }) : 'IfcBuildingElementProxy');
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      let mesh;
      if (!box) {
        const raw = meshes[mi++]!;
        const scaled = new Float64Array(raw.positions.length);
        for (let j = 0; j < scaled.length; j++) scaled[j] = raw.positions[j]! * k;
        mesh = cleanMesh({ positions: scaled, indices: raw.indices }).mesh;
      }
      const mat = materialById(s.material);
      const L = Math.max(size.a, size.b), W = Math.min(size.a, size.b);
      return {
        name: s.name || `Solide ${s.handle}`,
        cls,
        guid: isIfcGuid(s.bim?.guid) ? s.bim!.guid : undefined,
        layer: s.layer,
        color: app.doc.colorOf(s),
        opacity: mat?.opacity,
        material: materialName(app, s),
        box: box ?? undefined,
        mesh,
        volume: s.display.solidCount ? s.display.volume * k ** 3 : undefined,
        area: s.display.area * k * k,
        size: cls === 'IfcDoor' || cls === 'IfcWindow' ? { length: L, width: L, height: size.h } : { length: L, width: W, height: size.h },
      };
    });
    const open = elements.filter((e) => e.mesh && !isClosed(e.mesh)).length;
    const text = writeIfc({
      schema: ifcSettings.schema,
      fileName: `${baseName(app.doc.fileName)}.ifc`,
      project: String(v.project || baseName(app.doc.fileName)),
      site: 'Terrain',
      building: ifcSettings.building,
      storey: ifcSettings.storey,
      application: 'Xylform CAD',
      version: import.meta.env?.VITE_APP_VERSION ?? '',
      elements,
    });
    const t = await saveFile(text, { name: `${baseName(app.doc.fileName)}.ifc`, mime: 'application/x-step', description: 'Maquette IFC (BIM)', extensions: ['.ifc'] });
    if (!t) {
      end('cancel');
      return ctx.print('Export annulé.');
    }
    const summary = [...counts].map(([c, n]) => `${n} ${ifcLabel(c).toLowerCase()}${n > 1 && !ifcLabel(c).endsWith('s') ? 's' : ''}`).join(', ');
    ctx.print(`${t.name} (${ifcSettings.schema}) : ${summary} ; ${fmt(text.length / 1024, 1)} Ko.`);
    if (open) ctx.print(`${open} surface(s) ouverte(s) écrite(s) sans volume (EPAISSIR pour en faire des solides).`);
    end('ok', `Export IFC : ${es.length} élément(s)`);
    ok = true;
  } finally {
    if (!ok) end('error');
  }
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Lit un fichier IFC : un corps maillé par élément, rangé dans un calque par classe. */
export async function readIfcEntities(app: AppHost, ctx: CommandContext, name: string, bytes: Uint8Array): Promise<{ entities: NewEntity[]; layers: LayerDef[] }> {
  const end = app.ui.busy(`Lecture de ${name}…`);
  let ok = false;
  try {
    ctx.print(`Lecture IFC de ${name}…`);
    const [{ ifcApi }, { readIfc }] = await Promise.all([import('../../io/ifc/ifcWasm'), import('../../io/ifc/IfcReader')]);
    const api = await ifcApi();
    let r;
    try {
      r = readIfc(api, bytes);
    } finally {
      api.Dispose();
    }
    ctx.print(`${r.schema}${r.project ? ` « ${r.project} »` : ''} : ${r.elements.length} élément(s) avec géométrie${r.skipped ? `, ${r.skipped} ignoré(s) (pièces, réservations)` : ''}.`);
    if (!r.elements.length) {
      end('ok');
      ok = true;
      return { entities: [], layers: [] };
    }
    await app.ensureKernel(ctx);
    const k = 1 / MM_PER_UNIT[unitOf(app)];
    const entities: NewEntity[] = [];
    const layerColors = new Map<string, string>();
    let open = 0, n = 0;
    for (const el of r.elements) {
      const pos = new Float64Array(el.positions.length);
      for (let i = 0; i < pos.length; i++) pos[i] = el.positions[i]! * k;
      const mesh = cleanMesh({ positions: pos, indices: el.indices }).mesh;
      if (!mesh.indices.length) continue;
      const closed = isClosed(mesh);
      if (!closed) open++;
      let res: SolidResult;
      try {
        res = await app.kernel.call<SolidResult>({ op: 'meshBody', positions: mesh.positions, indices: mesh.indices, closed });
      } catch (e) {
        ctx.print(`${el.name} : ignoré (${e instanceof Error ? e.message : String(e)}).`);
        continue;
      }
      const layer = layerForClass(el.type);
      if (!layerColors.has(layer)) layerColors.set(layer, el.color);
      const cls = classFromType(el.type);
      const material = renderMaterialFor(el.material, el.type) ?? (el.opacity < 0.9 ? 'glass' : undefined);
      entities.push({
        type: '3DSOLID',
        name: el.name,
        layer,
        shapeId: res.shapeId,
        display: res.display,
        ...(el.color !== layerColors.get(layer) ? { color: el.color } : {}),
        ...(material ? { material } : {}),
        bim: { ...(cls ? { cls } : {}), ...(el.guid ? { guid: el.guid } : {}), ...(el.material ? { material: el.material } : {}) },
      } as NewEntity);
      if (++n % 200 === 0) ctx.print(`${n} / ${r.elements.length} éléments…`);
    }
    if (open) ctx.print(`${open} élément(s) sans volume fermé importé(s) en surfaces.`);
    ctx.print(`${entities.length} élément(s) importé(s) en corps maillés (déplacer, couper, booléens, export ; CONVSOLIDE pour un solide exact).`);
    const layers: LayerDef[] = [...layerColors].map(([name, color]) => ({ name, color, lineweight: 0.25, visible: true, frozen: false, locked: false }));
    end('ok', `IFC : ${entities.length} élément(s)`);
    ok = true;
    return { entities, layers };
  } finally {
    if (!ok) end('error');
  }
}

// ---------------------------------------------------------------------------
// Classe IFC
// ---------------------------------------------------------------------------

const classCmd = cmd('IFCCLASS', 'CLASSEIFC', ['BIMCLASSE', 'CLASSEBIM'], 'Choisit la classe IFC des solides (mur, dalle, poteau, poutre, porte…) pour l’export BIM', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à classer', isBody);
  if (!hs.length) return;
  const keys = [kw('Auto', 'Automatique', 'AU', 'D’après le nom, le calque et la forme, à l’export'), ...IFC_CLASSES.map((c) => kw(c.cls, c.keyword, undefined, c.label))];
  const first = app.doc.get(hs[0]!) as Solid | undefined;
  const r = await getKeyword(ctx, 'Classe IFC', keys, first?.bim?.cls ?? 'Auto');
  const cls = r === 'Auto' ? undefined : (r as IfcClass);
  app.doc.transaction('Classe IFC', () => {
    for (const h of hs) {
      const e = app.doc.get(h) as Solid | undefined;
      if (!e || e.type !== '3DSOLID') continue;
      const bim = { ...e.bim, cls };
      if (!cls) delete bim.cls;
      app.doc.replaceEntity(h, { bim: Object.keys(bim).length ? bim : undefined });
    }
  });
  ctx.print(`${hs.length} solide(s) : ${cls ? ifcLabel(cls) : 'classement automatique à l’export'}.`);
});

export const bimCommands: CommandDefinition[] = [exportIfc, classCmd];
