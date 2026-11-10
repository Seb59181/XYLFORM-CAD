import { createRoot } from 'react-dom/client';
import { AppHost } from './app/AppHost';
import { registerAll } from './app/commands';
import { openDesktopFile, recoverRecord } from './app/commands/files';
import { newsAtStartup, updatesAtStartup } from './app/commands/updates';
import { desktop, fileFromDesktop } from './io/desktop';
import { Autosaver, offerRecovery } from './io/autosave';
import { App } from './ui/App';
import { AppContext } from './ui/context';
import './ui/styles.css';
import { hideSplash, setSplash, splashError } from './ui/splash';

setSplash('Démarrage de l’interface…', 5);

const app = new AppHost(registerAll);
app.autosave = new Autosaver(app);
app.autosave.start();

/**
 * Après le démarrage : « Quoi de neuf » (une fois par version), dessins non enregistrés lors de
 * la dernière session (plantage…), puis recherche discrète d'une mise à jour (version installée).
 */
function recovery(): void {
  void newsAtStartup(app)
    .catch(() => undefined)
    .then(() => afterNews());
  setTimeout(() => updatesAtStartup(app), 6000);
}

function afterNews(): void {
  void offerRecovery(app, async (r) => {
    try {
      await recoverRecord(app, r, (m) => app.log(m));
      app.ui.toast(`Dessin récupéré : ${r.name}`, 'success');
    } catch (e) {
      app.ui.toast(`Récupération de « ${r.name} » impossible : ${(e as Error).message}`, 'error');
    }
  });
}
// accès depuis la console du navigateur (débogage, scripts)
(window as unknown as { sebcad: AppHost }).sebcad = app;

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={app}>
    <App />
  </AppContext.Provider>,
);

// espace 3D : l'écran de démarrage suit le chargement du noyau OpenCascade ; en 2D, il n'est
// chargé que s'il sert et l'interface est prête tout de suite
requestAnimationFrame(() => {
  if (app.settings.workspace !== '3d') {
    setSplash('Prêt', 100);
    hideSplash(150);
    setTimeout(recovery, 400);
    return;
  }
  setSplash('Démarrage du moteur 3D…', 8);
  const off = app.kernel.onProgress((step, pct) => setSplash(step, pct));
  // filet de sécurité : l'interface reste utilisable même si le noyau tarde
  const slow = setTimeout(() => hideSplash(), 90_000);
  app.kernel.start().then(
    () => {
      setSplash('Prêt', 100);
      hideSplash(200);
      setTimeout(recovery, 450);
    },
    (e: Error) => {
      splashError(`Le noyau 3D n’a pas pu démarrer : ${e.message}. Le dessin 2D reste disponible.`);
      hideSplash(4000);
      setTimeout(recovery, 4500);
    },
  ).finally(() => (off(), clearTimeout(slow)));
});
document.getElementById('splash')?.addEventListener('click', () => hideSplash());

// version bureau : dessins ouverts par double-clic dans l'Explorateur Windows
desktop?.onOpenFile((f) => void openDesktopFile(app, fileFromDesktop(f)));
