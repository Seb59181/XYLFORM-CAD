/**
 * Exécution des scripts de commandes : chaque ligne est tapée dans la ligne de commande, ses
 * réponses sont données une à une aux invites, puis un compte rendu ligne par ligne est produit
 * (réussite, messages, objets créés, erreur et invite en cause). C'est le moteur commun de la
 * commande SCRIPT et du serveur MCP (dessin piloté par une IA).
 *
 * Particularités des scripts (en plus de la syntaxe de la ligne de commande) :
 *  - les coordonnées tapées sont toujours absolues (`@` pour relatif), quel que soit le réglage de
 *    la saisie dynamique ;
 *  - aux invites de sélection : `$nom` (objets nommés, `$a,$b` pour plusieurs), `DERNIER` (objets
 *    créés par la commande précédente), `PRECEDENT` (sélection précédente), `Tout` ;
 *  - aux invites d'arête ou de face : `$nom:haut` (bas, avant, arriere, gauche, droite),
 *    `$nom:verticales`, `$nom:toutes`, `$nom:3` (3e arête/face) ou `$nom:10,0,5` (la plus proche du point) ;
 *  - en fin de ligne, si la commande attend encore une réponse facultative, Entrée est envoyée.
 */
import type { EntityPick, PromptResult, PromptSpec, Vec3 } from '../../core/commands';
import { formatPrompt } from '../../core/commands/InputParser';
import type { Entity } from '../../core/document/Document';
import { curvePoints } from '../../core/entities/geometry';
import type { AppHost, UiApi } from '../AppHost';
import { parseScript, type ScriptLine } from './scriptParser';

export type LineStatus = 'ok' | 'error' | 'cancelled' | 'skipped';

export interface ScriptLineReport {
  line: number;
  text: string;
  status: LineStatus;
  /** Messages de la ligne de commande pendant la ligne (sans l'écho des saisies). */
  messages: string[];
  /** Objets créés par la ligne (handles). */
  created: string[];
  /** Avertissements (valeur par défaut prise faute de réponse…). */
  warnings?: string[];
  /** Erreur : explication et invite en attente au moment de l'erreur. */
  error?: string;
  prompt?: string;
}

export interface ScriptReport {
  ok: boolean;
  /** Lignes de commande exécutées (réussies ou en erreur). */
  executed: number;
  total: number;
  errors: number;
  lines: ScriptLineReport[];
  /** Objets nommés à la fin du script. */
  names: Record<string, string[]>;
  durationMs: number;
  /** Interrompu (Échap, bouton Arrêter). */
  aborted: boolean;
  /** Étape d'annulation laissée par le script (null : le dessin n'a pas changé). */
  undoLabel: string | null;
}

export interface RunOptions {
  /** Continuer après une erreur (défaut : arrêt à la première erreur). */
  continueOnError?: boolean;
  /**
   * Sans interface : les boîtes de dialogue ouvertes par les commandes prennent leurs valeurs par
   * défaut (serveur MCP). Sinon elles s'affichent normalement.
   */
  headless?: boolean;
  /** Délai maximal d'une ligne (ms) ; 0 = sans limite. Défaut : 10 min sans interface, sinon sans limite. */
  lineTimeout?: number;
  /** Toutes les modifications du script forment une seule étape d'annulation (défaut : oui). */
  singleUndo?: boolean;
  /** Objets présélectionnés pour la première ligne (export d'objets choisis). */
  preselect?: string[];
  /** Avancement : ligne en cours. */
  onLine?(index: number, total: number, line: ScriptLine): void;
}

/** Interface sans fenêtre : chaque boîte de dialogue reçoit sa réponse par défaut. */
export function headlessUi(base: UiApi, log: (m: string) => void): UiApi {
  return {
    ...base,
    toast: (m) => log(m),
    openFile: async () => null,
    prompt: async (_t, initial) => initial ?? null,
    confirm: async () => true,
    meshExport: async (_f, _n, unit) => ({ unit: unit ?? 'mm', linearDeflection: 0.02, angularDeflection: 10, repair: true, separate: true, check: true, minWall: 0.8, overhang: 45 }),
    showHelp: () => undefined,
    showNews: async () => undefined,
    customize: () => undefined,
    contextMenu: () => undefined,
    form: async (spec) => Object.fromEntries(spec.fields.map((f) => [f.key, f.value])),
    // Échap = dernier bouton (Annuler) : rien d'irréversible sans quelqu'un devant l'écran
    choose: async (_m, _t, buttons) => buttons.length - 1,
    scriptEditor: async () => null,
    mcpPanel: () => undefined,
  };
}

