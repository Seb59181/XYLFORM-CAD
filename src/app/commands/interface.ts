/**
 * Agencement de l'interface (2.0) : fenêtres de vue multiples, onglets des dessins, écran épuré,
 * page Démarrage.
 */
import type { CommandDefinition } from '../../core/commands';
import type { ViewportLayout } from '../AppHost';
import { cmd, getKeyword, kw } from './helpers';

const LAYOUT_TEXT: Record<ViewportLayout, string> = { '1': 'une fenêtre', '2v': 'deux fenêtres côte à côte', '2h': 'deux fenêtres l’une sur l’autre', '3': 'trois fenêtres', '4': 'quatre fenêtres' };

const vports = cmd('VPORTS', 'FENETRES', ['FMULT', 'FENETRESVUE', 'VUESMULT'], 'Fenêtres de vue : 1, 2, 3 ou 4 vues du dessin (Dessus, Face, Droite…) ; on dessine dans la vue active', async (ctx, app) => {
  ctx.print('Les fenêtres secondaires montrent le même dessin sous un autre angle ; un clic dans l’une la rend active (sa vue passe dans la fenêtre de travail).');
  const v = await getKeyword(
    ctx,
    'Nombre de fenêtres',
    [kw('1', '1', '1', 'Une seule fenêtre'), kw('2v', '2V', '2V', 'Deux, côte à côte'), kw('2h', '2H', '2H', 'Deux, l’une sur l’autre'), kw('3', '3', '3', 'Trois : grande vue à gauche, deux à droite'), kw('4', '4', '4', 'Quatre')],
    app.settings.viewports === '1' ? '3' : '1',
  );
  app.set('viewports', v as ViewportLayout);
  ctx.print(`Disposition : ${LAYOUT_TEXT[v as ViewportLayout]}.`);
}, { transparent: true });

const fileTabs = cmd('FILETAB', 'ONGLETSDESSIN', ['ONGLETS', 'FILETABCLOSE'], 'Affiche ou masque la barre d’onglets des dessins', async (ctx, app) => {
  app.set('fileTabs', !app.settings.fileTabs);
  ctx.print(`Onglets des dessins ${app.settings.fileTabs ? 'affichés' : 'masqués'}.`);
}, { transparent: true });

const cleanScreen = cmd('CLEANSCREENON', 'ECRANEPURE', ['EPURE', 'CLEANSCREEN', 'CLEANSCREENOFF'], 'Écran épuré : masque ou rétablit le ruban et les onglets (Ctrl+0)', async (ctx, app) => {
  app.toggleCleanScreen();
  ctx.print(app.cleanScreen ? 'Écran épuré (Ctrl+0 pour revenir).' : 'Ruban et onglets rétablis.');
}, { transparent: true });

const start = cmd('STARTTAB', 'DEMARRAGE', ['ACCUEIL', 'START'], 'Affiche la page Démarrage (nouveau, ouvrir, dessins récents)', async (_ctx, app) => {
  app.showStart(true);
}, { transparent: true });

export const interfaceCommands: CommandDefinition[] = [vports, fileTabs, cleanScreen, start];
