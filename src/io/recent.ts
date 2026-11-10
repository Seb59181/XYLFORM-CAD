/**
 * Dessins récents (page Démarrage) : nom, chemin sur le disque (version bureau) et date, gardés
 * dans le stockage local. Dans le navigateur, sans chemin, un récent rouvre la boîte Ouvrir.
 */
export interface RecentFile {
  name: string;
  path?: string;
  time: number;
}

const KEY = 'sebcad.recent';
const MAX = 12;

export function recentFiles(): RecentFile[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentFile[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.name === 'string') : [];
  } catch {
    return [];
  }
}

const same = (a: RecentFile, b: { name: string; path?: string }) => (a.path && b.path ? a.path.toLowerCase() === b.path.toLowerCase() : !a.path && !b.path && a.name === b.name);

export function addRecent(name: string, path?: string): void {
  const entry: RecentFile = { name, ...(path ? { path } : {}), time: Date.now() };
  const list = [entry, ...recentFiles().filter((r) => !same(r, entry))].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible */
  }
}

export function removeRecent(r: RecentFile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentFiles().filter((x) => !same(x, r))));
  } catch {
    /* ignoré */
  }
}
