/**
 * Xylform CAD 1.0 : mise à jour automatique (version bureau) et écran « Quoi de neuf ».
 */
import type { CommandDefinition } from '../../core/commands';
import type { AppHost } from '../AppHost';
import { desktop } from '../../io/desktop';
import { APP_VERSION, markNewsSeen, notesBetween, pendingNews, releases } from '../changelog';
import { cmd, getKeyword, kw } from './helpers';

const RELEASES_URL = 'https://github.com/Seb59181/XYLFORM-CAD/releases';

/** Affiche « Quoi de neuf » : notes des versions parues depuis `previous` (ou de la version actuelle). */
export async function showNews(app: AppHost, previous: string | null): Promise<void> {
  const notes = notesBetween(previous);
  markNewsSeen();
  if (notes.length) await app.ui.showNews(notes, previous);
}

/** Au démarrage : « Quoi de neuf » une seule fois par version (premier lancement compris). */
export async function newsAtStartup(app: AppHost): Promise<void> {
  const previous = pendingNews();
  if (previous === undefined) return;
  await showNews(app, previous);
}

/** Au démarrage (version installée) : recherche discrète d'une mise à jour. */
export function updatesAtStartup(app: AppHost): void {
  if (!desktop?.checkUpdates) return;
  desktop.onUpdateStatus?.((s) => {
    app.log(s.text);
    if (s.kind !== 'info') app.ui.toast(s.text, s.kind);
  });
  if (app.settings.autoUpdate) void desktop.checkUpdates(false).catch(() => undefined);
}

const update = cmd('CHECKFORUPDATES', 'MISEAJOUR', ['MAJ', 'UPDATE'], 'Recherche une nouvelle version de Xylform CAD (ou règle la vérification automatique au démarrage)', async (ctx, app) => {
  if (!desktop?.checkUpdates) {
    ctx.print(`Version ${APP_VERSION} dans le navigateur : rechargez la page pour la dernière version, ou téléchargez la version Windows sur ${RELEASES_URL}`);
    return;
  }
  const auto = app.settings.autoUpdate;
  const choice = await getKeyword(
    ctx,
    `Version ${APP_VERSION}. Vérification au démarrage : ${auto ? 'activée' : 'désactivée'}`,
    [kw('check', 'Vérifier', 'V', 'Rechercher maintenant'), kw('auto', 'Auto', 'A', auto ? 'Ne plus vérifier au démarrage' : 'Vérifier à chaque démarrage')],
    'check',
  );
  if (choice === 'auto') {
    app.set('autoUpdate', !auto);
    ctx.print(app.settings.autoUpdate ? 'Xylform CAD vérifiera les mises à jour à chaque démarrage.' : 'Vérification automatique désactivée (MISEAJOUR pour vérifier à la main).');
    return;
  }
  ctx.print('Recherche d’une mise à jour…');
  const r = await desktop.checkUpdates(true);
  if (!r.ok) ctx.print(`Mise à jour impossible : ${r.reason ?? 'erreur inconnue'}. Les versions sont aussi sur ${RELEASES_URL}`);
  else if (r.busy) ctx.print('Téléchargement de la mise à jour en cours…');
}, { transparent: true });

const news = cmd('WHATSNEW', 'QUOIDENEUF', ['NOUVEAUTES', 'NOUVEAUTÉS'], 'Affiche les nouveautés de cette version de Xylform CAD', async (ctx, app) => {
  const all = releases();
  if (!all.length) {
    ctx.print('Aucune note de version disponible.');
    return;
  }
  await showNews(app, null);
}, { transparent: true });

export const updateCommands: CommandDefinition[] = [update, news];
