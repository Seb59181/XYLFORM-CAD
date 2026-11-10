/**
 * Écriture PDF vectorielle minimale (traits, remplissages, texte Helvetica) pour l'export des
 * mises en plan : une page aux dimensions du papier, coordonnées en millimètres, origine en bas
 * à gauche. Aucun module externe : le fichier reste petit et s'ouvre partout.
 */

export type PdfItem =
  | { kind: 'path'; pts: [number, number][]; closed?: boolean; stroke?: string; width?: number; dash?: number[]; fill?: string }
  | { kind: 'text'; x: number; y: number; size: number; text: string; angle?: number; align?: 'left' | 'center' | 'right'; color?: string; widthFactor?: number };

export interface PdfPage {
  /** Largeur et hauteur en mm. */
  w: number;
  h: number;
  items: PdfItem[];
}

const PT = 72 / 25.4;

/** Largeurs Helvetica (1/1000 em) des caractères ASCII 32 à 126. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Caractère → octet WinAnsi (accents français, °, Ø, ±, ², ×…). */
function winAnsi(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c < 127) return c;
  if (c >= 160 && c <= 255) return c;
  const map: Record<string, number> = { '€': 128, '‚': 130, '„': 132, '…': 133, '‰': 137, 'Œ': 140, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '™': 153, 'œ': 156, 'Ÿ': 159, '⌀': 216 };
  return map[ch] ?? 63; // « ? »
}

function charWidth(b: number): number {
  if (b >= 32 && b < 127) return HELV[b - 32]!;
  if (b === 176) return 400; // °
  if (b === 216 || b === 248) return b === 216 ? 778 : 611; // Ø ø
  if (b === 177 || b === 215) return 584; // ± ×
  if (b === 178 || b === 179) return 333;
  if (b === 133) return 1000;
  if (b === 150) return 556;
  if (b === 151) return 1000;
  if (b === 146 || b === 145) return 222;
  if (b >= 192 && b <= 197) return 667; // À…
  if (b === 199) return 722; // Ç
  if (b >= 200 && b <= 203) return 667; // È…
  if (b >= 204 && b <= 207) return 278;
  if (b >= 224 && b <= 229) return 556; // à…
  if (b === 231) return 500; // ç
  if (b >= 232 && b <= 235) return 556;
  if (b >= 236 && b <= 239) return 278;
  if (b >= 242 && b <= 246) return 556;
  if (b >= 249 && b <= 252) return 556;
  return 556;
}

/** Largeur d'un texte (mm) en Helvetica de corps `size` (mm). */
export function pdfTextWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(winAnsi(ch));
  return (w / 1000) * size;
}

const n = (v: number) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};

function rgb(color: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color ?? '');
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function escapeText(s: string): string {
  let out = '';
  for (const ch of s) {
    const b = winAnsi(ch);
    if (b === 40 || b === 41 || b === 92) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

function contentOf(page: PdfPage): string {
  const out: string[] = ['1 J 1 j'];
  let stroke = '', fill = '', width = -1, dash = '';
  for (const it of page.items) {
    if (it.kind === 'path') {
      if (it.pts.length < 2) continue;
      if (it.stroke !== undefined) {
        const c = rgb(it.stroke).map(n).join(' ');
        if (c !== stroke) out.push(`${c} RG`), (stroke = c);
        const w = (it.width ?? 0.25) * PT;
        if (w !== width) out.push(`${n(w)} w`), (width = w);
        const d = it.dash?.length ? `[${it.dash.map((x) => n(Math.max(Math.abs(x), 0.05) * PT)).join(' ')}] 0 d` : '[] 0 d';
        if (d !== dash) out.push(d), (dash = d);
      }
      if (it.fill !== undefined) {
        const c = rgb(it.fill).map(n).join(' ');
        if (c !== fill) out.push(`${c} rg`), (fill = c);
      }
      const p = it.pts.map(([x, y], i) => `${n(x * PT)} ${n(y * PT)} ${i ? 'l' : 'm'}`).join(' ');
      const op = it.fill !== undefined ? (it.stroke !== undefined ? 'B*' : 'f*') : it.closed ? 's' : 'S';
      out.push(`${p} ${op}`);
    } else {
      const c = rgb(it.color).map(n).join(' ');
      if (c !== fill) out.push(`${c} rg`), (fill = c);
      const wf = it.widthFactor ?? 1;
      const w = pdfTextWidth(it.text, it.size) * wf;
      const dx = it.align === 'center' ? -w / 2 : it.align === 'right' ? -w : 0;
      const a = it.angle ?? 0;
      const ca = Math.cos(a), sa = Math.sin(a);
      // matrice : rotation, facteur de largeur, puis décalage d'alignement le long du texte
      const x = it.x + ca * dx, y = it.y + sa * dx;
      out.push(`BT /F1 ${n(it.size * PT)} Tf ${n(ca * wf)} ${n(sa * wf)} ${n(-sa)} ${n(ca)} ${n(x * PT)} ${n(y * PT)} Tm (${escapeText(it.text)}) Tj ET`);
    }
  }
  return out.join('\n');
}

/** Document PDF (une page par entrée). */
export function writePdf(pages: PdfPage[], title = 'Xylform CAD'): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  // 1 catalogue, 2 pages, 3 police, 4 infos, puis contenu et page par page
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  add(`<< /Title (${escapeText(title)}) /Creator (Xylform CAD) /Producer (Xylform CAD) /CreationDate (D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}) >>`);
  // page i : contenu = objet 5 + 2i, page = objet 6 + 2i
  pages.forEach((p, i) => {
    const content = contentOf(p);
    objs[4 + i * 2] = `<< /Length ${latin1Length(content)} >>\nstream\n${content}\nendstream`;
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.w * PT)} ${n(p.h * PT)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
  });
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(latin1Length(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = latin1Length(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255;
  return bytes;
}

function latin1Length(s: string): number {
  return s.length; // le contenu n'utilise que des octets (texte échappé en octal)
}