const SIDES: Record<string, Vec3> = {
  HAUT: { x: 0, y: 0, z: 1 },
  DESSUS: { x: 0, y: 0, z: 1 },
  TOP: { x: 0, y: 0, z: 1 },
  BAS: { x: 0, y: 0, z: -1 },
  DESSOUS: { x: 0, y: 0, z: -1 },
  BOTTOM: { x: 0, y: 0, z: -1 },
  DROITE: { x: 1, y: 0, z: 0 },
  RIGHT: { x: 1, y: 0, z: 0 },
  GAUCHE: { x: -1, y: 0, z: 0 },
  LEFT: { x: -1, y: 0, z: 0 },
  ARRIERE: { x: 0, y: 1, z: 0 },
  BACK: { x: 0, y: 1, z: 0 },
  AVANT: { x: 0, y: -1, z: 0 },
  FRONT: { x: 0, y: -1, z: 0 },
};

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

type Solid = Extract<Entity, { type: '3DSOLID' }>;

/** Arêtes d'un solide (polylignes d'affichage). */
function edgesOf(s: Solid): Vec3[][] {
  const d = s.display;
  const out: Vec3[][] = [];
  for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
    const pts: Vec3[] = [];
    for (let k = d.edgeOffsets[i]!; k < d.edgeOffsets[i + 1]!; k++) pts.push({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: d.edgePoints[3 * k + 2]! });
    out.push(pts);
  }
  return out;
}

/** Faces d'un solide : centre, normale moyenne, planéité, aire, triangles (pour la distance). */
function facesOf(s: Solid): { center: Vec3; normal: Vec3; planar: boolean; area: number; tris: Vec3[][] }[] {
  const d = s.display;
  const n = d.faceCount || 0;
  const acc = Array.from({ length: n }, () => ({ c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, area: 0, normals: [] as Vec3[], tris: [] as Vec3[][] }));
  const P = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
  for (let t = 0; t * 3 < d.indices.length; t++) {
    const f = d.faceIds[t]!;
    const a = acc[f];
    if (!a) continue;
    const p = P(d.indices[3 * t]!), q = P(d.indices[3 * t + 1]!), r = P(d.indices[3 * t + 2]!);
    const u = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z }, v = { x: r.x - p.x, y: r.y - p.y, z: r.z - p.z };
    const c = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
    const area = Math.hypot(c.x, c.y, c.z) / 2;
    if (area <= 0) continue;
    a.area += area;
    a.c.x += ((p.x + q.x + r.x) / 3) * area;
    a.c.y += ((p.y + q.y + r.y) / 3) * area;
    a.c.z += ((p.z + q.z + r.z) / 3) * area;
    a.n.x += c.x / 2;
    a.n.y += c.y / 2;
    a.n.z += c.z / 2;
    a.normals.push({ x: c.x / (2 * area), y: c.y / (2 * area), z: c.z / (2 * area) });
    a.tris.push([p, q, r]);
  }
  return acc.map((a) => {
    const l = Math.hypot(a.n.x, a.n.y, a.n.z) || 1;
    const normal = { x: a.n.x / l, y: a.n.y / l, z: a.n.z / l };
    const k = a.area || 1;
    return { center: { x: a.c.x / k, y: a.c.y / k, z: a.c.z / k }, normal, planar: a.normals.every((m) => dot(m, normal) > 0.999), area: a.area, tris: a.tris };
  });
}

function distPointSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * ab.x, p.y - a.y - t * ab.y, p.z - a.z - t * ab.z);
}

function midOf(pts: Vec3[]): Vec3 {
  return pts[Math.floor(pts.length / 2)] ?? pts[0] ?? { x: 0, y: 0, z: 0 };
}

