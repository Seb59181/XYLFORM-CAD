/**
 * Types du système de commandes .
 *
 * Une commande est une coroutine asynchrone : elle émet des "prompts" (demande de point,
 * de distance, de mot-clé…) et attend une réponse qui peut venir indifféremment de la
 * ligne de commande, de la saisie dynamique au curseur (Dynamic Input) ou d'un clic
 * dans le viewport. Le parseur ne connaît donc que du texte ; le viewport injecte
 * directement des `PromptResult` de type `point`.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Option de commande, ex. `{ global: 'TTR', local: 'Ttr', alias: 'T' }`. */
export interface Keyword {
  /** Nom invariant (indépendant de la langue), utilisé dans le code de la commande. */
  global: string;
  /** Nom affiché. Les majuscules définissent le raccourci (ex. "Centre" → "C"). */
  local: string;
  /** Raccourci explicite ; sinon dérivé des majuscules de `local`. */
  alias?: string;
  /** Texte d'aide affiché dans l'autocomplétion. */
  description?: string;
}

export type PromptKind = 'point' | 'distance' | 'angle' | 'integer' | 'real' | 'keyword' | 'string' | 'selection' | 'entity';

/** Ce que le clic désigne pendant un prompt `entity` : un objet, une arête ou une face de solide. */
export type PickMode = 'entity' | 'edge' | 'face';

/** Objet désigné : handle, point cliqué, et index d'arête/face B-rep le cas échéant. */
export interface EntityPick {
  handle: string;
  point: Vec3;
  sub?: number;
}

export interface PromptSpec {
  kind: PromptKind;
  /** Message affiché, ex. "Spécifiez le centre du cercle". */
  message: string;
  keywords?: Keyword[];
  /** Valeur proposée entre chevrons `<10.0000>` et renvoyée sur Entrée. */
  defaultValue?: number | string | Vec3;
  /** Point de base (pour l'élastique, `@` relatif et les distances saisies au curseur). */
  basePoint?: Vec3;
  /** Entrée vide autorisée (renvoie `none`), ex. fin de LIGNE. */
  allowNone?: boolean;
  /** Contraintes de valeur numérique. */
  allowNegative?: boolean;
  allowZero?: boolean;
  /** Prompts `entity` : nature de l'élément à désigner. */
  pickMode?: PickMode;
  /** Prompts `entity` / `selection` : objets acceptés. */
  filter?: (handle: string) => boolean;
  /** Aperçu dynamique : polylignes dessinées en fonction du curseur. */
  preview?: (cursor: Vec3) => Vec3[][];
  /** Hauteur : le curseur glisse sur la verticale passant par `basePoint` (valeur signée). */
  vertical?: boolean;
  /** Distance le long d'un axe quelconque passant par `basePoint` (ex. normale d'une face). */
  axis?: Vec3;
  /** Courbe plane (polyligne, spline) : le point reste à la hauteur Z de `basePoint`. */
  planar?: boolean;
  /** Désactive l'élastique par défaut (ligne point de base → curseur). */
  noRubberBand?: boolean;
}

/** Axe de glissement du curseur (unitaire) d'un prompt de hauteur ou de distance axiale. */
export function promptAxis(spec: PromptSpec | null | undefined): Vec3 | undefined {
  if (!spec) return undefined;
  const a = spec.axis ?? (spec.vertical ? { x: 0, y: 0, z: 1 } : undefined);
  if (!a) return undefined;
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export type PromptResult =
  | { kind: 'point'; value: Vec3 }
  | { kind: 'number'; value: number }
  | { kind: 'keyword'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'entity'; value: EntityPick }
  | { kind: 'selection'; value: string[] }
  | { kind: 'none' }
  | { kind: 'cancel' };

export interface ParseError {
  kind: 'error';
  message: string;
}

/** Contexte d'exécution passé à chaque commande. */
export interface CommandContext {
  prompt(spec: PromptSpec): Promise<PromptResult>;
  /** Message dans l'historique de la ligne de commande. */
  print(message: string): void;
  /** Dernier point saisi (variable système LASTPOINT), base du `@`. */
  readonly lastPoint: Vec3;
  /** Accès au document (base de données d'entités) — typé par l'application hôte. */
  readonly document: unknown;
  /** Signal d'annulation (Échap). */
  readonly signal: AbortSignal;
}

export interface CommandDefinition {
  /** Nom global (anglais), ex. "CIRCLE". Accessible avec le préfixe `_` : `_CIRCLE`. */
  name: string;
  /** Nom localisé, ex. "CERCLE". */
  localName: string;
  /** Alias PGP, ex. ["C"]. */
  aliases?: string[];
  description?: string;
  /** Commande transparente (utilisable en cours d'une autre avec `'`), ex. 'ZOOM. */
  transparent?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

export class CommandCancelled extends Error {
  constructor() {
    super('*Annuler*');
    this.name = 'CommandCancelled';
  }
}
