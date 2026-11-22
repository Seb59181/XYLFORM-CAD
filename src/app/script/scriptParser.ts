/**
 * Lecture des scripts de commandes (.xscr, .scr, .txt) : une commande par ligne, suivie de ses
 * réponses séparées par des espaces, exactement comme on les taperait dans la ligne de commande.
 *
 *   ; commentaire (ou // commentaire)
 *   plaque = BOITE 0,0,0 100,60,8          ← « nom = » nomme les objets créés par la commande
 *   trou = CYLINDRE 20,30,-1 4 10
 *   SOUSTRACTION $plaque $trou             ← « $nom » désigne des objets nommés
 *   TEXTE 0,0 5 0 "Deux mots"              ← guillemets : réponse qui contient des espaces
 *   LIGNE 0,0 50,0 50,30 ""                ← "" = touche Entrée
 *
 * Une ligne qui finit par « \ » continue sur la suivante.
 */

export interface ScriptLine {
  /** Numéro de la première ligne dans le fichier (à partir de 1). */
  line: number;
  /** Texte d'origine (sans commentaire). */
  text: string;
  /** Nom donné aux objets créés (`nom = COMMANDE …`). */
  name?: string;
  /** Commande (premier mot). */
  command: string;
  /** Réponses aux invites, dans l'ordre. "" = Entrée. */
  args: string[];
}

export interface ScriptParseError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedScript {
  lines: ScriptLine[];
  errors: ScriptParseError[];
}

/** Nom d'objet de script : lettre ou _, puis lettres, chiffres, _ (accents permis). */
export const NAME_RE = /^[A-Za-z_À-ÿ][\wÀ-ÿ]*$/;

/** Retire un commentaire (`;` ou `//`) qui n'est pas entre guillemets. */
function stripComment(s: string): string {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === ';' || (c === '/' && s[i + 1] === '/'))) return s.slice(0, i);
  }
  return s;
}

/** Découpe une ligne en mots ; les guillemets gardent les espaces (`""` = Entrée, `\"` = guillemet). */
export function tokenize(s: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && s[j + 1] === '"') {
          out += '"';
          j += 2;
        } else out += s[j++];
      }
      if (j >= s.length) return { tokens, error: 'Guillemet non refermé.' };
      tokens.push(out);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    tokens.push(s.slice(i, j));
    i = j;
  }
  return { tokens };
}

export function parseScript(source: string): ParsedScript {
  const raw = source.replace(/^﻿/, '').split(/\r?\n/);
  const lines: ScriptLine[] = [];
  const errors: ScriptParseError[] = [];
  for (let i = 0; i < raw.length; i++) {
    const start = i + 1;
    let text = stripComment(raw[i]!).trim();
    // continuation « \ » en fin de ligne
    while (text.endsWith('\\') && i + 1 < raw.length) {
      text = `${text.slice(0, -1)} ${stripComment(raw[++i]!).trim()}`.trim();
    }
    if (!text) continue;
    let name: string | undefined;
    const m = /^([^\s=]+)\s*=\s*(.*)$/.exec(text);
    if (m && !m[1]!.includes(',') && !m[1]!.startsWith('$')) {
      if (!NAME_RE.test(m[1]!)) {
        errors.push({ line: start, text, message: `Nom « ${m[1]} » incorrect : lettres, chiffres et _ seulement, sans espace.` });
        continue;
      }
      name = m[1]!;
      text = m[2]!.trim();
      if (!text) {
        errors.push({ line: start, text: raw[i]!.trim(), message: `Aucune commande après « ${name} = ».` });
        continue;
      }
    }
    const { tokens, error } = tokenize(text);
    if (error) {
      errors.push({ line: start, text, message: error });
      continue;
    }
    const [command, ...args] = tokens;
    if (!command) continue;
    lines.push({ line: start, text, name, command, args });
  }
  return { lines, errors };
}
