/**
 * Analyseur des saisies texte pour un prompt donné.
 *
 * Syntaxes de points supportées (syntaxe classique des logiciels de CAO) :
 *   10,20          cartésien absolu (2D, z = élévation courante)
 *   10,20,5        cartésien absolu 3D
 *   @10,5          relatif au dernier point
 *   #10,5          absolu forcé (quand la saisie dynamique est en relatif par défaut)
 *   50<30          polaire absolu (distance<angle)
 *   @50<30         polaire relatif
 *   @50<30,10      cylindrique relatif (distance<angle,z)
 *   50<30<45       sphérique (distance<angle XY<angle depuis le plan XY)
 *   @              dernier point
 *   25             entrée directe de distance dans la direction du curseur
 *
 * Nombres : expressions arithmétiques simples (`2*(10+5)/3`), angles en degrés par défaut,
 * suffixes `d` (degrés), `r` (radians), `g` (grades).
 * Options : raccourci (majuscules du nom local), nom complet, préfixe unique, ou `_Global`.
 */
import type { Keyword, ParseError, PromptResult, PromptSpec, Vec3 } from './types';

export interface ParseEnv {
  lastPoint: Vec3;
  /** Élévation courante (variable ELEVATION) pour les saisies 2D. */
  elevation?: number;
  /** Direction normalisée base→curseur, pour l'entrée directe de distance. */
  cursorDirection?: Vec3;
  /** Saisie dynamique : les points secondaires sont relatifs par défaut (DYNPICOORDS = 0). */
  dynamicRelative?: boolean;
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Mots-clés
// ---------------------------------------------------------------------------

/** Raccourci d'une option : alias explicite, sinon les majuscules/chiffres du nom local. */
export function keywordAlias(k: Keyword): string {
  if (k.alias) return k.alias.toUpperCase();
  const caps = k.local.replace(/[^A-Z0-9]/g, '');
  return (caps || k.local).toUpperCase();
}

/** Formate la liste d'options : `[Centre/2P/3P/Ttr]`. */
export function formatKeywords(keywords: readonly Keyword[]): string {
  return keywords.length ? `[${keywords.map((k) => k.local).join('/')}]` : '';
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

export function matchKeyword(input: string, keywords: readonly Keyword[]): Keyword | ParseError | null {
  const raw = input.trim();
  if (!raw) return null;
  // `_Option` : nom global, indépendant de la langue (scripts, macros).
  if (raw.startsWith('_')) {
    const g = fold(raw.slice(1));
    return keywords.find((k) => fold(k.global) === g) ?? null;
  }
  const s = fold(raw);
  const exact = keywords.find((k) => keywordAlias(k) === s || fold(k.local) === s || fold(k.global) === s);
  if (exact) return exact;
  // Un nombre ("3") ne doit jamais être pris pour le préfixe d'une option ("3P").
  if (/^[\d.+\-]/.test(s)) return null;
  const prefixed = keywords.filter((k) => fold(k.local).startsWith(s));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) {
    return { kind: 'error', message: `Option ambiguë "${raw}" : ${prefixed.map((k) => k.local).join(', ')}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nombres et angles : petit évaluateur récursif descendant (pas d'eval()).
// ---------------------------------------------------------------------------

export function evaluateNumber(expr: string): number | null {
  const src = expr.replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];

  function parseExpr(): number {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function parseFactor(): number {
    const c = peek();
    if (c === '-') {
      i++;
      return -parseFactor();
    }
    if (c === '+') {
      i++;
      return parseFactor();
    }
    if (c === '(') {
      i++;
      const v = parseExpr();
      if (src[i++] !== ')') throw new Error('parenthèse');
      return v;
    }
    if (src.startsWith('pi', i) || src.startsWith('PI', i)) {
      i += 2;
      return Math.PI;
    }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new Error('nombre');
    i += m[0].length;
    return parseFloat(m[0]);
  }

  try {
    if (!src) return null;
    const v = parseExpr();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Angle en radians. Unités : degrés par défaut (ANGBASE = 0, ANGDIR = trigonométrique). */
export function evaluateAngle(text: string): number | null {
  const m = /^(.*?)([dDrRgG])?$/.exec(text.trim());
  if (!m) return null;
  const v = evaluateNumber(m[1]!);
  if (v === null) return null;
  switch (m[2]?.toLowerCase()) {
    case 'r':
      return v;
    case 'g':
      return (v * Math.PI) / 200;
    default:
      return v * DEG;
  }
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function parsePoint(text: string, env: ParseEnv): Vec3 | null {
  let s = text.trim();
  if (!s) return null;
  if (s === '@') return { ...env.lastPoint };

  let relative = env.dynamicRelative ?? false;
  if (s.startsWith('@')) {
    relative = true;
    s = s.slice(1);
  } else if (s.startsWith('#')) {
    relative = false;
    s = s.slice(1);
  }
  const elevation = relative ? 0 : (env.elevation ?? 0);
  let p: Vec3 | null = null;

  if (s.includes('<')) {
    // Polaire / cylindrique / sphérique
    const [distPart, ...angleParts] = s.split('<');
    const d = evaluateNumber(distPart!);
    if (d === null) return null;
    if (angleParts.length === 1) {
      const [angText, zText] = angleParts[0]!.split(',');
      const a = evaluateAngle(angText!);
      const z = zText !== undefined ? evaluateNumber(zText) : elevation;
      if (a === null || z === null) return null;
      p = { x: d * Math.cos(a), y: d * Math.sin(a), z };
    } else if (angleParts.length === 2) {
      const a = evaluateAngle(angleParts[0]!);
      const b = evaluateAngle(angleParts[1]!);
      if (a === null || b === null) return null;
      p = { x: d * Math.cos(b) * Math.cos(a), y: d * Math.cos(b) * Math.sin(a), z: d * Math.sin(b) };
    } else return null;
  } else if (s.includes(',')) {
    const parts = s.split(',').map(evaluateNumber);
    if (parts.length < 2 || parts.length > 3 || parts.some((v) => v === null)) return null;
    p = { x: parts[0]!, y: parts[1]!, z: parts[2] ?? elevation };
  } else {
    return null;
  }
  return relative ? add(env.lastPoint, p) : p;
}

// ---------------------------------------------------------------------------
// Point d'entrée : interprète une saisie pour un prompt
// ---------------------------------------------------------------------------

export function parseInput(text: string, spec: PromptSpec, env: ParseEnv): PromptResult | ParseError {
  const raw = text.trim();

  // Entrée vide : valeur par défaut, ou "aucune" si autorisé.
  if (!raw) {
    const d = spec.defaultValue;
    if (d !== undefined) {
      if (typeof d === 'number') return { kind: 'number', value: d };
      if (typeof d === 'string') {
        return spec.kind === 'string' ? { kind: 'string', value: d } : { kind: 'keyword', value: d };
      }
      return { kind: 'point', value: d };
    }
    if (spec.allowNone) return { kind: 'none' };
    return { kind: 'error', message: 'Une valeur est requise.' };
  }

  if (spec.kind === 'string') return { kind: 'string', value: text };

  // Les options passent avant tout le reste.
  if (spec.keywords?.length) {
    const kw = matchKeyword(raw, spec.keywords);
    if (kw && 'kind' in kw) return kw;
    if (kw) return { kind: 'keyword', value: kw.global };
    if (spec.kind === 'keyword') {
      return { kind: 'error', message: `Option inconnue. Choisissez ${formatKeywords(spec.keywords)}.` };
    }
  }

  switch (spec.kind) {
    case 'point': {
      const p = parsePoint(raw, env);
      if (p) return { kind: 'point', value: p };
      // Entrée directe de distance : un nombre seul + direction du curseur.
      const d = evaluateNumber(raw);
      if (d !== null && spec.basePoint && env.cursorDirection) {
        const u = env.cursorDirection;
        return { kind: 'point', value: add(spec.basePoint, { x: u.x * d, y: u.y * d, z: u.z * d }) };
      }
      return { kind: 'error', message: 'Point incorrect. Exemples : 10,20  @5,0  @25<45' };
    }
    case 'angle': {
      const a = evaluateAngle(raw);
      return a === null ? { kind: 'error', message: 'Angle incorrect.' } : { kind: 'number', value: a };
    }
    case 'distance':
    case 'real':
    case 'integer': {
      // Une distance peut aussi être donnée par un second point.
      if (spec.kind === 'distance' && spec.basePoint) {
        const p = parsePoint(raw, env);
        if (p) {
          const b = spec.basePoint;
          return { kind: 'number', value: Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) };
        }
      }
      const v = evaluateNumber(raw);
      if (v === null) return { kind: 'error', message: 'Nécessite un nombre ou une expression valide.' };
      if (spec.kind === 'integer' && !Number.isInteger(v)) return { kind: 'error', message: 'Nécessite un entier.' };
      if (v === 0 && spec.allowZero === false) return { kind: 'error', message: 'La valeur doit être non nulle.' };
      if (v < 0 && !spec.allowNegative) return { kind: 'error', message: 'La valeur doit être positive.' };
      return { kind: 'number', value: v };
    }
    case 'keyword':
      return { kind: 'error', message: 'Option inconnue.' };
    case 'selection':
      // Les mots-clés de sélection (F, P, D, Tous…) sont gérés plus haut ; le reste vient du viewport.
      return { kind: 'error', message: 'Sélectionnez des objets dans la zone de dessin.' };
    case 'entity':
      return { kind: 'error', message: 'Désignez un objet dans la zone de dessin.' };
  }
}

/** Ligne de prompt complète, ex. `Spécifiez le rayon du cercle ou [Diamètre] <10.0000>: `. */
export function formatPrompt(spec: PromptSpec, precision = 4): string {
  let s = spec.message;
  if (spec.keywords?.length) s += ` ou ${formatKeywords(spec.keywords)}`;
  const d = spec.defaultValue;
  if (d !== undefined) {
    const shown =
      typeof d === 'number'
        ? d.toFixed(precision)
        : typeof d === 'string'
          ? (spec.keywords?.find((k) => k.global === d)?.local ?? d)
          : `${d.x.toFixed(precision)},${d.y.toFixed(precision)},${d.z.toFixed(precision)}`;
    s += ` <${shown}>`;
  }
  return `${s}: `;
}
