/**
 * Xylform CAD, by Seb. — version bureau (Electron).
 *
 * L'application web compilée (dossier dist/) est servie par un protocole privé `app://sebcad`
 * (nom d'hôte hérité de SebCad, gardé pour conserver les réglages enregistrés par le navigateur)
 * (origine sécurisée : modules, workers et WebAssembly fonctionnent comme sur un serveur).
 * Le préchargement expose `window.sebcadDesktop` : boîtes Enregistrer natives, lecture et
 * écriture de fichiers par chemin, ouverture des dessins par double-clic dans l'Explorateur,
 * mise à jour automatique depuis GitHub Releases (electron/updater.cjs).
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const updater = require('./updater.cjs');

const NAME = 'Xylform CAD';

const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.XYLFORM_DEV_URL || process.env.SEBCAD_DEV_URL; // ex. http://localhost:5173 (npm run desktop:dev)
const OPENABLE = /\.(xcad|sebcad|ncad|dwg|dxf|step|stp|stl|3mf|pdf|png|jpe?g)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Première ouverture de Xylform CAD sur un PC où SebCad était installé : on reprend son dossier de
 * données (réglages, ruban personnalisé, dessins récents, copies de secours). L'ancien est conservé.
 */
function migrateFromSebCad() {
  try {
    const target = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'SebCad');
    if (fsSync.existsSync(target) || !fsSync.existsSync(old)) return;
    fsSync.cpSync(old, target, {
      recursive: true,
      // verrous et caches de Chromium : inutiles et parfois verrouillés
      filter: (src) => !/[\\/](Singleton\w*|lockfile|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad)$/.test(src),
    });
  } catch {
    /* sans importance : on démarre avec des réglages neufs */
  }
}
migrateFromSebCad();

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

/** Fichiers à ouvrir (ligne de commande ou seconde instance) en attendant l'interface. */
let pending = [];
let ready = false;
let win = null;

const filesFromArgs = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && OPENABLE.test(a));

async function sendFile(p) {
  try {
    const data = await fs.readFile(p);
    win?.webContents.send('open-file', { name: path.basename(p), path: p, data: new Uint8Array(data) });
  } catch (e) {
    dialog.showErrorBox(NAME, `Impossible d’ouvrir « ${p} » :\n${e.message}`);
  }
}

function queue(paths) {
  if (ready) paths.forEach(sendFile);
  else pending.push(...paths);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Xylform CAD, by Seb.',
    backgroundColor: '#1b1f24',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  updater.attach(win);
  // le dessin n'est pas enregistré : on demande avant de fermer
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: NAME,
      message: 'Un ou plusieurs dessins ouverts contiennent des modifications non enregistrées.',
      detail: 'Quitter sans enregistrer ? (Pour enregistrer : Annuler, puis ENREGTOUT ou clic droit sur un onglet › Enregistrer tout.)',
      buttons: ['Quitter sans enregistrer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift) win.webContents.toggleDevTools();
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  void win.loadURL(DEV_URL || 'app://sebcad/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    queue(filesFromArgs(argv));
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('fr.seb.xylformcad');
    Menu.setApplicationMenu(null);
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST)) return new Response('Interdit', { status: 403 });
      try {
        const data = await fs.readFile(file);
        return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(data.length) } });
      } catch {
        return new Response('Introuvable', { status: 404 });
      }
    });

    ipcMain.handle('read-file', async (_e, p) => new Uint8Array(await fs.readFile(p)));
    ipcMain.handle('write-file', async (_e, p, data) => {
      await fs.writeFile(p, Buffer.from(data));
    });
    ipcMain.handle('save-dialog', async (_e, opts) => {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: opts.name,
        filters: [{ name: opts.description, extensions: opts.extensions.map((x) => x.replace(/^\./, '')) }, { name: 'Tous les fichiers', extensions: ['*'] }],
      });
      return r.canceled ? null : r.filePath;
    });
    ipcMain.handle('check-updates', (_e, manual) => updater.check(!!manual));
    ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_FILE, updates: updater.available() }));
    ipcMain.on('renderer-ready', () => {
      ready = true;
      const list = pending;
      pending = [];
      list.forEach(sendFile);
    });

    queue(filesFromArgs(process.argv));
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
