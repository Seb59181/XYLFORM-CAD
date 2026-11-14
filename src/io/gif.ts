/**
 * Encodeur GIF animé minimal (sans dépendance) pour l'export du mode Présentation :
 * palette globale de 256 couleurs par coupe médiane, puis compression LZW.
 */

export interface GifFrame {
  width: number;
  height: number;
  /** RGBA, 4 octets par pixel (ImageData.data). */
  data: Uint8ClampedArray | Uint8Array;
}

const key = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Palette (≤ 256 couleurs RGB) des images, par coupe médiane sur un histogramme 15 bits. */
export function buildPalette(frames: GifFrame[], max = 256): number[][] {
  const hist = new Uint32Array(32768);
  for (const f of frames) {
    const d = f.data;
    const step = f.width * f.height > 200_000 ? 8 : 4;
    for (let i = 0; i < d.length; i += step) hist[key(d[i]!, d[i + 1]!, d[i + 2]!)]!++;
  }
  const cells: number[] = [];
  for (let k = 0; k < hist.length; k++) if (hist[k]) cells.push(k);
  const ch = (k: number, c: number) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const boxes: number[][] = cells.length ? [cells] : [[0]];
  while (boxes.length < max) {
    // boîte la plus « étendue » (pondérée par le nombre de pixels)
    let best = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      let w = 0;
      const lo = [31, 31, 31], hi = [0, 0, 0];
      for (const k of b) {
        w += hist[k]!;
        for (let c = 0; c < 3; c++) (lo[c] = Math.min(lo[c]!, ch(k, c))), (hi[c] = Math.max(hi[c]!, ch(k, c)));
      }
      const r = [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];
      const c = r.indexOf(Math.max(...r));
      const score = r[c]! * Math.sqrt(w);
      if (score > bestScore) (bestScore = score), (best = i), (bestCh = c);
    });
    if (best < 0) break;
    const b = boxes[best]!.sort((x, y) => ch(x, bestCh) - ch(y, bestCh));
    let total = 0;
    for (const k of b) total += hist[k]!;
    let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) {
      acc += hist[b[i]!]!;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(best, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map((b) => {
    let w = 0, r = 0, g = 0, bl = 0;
    for (const k of b) {
      const n = hist[k]! || 1;
      w += n;
      r += ((k >> 10) * 8 + 4) * n;
      g += (((k >> 5) & 31) * 8 + 4) * n;
      bl += ((k & 31) * 8 + 4) * n;
    }
    return [Math.round(r / w), Math.round(g / w), Math.round(bl / w)];
  });
}

function indexer(palette: number[][]): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const k = key(r, g, b);
    let i = cache[k]!;
    if (i >= 0) return i;
    let bestD = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const p = palette[j]!;
      const d = (p[0]! - r) ** 2 + (p[1]! - g) ** 2 + (p[2]! - b) ** 2;
      if (d < bestD) (bestD = d), (i = j);
    }
    cache[k] = i;
    return i;
  };
}

class Bytes {
  buf = new Uint8Array(1 << 16);
  n = 0;
  push(...v: number[]): void {
    for (const b of v) {
      if (this.n >= this.buf.length) {
        const nb = new Uint8Array(this.buf.length * 2);
        nb.set(this.buf);
        this.buf = nb;
      }
      this.buf[this.n++] = b;
    }
  }
  u16(v: number): void {
    this.push(v & 255, (v >> 8) & 255);
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

/** Compression LZW d'indices 8 bits, renvoie les sous-blocs GIF (≤ 255 octets). */
function lzw(indices: Uint8Array, out: Bytes): void {
  const minSize = 8, clear = 256, eoi = 257;
  let size = minSize + 1, next = 258;
  let dict = new Map<number, number>();
  const block: number[] = [];
  let acc = 0, bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      block.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) out.push(255, ...block.splice(0));
    }
  };
  out.push(minSize);
  emit(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]!;
    const k = (prefix << 8) | c;
    const hit = dict.get(k);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(k, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      size = minSize + 1;
      next = 258;
    }
    prefix = c;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(acc & 255);
  while (block.length) {
    const part = block.splice(0, 255);
    out.push(part.length, ...part);
  }
  out.push(0);
}

/** GIF animé en boucle ; `delayMs` entre images. */
export function encodeGif(frames: GifFrame[], delayMs = 100): Uint8Array {
  if (!frames.length) throw new Error('Aucune image à encoder.');
  const { width, height } = frames[0]!;
  const palette = buildPalette(frames);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const idx = indexer(palette);
  const o = new Bytes();
  o.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  o.u16(width);
  o.u16(height);
  o.push(0xf7, 0, 0); // palette globale 256 couleurs
  for (const p of palette) o.push(p[0]!, p[1]!, p[2]!);
  // boucle infinie (NETSCAPE2.0)
  o.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  const delay = Math.max(2, Math.round(delayMs / 10));
  const ind = new Uint8Array(width * height);
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error('Images de tailles différentes.');
    const d = f.data;
    for (let i = 0, j = 0; i < ind.length; i++, j += 4) ind[i] = idx(d[j]!, d[j + 1]!, d[j + 2]!);
    o.push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0);
    o.push(0x2c);
    o.u16(0);
    o.u16(0);
    o.u16(width);
    o.u16(height);
    o.push(0);
    lzw(ind, o);
  }
  o.push(0x3b);
  return o.out();
}
