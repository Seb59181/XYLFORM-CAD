/**
 * Bibliothèque de matériaux réalistes livrée avec l'application : pelouse, carrelage, plâtre,
 * béton, macadam, bois, pierre bleue… Chaque matériau a, dans `public/textures/<id>/` :
 *  - couleur.webp  : image de couleur raccordable (1024 px de large) ;
 *  - hauteur.webp  : relief en niveaux de gris (blanc = haut), d'où la vue calcule l'éclairage
 *                    des joints, des brins d'herbe, des fibres du bois… ;
 *  - rugosite.webp : rugosité (blanc = mat, noir = poli) ;
 *  - vignette.webp : aperçu de la fenêtre de choix.
 *
 * Les images sont entièrement calculées (scripts/textures/generer.py) : aucune photo tierce.
 * Le tableau textureLibrary.data.json, écrit par ce script, donne la taille réelle d'une image
 * (mm) et la profondeur du relief (mm).
 */
import data from './textureLibrary.data.json';

export type LibraryCategory = 'sols' | 'beton' | 'platre' | 'pierre' | 'briques' | 'carrelage' | 'bois' | 'toiture' | 'metaux';

export const LIBRARY_CATEGORIES: { id: LibraryCategory; label: string }[] = [
  { id: 'sols', label: 'Sols extérieurs' },
  { id: 'beton', label: 'Béton et ciment' },
  { id: 'platre', label: 'Plâtre et enduits' },
  { id: 'pierre', label: 'Pierre' },
  { id: 'briques', label: 'Briques' },
  { id: 'carrelage', label: 'Carrelage' },
  { id: 'bois', label: 'Bois' },
  { id: 'toiture', label: 'Toiture et bardage' },
  { id: 'metaux', label: 'Métaux et divers' },
];

export interface LibraryTexture {
  id: string;
  label: string;
  category: LibraryCategory;
  /** Précision affichée sous le nom (format des éléments…). */
  detail?: string;
  /** Largeur réelle d'une image (mm) : taille du motif proposée. */
  size: number;
  /** Hauteur réelle d'une image (mm). */
  height: number;
  /** Profondeur du relief codé dans hauteur.webp (mm, du plus bas au plus haut). */
  relief: number;
  /** Matière métallique (0–1) ; la rugosité vient de l'image. */
  metalness: number;
  /** Mots de recherche supplémentaires. */
  keywords?: string;
}

type Entry = Omit<LibraryTexture, 'size' | 'height' | 'relief'>;