const bboxCenter = (s: Solid): Vec3 => {
  const { min, max } = s.display.bbox;
  return { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
};

/** Point représentatif d'un objet (désignation par `$nom`). */
export function entityPoint(e: Entity): Vec3 {
  if (e.type === '3DSOLID') return bboxCenter(e);
  const pl = curvePoints(e)[0];
  return pl?.[Math.floor(pl.length / 2)] ?? { x: 0, y: 0, z: 0 };
}

function parsePointToken(s: string): Vec3 | null {
  const parts = s.split(',').map((v) => Number(v.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return { x: parts[0]!, y: parts[1]!, z: parts[2] ?? 0 };
}

/** Arêtes ou faces d'un solide choisies par un sélecteur (`haut`, `verticales`, `3`, `10,0,5`…). */
export function subElements(s: Solid, mode: 'edge' | 'face', selector: string): number[] | string {
  const key = norm(selector.trim());
  const size = Math.max(s.display.bbox.max.x - s.display.bbox.min.x, s.display.bbox.max.y - s.display.bbox.min.y, s.display.bbox.max.z - s.display.bbox.min.z, 1);
  const tol = size * 1e-4 + 1e-6;
  if (mode === 'edge') {
    const all = edgesOf(s);
    // les arêtes de couture (cylindres, sphères…) ne bordent qu'une seule face : jamais désignées
    const seams = seamEdges(s, all, tol * 10);
    const edges = all.map((pts, i) => (seams.has(i) ? [] : pts));
    if (!all.length) return `${s.name || s.handle} n'a pas d'arête.`;
    if (key === 'TOUTES' || key === 'TOUT' || key === 'ALL') return edges.flatMap((pts, i) => (pts.length ? [i] : []));
    if (key === 'VERTICALES' || key === 'VERTICAL') {
      const r = edges.flatMap((pts, i) => (pts.length > 1 && pts.every((p) => Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y) < tol) && Math.abs(pts[pts.length - 1]!.z - pts[0]!.z) > tol ? [i] : []));
      return r.length ? r : 'Aucune arête verticale.';
    }
    if (key === 'HORIZONTALES' || key === 'HORIZONTAL') {
      const r = edges.flatMap((pts, i) => (pts.length > 1 && pts.every((p) => Math.abs(p.z - pts[0]!.z) < tol) ? [i] : []));
      return r.length ? r : 'Aucune arête horizontale.';
    }
    const dir = SIDES[key];
    if (dir) {
      const top = Math.max(...all.flat().map((p) => dot(p, dir)));
      const r = edges.flatMap((pts, i) => (pts.length && pts.every((p) => dot(p, dir) > top - tol) ? [i] : []));
      return r.length ? r : `Aucune arête entièrement du côté « ${selector} ».`;
    }
    if (/^\d+$/.test(key)) {
      const i = Number(key) - 1;
      return i >= 0 && i < all.length ? [i] : `Arête ${key} inexistante (le solide en a ${all.length}).`;
    }
    const p = parsePointToken(selector);
    if (p) {
      let best = -1, bd = Infinity;
      edges.forEach((pts, i) => {
        for (let k = 0; k + 1 < pts.length; k++) {
          const dd = distPointSegment(p, pts[k]!, pts[k + 1]!);
          if (dd < bd) (bd = dd), (best = i);
        }
      });
      return best >= 0 ? [best] : 'Aucune arête.';
    }
    return `Sélecteur d'arête « ${selector} » inconnu : haut, bas, avant, arriere, gauche, droite, verticales, horizontales, toutes, un numéro ou un point x,y,z.`;
  }
  const faces = facesOf(s);
  if (!faces.length) return `${s.name || s.handle} n'a pas de face.`;
  if (key === 'TOUTES' || key === 'TOUT' || key === 'ALL') return faces.map((_, i) => i);
  const dir = SIDES[key];
  if (dir) {
    const cands = faces.map((f, i) => ({ f, i })).filter(({ f }) => f.area > 0 && dot(f.normal, dir) > 0.98);
    if (!cands.length) return `Aucune face tournée vers « ${selector} ».`;
    const top = Math.max(...cands.map(({ f }) => dot(f.center, dir)));
    return cands.filter(({ f }) => dot(f.center, dir) > top - tol * 10).map(({ i }) => i);
  }
  if (/^\d+$/.test(key)) {
    const i = Number(key) - 1;
    return i >= 0 && i < faces.length ? [i] : `Face ${key} inexistante (le solide en a ${faces.length}).`;
  }
  const p = parsePointToken(selector);
  if (p) {
    let best = -1, bd = Infinity;
    faces.forEach((f, i) => {
      for (const t of f.tris) {
        const c = { x: (t[0]!.x + t[1]!.x + t[2]!.x) / 3, y: (t[0]!.y + t[1]!.y + t[2]!.y) / 3, z: (t[0]!.z + t[1]!.z + t[2]!.z) / 3 };
        const dd = Math.min(Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z), ...t.map((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)));
        if (dd < bd) (bd = dd), (best = i);
      }
    });
    return best >= 0 ? [best] : 'Aucune face.';
  }
  return `Sélecteur de face « ${selector} » inconnu : haut, bas, avant, arriere, gauche, droite, toutes, un numéro ou un point x,y,z.`;
}

/** Arêtes qui ne bordent qu'une seule face (coutures des surfaces fermées). */
function seamEdges(s: Solid, edges: Vec3[][], tol: number): Set<number> {
  const d = s.display;
  const out = new Set<number>();
  const P = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
  edges.forEach((pts, i) => {
    if (pts.length < 2) return;
    // point au milieu du premier segment : sur le bord des triangles des faces voisines
    const m = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2, z: (pts[0]!.z + pts[1]!.z) / 2 };
    const faces = new Set<number>();
    for (let t = 0; t * 3 < d.indices.length && faces.size < 2; t++) {
      const a = P(d.indices[3 * t]!), b = P(d.indices[3 * t + 1]!), c = P(d.indices[3 * t + 2]!);
      if (Math.min(distPointSegment(m, a, b), distPointSegment(m, b, c), distPointSegment(m, c, a)) < tol) faces.add(d.faceIds[t]!);
    }
    if (faces.size === 1) out.add(i);
  });
  return out;
}

