/**
 * Registre des commandes : résolution des noms/alias et autocomplétion adaptative
 * (les commandes les plus utilisées remontent, comme AUTOCOMPLETE/INPUTSEARCHOPTIONS).
 */
import type { CommandDefinition } from './types';

export interface Suggestion {
  name: string;
  /** Texte effectivement inséré (nom localisé). */
  insert: string;
  description?: string;
  /** Alias ayant provoqué la correspondance, affiché en gris. */
  matchedAlias?: string;
  score: number;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

export class CommandRegistry {
  private readonly byKey = new Map<string, CommandDefinition>();
  private readonly defs: CommandDefinition[] = [];
  private readonly usage = new Map<string, number>();

  register(def: CommandDefinition): this {
    this.defs.push(def);
    for (const key of [def.name, def.localName, ...(def.aliases ?? [])]) {
      const k = fold(key);
      const existing = this.byKey.get(k);
      if (existing && existing !== def) throw new Error(`Nom de commande en double : ${key}`);
      this.byKey.set(k, def);
    }
    return this;
  }

  /**
   * Résout un nom saisi : `CERCLE`, `C`, `_CIRCLE` (nom global), `'ZOOM` (transparent),
   * `-CALQUE` (version ligne de commande sans boîte de dialogue, transmise via `dashed`).
   */
  resolve(input: string): { def: CommandDefinition; transparent: boolean; dashed: boolean } | null {
    let s = input.trim();
    const transparent = s.startsWith("'");
    if (transparent) s = s.slice(1);
    if (s.startsWith('_')) s = s.slice(1);
    const dashed = s.startsWith('-');
    if (dashed) s = s.slice(1);
    const def = this.byKey.get(fold(s));
    if (!def) return null;
    if (transparent && !def.transparent) return null;
    return { def, transparent, dashed };
  }

  recordUsage(def: CommandDefinition): void {
    this.usage.set(def.name, (this.usage.get(def.name) ?? 0) + 1);
  }

  /**
   * Autocomplétion : alias exact > préfixe du nom > préfixe d'alias > sous-chaîne > sous-séquence.
   * Chaque niveau est pondéré par la fréquence d'utilisation.
   */
  complete(prefix: string, limit = 8): Suggestion[] {
    const q = fold(prefix.trim().replace(/^[_']/, ''));
    if (!q) return [];
    const out: Suggestion[] = [];
    for (const def of this.defs) {
      const name = fold(def.localName);
      const aliases = (def.aliases ?? []).map(fold);
      let score = 0;
      let matchedAlias: string | undefined;
      if (aliases.includes(q)) {
        score = 1000;
        matchedAlias = q;
      } else if (name.startsWith(q) || fold(def.name).startsWith(q)) score = 800 - name.length;
      else if ((matchedAlias = aliases.find((a) => a.startsWith(q)))) score = 600;
      else if (name.includes(q)) score = 400;
      else if (isSubsequence(q, name)) score = 200;
      if (!score) continue;
      score += Math.min(150, 10 * (this.usage.get(def.name) ?? 0));
      out.push({ name: def.name, insert: def.localName, description: def.description, matchedAlias, score });
    }
    return out.sort((a, b) => b.score - a.score || a.insert.localeCompare(b.insert)).slice(0, limit);
  }

  all(): readonly CommandDefinition[] {
    return this.defs;
  }
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i++;
  return i === needle.length;
}

/** Historique navigable (flèches haut/bas), filtré par le préfixe en cours de saisie. */
export class CommandHistory {
  private readonly items: string[] = [];
  private cursor = -1;
  private filter = '';

  constructor(private readonly capacity = 500) {}

  push(line: string): void {
    const s = line.trim();
    if (!s) return;
    if (this.items[this.items.length - 1] !== s) this.items.push(s);
    if (this.items.length > this.capacity) this.items.shift();
    this.reset();
  }

  reset(): void {
    this.cursor = -1;
    this.filter = '';
  }

  /** Entrée précédente commençant par `typed` (fixé au premier appui). */
  previous(typed = ''): string | undefined {
    if (this.cursor === -1) this.filter = fold(typed);
    for (let i = (this.cursor === -1 ? this.items.length : this.cursor) - 1; i >= 0; i--) {
      if (fold(this.items[i]!).startsWith(this.filter)) {
        this.cursor = i;
        return this.items[i];
      }
    }
    return this.cursor === -1 ? undefined : this.items[this.cursor];
  }

  next(): string | undefined {
    if (this.cursor === -1) return undefined;
    for (let i = this.cursor + 1; i < this.items.length; i++) {
      if (fold(this.items[i]!).startsWith(this.filter)) {
        this.cursor = i;
        return this.items[i];
      }
    }
    this.cursor = -1;
    return '';
  }

  entries(): readonly string[] {
    return this.items;
  }
}