const ENTRIES: Entry[] = [
  // 1. Sols extérieurs
  { id: 'pelouse', label: 'Pelouse', category: 'sols', detail: 'Gazon tondu', metalness: 0, keywords: 'herbe gazon jardin' },
  { id: 'herbe_haute', label: 'Herbe haute', category: 'sols', detail: 'Prairie, herbe non tondue', metalness: 0, keywords: 'pre prairie champ' },
  { id: 'terre', label: 'Terre', category: 'sols', detail: 'Terre meuble avec cailloux', metalness: 0, keywords: 'sol jardin potager' },
  { id: 'gravier', label: 'Gravier', category: 'sols', detail: 'Gravillons 10–15 mm', metalness: 0, keywords: 'cailloux allee graviers' },
  { id: 'sable', label: 'Sable', category: 'sols', metalness: 0, keywords: 'plage' },
  { id: 'macadam', label: 'Macadam (enrobé)', category: 'sols', detail: 'Enrobé routier', metalness: 0, keywords: 'asphalte bitume goudron route parking' },
  { id: 'paves_beton', label: 'Pavés béton', category: 'sols', detail: '20 × 10 cm en chevrons', metalness: 0, keywords: 'paves autobloquants allee' },
  { id: 'paves_pierre', label: 'Pavés anciens', category: 'sols', detail: 'Pavés de pierre ≈ 10 cm', metalness: 0, keywords: 'paves granit rue' },
  { id: 'dalles_jardin', label: 'Dalles de jardin', category: 'sols', detail: '50 × 50 cm, joints herbe', metalness: 0, keywords: 'dalles beton lave terrasse' },
  // 2. Béton et ciment
  { id: 'ciment_lisse', label: 'Ciment lissé', category: 'beton', detail: 'Béton ciré, lissé à la truelle', metalness: 0, keywords: 'beton cire' },
  { id: 'beton_brut', label: 'Béton brut', category: 'beton', detail: 'Avec bulles de décoffrage', metalness: 0 },
  { id: 'beton_banche', label: 'Béton banché', category: 'beton', detail: 'Empreintes de planches, trous de banche', metalness: 0, keywords: 'coffrage planches' },
  { id: 'parpaing', label: 'Parpaing', category: 'beton', detail: 'Blocs 50 × 20 cm', metalness: 0, keywords: 'bloc beton agglo' },
  { id: 'chape', label: 'Chape', category: 'beton', detail: 'Chape de ciment talochée', metalness: 0, keywords: 'sol ciment' },
  // 3. Plâtre et enduits
  { id: 'platre_lisse', label: 'Plâtre lisse', category: 'platre', metalness: 0, keywords: 'mur blanc' },
  { id: 'carreaux_platre', label: 'Carreaux de plâtre', category: 'platre', detail: 'Cloison 66 × 50 cm', metalness: 0, keywords: 'cloison carreaux platre' },
  { id: 'plaque_platre', label: 'Plaque de plâtre', category: 'platre', detail: 'Plaques de 1,20 m, joints et vis enduits', metalness: 0, keywords: 'ba13 placo cloison' },
  { id: 'crepi', label: 'Crépi', category: 'platre', detail: 'Crépi de façade', metalness: 0, keywords: 'facade enduit' },
  { id: 'enduit_chaux', label: 'Enduit à la chaux', category: 'platre', metalness: 0, keywords: 'chaux facade' },
  // 4. Pierre
  { id: 'pierre_bleue_adoucie', label: 'Pierre bleue adoucie', category: 'pierre', detail: 'Petit granit poncé', metalness: 0, keywords: 'petit granit seuil' },
  { id: 'pierre_bleue_bouchardee', label: 'Pierre bleue bouchardée', category: 'pierre', detail: 'Surface martelée, antidérapante', metalness: 0, keywords: 'petit granit seuil terrasse' },
  { id: 'pierre_calcaire', label: 'Pierre de taille', category: 'pierre', detail: 'Calcaire, blocs 60 × 30 cm', metalness: 0, keywords: 'calcaire mur facade' },
  { id: 'moellons', label: 'Moellons', category: 'pierre', detail: 'Mur de pierres hourdées', metalness: 0, keywords: 'mur pierre seche' },
  { id: 'marbre_blanc', label: 'Marbre blanc', category: 'pierre', detail: 'Poli', metalness: 0, keywords: 'marbre' },
  { id: 'granit', label: 'Granit', category: 'pierre', detail: 'Poli', metalness: 0, keywords: 'plan de travail' },
  { id: 'ardoise', label: 'Ardoise', category: 'pierre', detail: 'Dalle clivée', metalness: 0, keywords: 'schiste' },
  // 5. Briques
  { id: 'brique_rouge', label: 'Brique rouge', category: 'briques', detail: '22 × 6,5 cm', metalness: 0, keywords: 'mur facade' },
  { id: 'brique_claire', label: 'Brique claire', category: 'briques', detail: '22 × 6,5 cm', metalness: 0, keywords: 'mur facade jaune' },
  { id: 'brique_blanche', label: 'Brique peinte en blanc', category: 'briques', metalness: 0, keywords: 'mur blanc' },
  // 6. Carrelage
  { id: 'carrelage_blanc', label: 'Carrelage blanc', category: 'carrelage', detail: '20 × 20 cm', metalness: 0, keywords: 'salle de bain cuisine' },
  { id: 'carrelage_gris', label: 'Carrelage gris grand format', category: 'carrelage', detail: '60 × 60 cm', metalness: 0, keywords: 'sol gres' },
  { id: 'faience_metro', label: 'Faïence métro', category: 'carrelage', detail: '15 × 7,5 cm biseautée', metalness: 0, keywords: 'credence cuisine' },
  { id: 'carreaux_ciment', label: 'Carreaux de ciment', category: 'carrelage', detail: '20 × 20 cm à motif', metalness: 0, keywords: 'motif ancien' },
  { id: 'mosaique', label: 'Mosaïque', category: 'carrelage', detail: 'Pâte de verre 2,5 cm', metalness: 0, keywords: 'piscine douche' },
  { id: 'tomettes', label: 'Tomettes', category: 'carrelage', detail: 'Terre cuite hexagonale 16 cm', metalness: 0, keywords: 'terre cuite hexagone' },
  // 7. Bois
  { id: 'chene', label: 'Chêne', category: 'bois', metalness: 0, keywords: 'bois massif' },
  { id: 'pin', label: 'Pin', category: 'bois', detail: 'Avec nœuds', metalness: 0, keywords: 'sapin resineux' },
  { id: 'noyer', label: 'Noyer', category: 'bois', metalness: 0, keywords: 'bois fonce' },
  { id: 'parquet_lames', label: 'Parquet à lames', category: 'bois', detail: 'Chêne, lames de 14 cm', metalness: 0, keywords: 'plancher sol' },
  { id: 'parquet_chevrons', label: 'Parquet bâtons rompus', category: 'bois', detail: 'Chêne, 7 × 42 cm', metalness: 0, keywords: 'chevrons sol' },
  { id: 'terrasse', label: 'Lames de terrasse', category: 'bois', detail: 'Bois exotique rainuré', metalness: 0, keywords: 'deck platelage' },
  { id: 'contreplaque', label: 'Contreplaqué', category: 'bois', detail: 'Bouleau', metalness: 0, keywords: 'panneau' },
  { id: 'osb', label: 'OSB', category: 'bois', detail: 'Panneau de copeaux orientés', metalness: 0, keywords: 'panneau aggloméré' },
  // 8. Toiture et bardage
  { id: 'tuiles', label: 'Tuiles', category: 'toiture', detail: 'Tuiles canal en terre cuite', metalness: 0, keywords: 'toit' },
  { id: 'ardoises_toit', label: 'Ardoises de toit', category: 'toiture', metalness: 0, keywords: 'toit couverture' },
  { id: 'zinc', label: 'Zinc à joint debout', category: 'toiture', detail: 'Bacs de 50 cm', metalness: 0.85, keywords: 'toit couverture metal' },
  { id: 'bardage_bois', label: 'Bardage bois', category: 'toiture', detail: 'Lames verticales grisées', metalness: 0, keywords: 'facade clin' },
  { id: 'tole_ondulee', label: 'Tôle ondulée', category: 'toiture', metalness: 0.9, keywords: 'abri hangar metal' },
  // 9. Métaux et divers
  { id: 'acier_rouille', label: 'Acier rouillé', category: 'metaux', detail: 'Acier corten', metalness: 0.35, keywords: 'corten rouille' },
  { id: 'tole_larmee', label: 'Tôle larmée', category: 'metaux', detail: 'Aluminium antidérapant', metalness: 1, keywords: 'tole striee alu' },
  { id: 'galvanise', label: 'Acier galvanisé', category: 'metaux', metalness: 1, keywords: 'zingue' },
  { id: 'moquette', label: 'Moquette', category: 'metaux', metalness: 0, keywords: 'tapis sol textile' },
  { id: 'cuir', label: 'Cuir', category: 'metaux', metalness: 0, keywords: 'siege' },
];

