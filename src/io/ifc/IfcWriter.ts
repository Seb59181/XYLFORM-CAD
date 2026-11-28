/**
 * Écriture d'un fichier IFC (format ouvert du BIM, ISO 16739) en texte STEP, schéma IFC4 ou
 * IFC2X3 : projet › site › bâtiment › niveau, un élément par solide (mur, dalle, poteau…) avec
 * sa géométrie, sa couleur, son matériau, son calque, ses dimensions et ses quantités.
 *
 * Géométrie : une boîte (primitive non déformée) devient une extrusion de rectangle, que les
 * logiciels BIM savent modifier ; les autres solides sont écrits en facettes (IFC4 :
 * IfcTriangulatedFaceSet, IFC2X3 : IfcFacetedBrep). Les coordonnées sont en millimètres.
 */
import type { IndexedMesh } from '../../core/mesh/IndexedMesh';
import { ifcGuid, type IfcClass } from '../../core/bim';

export type IfcSchema = 'IFC4' | 'IFC2X3';

interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Extrusion : profil (rectangle de `size.x` × `size.y` à partir de l'origine, ou disque de rayon
 * `radius` centré sur l'origine) poussé de `size.z` le long de l'axe Z local. Axes X et Z
 * unitaires et orthogonaux.
 */
export interface IfcBox {
  origin: V3;
  xAxis: V3;
  zAxis: V3;
  size: V3;
  radius?: number;
}

export interface IfcElementInput {
  name: string;
  cls: IfcClass;
  guid?: string;
  layer: string;
  /** #RRGGBB */
  color: string;
  /** Opacité 0–1 (1 = opaque). */
  opacity?: number;
  material?: string;
  /** Géométrie en mm : boîte (extrusion) ou facettes. */
  box?: IfcBox;
  mesh?: IndexedMesh;
  /** Volume (mm³), aire (mm²), dimensions hors tout (mm) : quantités et propriétés. */
  volume?: number;
  area?: number;
  size: { length: number; width: number; height: number };
  /** Propriétés en plus (nom → texte). */
  props?: Record<string, string>;
}

export interface IfcProjectInput {
  schema: IfcSchema;
  fileName: string;
  project: string;
  site: string;
  building: string;
  storey: string;
  author?: string;
  application: string;
  version: string;
  elements: IfcElementInput[];
  /** Date de création (tests) ; maintenant par défaut. */
  date?: Date;
  /** Générateur d'identifiants (tests). */
  guid?: () => string;
}

// ---------------------------------------------------------------------------
// Valeurs STEP
// ---------------------------------------------------------------------------

/** Chaîne STEP : apostrophes doublées, caractères non ASCII en \X2\…\X0\. */
export function stepString(s: string): string {
  let out = '';
  let wide = '';
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) {
      flush();
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
    } else if (c < 32) {
      flush();
      out += ' ';
    } else if (c > 0xffff) {
      const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800, lo = ((c - 0x10000) % 0x400) + 0xdc00;
      wide += hi.toString(16).toUpperCase().padStart(4, '0') + lo.toString(16).toUpperCase().padStart(4, '0');
    } else wide += c.toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `'${out}'`;
}

/** Réel STEP (toujours avec un point : « 1. », « 0.5 », « 1.E-05 »). */
export function stepReal(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '0.';
  if (Math.abs(v) >= 1e-6 && Math.abs(v) < 1e15) {
    const s = String(Math.round(v * 1e6) / 1e6);
    return s.includes('.') ? s : `${s}.`;
  }
  const [m, e] = v.toExponential(9).split('e') as [string, string];
  const mant = m.replace(/0+$/, '');
  return `${mant}E${e.startsWith('-') ? '-' : ''}${e.replace(/^[-+]/, '').padStart(2, '0')}`;
}

const list = (xs: string[]) => `(${xs.join(',')})`;

class StepFile {
  private lines: string[] = [];
  private n = 0;
  add(entity: string): string {
    this.n++;
    this.lines.push(`#${this.n}=${entity};`);
    return `#${this.n}`;
  }
  get body(): string {
    return this.lines.join('\n');
  }
}

/** Longueurs d'un élément pour les quantités : IFC4 a un attribut « Formula » en plus. */
function quantity(schema: IfcSchema, kind: 'LENGTH' | 'AREA' | 'VOLUME', name: string, value: number): string {
  const tail = schema === 'IFC4' ? ',$' : '';
  return `IFCQUANTITY${kind}(${stepString(name)},$,$,${stepReal(value)}${tail})`;
}