/** Point d'une arête ou d'une face (pour la désignation). */
function subPoint(s: Solid, mode: 'edge' | 'face', i: number): Vec3 {
  if (mode === 'edge') return midOf(edgesOf(s)[i] ?? []);
  return facesOf(s)[i]?.center ?? bboxCenter(s);
}

class ScriptError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exécute un script dans le dessin actif. Une seule exécution à la fois ; `stop()` l'interrompt.
 */
export class ScriptRunner {
  private running = false;
  private aborted = false;
  private readonly byDoc = new WeakMap<object, Map<string, string[]>>();

  /** Noms des objets (`nom = …`) du dessin actif, conservés d'une exécution à l'autre. */
  get names(): Map<string, string[]> {
    let m = this.byDoc.get(this.app.doc);
    if (!m) this.byDoc.set(this.app.doc, (m = new Map()));
    return m;
  }
  /** Objets créés par la dernière commande (DERNIER). */
  private last: string[] = [];
  private previous: string[] = [];
  /** Objets donnés aux invites de la ligne en cours (pour faire suivre les noms). */
  private delivered: string[] = [];

  constructor(private readonly app: AppHost) {}

  get busy(): boolean {
    return this.running;
  }

  stop(): void {
    if (!this.running) return;
    this.aborted = true;
    void this.app.processor.cancelAll();
  }

