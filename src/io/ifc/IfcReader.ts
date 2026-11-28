/**
 * Lecture d'un fichier IFC (IFC2X3, IFC4, IFC4X3) avec la bibliothèque libre web-ifc : chaque
 * élément du bâtiment (mur, dalle, porte, meuble…) donne un maillage en millimètres, Z vers le
 * haut, avec sa classe, son nom, son identifiant, sa couleur et son matériau.
 */
import type { IfcAPI } from 'web-ifc';

export interface IfcImportedElement {
  expressId: number;
  /** Nom de la classe en majuscules (IFCWALL, IFCSLAB…). */
  type: string;
  guid?: string;
  name: string;
  /** #RRGGBB et opacité 0–1 de la plus grande partie de l'élément. */
  color: string;
  opacity: number;
  material?: string;
  /** Étage (IfcBuildingStorey) qui contient l'élément. */
  storey?: string;
  positions: Float64Array;
  indices: Uint32Array;
}

export interface IfcReadResult {
  schema: string;
  project?: string;
  elements: IfcImportedElement[];
  /** Éléments sans géométrie lisible ou ignorés (espaces, ouvertures). */
  skipped: number;
}

/** Classes jamais importées : volumes abstraits (pièces, réservations, zones). */
const SKIP = new Set(['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVIRTUALELEMENT', 'IFCZONE', 'IFCANNOTATION', 'IFCGRID', 'IFCSITE']);

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');

const val = (a: unknown): string | undefined => {
  const v = (a as { value?: unknown } | null | undefined)?.value;
  return typeof v === 'string' && v.trim() ? decodeStep(v.trim()) : undefined;
};

/** Décodage des chaînes STEP \X2\…\X0\ et \S\ que web-ifc laisse telles quelles. */
export function decodeStep(s: string): string {
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, h: string) => {
      let out = '';
      for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128));
}

/**
 * Lit le fichier. `api` est une instance web-ifc déjà initialisée (Init) ; elle reste utilisable
 * après l'appel. `progress` reçoit l'avancement (0–1).
 */
export function readIfc(api: IfcAPI, bytes: Uint8Array, progress?: (f: number) => void): IfcReadResult {
  const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 24 });
  if (model < 0) throw new Error('Fichier IFC illisible.');
  try {
    const schema = api.GetModelSchema(model);
    const typeName = (id: number) => {
      try {
        return String(api.GetNameFromTypeCode(api.GetLineType(model, id))).toUpperCase();
      } catch {
        return '';
      }
    };
    const materials = materialMap(api, model);
    const storeys = storeyMap(api, model);
    // web-ifc rend les coordonnées en mètres, Y vers le haut : retour en mm, Z vers le haut
    const S = 1000;
    const byElement = new Map<number, { parts: { pos: Float64Array; idx: Uint32Array; color: string; opacity: number }[] }>();
    let skipped = 0;
    api.StreamAllMeshes(model, (mesh, index, total) => {
      if (progress && total) progress(index / total);
      const type = typeName(mesh.expressID);
      if (SKIP.has(type)) {
        skipped++;
        return;
      }
      const entry = byElement.get(mesh.expressID) ?? { parts: [] };
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const geo = api.GetGeometry(model, pg.geometryExpressID);
        try {
          const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
          const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
          if (!ix.length) continue;
          const m = pg.flatTransformation;
          const n = v.length / 6;
          const pos = new Float64Array(n * 3);
          for (let i = 0; i < n; i++) {
            const x = v[6 * i]!, y = v[6 * i + 1]!, z = v[6 * i + 2]!;
            // matrice 4×4 en colonnes
            const X = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
            const Y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
            const Z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
            // (X, Y, Z) Y vers le haut → (X, -Z, Y) Z vers le haut
            pos[3 * i] = X * S;
            pos[3 * i + 1] = -Z * S;
            pos[3 * i + 2] = Y * S;
          }
          const c = pg.color;
          entry.parts.push({ pos, idx: new Uint32Array(ix), color: `#${hex2(c.x)}${hex2(c.y)}${hex2(c.z)}`, opacity: c.w });
        } finally {
          geo.delete();
        }
      }
      if (entry.parts.length) byElement.set(mesh.expressID, entry);
      else skipped++;
    });

    const elements: IfcImportedElement[] = [];
    for (const [id, { parts }] of byElement) {
      const nv = parts.reduce((s, p) => s + p.pos.length, 0), ni = parts.reduce((s, p) => s + p.idx.length, 0);
      const positions = new Float64Array(nv), indices = new Uint32Array(ni);
      let ov = 0, oi = 0;
      // couleur de la partie la plus grande (une fenêtre : le cadre plutôt que la vitre)
      let best = parts[0]!;
      for (const p of parts) {
        positions.set(p.pos, ov);
        for (let k = 0; k < p.idx.length; k++) indices[oi + k] = p.idx[k]! + ov / 3;
        ov += p.pos.length;
        oi += p.idx.length;
        if (p.idx.length > best.idx.length) best = p;
      }
      let line: Record<string, unknown> | undefined;
      try {
        line = api.GetLine(model, id) as Record<string, unknown>;
      } catch {
        line = undefined;
      }
      const type = typeName(id) || 'IFCBUILDINGELEMENTPROXY';
      elements.push({
        expressId: id,
        type,
        guid: val(line?.GlobalId),
        name: val(line?.Name) ?? val(line?.ObjectType) ?? `${type.replace(/^IFC/, '')} ${id}`,
        color: best.color,
        opacity: best.opacity,
        material: materials.get(id),
        storey: storeys.get(id),
        positions,
        indices,
      });
    }
    let project: string | undefined;
    try {
      const ids = api.GetLineIDsWithType(model, typeCode(api, 'IFCPROJECT'));
      if (ids.size()) project = val((api.GetLine(model, ids.get(0)) as Record<string, unknown>).Name);
    } catch {
      /* nom du projet facultatif */
    }
    progress?.(1);
    return { schema, project, elements, skipped };
  } finally {
    api.CloseModel(model);
  }
}

