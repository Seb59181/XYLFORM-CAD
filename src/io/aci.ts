/**
 * Index de couleur DXF (ACI 1–255) ↔ RVB. Les 9 premières couleurs sont fixes ; 10–249
 * suivent la roue de couleurs DXF (24 teintes × 5 luminosités × 2 saturations) ; 250–255 sont des gris.
 */

function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export const ACI: [number, number, number][] = (() => {
  const t: [number, number, number][] = new Array(256);
  t[0] = [0, 0, 0];
  const fixed: [number, number, number][] = [
    [255, 0, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 255, 255],
    [0, 0, 255],
    [255, 0, 255],
    [255, 255, 255],
    [128, 128, 128],
    [192, 192, 192],
  ];
  fixed.forEach((c, i) => (t[i + 1] = c));
  const values = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];
  for (let i = 10; i < 250; i++) {
    const h = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    t[i] = hsv(h, k % 2 === 0 ? 1 : 0.5, values[k]!);
  }
  const grays = [51, 91, 132, 173, 214, 255];
  grays.forEach((g, i) => (t[250 + i] = [g, g, g]));
  return t;
})();

export function aciToHex(i: number): string {
  const c = ACI[Math.max(1, Math.min(255, Math.abs(i)))] ?? [255, 255, 255];
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1]!, 16) : 0xffffff;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Couleur ACI la plus proche (distance pondérée perceptuelle). */
export function hexToAci(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  let best = 7, bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = ACI[i]!;
    const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bestD) (bestD = d), (best = i);
  }
  return best;
}

export const trueColorToHex = (v: number) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
export const hexToTrueColor = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return (r << 16) | (g << 8) | b;
};
