/**
 * Enregistrement de fichiers : boîte native de la version bureau, API File System Access
 * (Chrome, Edge) quand elle existe — « Enregistrer » réécrit alors le même fichier sans
 * redemander —, sinon téléchargement classique.
 */
import { desktop } from './desktop';

interface SavePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** Fichier réinscriptible : poignée du navigateur ou chemin (version bureau). */
export type SaveHandle = FileSystemFileHandle | { path: string; name: string };

export interface SaveTarget {
  name: string;
  handle?: SaveHandle;
}

export interface SaveOptions {
  name: string;
  mime: string;
  description: string;
  extensions: string[];
  /** Fichier déjà ouvert : réécrit sans boîte de dialogue. */
  handle?: SaveHandle | null;
}

const toBlob = (data: Uint8Array | string | Blob, mime: string) =>
  data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)], { type: mime });

/** Écrit le fichier ; renvoie null si l'utilisateur a annulé. */
export async function saveFile(data: Uint8Array | string | Blob, opts: SaveOptions): Promise<SaveTarget | null> {
  if (desktop) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    const path = opts.handle && 'path' in opts.handle ? opts.handle.path : await desktop.saveDialog({ name: opts.name, description: opts.description, extensions: opts.extensions });
    if (!path) return null;
    await desktop.writeFile(path, bytes);
    const name = path.split(/[\\/]/).pop() ?? opts.name;
    return { name, handle: { path, name } };
  }
  const blob = toBlob(data, opts.mime);
  if (opts.handle && !('path' in opts.handle)) {
    try {
      await writeHandle(opts.handle, blob);
      return { name: opts.handle.name, handle: opts.handle };
    } catch {
      /* droit d'écriture retiré : on redemande l'emplacement */
    }
  }
  const w = window as unknown as SavePickerWindow;
  if (w.showSaveFilePicker && window.isSecureContext && window.self === window.top) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: opts.name,
        types: [{ description: opts.description, accept: { [opts.mime]: opts.extensions } }],
      });
      await writeHandle(handle, blob);
      return { name: handle.name, handle };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      // sinon : téléchargement classique ci-dessous
    }
  }
  download(blob, opts.name);
  return { name: opts.name };
}

async function writeHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '');
export const extension = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
