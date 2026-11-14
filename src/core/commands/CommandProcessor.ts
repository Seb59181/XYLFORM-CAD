/**
 * Interpréteur de la ligne de commande.
 *
 * Il relie trois sources d'entrée à une seule file de prompts :
 *  - `submit(text)`   : ligne de commande et saisie dynamique (Entrée ou Espace côté UI) ;
 *  - `pick(point)`    : clic dans le viewport (avec accrochage aux objets déjà résolu) ;
 *  - `cancel()`       : Échap.
 *
 * Comportements classiques reproduits : Entrée à vide relance la dernière commande,
 * commandes transparentes (`'ZOOM`) au milieu d'un prompt, préfixe `_` pour les
 * noms globaux, messages d'erreur sans quitter le prompt, variable LASTPOINT.
 */
import { CommandHistory, CommandRegistry } from './CommandRegistry';
import { formatPrompt, parseInput, type ParseEnv } from './InputParser';
import {
  CommandCancelled,
  promptAxis,
  type CommandContext,
  type CommandDefinition,
  type EntityPick,
  type PromptResult,
  type PromptSpec,
  type Vec3,
} from './types';

export interface CommandProcessorEvents {
  /** Nouveau prompt à afficher (ligne de commande + bulle de saisie dynamique). */
  prompt?(spec: PromptSpec, text: string): void;
  /** Ligne ajoutée à l'historique de la ligne de commande. */
  print?(line: string): void;
  /** Plus aucune commande active : affichage de "Commande:". */
  idle?(): void;
  commandStart?(def: CommandDefinition): void;
  commandEnd?(def: CommandDefinition, status: 'done' | 'cancelled' | 'error'): void;
}

interface PendingPrompt {
  spec: PromptSpec;
  resolve(result: PromptResult): void;
}

interface Frame {
  def: CommandDefinition;
  abort: AbortController;
  pending: PendingPrompt | null;
  /** Résolue quand la commande est terminée (fin, annulation ou erreur). */
  done: Promise<void>;
}

export class CommandProcessor {
  readonly history = new CommandHistory();
  private readonly stack: Frame[] = [];
  private lastCommand: CommandDefinition | null = null;
  private _lastPoint: Vec3 = { x: 0, y: 0, z: 0 };
  /** Direction base→curseur fournie par le viewport à chaque mouvement de souris. */
  cursorDirection: Vec3 | undefined;
  elevation = 0;
  dynamicRelative = false;
  /** Jeu de sélection courant, livré quand l'utilisateur valide un prompt `selection`. */
  selectionSource: () => string[] = () => [];

  constructor(
    readonly registry: CommandRegistry,
    private readonly document: unknown,
    private readonly events: CommandProcessorEvents = {},
  ) {}

  get lastPoint(): Vec3 {
    return this._lastPoint;
  }

  get isIdle(): boolean {
    return this.stack.length === 0;
  }

  /** Prompt actuellement en attente (pour l'élastique et les options cliquables). */
  get activePrompt(): PromptSpec | null {
    return this.stack[this.stack.length - 1]?.pending?.spec ?? null;
  }

  /** Suggestions pour la saisie en cours : commandes si inactif, options sinon. */
  suggest(text: string) {
    const spec = this.activePrompt;
    if (!spec) return this.registry.complete(text);
    const q = text.trim().toUpperCase();
    return (spec.keywords ?? [])
      .filter((k) => !q || k.local.toUpperCase().startsWith(q))
      .map((k) => ({ name: k.global, insert: k.local, description: k.description, score: 0 }));
  }