  async run(source: string, opts: RunOptions = {}): Promise<ScriptReport> {
    if (this.running) throw new Error('Un script est déjà en cours d’exécution.');
    const t0 = Date.now();
    const app = this.app;
    const parsed = parseScript(source);
    const report: ScriptReport = { ok: true, executed: 0, total: parsed.lines.length, errors: 0, lines: [], names: {}, durationMs: 0, aborted: false, undoLabel: null };
    if (parsed.errors.length) {
      for (const e of parsed.errors) report.lines.push({ line: e.line, text: e.text, status: 'error', messages: [], created: [], error: e.message });
      report.errors = parsed.errors.length;
      report.ok = false;
      if (!opts.continueOnError) {
        report.lines.sort((a, b) => a.line - b.line);
        report.durationMs = Date.now() - t0;
        return report;
      }
    }
    this.running = true;
    this.aborted = false;
    // les commandes en cours sont terminées avant de commencer
    if (!app.processor.isIdle) await app.processor.cancelAll();
    const proc = app.processor;
    const saved = { dyn: proc.dynamicRelative, dir: proc.cursorDirection, ui: app.ui };
    proc.dynamicRelative = false;
    // un nombre seul à une invite de point = distance vers +X depuis le point précédent
    proc.cursorDirection = { x: 1, y: 0, z: 0 };
    if (opts.headless) app.ui = headlessUi(saved.ui, (m) => app.log(m));
    const timeout = opts.lineTimeout ?? (opts.headless ? 600_000 : 0);
    const single = opts.singleUndo !== false;
    const doc = app.doc;
    const label = `Script (${parsed.lines.length} lignes, ${new Date().toLocaleTimeString('fr-FR')})`;
    const version = doc.version;
    if (single) app.holdUndoGroup(label);
    try {
      for (let i = 0; i < parsed.lines.length; i++) {
        const line = parsed.lines[i]!;
        if (this.aborted) {
          report.aborted = true;
          break;
        }
        opts.onLine?.(i, parsed.lines.length, line);
        const r = await this.runLine(line, timeout, i === 0 ? opts.preselect : undefined);
        report.lines.push(r);
        report.executed++;
        if (r.status === 'cancelled') {
          report.aborted = true;
          report.ok = false;
          break;
        }
        if (r.status === 'error') {
          report.errors++;
          report.ok = false;
          if (!opts.continueOnError) break;
        }
      }
    } finally {
      if (single) app.releaseUndoGroup();
      proc.dynamicRelative = saved.dyn;
      proc.cursorDirection = saved.dir;
      app.ui = saved.ui;
      this.running = false;
    }
    // lignes non exécutées après un arrêt
    const done = new Set(report.lines.map((l) => l.line));
    for (const l of parsed.lines) if (!done.has(l.line)) report.lines.push({ line: l.line, text: l.text, status: 'skipped', messages: [], created: [] });
    report.lines.sort((a, b) => a.line - b.line);
    report.names = Object.fromEntries([...this.names].filter(([, hs]) => hs.length));
    report.undoLabel = single && app.doc === doc && doc.version !== version && doc.undoLabel === label ? label : null;
    report.durationMs = Date.now() - t0;
    app.viewport?.redraw();
    return report;
  }

