/**
 * Mise à jour automatique de Xylform CAD (electron-updater + GitHub Releases).
 *
 * - Version installée (installateur NSIS) : recherche au démarrage (si l'option est active) et par
 *   la commande MISEAJOUR ; l'utilisateur choisit de télécharger, puis d'installer tout de suite
 *   (redémarrage) ou à la fermeture du logiciel.
 * - Version portable : elle ne peut pas se remplacer elle-même ; on signale la nouvelle version et
 *   on ouvre la page de téléchargement.
 * - Lancement depuis les sources (npm run desktop) : rien n'est fait.
 *
 * Les versions sont lues dans le fichier latest.yml de la dernière « Release » du dépôt GitHub
 * (configuré par `publish` dans electron-builder.config.cjs).
 */
const { app, dialog, shell } = require('electron');

const NAME = 'Xylform CAD';
const RELEASES = 'https://github.com/Seb59181/XYLFORM-CAD/releases/latest';
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

let win = null;
let busy = false;
let downloaded = null;
/** Réponse en attente d'une recherche lancée à la main (commande MISEAJOUR). */
let manualCheck = false;

const available = () => !!autoUpdater && app.isPackaged;

/** Message dans la ligne de commande de l'interface. */
function status(text, kind = 'info') {
  win?.webContents.send('update-status', { text, kind });
}

function box(opts) {
  return win ? dialog.showMessageBox(win, { title: NAME, noLink: true, ...opts }) : dialog.showMessageBox({ title: NAME, noLink: true, ...opts });
}

/** Notes de version (texte brut) fournies par GitHub. */
function notes(info) {
  const n = info.releaseNotes;
  const text = Array.isArray(n) ? n.map((x) => x.note).join('\n') : n || '';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 900);
}

function setup() {
  if (!available()) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', async (info) => {
    const manual = manualCheck;
    manualCheck = false;
    status(`${NAME} ${info.version} est disponible (version installée : ${app.getVersion()}).`);
    const detail = notes(info);
    if (PORTABLE) {
      const r = await box({
        type: 'info',
        message: `${NAME} ${info.version} est disponible.`,
        detail: `Vous utilisez la version portable ${app.getVersion()}, qui ne peut pas se mettre à jour toute seule : téléchargez la nouvelle version portable (ou l'installateur, qui se met ensuite à jour automatiquement).${detail ? `\n\n${detail}` : ''}`,
        buttons: ['Ouvrir la page de téléchargement', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) void shell.openExternal(RELEASES);
      return;
    }
    const r = await box({
      type: 'info',
      message: `${NAME} ${info.version} est disponible.`,
      detail: `Version installée : ${app.getVersion()}. Télécharger la mise à jour maintenant ? (Vous pourrez continuer à travailler pendant le téléchargement.)${detail ? `\n\nNouveautés :\n${detail}` : ''}`,
      buttons: ['Télécharger', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) {
      if (manual) status('Mise à jour reportée. Commande MISEAJOUR pour la relancer.');
      return;
    }
    busy = true;
    status(`Téléchargement de ${NAME} ${info.version}…`);
    autoUpdater.downloadUpdate().catch((e) => {
      busy = false;
      win?.setProgressBar(-1);
      status(`Téléchargement de la mise à jour impossible : ${e.message}`, 'error');
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      manualCheck = false;
      status(`${NAME} est à jour (version ${app.getVersion()}).`, 'success');
      void box({ type: 'info', message: `${NAME} est à jour.`, detail: `Version ${app.getVersion()}, la plus récente publiée.`, buttons: ['OK'] });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    win?.setProgressBar(Math.max(0, Math.min(1, p.percent / 100)));
  });

  autoUpdater.on('update-downloaded', async (info) => {
    busy = false;
    downloaded = info.version;
    win?.setProgressBar(-1);
    status(`Mise à jour ${info.version} téléchargée : elle sera installée à la fermeture de ${NAME}.`, 'success');
    const r = await box({
      type: 'info',
      message: `La mise à jour ${info.version} est prête.`,
      detail: `Redémarrer maintenant pour l'installer ? Sinon elle s'installera à la fermeture de ${NAME}.\nLes dessins non enregistrés vous seront signalés avant la fermeture.`,
      buttons: ['Redémarrer et installer', 'À la fermeture'],
      defaultId: 0,
      cancelId: 1,
    });
    // isSilent = false : l'installateur affiche sa progression ; isForceRunAfter : relance du logiciel
    if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });

  autoUpdater.on('error', (e) => {
    busy = false;
    win?.setProgressBar(-1);
    if (manualCheck) {
      manualCheck = false;
      void box({ type: 'warning', message: 'Recherche de mise à jour impossible.', detail: `${e?.message ?? e}\n\nVérifiez la connexion Internet, ou consultez ${RELEASES}`, buttons: ['OK'] });
    }
    status(`Mise à jour : ${e?.message ?? e}`, 'error');
  });
}

/** Fenêtre principale (dialogues, barre de progression dans la barre des tâches). */
function attach(w) {
  win = w;
}

/**
 * Recherche une mise à jour. `manual` : demandée par l'utilisateur (on répond même s'il n'y a
 * rien de neuf). Renvoie l'état pour l'interface.
 */
async function check(manual) {
  if (!available()) return { ok: false, reason: app.isPackaged ? 'Module de mise à jour absent.' : 'Mise à jour automatique disponible seulement dans la version installée.' };
  if (downloaded) {
    if (manual) {
      const r = await box({ type: 'info', message: `La mise à jour ${downloaded} est déjà téléchargée.`, detail: 'Redémarrer maintenant pour l’installer ?', buttons: ['Redémarrer et installer', 'Plus tard'], defaultId: 0, cancelId: 1 });
      if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
    return { ok: true, downloaded };
  }
  if (busy) return { ok: true, busy: true };
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    manualCheck = false;
    return { ok: false, reason: e.message };
  }
}

setup();

module.exports = { attach, check, available };
