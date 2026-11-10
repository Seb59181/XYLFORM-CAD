/**
 * Raccourcis clavier personnalisés (PERSONNALISER) : combinaison normalisée « Ctrl+Maj+B »,
 * « Alt+3 », « F5 »… → commande. Les lettres seules restent réservées à la ligne de commande.
 */

/** Combinaison d'une frappe ; null pour une touche de modification seule. */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
  let k: string;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5); // rangée des chiffres (AZERTY : & é " …)
  else if (/^Numpad\d$/.test(e.code)) k = `Pavé${e.code.slice(6)}`;
  else if (e.key.length === 1) k = e.key.toUpperCase();
  else k = KEY_NAMES[e.key] ?? e.key;
  const parts = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Maj' : '', k].filter(Boolean);
  return parts.join('+');
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Espace',
  ArrowUp: 'Haut',
  ArrowDown: 'Bas',
  ArrowLeft: 'Gauche',
  ArrowRight: 'Droite',
  Insert: 'Inser',
  Delete: 'Suppr',
  Home: 'Début',
  End: 'Fin',
  PageUp: 'PgPréc',
  PageDown: 'PgSuiv',
};

/** Raccourcis intégrés (remplaçables, mais l'utilisateur est prévenu). */
export const BUILTIN: Record<string, string> = {
  F1: 'Aide',
  F2: 'Historique de la ligne de commande',
  F3: 'Accrochage aux objets',
  F7: 'Grille',
  F8: 'Ortho',
  F9: 'Résolution',
  F10: 'Polaire',
  F11: 'Repérage des objets',
  F12: 'Saisie dynamique',
  'Ctrl+Z': 'Annuler',
  'Ctrl+Y': 'Rétablir',
  'Ctrl+Maj+Z': 'Rétablir',
  'Ctrl+S': 'Enregistrer',
  'Ctrl+Maj+S': 'Enregistrer sous',
  'Ctrl+O': 'Ouvrir',
  'Ctrl+N': 'Nouveau',
  'Ctrl+A': 'Tout sélectionner',
  'Ctrl+C': 'Copier',
  'Ctrl+X': 'Couper',
  'Ctrl+V': 'Coller',
  'Ctrl+1': 'Propriétés',
};

/** Raison pour laquelle une combinaison n'est pas utilisable, sinon null. */
export function comboProblem(combo: string): string | null {
  const parts = combo.split('+');
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const fkey = /^F\d{1,2}$/.test(key);
  if (!mods.some((m) => m === 'Ctrl' || m === 'Alt') && !fkey) return 'Ajoutez Ctrl ou Alt (une lettre seule sert à taper les commandes), ou utilisez une touche F1 à F12.';
  if (['Escape', 'Enter', 'Tab', 'Backspace'].includes(key)) return 'Touche réservée.';
  return null;
}
