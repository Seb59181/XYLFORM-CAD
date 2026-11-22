/**
 * Scripts de commandes et pilotage par une IA : SCRIPT (fenêtre où coller, ouvrir et exécuter un
 * script), COULEUR et NOMOBJET (utiles aux scripts : couleur et nom des objets exportés en 3MF).
 */
import type { CommandDefinition } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import type { AppHost } from '../AppHost';
import { formatReport, type ScriptReport } from '../script/ScriptRunner';
import { cmd, getString, pickRequired, selectObjects } from './helpers';

const LAST_KEY = 'xylform.script.last';

export const SCRIPT_ACCEPT = '.xscr,.scr,.txt';
export const isScriptFile = (name: string) => /\.(xscr|scr)$/i.test(name);

function lastScript(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberScript(text: string): void {
  try {
    localStorage.setItem(LAST_KEY, text);
  } catch {
    /* stockage indisponible : sans importance */
  }
}

/** Exécute un script dans le dessin actif et écrit le compte rendu dans la ligne de commande. */
export async function runScript(app: AppHost, text: string, continueOnError = false): Promise<ScriptReport> {
  app.log('— Exécution du script —');
  const report = await app.script.run(text, { continueOnError });
  for (const line of formatReport(report).split('\n')) app.log(line);
  app.emit('prompt');
  if (report.ok) app.ui.toast(`Script exécuté : ${report.executed} ligne(s)`, 'success');
  else if (report.aborted) app.ui.toast('Script interrompu.', 'info');
  else app.ui.toast(`Script : ${report.errors} erreur(s), voir le compte rendu`, 'error');
  return report;
}

/**
 * Fenêtre des scripts : après une exécution avec erreurs, elle se rouvre avec le compte rendu
 * pour corriger et relancer.
 */
export async function scriptSession(app: AppHost, initial?: { text: string; fileName?: string }): Promise<void> {
  let text = initial?.text ?? lastScript();
  let fileName = initial?.fileName;
  let report: ScriptReport | undefined;
  let continueOnError = false;
  for (;;) {
    const r = await app.ui.scriptEditor({ text, fileName, report, continueOnError });
    if (!r) return;
    text = r.text;
    fileName = r.fileName;
    continueOnError = r.continueOnError;
    rememberScript(text);
    if (!(await app.leaveCommand())) return;
    // nouvel essai après une erreur : le résultat partiel du précédent est d'abord annulé
    if (report && !report.ok && report.undoLabel && app.doc.undoLabel === report.undoLabel) {
      app.doc.undo();
      app.log('Résultat partiel de l’essai précédent annulé.');
    }
    report = await runScript(app, text, continueOnError);
    if (report.ok || report.aborted) return;
  }
}

/** Ouvre un fichier de script (glissé dans la fenêtre ou ouvert depuis l'Explorateur). */
export async function openScriptFile(app: AppHost, file: File): Promise<void> {
  await scriptSession(app, { text: await file.text(), fileName: file.name });
}

const script = cmd('SCRIPT', 'SCRIPT', ['SCR', 'EXECSCRIPT', 'SCRIPTIA'], 'Exécute un script de commandes (.xscr, .scr, .txt), par exemple écrit par une IA', async (_ctx, app) => {
  if (app.script.busy) throw new Error('Un script est déjà en cours.');
  // la fenêtre s'ouvre une fois la commande terminée : le script s'exécute comme une saisie normale
  setTimeout(() => void scriptSession(app), 0);
});

/** Couleurs nommées acceptées par COULEUR. */
export const COLOR_NAMES: Record<string, string> = {
  rouge: '#e63946',
  red: '#e63946',
  vert: '#2a9d4f',
  green: '#2a9d4f',
  bleu: '#1d70c9',
  blue: '#1d70c9',
  jaune: '#f4c430',
  yellow: '#f4c430',
  orange: '#f4801f',
  violet: '#7b3fa0',
  purple: '#7b3fa0',
  rose: '#f28cb1',
  cyan: '#20b2c8',
  magenta: '#c2338f',
  noir: '#1a1a1a',
  black: '#1a1a1a',
  blanc: '#f5f5f5',
  white: '#f5f5f5',
  gris: '#8d949b',
  gray: '#8d949b',
  grey: '#8d949b',
  marron: '#7a4b2a',
  brown: '#7a4b2a',
};

/** Couleur saisie → #rrggbb ; null = DuCalque ; undefined = incorrecte. */
export function parseColor(input: string): string | null | undefined {
  const s = input.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!s || s === 'ducalque' || s === 'bylayer' || s === 'calque') return null;
  if (COLOR_NAMES[s]) return COLOR_NAMES[s];
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
  }
  const rgb = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(s.replace(/\s+/g, ''));
  if (rgb) {
    const v = [rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, Number(x)));
    return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  return undefined;
}

const color = cmd('COLOR', 'COULEUR', ['COUL', 'COL'], 'Couleur propre des objets choisis (nom, #RRGGBB, r,g,b ou DuCalque) ; reprise dans l’export 3MF', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets à colorer');
  if (!hs.length) return;
  for (;;) {
    const s = await getString(ctx, 'Couleur (rouge, bleu, vert, jaune, orange, violet, noir, blanc, gris, #RRGGBB, r,g,b ou DuCalque)', 'DuCalque');
    if (s === null) return;
    const c = parseColor(s);
    if (c === undefined) {
      ctx.print(`Couleur « ${s} » inconnue.`);
      continue;
    }
    app.doc.transaction('Couleur', () => hs.forEach((h) => app.doc.replaceEntity(h, { color: c ?? undefined } as Partial<Entity>)));
    ctx.print(`${hs.length} objet(s) : couleur ${c ?? 'DuCalque'}.`);
    return;
  }
});

const rename = cmd('OBJECTNAME', 'NOMOBJET', ['NOMMER', 'RENOMMEROBJET'], 'Donne un nom à un solide (Navigateur, nomenclature, objets du fichier 3MF)', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Choisissez le solide à nommer', (x) => x.type === '3DSOLID');
  const s = await getString(ctx, 'Nom du solide', (e as Extract<Entity, { type: '3DSOLID' }>).name);
  if (!s?.trim()) return;
  app.doc.replaceEntity(e.handle, { name: s.trim() } as Partial<Entity>);
  ctx.print(`Solide nommé « ${s.trim()} ».`);
});

const mcp = cmd('MCP', 'MCP', ['CONNEXIONIA', 'SERVEURMCP'], 'Connexion IA : serveur MCP local pour qu’un assistant IA dessine dans Xylform CAD (version bureau)', async (_ctx, app) => app.ui.mcpPanel());

export const scriptCommands: CommandDefinition[] = [script, color, rename, mcp];
