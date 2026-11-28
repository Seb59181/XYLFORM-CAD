/**
 * BIM : classes IFC que Xylform CAD sait écrire et relire (mur, dalle, poteau…), noms français,
 * et classement automatique d'un solide d'après son nom, son calque ou ses proportions.
 */

export type IfcClass =
  | 'IfcWall'
  | 'IfcSlab'
  | 'IfcColumn'
  | 'IfcBeam'
  | 'IfcRoof'
  | 'IfcDoor'
  | 'IfcWindow'
  | 'IfcStair'
  | 'IfcRailing'
  | 'IfcCovering'
  | 'IfcFooting'
  | 'IfcMember'
  | 'IfcPlate'
  | 'IfcFurnishingElement'
  | 'IfcBuildingElementProxy';

/** Informations BIM portées par un solide (classe choisie, identifiant IFC conservé). */
export interface BimInfo {
  /** Classe IFC ; absente = classement automatique à l'export. */
  cls?: IfcClass;
  /** GlobalId IFC (22 caractères) : gardé à l'import pour que le même élément garde le même identifiant. */
  guid?: string;
  /** Nom du matériau lu dans le fichier IFC (réécrit tel quel à l'export). */
  material?: string;
}

export const IFC_CLASSES: { cls: IfcClass; label: string; keyword: string; words: string[] }[] = [
  { cls: 'IfcWall', label: 'Mur', keyword: 'Mur', words: ['mur', 'cloison', 'voile', 'wall', 'refend'] },
  { cls: 'IfcSlab', label: 'Dalle / plancher', keyword: 'Dalle', words: ['dalle', 'plancher', 'chape', 'radier', 'slab', 'sol'] },
  { cls: 'IfcColumn', label: 'Poteau', keyword: 'Poteau', words: ['poteau', 'pilier', 'colonne', 'column'] },
  { cls: 'IfcBeam', label: 'Poutre', keyword: 'Poutre', words: ['poutre', 'linteau', 'solive', 'panne', 'beam'] },
  { cls: 'IfcRoof', label: 'Toiture', keyword: 'Toiture', words: ['toit', 'toiture', 'couverture', 'roof'] },
  { cls: 'IfcDoor', label: 'Porte', keyword: 'Porte', words: ['porte', 'door'] },
  { cls: 'IfcWindow', label: 'Fenêtre', keyword: 'Fenetre', words: ['fenetre', 'baie', 'vitrage', 'window', 'velux', 'chassis'] },
  { cls: 'IfcStair', label: 'Escalier', keyword: 'Escalier', words: ['escalier', 'marche', 'stair'] },
  { cls: 'IfcRailing', label: 'Garde-corps', keyword: 'Garde-corps', words: ['garde-corps', 'gardecorps', 'rambarde', 'balustrade', 'main courante', 'railing'] },
  { cls: 'IfcCovering', label: 'Revêtement', keyword: 'Revetement', words: ['revetement', 'plafond', 'faux-plafond', 'carrelage', 'parquet', 'isolant', 'isolation', 'covering'] },
  { cls: 'IfcFooting', label: 'Fondation', keyword: 'Fondation', words: ['fondation', 'semelle', 'longrine', 'footing'] },
  { cls: 'IfcMember', label: 'Ossature (montant, chevron)', keyword: 'Ossature', words: ['montant', 'chevron', 'ossature', 'lambourde', 'tasseau', 'member'] },
  { cls: 'IfcPlate', label: 'Plaque / panneau', keyword: 'Plaque', words: ['plaque', 'panneau', 'tole', 'plate'] },
  { cls: 'IfcFurnishingElement', label: 'Mobilier', keyword: 'Mobilier', words: ['meuble', 'mobilier', 'table', 'chaise', 'armoire', 'placard', 'furniture'] },
  { cls: 'IfcBuildingElementProxy', label: 'Élément générique', keyword: 'Generique', words: [] },
];

