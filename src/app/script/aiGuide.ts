/**
 * Consigne à donner à une IA pour qu'elle écrive des scripts Xylform CAD : fiche de référence
 * (docs/scripts-ia.md) suivie de la liste complète des commandes de cette version.
 */
import guide from '../../../docs/scripts-ia.md?raw';
import type { CommandRegistry } from '../../core/commands';

export const AI_GUIDE = guide;

/** Liste des commandes : nom, alias, description (une ligne chacune). */
export function commandIndex(registry: CommandRegistry): string {
  return [...registry.all()]
    .filter((d) => d.description)
    .sort((a, b) => a.localName.localeCompare(b.localName, 'fr'))
    .map((d) => `- ${d.localName}${d.aliases?.length ? ` (${d.aliases.join(', ')})` : ''} — ${d.description}`)
    .join('\n');
}

/** Consigne complète (à coller au début d'une conversation avec une IA). */
export function buildAiGuide(registry: CommandRegistry, version?: string): string {
  return `${guide.trim()}\n\n## 7. Toutes les commandes${version ? ` (Xylform CAD ${version})` : ''}\n\n${commandIndex(registry)}\n`;
}