function typeCode(api: IfcAPI, name: string): number {
  return api.GetTypeCodeFromName(name);
}

const refId = (r: unknown): number | undefined => {
  const v = (r as { value?: unknown } | null | undefined)?.value;
  return typeof v === 'number' ? v : undefined;
};
const refs = (r: unknown): number[] => (Array.isArray(r) ? r.map(refId).filter((x): x is number => x !== undefined) : []);

/** Élément → nom du matériau (IfcMaterial, ensembles de couches, listes, constituants). */
function materialMap(api: IfcAPI, model: number): Map<number, string> {
  const out = new Map<number, string>();
  let ids;
  try {
    ids = api.GetLineIDsWithType(model, typeCode(api, 'IFCRELASSOCIATESMATERIAL'));
  } catch {
    return out;
  }
  const nameOf = (id: number | undefined, depth = 0): string | undefined => {
    if (id === undefined || depth > 4) return undefined;
    let l: Record<string, unknown>;
    try {
      l = api.GetLine(model, id) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const t = String(api.GetNameFromTypeCode(api.GetLineType(model, id))).toUpperCase();
    if (t === 'IFCMATERIAL') return val(l.Name);
    if (t === 'IFCMATERIALLAYERSETUSAGE') return nameOf(refId(l.ForLayerSet), depth + 1);
    if (t === 'IFCMATERIALLAYERSET') return val(l.LayerSetName) ?? (refs(l.MaterialLayers).map((x) => nameOf(x, depth + 1)).filter(Boolean).join(' / ') || undefined);
    if (t === 'IFCMATERIALLAYER') return nameOf(refId(l.Material), depth + 1);
    if (t === 'IFCMATERIALLIST') return refs(l.Materials).map((x) => nameOf(x, depth + 1)).filter(Boolean).join(' / ') || undefined;
    if (t === 'IFCMATERIALCONSTITUENTSET') return val(l.Name) ?? (refs(l.MaterialConstituents).map((x) => nameOf(x, depth + 1)).filter(Boolean).join(' / ') || undefined);
    if (t === 'IFCMATERIALCONSTITUENT') return val(l.Name) ?? nameOf(refId(l.Material), depth + 1);
    if (t === 'IFCMATERIALPROFILESETUSAGE') return nameOf(refId(l.ForProfileSet), depth + 1);
    if (t === 'IFCMATERIALPROFILESET') return val(l.Name) ?? (refs(l.MaterialProfiles).map((x) => nameOf(x, depth + 1)).filter(Boolean).join(' / ') || undefined);
    if (t === 'IFCMATERIALPROFILE') return val(l.Name) ?? nameOf(refId(l.Material), depth + 1);
    return val(l.Name);
  };
  for (let i = 0; i < ids.size(); i++) {
    try {
      const rel = api.GetLine(model, ids.get(i)) as Record<string, unknown>;
      const name = nameOf(refId(rel.RelatingMaterial));
      if (name) for (const o of refs(rel.RelatedObjects)) if (!out.has(o)) out.set(o, name);
    } catch {
      /* relation illisible : ignorée */
    }
  }
  return out;
}

/** Élément → nom de l'étage qui le contient. */
function storeyMap(api: IfcAPI, model: number): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const ids = api.GetLineIDsWithType(model, typeCode(api, 'IFCRELCONTAINEDINSPATIALSTRUCTURE'));
    for (let i = 0; i < ids.size(); i++) {
      const rel = api.GetLine(model, ids.get(i)) as Record<string, unknown>;
      const st = refId(rel.RelatingStructure);
      if (st === undefined) continue;
      const name = val((api.GetLine(model, st) as Record<string, unknown>).Name);
      if (name) for (const o of refs(rel.RelatedElements)) out.set(o, name);
    }
  } catch {
    /* étages facultatifs */
  }
  return out;
}

/** Matière de rendu de Xylform CAD la plus proche d'un nom de matériau IFC. */
export function renderMaterialFor(name: string | undefined, type: string): string | undefined {
  const t = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (/verre|glass|vitrage|glazing/.test(t)) return 'glass';
  if (/beton|concrete|ciment|cement|mortier|parpaing|masonry|maconnerie/.test(t)) return 'concrete';
  if (/inox|stainless/.test(t)) return 'stainless';
  if (/alu/.test(t)) return 'aluminium';
  if (/acier|steel|metal|fer\b|iron/.test(t)) return 'steel';
  if (/chene|oak|noyer|walnut|wenge|acajou|dark wood/.test(t)) return 'wooddark';
  if (/bois|wood|timber|pin\b|pine|sapin|epicea|douglas|osb|contreplaque|plywood|parquet/.test(t)) return 'woodlight';
  if (/cuivre|copper/.test(t)) return 'copper';
  if (/laiton|brass/.test(t)) return 'brass';
  if (/ceram|faience|porcelain|carrel|tile/.test(t)) return 'ceramic';
  if (/caoutchouc|rubber|epdm/.test(t)) return 'rubber';
  return undefined;
}