export const ifcLabel = (cls: string | undefined): string => IFC_CLASSES.find((c) => c.cls === cls)?.label ?? 'Élément générique';
export const isIfcClass = (s: string): s is IfcClass => IFC_CLASSES.some((c) => c.cls === s);

/** Minuscules sans accents (comparaison des noms). */
export const plain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Classe déduite d'un texte (nom du solide, nom du calque) ; undefined si aucun mot connu. */
export function classFromText(text: string): IfcClass | undefined {
  const t = plain(text);
  for (const c of IFC_CLASSES) {
    for (const w of c.words) {
      // mot entier, au pluriel éventuellement (« murs », « poteaux ») ; « Solide 3 » n'est pas un sol
      const re = new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, '[-\\s_]?')}(s|x)?([^a-z]|$)`);
      if (re.test(t)) return c.cls;
    }
  }
  return undefined;
}

/**
 * Classe déduite des proportions (dimensions en mm : `a` et `b` horizontales, `h` verticale ;
 * `fill` = volume / volume de la boîte englobante). Un solide trop creux ou trop irrégulier reste
 * un élément générique.
 */
export function classFromShape(a: number, b: number, h: number, fill: number): IfcClass {
  const L = Math.max(a, b), W = Math.min(a, b);
  if (!(L > 0 && W > 0 && h > 0) || fill < 0.6) return 'IfcBuildingElementProxy';
  // dalle : mince à l'horizontale
  if (h <= 600 && h * 4 <= W) return 'IfcSlab';
  // mur : mince, long et haut
  if (W <= 800 && L >= 3 * W && h >= 3 * W && h >= 1000) return 'IfcWall';
  // poteau : élancé à la verticale
  if (L <= 1500 && h >= 3 * L && h >= 1000) return 'IfcColumn';
  // poutre : élancée à l'horizontale
  if (W <= 1500 && h <= 1500 && L >= 4 * Math.max(W, h) && L >= 1000) return 'IfcBeam';
  return 'IfcBuildingElementProxy';
}

/** Classe d'un solide à l'export : choisie, sinon d'après le nom, le calque, puis la forme. */
export function classify(o: { cls?: string; name?: string; layer?: string; size: { a: number; b: number; h: number }; fill: number }): IfcClass {
  if (o.cls && isIfcClass(o.cls)) return o.cls;
  return classFromText(o.name ?? '') ?? classFromText(o.layer ?? '') ?? classFromShape(o.size.a, o.size.b, o.size.h, o.fill);
}

/** Calque proposé pour les éléments d'une classe IFC importée. */
export function layerForClass(ifcType: string): string {
  const c = IFC_CLASSES.find((k) => k.cls.toUpperCase() === ifcType.toUpperCase() || `${k.cls}STANDARDCASE`.toUpperCase() === ifcType.toUpperCase());
  if (c) return `IFC ${c.label}`;
  const t = ifcType.replace(/^Ifc/i, '');
  return `IFC ${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}`;
}

/** Classe IFC (casse du schéma) à partir du nom en majuscules que renvoie le lecteur. */
export function classFromType(ifcType: string): IfcClass | undefined {
  const up = ifcType.toUpperCase().replace(/STANDARDCASE$|ELEMENTEDCASE$/, '');
  return IFC_CLASSES.find((c) => c.cls.toUpperCase() === up)?.cls ?? (up === 'IFCFURNITURE' ? 'IfcFurnishingElement' : undefined);
}

// ---------------------------------------------------------------------------
// GlobalId IFC : 128 bits codés en 22 caractères (alphabet IFC)
// ---------------------------------------------------------------------------

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export function ifcGuid(random: () => number = Math.random): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues && random === Math.random) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256) & 255;
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // UUID v4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  // 2 bits puis 21 groupes de 6 bits
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 22; i++) {
    s = GUID_CHARS[Number(n & 63n)]! + s;
    n >>= 6n;
  }
  return s;
}

export const isIfcGuid = (s: unknown): s is string => typeof s === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(s);