  private async runLine(line: ScriptLine, timeout: number, preselect?: string[]): Promise<ScriptLineReport> {
    const app = this.app;
    const proc = app.processor;
    const messages: string[] = [];
    const echo = new Set<string>();
    const offLog = app.on('log', () => {
      const m = app.lines[app.lines.length - 1];
      if (m === undefined || echo.has(m)) return;
      if (/^Commande: /.test(m) && messages.length === 0) return;
      if (messages.length < 60) messages.push(m);
    });
    let status: LineStatus = 'ok';
    let failed = false;
    const ends: ('done' | 'cancelled' | 'error')[] = [];
    const offEnd = app.onCommandEnd((s) => ends.push(s));
    const doc = app.doc;
    const before = new Set(doc.all().map((e) => e.handle));
    const touched = new Set<string>();
    const offDoc = doc.subscribe((c) => c.touched.forEach((h) => touched.add(h)));
    const report: ScriptLineReport = { line: line.line, text: line.text, status: 'ok', messages, created: [] };
    this.delivered = [];
    const fail = (error: string) => {
      failed = true;
      report.error = error;
      const spec = proc.activePrompt;
      if (spec) report.prompt = formatPrompt(spec).replace(/:\s*$/, '');
    };
    const settle = async () => {
      if (proc.settled) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = proc.whenSettled();
      if (timeout > 0) {
        const t = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeout)));
        const r = await Promise.race([wait.then(() => 'ok' as const), t]);
        clearTimeout(timer);
        if (r === 'timeout') throw new ScriptError(`La commande ne répond plus depuis ${Math.round(timeout / 1000)} s.`);
      } else await wait;
    };
    try {
      if (!proc.isIdle) await proc.cancelAll();
      if (preselect?.length) app.selection.set(preselect);
      else app.selection.clear();
      // la commande
      const r0 = proc.submit(line.command);
      if (!r0.accepted) throw new ScriptError(r0.message ?? `Commande « ${line.command} » refusée.`);
      if (/^'?_?(SCRIPT|SCR)$/i.test(line.command) || proc.activeCommand?.name === 'SCRIPT') throw new ScriptError('Un script ne peut pas lancer SCRIPT.');
      await settle();
      // les réponses
      for (let k = 0; k < line.args.length; k++) {
        const tok = line.args[k]!;
        if (this.aborted) break;
        if (proc.isIdle) {
          const rest = line.args.slice(k).map((a) => (a === '' ? '""' : a.includes(' ') ? `"${a}"` : a)).join(' ');
          throw new ScriptError(`La commande est terminée mais il reste des valeurs : ${rest}`);
        }
        const spec = proc.activePrompt;
        if (!spec) {
          await settle();
          k--;
          continue;
        }
        const results = this.scriptAnswer(tok, spec);
        if (typeof results === 'string') throw new ScriptError(results);
        if (results) {
          for (let j = 0; j < results.length; j++) {
            const cur = proc.activePrompt;
            if (!cur || cur.kind !== spec.kind) throw new ScriptError(`« ${tok} » : la commande n'attend plus ${spec.kind === 'entity' ? 'de désignation' : 'de sélection'} (${results.length - j} élément(s) non donnés).`);
            const res = results[j]!;
            if (res.kind === 'selection') this.delivered.push(...res.value);
            else if (res.kind === 'entity') this.delivered.push(res.value.handle);
            if (!proc.answer(res)) throw new ScriptError(`« ${tok} » refusé à l'invite.`);
            await settle();
          }
          continue;
        }
        if (tok === '') echo.add(`${formatPrompt(spec)}`);
        else echo.add(`${formatPrompt(spec)}${tok.trim()}`);
        const r = proc.submit(tok);
        if (!r.accepted) {
          const hint = spec.kind === 'selection' ? ' (aux invites de sélection : $nom, DERNIER, PRECEDENT ou Tout)' : spec.kind === 'entity' ? ' (désignez avec $nom, ou $nom:haut… pour une arête ou une face)' : '';
          throw new ScriptError(`« ${tok === '' ? 'Entrée' : tok} » refusé : ${r.message ?? 'saisie incorrecte'}${hint}`);
        }
        await settle();
      }
      // fin de ligne : Entrée tant que la commande attend une réponse facultative
      for (let n = 0; n < 6 && !proc.isIdle && !this.aborted; n++) {
        const spec = proc.activePrompt;
        if (!spec) {
          await settle();
          continue;
        }
        const optional = spec.allowNone || spec.defaultValue !== undefined || spec.kind === 'selection' || (spec.kind === 'entity' && spec.allowNone);
        if (!optional) break;
        if (spec.defaultValue !== undefined && !spec.allowNone && spec.kind !== 'selection') {
          const d = spec.defaultValue;
          const shown = typeof d === 'number' ? String(Math.round(d * 1e4) / 1e4) : typeof d === 'string' ? (spec.keywords?.find((k) => k.global === d)?.local ?? d) : `${d.x},${d.y},${d.z}`;
          (report.warnings ??= []).push(`Valeur par défaut ${shown} prise pour « ${spec.message} » (réponse absente du script).`);
        }
        echo.add(formatPrompt(spec));
        const r = proc.submit('');
        if (!r.accepted) break;
        await settle();
      }
      if (!proc.isIdle && !this.aborted) throw new ScriptError('Réponse manquante : la commande attend encore une valeur.');
      if (ends.includes('error')) {
        const err = [...messages].reverse().find((m) => /^Erreur/.test(m));
        failed = true;
        report.error = err ?? 'La commande a échoué.';
      } else if (ends.includes('cancelled') || this.aborted) status = 'cancelled';
    } catch (e) {
      fail((e as Error).message);
      if (!proc.isIdle) await proc.cancelAll();
    } finally {
      offLog();
      offEnd();
      offDoc();
    }
    if (this.aborted && !failed) status = 'cancelled';
    if (failed) status = 'error';
    report.status = status;
    // objets créés et noms
    if (app.doc === doc) {
      const now = doc.all();
      const exists = new Set(now.map((e) => e.handle));
      const created = now.filter((e) => !before.has(e.handle)).map((e) => e.handle);
      const modified = [...touched].filter((h) => exists.has(h) && before.has(h));
      report.created = created;
      // les noms suivent les objets : supprimés → remplacés par le résultat de la commande ; si
      // chaque objet désigné a donné un objet (EXTRUSION de plusieurs profils…), un pour un
      const consumed = [...new Set(this.delivered)].filter((h) => !exists.has(h));
      const oneToOne = consumed.length > 1 && consumed.length === created.length;
      for (const [n, hs] of this.names) {
        const kept = hs.filter((h) => exists.has(h));
        if (kept.length || !hs.length || !created.length) {
          this.names.set(n, kept);
          continue;
        }
        const mapped = oneToOne ? hs.map((h) => created[consumed.indexOf(h)]).filter((h): h is string => !!h) : [];
        this.names.set(n, mapped.length ? mapped : [...created]);
      }
      if (status === 'ok') {
        const result = created.length ? created : modified;
        if (result.length) {
          this.previous = this.last.filter((h) => exists.has(h));
          this.last = result;
        }
        if (line.name) {
          if (!result.length) {
            report.status = 'error';
            report.error = `« ${line.name} = » : la commande n'a créé ni modifié aucun objet.`;
          } else this.names.set(line.name.toLowerCase(), result);
        }
      }
    } else {
      report.created = [];
      this.last = [];
      this.previous = [];
    }
    // petite respiration pour l'interface (affichage entre deux lignes)
    await sleep(0);
    return report;
  }

  /** Objets d'un nom ; message d'erreur si inconnu. */
  private named(name: string): string[] | string {
    const hs = this.names.get(name.toLowerCase());
    if (!hs) {
      const known = [...this.names].filter(([, v]) => v.some((h) => this.app.doc.get(h))).map(([k]) => k);
      return `Nom « $${name} » inconnu${known.length ? ` (noms connus : ${known.map((k) => `$${k}`).join(', ')})` : ' : nommez d’abord des objets avec « nom = COMMANDE … »'}.`;
    }
    const alive = hs.filter((h) => this.app.doc.get(h));
    if (!alive.length) return `Les objets « $${name} » n'existent plus.`;
    return alive;
  }

  /**
   * Réponses propres aux scripts (sélections nommées, désignation d'arêtes/faces). null : le mot
   * est passé tel quel à la ligne de commande ; chaîne : message d'erreur.
   */
  private scriptAnswer(tok: string, spec: PromptSpec): PromptResult[] | string | null {
    const t = tok.trim();
    if (spec.kind !== 'selection' && spec.kind !== 'entity') {
      if (t.startsWith('$')) return `« ${t} » : la commande attend ici ${spec.kind === 'point' ? 'un point (x,y ou x,y,z)' : spec.kind === 'keyword' ? 'une option' : 'une valeur'} — ${formatPrompt(spec).replace(/:\s*$/, '')}.`;
      return null;
    }
    // un mot-clé de l'invite reste prioritaire (Tout, options…)
    const u = norm(t);
    if (spec.keywords?.some((k) => [k.global, k.local, k.alias, k.local.replace(/[a-zé-ü]/g, '')].some((x) => x && norm(x) === u))) return null;
    const isLast = u === 'DERNIER' || u === 'LAST';
    const isPrev = u === 'PRECEDENT' || u === 'PREVIOUS';
    if (spec.kind === 'selection') {
      let hs: string[] = [];
      if (isLast) hs = this.last.filter((h) => this.app.doc.get(h));
      else if (isPrev) hs = this.previous.filter((h) => this.app.doc.get(h));
      else if (t.startsWith('$')) {
        for (const part of t.split(/[,+]/)) {
          const p = part.trim().replace(/^\$/, '');
          if (!p) continue;
          const r = this.named(p.split(':')[0]!);
          if (typeof r === 'string') return r;
          hs.push(...r);
        }
      } else return null;
      if (spec.filter) hs = hs.filter((h) => spec.filter!(h));
      hs = [...new Set(hs)];
      if (!hs.length) return `« ${t} » : aucun objet ne convient à l'invite « ${spec.message} ».`;
      return [{ kind: 'selection', value: hs }];
    }
    // désignation d'un objet, d'une arête ou d'une face
    let handles: string[];
    let selector: string | undefined;
    if (isLast) handles = this.last;
    else if (isPrev) handles = this.previous;
    else if (t.startsWith('$')) {
      const m = /^\$([^:]+)(?::(.+))?$/.exec(t);
      if (!m) return `« ${t} » incorrect.`;
      const r = this.named(m[1]!);
      if (typeof r === 'string') return r;
      handles = r;
      selector = m[2];
    } else return null;
    handles = handles.filter((h) => this.app.doc.get(h) && (!spec.filter || spec.filter(h)));
    if (!handles.length) return `« ${t} » : aucun objet ne convient à l'invite « ${spec.message} ».`;
    const mode = spec.pickMode ?? 'entity';
    if (mode === 'entity') {
      return handles.slice(0, 1).map((h) => ({ kind: 'entity', value: { handle: h, point: entityPoint(this.app.doc.get(h)!) } satisfies EntityPick }));
    }
    const e = this.app.doc.get(handles[0]!);
    if (!e || e.type !== '3DSOLID') return `« ${t} » n'est pas un solide.`;
    if (!selector) return `« ${t} » : précisez ${mode === 'edge' ? 'les arêtes' : 'les faces'}, par ex. ${t}:haut, ${t}:verticales, ${t}:2 ou ${t}:10,0,5.`;
    const subs = subElements(e, mode, selector);
    if (typeof subs === 'string') return subs;
    // sélecteur « x,y,z » : le point donné sert de point cliqué (centre d'un texte gravé, d'un trou…)
    const at = parsePointToken(selector);
    return subs.map((i) => ({ kind: 'entity', value: { handle: e.handle, point: at ?? subPoint(e, mode, i), sub: i } }));
  }
}

