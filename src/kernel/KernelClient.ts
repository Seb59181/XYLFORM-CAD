/**
 * Côté interface : envoie les requêtes au worker du noyau et renvoie des promesses.
 * Les requêtes sont sérialisées (une à la fois) : le noyau OCC n'est pas réentrant.
 */
import type { IndexedMesh } from '../core/mesh/IndexedMesh';
import type { DisplayMesh, KernelRequest, KernelResponse, SolidResult } from './protocol';
import { CommandCancelled } from '../core/commands/types';

export type KernelStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Le worker (OpenCascade, ≈ 50 Mo de WebAssembly) n'est démarré qu'à la première demande :
 * l'espace de travail 2D n'en paie jamais le coût.
 */
export class KernelClient {
  private worker: Worker | null = null;
  private seq = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; bg: boolean }>();
  private readonly listeners = new Set<(s: KernelStatus, busy: boolean) => void>();
  private readonly progressListeners = new Set<(step: string, pct?: number) => void>();
  status: KernelStatus = 'idle';
  /** Requêtes en cours lancées par l'utilisateur (hors tâches de fond). */
  busy = 0;
  /** Incrémenté à chaque redémarrage : les identifiants de forme antérieurs ne valent plus rien. */
  generation = 0;
  private started: Promise<void> | null = null;

  /** Démarre le noyau si besoin ; résolue quand il est prêt. */
  get ready(): Promise<void> {
    return this.start();
  }

  start(): Promise<void> {
    if (this.started) return this.started;
    this.status = 'loading';
    this.notify();
    const worker = new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.started = new Promise((resolve, reject) => {
      worker.addEventListener('message', (ev: MessageEvent) => {
        const d = ev.data as { type?: string; error?: string; step?: string; pct?: number } & Partial<KernelResponse>;
        if (d.type === 'progress') {
          for (const fn of this.progressListeners) fn(d.step!, d.pct);
          return;
        }
        if (d.type === 'ready') {
          this.status = 'ready';
          this.notify();
          resolve();
          return;
        }
        if (d.type === 'failed') {
          this.status = 'failed';
          this.notify();
          reject(new Error(d.error));
          return;
        }
        const p = this.pending.get(d.id!);
        if (!p) return;
        this.pending.delete(d.id!);
        if (!p.bg) {
          this.busy--;
          this.notify();
        }
        if (d.ok) p.resolve((d as { result: unknown }).result);
        else p.reject(new Error((d as { error: string }).error));
      });
      worker.addEventListener('error', (e) => {
        this.status = 'failed';
        this.notify();
        reject(new Error(e.message || 'Le worker du noyau n’a pas pu démarrer.'));
      });
    });
    this.started.catch(() => undefined);
    return this.started;
  }

  onStatus(fn: (s: KernelStatus, busy: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Étapes du démarrage du noyau (téléchargement du WebAssembly, initialisation). */
  onProgress(fn: (step: string, pct?: number) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.status, this.busy > 0);
  }

  /** `background` : tâche de fond (copie de secours…), non comptée dans `busy`. */
  call<T>(req: KernelRequest, opts: { background?: boolean } = {}): Promise<T> {
    const id = this.seq++;
    const bg = !!opts.background;
    if (!bg) {
      this.busy++;
      this.notify();
    }
    const ready = this.start();
    const worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, bg });
      ready.then(
        () => {
          // noyau redémarré entre-temps : la requête a déjà été rejetée
          if (this.worker === worker && this.pending.has(id)) worker!.postMessage({ id, req });
        },
        (e: Error) => {
          if (!this.pending.delete(id)) return;
          if (!bg) {
            this.busy--;
            this.notify();
          }
          reject(e);
        },
      );
    });
  }

  /**
   * Arrête net le worker (le calcul en cours est perdu, OpenCascade ne sait pas s'interrompre)
   * et en démarre un neuf. Les requêtes en cours sont rejetées par CommandCancelled ; toutes les
   * formes du noyau sont perdues (l'hôte les recharge).
   */
  restart(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.started = null;
    this.generation++;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.busy = 0;
    for (const p of pending) p.reject(new CommandCancelled());
    return this.start();
  }

  solid(req: KernelRequest): Promise<SolidResult> {
    return this.call<SolidResult>(req);
  }

  display(shapeId: string): Promise<DisplayMesh> {
    return this.call<DisplayMesh>({ op: 'display', shapeId });
  }

  exportMesh(shapeIds: string[], linearDeflection: number, angularDeflectionDeg: number): Promise<IndexedMesh[]> {
    return this.call<IndexedMesh[]>({ op: 'exportMesh', shapeIds, linearDeflection, angularDeflectionDeg });
  }
}