  /** Saisie validée (Entrée/Espace). La commande démarrée s'exécute de façon asynchrone. */
  submit(text: string): void {
    const top = this.stack[this.stack.length - 1];

    if (!top) {
      const trimmed = text.trim();
      if (!trimmed) {
        if (this.lastCommand) void this.start(this.lastCommand);
        return;
      }
      const resolved = this.registry.resolve(trimmed);
      if (!resolved) {
        this.print(`Commande inconnue "${trimmed.toUpperCase()}". Appuyez sur F1 pour obtenir de l'aide.`);
        this.events.idle?.();
        return;
      }
      this.history.push(trimmed);
      void this.start(resolved.def);
      return;
    }

    if (!top.pending) return; // la commande calcule, saisie ignorée

    // Fin de sélection : Entrée valide le jeu de sélection construit au clic.
    if (top.pending.spec.kind === 'selection' && !text.trim()) {
      const handles = this.selectionSource();
      if (!handles.length && !top.pending.spec.allowNone) {
        this.print('Aucun objet sélectionné.');
        this.emitPrompt(top.pending.spec);
        return;
      }
      this.print(`${formatPrompt(top.pending.spec)}${handles.length} trouvé(s)`);
      this.deliver(top, handles.length ? { kind: 'selection', value: handles } : { kind: 'none' });
      return;
    }

    // Commande transparente au milieu d'un prompt.
    if (text.trim().startsWith("'")) {
      const resolved = this.registry.resolve(text);
      if (resolved?.transparent) {
        void this.start(resolved.def);
        return;
      }
    }

    const spec = top.pending.spec;
    const mod = spec.kind === 'point' ? pointModifier(text, spec) : null;
    if (mod) {
      this.print(`${formatPrompt(spec)}${text.trim()}`);
      void this.start(this.modifierCommand(mod, top, spec));
      return;
    }
    const dynBase = spec.dynBase ?? spec.basePoint;
    const env: ParseEnv = {
      lastPoint: this._lastPoint,
      elevation: this.elevation,
      cursorDirection: this.cursorDirection,
      dynamicRelative: this.dynamicRelative && !!dynBase,
      dynamicBase: this.dynamicRelative ? dynBase : undefined,
    };
    // saisie dynamique : « 100< » ou « 120, » (seconde case vide) = première valeur seule
    if (spec.kind === 'point') text = text.replace(/^([^<,]+)[<,]\s*$/, '$1');
    const result = parseInput(text, spec, env);
    if (result.kind === 'error') {
      this.print(result.message);
      this.emitPrompt(top.pending.spec);
      return;
    }
    this.print(`${formatPrompt(top.pending.spec)}${text.trim()}`);
    this.deliver(top, result);
  }

  /** Point cliqué dans le viewport. */
  pick(point: Vec3): void {
    const top = this.stack[this.stack.length - 1];
    if (!top?.pending) return;
    const spec = top.pending.spec;
    if (spec.kind === 'point') this.deliver(top, { kind: 'point', value: point });
    else if ((spec.kind === 'distance' || spec.kind === 'real') && spec.basePoint) {
      const b = spec.basePoint;
      const u = promptAxis(spec);
      const value = u ? (point.x - b.x) * u.x + (point.y - b.y) * u.y + (point.z - b.z) * u.z : Math.hypot(point.x - b.x, point.y - b.y, point.z - b.z);
      if (value < 0 && !spec.allowNegative) return;
      this.deliver(top, { kind: 'number', value });
      this._lastPoint = point;
    } else if (spec.kind === 'angle' && spec.basePoint) {
      this.deliver(top, { kind: 'number', value: Math.atan2(point.y - spec.basePoint.y, point.x - spec.basePoint.x) });
    }
  }

  /** Objet désigné dans le viewport (prompts `entity`). */
  pickEntity(pick: EntityPick): void {
    const top = this.stack[this.stack.length - 1];
    if (top?.pending?.spec.kind === 'entity') this.deliver(top, { kind: 'entity', value: pick });
  }

  /** Démarre une commande fournie directement (poignées, menus contextuels). */
  run(def: CommandDefinition): Promise<void> {
    if (this.stack.length && !def.transparent) return this.cancelAll().then(() => this.start(def));
    return this.start(def);
  }

  /** Lance une commande par son nom, comme si elle était tapée (boutons du ruban). */
  execute(text: string): void {
    const resolved = this.registry.resolve(text);
    if (!resolved) {
      this.print(`Commande inconnue "${text.toUpperCase()}".`);
      return;
    }
    this.history.push(text);
    // la commande courante est annulée et terminée (fin de groupe d'annulation) avant de lancer la suivante
    if (this.stack.length && !(resolved.transparent || resolved.def.transparent)) void this.cancelAll().then(() => this.start(resolved.def));
    else void this.start(resolved.def);
  }

