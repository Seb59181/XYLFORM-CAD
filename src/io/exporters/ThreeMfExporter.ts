/**
 * Export 3MF (3D Manufacturing Format, spécification Core 1.3).
 *
 * Paquet OPC (ZIP) :
 *   [Content_Types].xml
 *   _rels/.rels                 → relation "3dmodel" vers /3D/3dmodel.model
 *   3D/3dmodel.model            → XML : unit="millimeter", ressources, build
 *
 * Contrairement au STL, le 3MF porte l'unité, plusieurs objets nommés, des couleurs et des
 * sommets partagés (indexés). La spécification EXIGE des maillages manifold et orientés :
 * chaque objet est donc validé séparément par `prepareForPrint`.
 */
import { zipSync, strToU8 } from 'fflate';
import type { IndexedMesh } from '../../core/mesh/IndexedMesh';
import { prepareForPrint, type PreparedMesh, type PrintExportOptions } from './PrintPreparation';

export interface ThreeMfObject {
  name: string;
  mesh: IndexedMesh;
  /** Couleur d'affichage sRGB, ex. "#C8A050". */
  color?: string;
  /** Matrice 3×4 de placement dans la build (ligne par ligne, 12 valeurs), en mm. */
  transform?: readonly number[];
}

export interface ThreeMfOptions extends PrintExportOptions {
  title?: string;
  designer?: string;
  application?: string;
  /** Date ISO, injectable pour des exports reproductibles. */
  creationDate?: string;
}

export interface ThreeMfExportResult {
  data: Uint8Array;
  objects: { name: string; prepared: PreparedMesh }[];
}

const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const REL_3DMODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${REL_3DMODEL}"/>
</Relationships>`;

/** Nombre compact sans notation exponentielle, précision 1e-6 mm. */
function num(v: number): string {
  const s = v.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function normalizeColor(c: string): string {
  const hex = c.replace('#', '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) throw new Error(`Couleur invalide : ${c}`);
  return `#${hex.length === 6 ? hex + 'FF' : hex}`;
}

export function exportThreeMf(objects: readonly ThreeMfObject[], opts: ThreeMfOptions = {}): ThreeMfExportResult {
  if (!objects.length) throw new Error('Aucun objet à exporter.');
  const prepared = objects.map((o) => ({ name: o.name, prepared: prepareForPrint(o.mesh, opts) }));

  const colored = objects.filter((o) => o.color);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<model unit="millimeter" xml:lang="fr-FR" xmlns="${NS_CORE}">`);
  const meta = (name: string, value?: string) => value && lines.push(`  <metadata name="${name}">${xmlEscape(value)}</metadata>`);
  meta('Title', opts.title);
  meta('Designer', opts.designer);
  meta('Application', opts.application ?? 'Xylform CAD');
  meta('CreationDate', opts.creationDate ?? new Date().toISOString().slice(0, 10));
  lines.push('  <resources>');

  // id 1 réservé aux matériaux de base si au moins un objet est coloré
  const materialId = 1;
  let nextId = colored.length ? 2 : 1;
  if (colored.length) {
    lines.push(`    <basematerials id="${materialId}">`);
    for (const o of colored) lines.push(`      <base name="${xmlEscape(o.name)}" displaycolor="${normalizeColor(o.color!)}"/>`);
    lines.push('    </basematerials>');
  }

  const ids: number[] = [];
  objects.forEach((o, i) => {
    const id = nextId++;
    ids.push(id);
    const m = prepared[i]!.prepared.mesh;
    const colorIndex = colored.indexOf(o);
    const mat = colorIndex >= 0 ? ` pid="${materialId}" pindex="${colorIndex}"` : '';
    lines.push(`    <object id="${id}" type="model" name="${xmlEscape(o.name)}"${mat}>`);
    lines.push('      <mesh>');
    lines.push('        <vertices>');
    const p = m.positions;
    for (let v = 0; v < p.length; v += 3) lines.push(`          <vertex x="${num(p[v]!)}" y="${num(p[v + 1]!)}" z="${num(p[v + 2]!)}"/>`);
    lines.push('        </vertices>');
    lines.push('        <triangles>');
    const ix = m.indices;
    for (let t = 0; t < ix.length; t += 3) lines.push(`          <triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}"/>`);
    lines.push('        </triangles>');
    lines.push('      </mesh>');
    lines.push('    </object>');
  });
  lines.push('  </resources>');
  lines.push('  <build>');
  objects.forEach((o, i) => {
    const tr = o.transform ? ` transform="${o.transform.map(num).join(' ')}"` : '';
    lines.push(`    <item objectid="${ids[i]}"${tr}/>`);
  });
  lines.push('  </build>');
  lines.push('</model>');

  const data = zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(lines.join('\n')),
    },
    { level: 6 },
  );
  return { data, objects: prepared };
}
