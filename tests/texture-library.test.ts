/** Xylform CAD 1.6.0 : bibliothèque de matériaux réalistes, relief et rugosité des textures. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reliefPercent } from '../src/core/render';
import { heightFromPhoto, LIBRARY_CATEGORIES, LIBRARY_TEXTURES, libraryTexture, libraryUrl, normalsFromHeight, searchLibrary } from '../src/core/textureLibrary';
import data from '../src/core/textureLibrary.data.json';

const PUBLIC = join(__dirname, '..', 'public');

/** Largeur et hauteur d'une image WebP (en-têtes VP8, VP8L et VP8X). */
function webpSize(buf: Buffer): { w: number; h: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
}

describe('bibliothèque de matériaux', () => {
  it('une cinquantaine de matériaux, toutes les catégories remplies, identifiants uniques', () => {
    expect(LIBRARY_TEXTURES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(LIBRARY_TEXTURES.map((t) => t.id)).size).toBe(LIBRARY_TEXTURES.length);
    for (const c of LIBRARY_CATEGORIES) expect(LIBRARY_TEXTURES.some((t) => t.category === c.id)).toBe(true);
    // chaque matériau généré est au catalogue (et inversement)
    expect(Object.keys(data).sort()).toEqual(LIBRARY_TEXTURES.map((t) => t.id).sort());
    for (const id of ['pelouse', 'carreaux_platre', 'ciment_lisse', 'macadam', 'platre_lisse', 'chene', 'pierre_bleue_adoucie']) expect(libraryTexture(id)).toBeDefined();
  });

  it('les quatre images de chaque matériau sont livrées, aux bonnes proportions', () => {
    for (const t of LIBRARY_TEXTURES) {
      for (const f of ['couleur', 'hauteur', 'rugosite', 'vignette'] as const) {
        const p = join(PUBLIC, libraryUrl(t.id, f));
        expect(existsSync(p), p).toBe(true);
        expect(statSync(p).size).toBeLessThan(700_000);
      }
      const c = webpSize(readFileSync(join(PUBLIC, libraryUrl(t.id, 'couleur'))));
      expect(c.w).toBe(1024);
      expect(c.h / c.w).toBeCloseTo(t.height / t.size, 2);
      const h = webpSize(readFileSync(join(PUBLIC, libraryUrl(t.id, 'hauteur'))));
      expect(h.w / h.h).toBeCloseTo(c.w / c.h, 1);
      expect(t.size).toBeGreaterThan(0);
      expect(t.relief).toBeGreaterThan(0);
      expect(t.metalness).toBeGreaterThanOrEqual(0);
    }
  });

  it('taille réelle : un carreau de 20 cm fait 20 cm (4 carreaux sur 80 cm)', () => {
    expect(libraryTexture('carrelage_blanc')!.size).toBe(800);
    expect(libraryTexture('carreaux_platre')!.size).toBe(1332);
    expect(libraryTexture('carreaux_platre')!.height).toBeCloseTo(1000, -1);
  });

  it('recherche sans accents ni majuscules, par nom, mot-clé ou catégorie', () => {
    expect(searchLibrary('pelouse').map((t) => t.id)).toContain('pelouse');
    expect(searchLibrary('PIERRE BLEUE').map((t) => t.id)).toEqual(['pierre_bleue_adoucie', 'pierre_bleue_bouchardee']);
    expect(searchLibrary('asphalte').map((t) => t.id)).toEqual(['macadam']);
    expect(searchLibrary('beton').length).toBeGreaterThanOrEqual(5);
    expect(searchLibrary('', 'bois').every((t) => t.category === 'bois')).toBe(true);
    expect(searchLibrary('platre').map((t) => t.id)).toContain('carreaux_platre');
  });
});

describe('relief des textures', () => {
  it('surface plane : normale droite', () => {
    const n = normalsFromHeight(new Uint8Array(16).fill(90), 4, 4, 5, 1);
    for (let i = 0; i < 16; i++) expect([n[i * 4], n[i * 4 + 1], n[i * 4 + 2], n[i * 4 + 3]]).toEqual([128, 128, 255, 255]);
  });

  it('pente : la normale penche du côté qui descend, raccord sur les bords', () => {
    // hauteur qui monte avec x (dents de scie raccordées : 0, 85, 170, 255)
    const w = 4, h = 2;
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x * 85;
    const n = normalsFromHeight(g, w, h, 1, 1);
    expect(n[1 * 4]).toBeLessThan(128); // pente montante en x : normale vers −x
    expect(n[1 * 4 + 1]).toBe(128);
    expect(n[0]).toBeGreaterThan(128); // bord gauche : voisin de gauche = 255 (raccord)
    // même pente vue en y
    const t = new Uint8Array(w * h * 2);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) t[y * 2 + x] = y * 85;
    const m = normalsFromHeight(t, 2, 4, 1, 1);
    expect(m[(1 * 2) * 4 + 1]).toBeLessThan(128);
  });

  it('plus de profondeur ou des pixels plus petits = pente plus forte', () => {
    const g = new Uint8Array([0, 128, 255, 128]);
    const a = normalsFromHeight(g, 4, 1, 1, 1)[1 * 4]!;
    const b = normalsFromHeight(g, 4, 1, 4, 1)[1 * 4]!;
    const c = normalsFromHeight(g, 4, 1, 1, 0.25)[1 * 4]!;
    expect(b).toBeLessThan(a);
    expect(c).toBe(b);
  });

  it('photo importée : relief tiré des contrastes locaux, sans l’éclairage d’ensemble', () => {
    const w = 32, h = 32;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // dégradé lent (éclairage de la photo) + damier fin (matière)
        const v = 40 + x * 4 + ((x >> 1) + (y >> 1)) % 2 * 30;
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
    const g = heightFromPhoto(rgba, w, h);
    expect(Math.max(...g)).toBe(255);
    expect(Math.min(...g)).toBe(0);
    // case claire du damier plus haute que la case sombre voisine, malgré le dégradé
    // (x = 10 : case claire, x = 12 : case sombre plus à droite, donc plus éclairée par le dégradé)
    expect(g[0 * w + 10]!).toBeGreaterThan(g[0 * w + 12]!);
    expect(g[2 * w + 10]!).toBeLessThan(g[0 * w + 10]!);
    const flat = heightFromPhoto(new Uint8Array(w * h * 4).fill(120), w, h);
    expect(new Set(flat).size).toBe(1);
  });

  it('relief par défaut : 100 % pour la bibliothèque, lisse pour une image importée', () => {
    expect(reliefPercent({}, { library: 'pelouse' })).toBe(100);
    expect(reliefPercent({}, {})).toBe(0);
    expect(reliefPercent({ relief: 50 }, {})).toBe(50);
    expect(reliefPercent({ relief: 9999 }, undefined)).toBe(400);
    expect(reliefPercent({ relief: -3 }, { library: 'x' })).toBe(0);
  });
});
