/**
 * Pont vers la version bureau (Electron) : exposé par le script de préchargement sous
 * `window.sebcadDesktop`. Absent dans le navigateur.
 */

export interface DesktopFile {
  name: string;
  path: string;
  data: Uint8Array;
}

export interface DesktopApi {
  readonly version: string;
  /** Chemin complet d'un fichier choisi ou déposé. */
  pathForFile(file: File): string;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Boîte « Enregistrer sous » native ; null si annulée. */
  saveDialog(opts: { name: string; description: string; extensions: string[] }): Promise<string | null>;
  /** Version du logiciel et possibilités de mise à jour (absent des versions < 1.0.0 de Xylform CAD). */
  appInfo?(): Promise<{ version: string; packaged: boolean; portable: boolean; updates: boolean }>;
  /** Recherche une mise à jour sur GitHub ; `manual` : l'utilisateur l'a demandée. */
  checkUpdates?(manual: boolean): Promise<{ ok: boolean; reason?: string; busy?: boolean; downloaded?: string }>;
  /** Messages de la mise à jour (disponible, téléchargée, erreur). */
  onUpdateStatus?(cb: (s: { text: string; kind: 'info' | 'success' | 'error' }) => void): void;
  /** Fichiers ouverts par double-clic dans l'Explorateur (au démarrage ou application déjà lancée). */
  onOpenFile(cb: (file: DesktopFile) => void): void;
}

export const desktop: DesktopApi | null = (globalThis as { sebcadDesktop?: DesktopApi }).sebcadDesktop ?? null;

/** Fichiers reconstruits à partir d'un chemin (ouverture depuis l'Explorateur). */
const knownPaths = new WeakMap<File, string>();

/** Fichier ouvert par l'Explorateur : objet File dont le chemin d'origine est mémorisé. */
export function fileFromDesktop(f: DesktopFile): File {
  const file = new File([f.data as Uint8Array<ArrayBuffer>], f.name);
  knownPaths.set(file, f.path);
  return file;
}

/** Chemin d'un fichier sur le disque (version bureau uniquement). */
export function pathOf(file: File): string | undefined {
  const known = knownPaths.get(file);
  if (known) return known;
  try {
    return desktop?.pathForFile(file) || undefined;
  } catch {
    return undefined;
  }
}