/**
 * Attributs propres à la classe après les 8 attributs communs (GlobalId … Tag), selon le schéma :
 * PredefinedType (IFC4), ShapeType / PredefinedType / CompositionType (IFC2X3), tailles des
 * portes et fenêtres.
 */
function classTail(schema: IfcSchema, cls: IfcClass, size: { width: number; height: number }): string {
  const h = stepReal(size.height), w = stepReal(size.width);
  if (schema === 'IFC4') {
    switch (cls) {
      case 'IfcFurnishingElement':
        return '';
      case 'IfcDoor':
        return `,${h},${w},.NOTDEFINED.,.NOTDEFINED.,$`;
      case 'IfcWindow':
        return `,${h},${w},.NOTDEFINED.,.NOTDEFINED.,$`;
      case 'IfcSlab':
        return ',.FLOOR.';
      case 'IfcWall':
        return ',.STANDARD.';
      default:
        return ',.NOTDEFINED.';
    }
  }
  switch (cls) {
    case 'IfcDoor':
    case 'IfcWindow':
      return `,${h},${w}`;
    case 'IfcSlab':
      return ',.FLOOR.';
    case 'IfcRoof':
    case 'IfcStair':
    case 'IfcRailing':
    case 'IfcCovering':
    case 'IfcFooting':
      return ',.NOTDEFINED.';
    case 'IfcBuildingElementProxy':
      return ',$';
    default:
      return '';
  }
}

