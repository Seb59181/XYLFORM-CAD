/**
 * Chargement des fonds de plan : DWG/DXF (contenu vectoriel conservé tel quel, dans ses propres
 * coordonnées), PDF (page rendue en image par pdf.js) et images raster.
 */
import type { UnderlayDef, UnderlayKind } from '../core/document/Document';
import { boundsOf } from '../core/entities/underlay';
import { readDxf } from './dxf';
import { extension } from './fileAccess';

export const UNDERLAY_ACCEPT = '.dwg,.dxf,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif';

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };

/** Millimètres par unité de dessin pour les formats sans unités propres (PDF). */
const MM: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 14: 100 };

export function underlayKind(name: string): UnderlayKind | null {
  const ext = extension(name);
  if (ext === 'dwg' || ext === 'dxf' || ext === 'pdf') return ext;
  return IMAGE_MIME[ext] ? 'image' : null;
}

/** Texte DXF d'un fichier DXF ou DWG. */
export async function cadText(bytes: Uint8Array, ext: string, print: (m: string) => void): Promise<string> {
  if (ext === 'dwg') {
    print('Conversion du DWG (LibreDWG)…');
    const { dwgToDxf } = await import('./dwg');
    return dwgToDxf(bytes);
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

export type UnderlayContent = Pick<UnderlayDef, 'kind' | 'entities' | 'layers' | 'image' | 'page' | 'bounds' | 'units' | 'adjustColors'> & {
  /** PDF : nombre de pages du document. */
  pages?: number;
};

export interface LoadOptions {
  print: (m: string) => void;
  /** Unités du dessin courant (INSUNITS). */
  hostUnits: number;
  /** PDF : page à rendre (1 par défaut) ; appelé si le document en a plusieurs. */
  choosePage?: (pages: number) => Promise<number>;
  page?: number;
}

/** Lit le contenu d'un fond de plan (sans l'insérer). */
export async function loadUnderlay(name: string, bytes: Uint8Array, opts: LoadOptions): Promise<UnderlayContent> {
  const kind = underlayKind(name);
  if (!kind) throw new Error(`Format de fond de plan non pris en charge : .${extension(name)}`);
  if (kind === 'dwg' || kind === 'dxf') {
    const r = readDxf(await cadText(bytes, kind, opts.print));
    if (!r.entities.length) throw new Error('Ce dessin ne contient aucun objet affichable.');
    const layers = r.layers.map((l) => ({ name: l.name, color: l.color, visible: l.visible && !l.frozen }));
    for (const e of r.entities) if (e.layer && !layers.some((l) => l.name === e.layer)) layers.push({ name: e.layer, color: '#ffffff', visible: true });
    return { kind, entities: r.entities, layers, bounds: boundsOf(r.entities), units: r.insunits };
  }
  if (kind === 'pdf') return loadPdf(bytes, opts);
  const mime = IMAGE_MIME[extension(name)]!;
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  const image = { data: bytes, mime, pxWidth: bmp.width, pxHeight: bmp.height, pixelSize: 1 };
  bmp.close();
  return { kind, image, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: image.pxWidth, y: image.pxHeight, z: 0 } } };
}

/**
 * Blanc → transparent (« couleur vers alpha ») : le papier disparaît, les traits gardent leur
 * couleur et leur anticrénelage. Indispensable sur le fond sombre de l'espace objet.
 */
function whiteToAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    const a = 255 - Math.min(r, g, b);
    if (a === 0) {
      d[i + 3] = 0;
      continue;
    }
    const k = 255 / a, w0 = 255 - a;
    d[i] = (r - w0) * k;
    d[i + 1] = (g - w0) * k;
    d[i + 2] = (b - w0) * k;
    d[i + 3] = (a * d[i + 3]!) / 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Rend une page PDF en PNG (fond transparent) à la taille réelle de la page. */
async function loadPdf(bytes: Uint8Array, opts: LoadOptions): Promise<UnderlayContent> {
  opts.print('Lecture du PDF…');
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  try {
    const pages = pdf.numPages;
    let n = opts.page ?? 1;
    if (opts.page === undefined && pages > 1 && opts.choosePage) n = await opts.choosePage(pages);
    n = Math.max(1, Math.min(pages, Math.round(n)));
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 }); // en points (1/72 pouce)
    const inches = Math.max(base.width, base.height) / 72;
    // ≈ 200 dpi, plafonné pour rester dans les limites des textures GPU
    const dpi = Math.min(200, 6000 / inches);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    opts.print(`Rendu de la page ${n}/${pages} (${canvas.width} × ${canvas.height} px)…`);
    // contexte avec transparence créé ici (pdf.js l'ouvrirait opaque), page rendue sur blanc
    const ctx2 = canvas.getContext('2d', { alpha: true, willReadFrequently: true })!;
    await page.render({ canvas, viewport }).promise;
    whiteToAlpha(ctx2, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Rendu PDF impossible'))), 'image/png'));
    const data = new Uint8Array(await blob.arrayBuffer());
    // taille réelle : 1 pt = 25,4/72 mm, convertie dans les unités du dessin
    const mmPerUnit = MM[opts.hostUnits] ?? 1;
    const pixelSize = (base.width * 25.4) / 72 / canvas.width / mmPerUnit;
    const image = { data, mime: 'image/png', pxWidth: canvas.width, pxHeight: canvas.height, pixelSize };
    return {
      kind: 'pdf',
      image,
      page: n,
      pages,
      adjustColors: true,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: canvas.width * pixelSize, y: canvas.height * pixelSize, z: 0 } },
    };
  } finally {
    void task.destroy();
  }
}
