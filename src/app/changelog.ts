/**
 * Notes de version affichées par l'écran « Quoi de neuf » : extraites du CHANGELOG.md du dépôt
 * (sections `## x.y.z — date`), intégré à la compilation.
 */
import changelog from '../../CHANGELOG.md?raw';

export interface ReleaseNotes {
  version: string;
  date: string;
  /** Texte Markdown de la section (sans son titre). */
  body: string;
}

export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.0.0';

/** Sections publiées (les plus récentes d'abord). */
export function releases(text = changelog): ReleaseNotes[] {
  const out: ReleaseNotes[] = [];
  const re = /^## (\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const next = text.slice(start).search(/^(## |---\s*$)/m);
    const end = next < 0 ? (heads[i + 1]?.index ?? text.length) : start + next;
    out.push({ version: m[1]!, date: (m[2] ?? '').trim(), body: text.slice(start, end).trim() });
  });
  return out;
}

/** Compare deux versions x.y.z : < 0 si a est plus ancienne. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0), pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Notes des versions plus récentes que `since` (exclue) jusqu'à `upTo` (incluse). */
export function notesBetween(since: string | null, upTo = APP_VERSION, text = changelog): ReleaseNotes[] {
  const all = releases(text).filter((r) => compareVersions(r.version, upTo) <= 0);
  const newer = since ? all.filter((r) => compareVersions(r.version, since) > 0) : [];
  return newer.length ? newer : all.slice(0, 1);
}

const SEEN_KEY = 'xylform.lastSeenVersion';

/**
 * Faut-il afficher « Quoi de neuf » ? Oui une seule fois par version : la version vue est
 * mémorisée. Renvoie la version vue précédente (null au premier lancement) ou undefined si rien
 * de neuf.
 */
export function pendingNews(version = APP_VERSION): string | null | undefined {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {
    return undefined;
  }
  return seen === version ? undefined : seen;
}

export function markNewsSeen(version = APP_VERSION): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* stockage indisponible : l'écran reviendra au prochain lancement */
  }
}