/** Compte rendu lisible (ligne de commande, presse-papiers, réponse MCP). */
export function formatReport(r: ScriptReport, verbose = false): string {
  const out: string[] = [];
  const head = r.ok ? `Script terminé : ${r.executed} ligne(s) exécutée(s) sans erreur` : r.aborted ? `Script interrompu après ${r.executed} ligne(s)` : `Script : ${r.errors} erreur(s) sur ${r.executed} ligne(s) exécutée(s) (${r.total} au total)`;
  out.push(`${head} en ${(r.durationMs / 1000).toFixed(1)} s.`);
  for (const l of r.lines) {
    if (l.status === 'ok' && !verbose && !l.warnings?.length) continue;
    if (l.status === 'skipped') {
      out.push(`  ligne ${l.line} : non exécutée — ${l.text}`);
      continue;
    }
    const tag = l.status === 'ok' ? 'OK' : l.status === 'cancelled' ? 'INTERROMPU' : 'ERREUR';
    out.push(`  ligne ${l.line} [${tag}] ${l.text}`);
    if (l.error) out.push(`      → ${l.error}`);
    for (const w of l.warnings ?? []) out.push(`      ! ${w}`);
    if (l.prompt) out.push(`      invite en attente : ${l.prompt}`);
    if (verbose || l.status !== 'ok') for (const m of l.messages.slice(-8)) out.push(`      | ${m}`);
    if (l.created.length && verbose) out.push(`      objets créés : ${l.created.join(', ')}`);
  }
  const names = Object.entries(r.names);
  if (names.length) out.push(`Objets nommés : ${names.map(([n, hs]) => `$${n} = ${hs.join(',')}`).join(' ; ')}`);
  return out.join('\n');
}