const hexRgb = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1]!, 16) : 0xbfbfbf;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const norm = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/** Écrit le fichier IFC complet. */
export function writeIfc(p: IfcProjectInput): string {
  const f = new StepFile();
  const schema = p.schema;
  const guid = p.guid ?? (() => ifcGuid());
  const date = p.date ?? new Date();
  const str = stepString;
  const pt = (v: V3) => f.add(`IFCCARTESIANPOINT((${stepReal(v.x)},${stepReal(v.y)},${stepReal(v.z)}))`);
  const dir = (v: V3) => f.add(`IFCDIRECTION((${stepReal(v.x)},${stepReal(v.y)},${stepReal(v.z)}))`);

  // propriétaire (obligatoire en IFC2X3)
  const person = f.add(`IFCPERSON($,${str(p.author || 'Utilisateur')},$,$,$,$,$,$)`);
  const org = f.add(`IFCORGANIZATION($,${str(p.application)},$,$,$)`);
  const po = f.add(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
  const app = f.add(`IFCAPPLICATION(${org},${str(p.version)},${str(p.application)},'XylformCAD')`);
  const created = Math.floor(date.getTime() / 1000);
  const owner = f.add(`IFCOWNERHISTORY(${po},${app},$,.ADDED.,${created},${po},${app},${created})`);

  // unités : mm, m², m³, radians
  const uLen = f.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const uArea = f.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
  const uVol = f.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
  const uAng = f.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = f.add(`IFCUNITASSIGNMENT((${uLen},${uArea},${uVol},${uAng}))`);

  const origin = pt({ x: 0, y: 0, z: 0 });
  const zDir = dir({ x: 0, y: 0, z: 1 });
  const xDir = dir({ x: 1, y: 0, z: 0 });
  const world = f.add(`IFCAXIS2PLACEMENT3D(${origin},${zDir},${xDir})`);
  const ctx = f.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const body = f.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);

  const project = f.add(`IFCPROJECT(${str(guid())},${owner},${str(p.project)},$,$,$,$,(${ctx}),${units})`);
  const sitePl = f.add(`IFCLOCALPLACEMENT($,${world})`);
  const site = f.add(`IFCSITE(${str(guid())},${owner},${str(p.site)},$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = f.add(`IFCLOCALPLACEMENT(${sitePl},${f.add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)})`);
  const building = f.add(`IFCBUILDING(${str(guid())},${owner},${str(p.building)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = f.add(`IFCLOCALPLACEMENT(${bldPl},${f.add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)})`);
  const storey = f.add(`IFCBUILDINGSTOREY(${str(guid())},${owner},${str(p.storey)},$,$,${stPl},$,$,.ELEMENT.,0.)`);
  f.add(`IFCRELAGGREGATES(${str(guid())},${owner},$,$,${project},(${site}))`);
  f.add(`IFCRELAGGREGATES(${str(guid())},${owner},$,$,${site},(${building}))`);
  f.add(`IFCRELAGGREGATES(${str(guid())},${owner},$,$,${building},(${storey}))`);

  const elements: string[] = [];
  const styles = new Map<string, string>();
  const materials = new Map<string, { id: string; elements: string[] }>();
  const layers = new Map<string, string[]>();

  for (const el of p.elements) {
    // style de surface (partagé par couleur)
    const key = `${el.color}|${el.opacity ?? 1}`;
    let style = styles.get(key);
    if (!style) {
      const [r, g, b] = hexRgb(el.color);
      const rgb = f.add(`IFCCOLOURRGB($,${stepReal(r)},${stepReal(g)},${stepReal(b)})`);
      const transparency = 1 - (el.opacity ?? 1);
      const shading = f.add(schema === 'IFC4' ? `IFCSURFACESTYLESHADING(${rgb},${stepReal(transparency)})` : `IFCSURFACESTYLERENDERING(${rgb},${stepReal(transparency)},$,$,$,$,$,$,.FLAT.)`);
      style = f.add(`IFCSURFACESTYLE(${str(el.color)},.BOTH.,(${shading}))`);
      styles.set(key, style);
    }

    let item: string;
    let repType: string;
    let placementOrigin: V3;
    let axes: [V3, V3] | undefined;
    if (el.box) {
      const bx = el.box;
      const zA = norm(bx.zAxis), xA = norm(bx.xAxis);
      placementOrigin = bx.origin;
      const centre = bx.radius ? { x: 0, y: 0 } : { x: bx.size.x / 2, y: bx.size.y / 2 };
      const prof2d = f.add(`IFCAXIS2PLACEMENT2D(${f.add(`IFCCARTESIANPOINT((${stepReal(centre.x)},${stepReal(centre.y)}))`)},$)`);
      const prof = f.add(bx.radius ? `IFCCIRCLEPROFILEDEF(.AREA.,$,${prof2d},${stepReal(bx.radius)})` : `IFCRECTANGLEPROFILEDEF(.AREA.,$,${prof2d},${stepReal(bx.size.x)},${stepReal(bx.size.y)})`);
      const pos = f.add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
      item = f.add(`IFCEXTRUDEDAREASOLID(${prof},${pos},${zDir},${stepReal(bx.size.z)})`);
      repType = 'SweptSolid';
      // l'orientation de la boîte va dans le placement de l'élément
      axes = [zA, xA];
    } else if (el.mesh && el.mesh.indices.length) {
      const m = el.mesh;
      const n = m.positions.length / 3;
      let mx = Infinity, my = Infinity, mz = Infinity;
      for (let i = 0; i < n; i++) {
        mx = Math.min(mx, m.positions[3 * i]!);
        my = Math.min(my, m.positions[3 * i + 1]!);
        mz = Math.min(mz, m.positions[3 * i + 2]!);
      }
      placementOrigin = { x: mx, y: my, z: mz };
      const local = (i: number) => [stepReal(m.positions[3 * i]! - mx), stepReal(m.positions[3 * i + 1]! - my), stepReal(m.positions[3 * i + 2]! - mz)];
      const closed = isClosed(m);
      if (schema === 'IFC4') {
        const coords: string[] = [];
        for (let i = 0; i < n; i++) coords.push(`(${local(i).join(',')})`);
        const cl = f.add(`IFCCARTESIANPOINTLIST3D(${list(coords)})`);
        const tris: string[] = [];
        for (let t = 0; t < m.indices.length; t += 3) tris.push(`(${m.indices[t]! + 1},${m.indices[t + 1]! + 1},${m.indices[t + 2]! + 1})`);
        // IFC4 d'origine : NormalIndex ; IFC4 ADD2 : PnIndex. Les deux à $ : même écriture.
        item = f.add(`IFCTRIANGULATEDFACESET(${cl},$,${closed ? '.T.' : '.F.'},${list(tris)},$)`);
        repType = 'Tessellation';
      } else {
        const pts: string[] = [];
        for (let i = 0; i < n; i++) pts.push(f.add(`IFCCARTESIANPOINT((${local(i).join(',')}))`));
        const faces: string[] = [];
        for (let t = 0; t < m.indices.length; t += 3) {
          const loop = f.add(`IFCPOLYLOOP((${pts[m.indices[t]!]},${pts[m.indices[t + 1]!]},${pts[m.indices[t + 2]!]}))`);
          faces.push(f.add(`IFCFACE((${f.add(`IFCFACEOUTERBOUND(${loop},.T.)`)}))`));
        }
        if (closed) {
          item = f.add(`IFCFACETEDBREP(${f.add(`IFCCLOSEDSHELL(${list(faces)})`)})`);
          repType = 'Brep';
        } else {
          item = f.add(`IFCSHELLBASEDSURFACEMODEL((${f.add(`IFCOPENSHELL(${list(faces)})`)}))`);
          repType = 'SurfaceModel';
        }
      }
    } else continue;

    f.add(schema === 'IFC4' ? `IFCSTYLEDITEM(${item},(${style}),$)` : `IFCSTYLEDITEM(${item},(${f.add(`IFCPRESENTATIONSTYLEASSIGNMENT((${style}))`)}),$)`);
    const rep = f.add(`IFCSHAPEREPRESENTATION(${body},'Body',${str(repType)},(${item}))`);
    const shape = f.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
    const elAxis = axes ? f.add(`IFCAXIS2PLACEMENT3D(${pt(placementOrigin)},${dir(axes[0])},${dir(axes[1])})`) : f.add(`IFCAXIS2PLACEMENT3D(${pt(placementOrigin)},$,$)`);
    const elPl = f.add(`IFCLOCALPLACEMENT(${stPl},${elAxis})`);
    const id = f.add(
      `${el.cls.toUpperCase()}(${str(el.guid || guid())},${owner},${str(el.name)},$,$,${elPl},${shape},$${classTail(schema, el.cls, el.size)})`,
    );
    elements.push(id);
    const lay = layers.get(el.layer) ?? [];
    lay.push(rep);
    layers.set(el.layer, lay);

    // propriétés : calque, matériau, dimensions
    const props: string[] = [];
    const label = (name: string, v: string) => props.push(f.add(`IFCPROPERTYSINGLEVALUE(${str(name)},$,IFCLABEL(${str(v)}),$)`));
    const length = (name: string, v: number) => props.push(f.add(`IFCPROPERTYSINGLEVALUE(${str(name)},$,IFCLENGTHMEASURE(${stepReal(v)}),$)`));
    label('Calque', el.layer);
    if (el.material) label('Matériau', el.material);
    label('Couleur', el.color);
    length('Longueur', el.size.length);
    length('Largeur', el.size.width);
    length('Hauteur', el.size.height);
    for (const [k, v] of Object.entries(el.props ?? {})) label(k, v);
    const pset = f.add(`IFCPROPERTYSET(${str(guid())},${owner},'Xylform CAD',$,${list(props)})`);
    f.add(`IFCRELDEFINESBYPROPERTIES(${str(guid())},${owner},$,$,(${id}),${pset})`);
    const qs = [quantity(schema, 'LENGTH', 'Length', el.size.length), quantity(schema, 'LENGTH', 'Width', el.size.width), quantity(schema, 'LENGTH', 'Height', el.size.height)].map((q) => f.add(q));
    // m² et m³ (unités du projet)
    if (el.area) qs.push(f.add(quantity(schema, 'AREA', 'GrossSurfaceArea', el.area / 1e6)));
    if (el.volume) qs.push(f.add(quantity(schema, 'VOLUME', 'NetVolume', el.volume / 1e9)));
    const qto = f.add(`IFCELEMENTQUANTITY(${str(guid())},${owner},'Qto_XylformCAD',$,'Xylform CAD',${list(qs)})`);
    f.add(`IFCRELDEFINESBYPROPERTIES(${str(guid())},${owner},$,$,(${id}),${qto})`);

    if (el.material) {
      const m = materials.get(el.material) ?? { id: f.add(schema === 'IFC4' ? `IFCMATERIAL(${str(el.material)},$,$)` : `IFCMATERIAL(${str(el.material)})`), elements: [] };
      m.elements.push(id);
      materials.set(el.material, m);
    }
  }

  if (elements.length) f.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${str(guid())},${owner},$,$,${list(elements)},${storey})`);
  for (const m of materials.values()) f.add(`IFCRELASSOCIATESMATERIAL(${str(guid())},${owner},$,$,${list(m.elements)},${m.id})`);
  for (const [name, reps] of layers) f.add(`IFCPRESENTATIONLAYERASSIGNMENT(${str(name)},$,${list(reps)},$)`);

  const stamp = date.toISOString().slice(0, 19);
  const view = schema === 'IFC4' ? 'ViewDefinition [ReferenceView_V1.2]' : 'ViewDefinition [CoordinationView_V2.0]';
  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${str(view)}),'2;1');`,
    `FILE_NAME(${str(p.fileName)},'${stamp}',(${str(p.author || '')}),(''),${str(`${p.application} ${p.version}`)},${str(p.application)},'');`,
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    f.body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** Maillage fermé : chaque arête partagée par exactement deux triangles. */
export function isClosed(m: IndexedMesh): boolean {
  const edges = new Map<string, number>();
  const idx = m.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k]!, b = idx[t + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const c of edges.values()) if (c !== 2) return false;
  return edges.size > 0;
}
