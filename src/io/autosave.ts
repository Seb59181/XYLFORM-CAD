/**
 * Sauvegarde automatique : toutes les
 * `autosaveMinutes` minutes, si le dessin a changé et n'est pas enregistré, une copie complète
 * (.xcad) est rangée dans le stockage local (IndexedDB). Au démarrage suivant, si une copie
 * non enregistrée existe (plantage, coupure, fermeture sans enregistrer), Xylform CAD propose de la
 * récupérer. Enregistrer le dessin efface la copie.
 */
import type { AppHost, DocTab } from '../app/AppHost';
import { saveProject } from './project';

export interface AutosaveRecord {
  name: string;
  /** Date de la copie (ms). */
  time: number;
  /** Nombre d'objets du dessin. */
  count: number;
  data: Uint8Array;
}

const DB = 'sebcad-autosave';
const STORE = 'drawings';
const KEY = 'last';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponible'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Ancienne clé (une seule copie, SebCad < 2.0) ; les onglets ont chacun leur clé `doc:<id>`. */
export const readAutosave = (): Promise<AutosaveRecord | undefined> => tx<AutosaveRecord | undefined>('readonly', (s) => s.get(KEY)).catch(() => undefined);
export const writeAutosave = (r: AutosaveRecord, key = KEY): Promise<void> => tx<void>('readwrite', (s) => s.put(r, key));
export const clearAutosave = (key = KEY): Promise<void> => tx<void>('readwrite', (s) => s.delete(key)).catch(() => undefined);

/** Toutes les copies de secours (une par dessin non enregistré), de la plus récente à la plus ancienne. */
export async function readAutosaves(): Promise<(AutosaveRecord & { key: string })[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    const out: (AutosaveRecord & { key: string })[] = [];
    for (const k of keys) {
      const r = await tx<AutosaveRecord | undefined>('readonly', (s) => s.get(k));
      if (r?.data?.length) out.push({ ...r, key: String(k) });
    }
    return out.sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

interface TabState {
  savedVersion: number;
  /** Clé de la copie de secours de cet onglet, si elle existe. */
  key: string | null;
}

/** Surveille les dessins ouverts et enregistre automatiquement ceux qui sont modifiés. */
export class Autosaver {
  private readonly tabs = new WeakMap<DocTab, TabState>();
  private lastTime = Date.now();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly app: AppHost) {}

  private state(t: DocTab): TabState {
    let st = this.tabs.get(t);
    if (!st) this.tabs.set(t, (st = { savedVersion: -1, key: null }));
    return st;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 20_000);
    // dessin enregistré (ou nouveau / ouvert) : sa copie de secours ne sert plus
    const check = () => {
      for (const t of this.app.docs) {
        const st = this.tabs.get(t);
        if (st?.key && !t.doc.dirty) {
          void clearAutosave(st.key);
          st.key = null;
          st.savedVersion = t.doc.version;
        }
      }
    };
    this.app.on('doc', check);
    this.app.on('tabs', check);
  }

  /** Dessin récupéré : la copie reste jusqu'au prochain enregistrement. */
  markRecovered(tab: DocTab, key: string): void {
    const st = this.state(tab);
    st.key = key;
    st.savedVersion = tab.doc.version;
  }

  /** Onglet fermé (enregistré ou abandonné) : sa copie de secours est effacée. */
  forget(tab: DocTab): void {
    const st = this.tabs.get(tab);
    if (st?.key) void clearAutosave(st.key);
    this.tabs.delete(tab);
  }

  /** Copie immédiate des dessins modifiés (aussi appelée par la commande SAUVAUTO). */
  async saveNow(force = false): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    let any = false;
    try {
      for (const t of [...this.app.docs]) {
        const st = this.state(t);
        const doc = t.doc;
        if (!doc.all().length) continue;
        if (!force && (!doc.dirty || doc.version === st.savedVersion)) continue;
        try {
          const version = doc.version;
          const data = await saveProject(this.app, doc);
          const key = st.key ?? `doc:${t.id}`;
          await writeAutosave({ name: doc.fileName, time: Date.now(), count: doc.all().length, data }, key);
          st.key = key;
          st.savedVersion = version;
          any = true;
        } catch (e) {
          console.warn('Sauvegarde automatique impossible', e);
        }
      }
      return any;
    } finally {
      this.lastTime = Date.now();
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    const app = this.app;
    const minutes = app.settings.autosaveMinutes;
    if (!minutes || Date.now() - this.lastTime < minutes * 60_000) return;
    // pas pendant une commande ni un calcul du noyau : on réessaie au tour suivant
    if (app.processor.activeCommand || app.kernel.busy > 0) return;
    if (await this.saveNow()) app.log(`Sauvegarde automatique effectuée (${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}).`);
  }
}

/** Au démarrage : propose de récupérer les copies automatiques non enregistrées (une par dessin). */
export async function offerRecovery(app: AppHost, load: (r: AutosaveRecord & { key: string }) => Promise<void>): Promise<void> {
  const records = await readAutosaves();
  if (!records.length) return;
  const when = (r: AutosaveRecord) => {
    const d = new Date(r.time);
    return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const list = records.map((r) => `• « ${r.name} » (${when(r)}, ${r.count} objet(s))`).join('\n');
  const ok = await app.ui.confirm(
    records.length === 1
      ? `Le dessin « ${records[0]!.name} » n’avait pas été enregistré (sauvegarde automatique du ${when(records[0]!)}, ${records[0]!.count} objet(s)).\n\nVoulez-vous le récupérer ? Sinon, la copie de secours est effacée.`
      : `${records.length} dessins n’avaient pas été enregistrés :\n${list}\n\nVoulez-vous les récupérer (un onglet par dessin) ? Sinon, les copies de secours sont effacées.`,
    'Récupération des dessins',
    { ok: 'Récupérer', cancel: 'Ignorer' },
  );
  if (ok) for (const r of records) await load(r);
  else for (const r of records) await clearAutosave(r.key);
}