const DATA = data as Record<string, { size: number; height: number; relief: number }>;

export const LIBRARY_TEXTURES: LibraryTexture[] = ENTRIES.filter((e) => DATA[e.id]).map((e) => ({ ...e, ...DATA[e.id]! }));

export const libraryTexture = (id: string | undefined): LibraryTexture | undefined => (id ? LIBRARY_TEXTURES.find((t) => t.id === id) : undefined);

/** Adresse d'une image de la bibliothèque (servie avec l'application). */
export function libraryUrl(id: string, file: 'couleur' | 'hauteur' | 'rugosite' | 'vignette'): string {
  return `/textures/${id}/${file}.webp`;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Recherche par nom, précision, catégorie ou mot-clé (sans accents ni majuscules). */
export function searchLibrary(query: string, category?: LibraryCategory | 'all'): LibraryTexture[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return LIBRARY_TEXTURES.filter((t) => {
    if (category && category !== 'all' && t.category !== category) return false;
    if (!words.length) return true;
    const hay = fold(`${t.label} ${t.detail ?? ''} ${t.keywords ?? ''} ${LIBRARY_CATEGORIES.find((c) => c.id === t.category)?.label ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Carte de normales (RGBA, raccordable) d'un champ de hauteurs en niveaux de gris.
 * `depth` = profondeur (mm) représentée par l'écart noir → blanc ; `pixelMm` = taille d'un pixel
 * sur la pièce (mm). Convention : la ligne 0 de l'image correspond à v = 0 (images chargées
 * sans retournement), vert = pente selon +v.
 */
export function normalsFromHeight(gray: ArrayLike<number>, width: number, height: number, depth: number, pixelMm: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const k = depth / 255 / (2 * Math.max(pixelMm, 1e-9));
  for (let y = 0; y < height; y++) {
    const ym = ((y - 1 + height) % height) * width, yp = ((y + 1) % height) * width, y0 = y * width;
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width, xp = (x + 1) % width;
      const dx = (gray[y0 + xp]! - gray[y0 + xm]!) * k;
      const dy = (gray[yp + x]! - gray[ym + x]!) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y0 + x) * 4;
      out[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Relief tiré d'une photo importée : la luminance, débarrassée de ses variations lentes
 * (éclairage de la prise de vue), sert de hauteur. Renvoie des niveaux 0–255.
 */
export function heightFromPhoto(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  // moyenne locale (boîte raccordable, deux passes) : on retire les ombres larges de la photo
  const r = Math.max(2, Math.round(Math.min(width, height) / 24));
  const tmp = new Float32Array(n);
  const avg = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += lum[y * width + ((x + width) % width)]!;
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = s / (2 * r + 1);
      s += lum[y * width + ((x + r + 1) % width)]! - lum[y * width + ((x - r + width) % width)]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[((y + height) % height) * width + x]!;
    for (let y = 0; y < height; y++) {
      avg[y * width + x] = s / (2 * r + 1);
      s += tmp[((y + r + 1) % height) * width + x]! - tmp[((y - r + height) % height) * width + x]!;
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = lum[i]! - avg[i]!;
    lum[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Uint8Array(n);
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < n; i++) out[i] = Math.round(((lum[i]! - lo) / span) * 255);
  return out;
}