  /** Annule toutes les commandes en cours (bouton du ruban pendant une commande). */
  cancelAll(): Promise<void> {
    const frames = [...this.stack];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      f.abort.abort();
      if (f.pending) this.deliver(f, { kind: 'cancel' });
    }
    return Promise.all(frames.map((f) => f.done)).then(() => undefined);
  }

  get activeCommand(): CommandDefinition | null {
    return this.stack[this.stack.length - 1]?.def ?? null;
  }

  get lastCommandName(): string | null {
    return this.lastCommand?.localName ?? null;
  }

  /** Message dans l'historique (utilisé par l'hôte). */
  echo(line: string): void {
    this.print(line);
  }

  /** Échap : annule la commande la plus interne. */
  cancel(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    top.abort.abort();
    if (top.pending) this.deliver(top, { kind: 'cancel' });
  }

  // -------------------------------------------------------------------------

  private async start(def: CommandDefinition): Promise<void> {
    let finished!: () => void;
    const frame: Frame = { def, abort: new AbortController(), pending: null, done: new Promise<void>((r) => (finished = r)) };
    this.stack.push(frame);
    this.registry.recordUsage(def);
    if (!def.transparent) this.lastCommand = def;
    this.print(`Commande: ${def.localName}`);
    this.events.commandStart?.(def);

    const processor = this;
    const ctx: CommandContext = {
      prompt: (spec) =>
        new Promise<PromptResult>((resolve) => {
          frame.pending = { spec, resolve };
          this.emitPrompt(spec);
        }),
      print: (m) => this.print(m),
      document: this.document,
      signal: frame.abort.signal,
      get lastPoint() {
        return processor._lastPoint;
      },
    };

    let status: 'done' | 'cancelled' | 'error' = 'done';
    try {
      await def.run(ctx);
    } catch (e) {
      if (e instanceof CommandCancelled) {
        status = 'cancelled';
        this.print('*Annuler*');
      } else {
        status = 'error';
        this.print(`Erreur dans ${def.localName} : ${(e as Error).message}`);
      }
    } finally {
      this.stack.splice(this.stack.indexOf(frame), 1);
      this.events.commandEnd?.(def, status);
      const parent = this.stack[this.stack.length - 1];
      if (parent?.pending) {
        this.print(`Reprise de la commande ${parent.def.localName}.`);
        this.emitPrompt(parent.pending.spec);
      } else if (!parent) this.events.idle?.();
      finished();
    }
  }

  /**
   * Modificateurs de point tapés à la place d'un point : DE (point de base puis
   * décalage @x,y) et M2P (milieu de deux points). Ils s'exécutent comme une commande transparente
   * et livrent le point obtenu à la commande en cours.
   */
  private modifierCommand(mod: 'from' | 'm2p', parent: Frame, spec: PromptSpec): CommandDefinition {
    const ask = async (ctx: CommandContext, s: PromptSpec): Promise<Vec3> => {
      const r = await ctx.prompt(s);
      if (r.kind !== 'point') throw new CommandCancelled();
      return r.value;
    };
    return {
      name: mod === 'from' ? 'FROM' : 'M2P',
      localName: mod === 'from' ? 'DE' : 'M2P',
      transparent: true,
      run: async (ctx) => {
        let p: Vec3;
        if (mod === 'from') {
          const base = await ask(ctx, { kind: 'point', message: 'Point de base' });
          p = await ask(ctx, { kind: 'point', message: '<Décalage> (ex. @10,5)', basePoint: base, dynBase: base });
        } else {
          const a = await ask(ctx, { kind: 'point', message: 'Premier point du milieu' });
          const b = await ask(ctx, { kind: 'point', message: 'Second point du milieu', basePoint: a });
          p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        }
        if (parent.pending?.spec === spec) this.deliver(parent, { kind: 'point', value: p });
      },
    };
  }

  private deliver(frame: Frame, result: PromptResult): void {
    const pending = frame.pending;
    if (!pending) return;
    frame.pending = null;
    if (result.kind === 'point') this._lastPoint = result.value;
    pending.resolve(result);
  }

  private emitPrompt(spec: PromptSpec): void {
    this.events.prompt?.(spec, formatPrompt(spec));
  }

  private print(line: string): void {
    this.events.print?.(line);
  }
}

/** « DE »/« FROM » ou « M2P »/« MTP » tapé à un prompt de point (sauf si c'est une option du prompt). */
function pointModifier(text: string, spec: PromptSpec): 'from' | 'm2p' | null {
  const t = text.trim().toUpperCase().replace(/^_/, '');
  const mod = t === 'DE' || t === 'FROM' || t === 'FRO' ? 'from' : t === 'M2P' || t === 'MTP' ? 'm2p' : null;
  if (!mod) return null;
  const clash = (spec.keywords ?? []).some((k) => [k.global, k.local, k.alias, k.local.replace(/[a-zé-ü]/g, '')].some((x) => x?.toUpperCase() === t));
  return clash ? null : mod;
}

/** Raccourcis pour écrire les commandes : lèvent `CommandCancelled` sur Échap. */
export async function ask(ctx: CommandContext, spec: PromptSpec): Promise<Exclude<PromptResult, { kind: 'cancel' }>> {
  const r = await ctx.prompt(spec);
  if (r.kind === 'cancel' || ctx.signal.aborted) throw new CommandCancelled();
  return r;
}
