/**
 * Connexion IA (serveur MCP), côté processus principal.
 *
 * Quand elle est activée, un petit serveur HTTP écoute sur 127.0.0.1 (port libre, jeton secret)
 * et relaie à l'interface les appels du pont MCP (electron/mcp-bridge.cjs) que lance l'assistant
 * IA. Le pont et le fichier de connexion sont écrits dans le dossier « mcp » des données de
 * l'application, à un emplacement fixe (même pour la version portable).
 */
const { app, dialog, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const dir = () => path.join(app.getPath('userData'), 'mcp');
const connectionFile = () => path.join(dir(), 'connexion.json');
const bridgeFile = () => path.join(dir(), 'xylform-mcp.cjs');
const outputDir = () => path.join(app.getPath('documents'), 'Xylform CAD');

let server = null;
let port = 0;
let token = '';
let getWin = () => null;
let rendererReady = false;
let nextId = 1;
const pending = new Map();

function readConnection() {
  try {
    return JSON.parse(fs.readFileSync(connectionFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** Programme à lancer pour ouvrir l'application (le pont le démarre si elle est fermée). */
function launcher() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
}

/** Configuration MCP à donner à l'assistant IA (format « mcpServers »). */
function clientConfig() {
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  // version installée : l'exécutable sert lui-même d'interpréteur Node (pas besoin d'installer Node)
  const entry =
    app.isPackaged && !portable
      ? { command: process.execPath, args: [bridgeFile()], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { command: 'node', args: [bridgeFile()] };
  return { mcpServers: { 'xylform-cad': entry } };
}

function writeFiles(enabled) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'mcp-bridge.cjs'), bridgeFile());
  const conn = { enabled, port: enabled ? port : 0, token: enabled ? token : '', ...launcher(), version: app.getVersion(), pid: enabled ? process.pid : 0 };
  fs.writeFileSync(connectionFile(), JSON.stringify(conn, null, 2), { mode: 0o600 });
}

function json(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

async function waitRenderer(ms) {
  const t = Date.now();
  while (!(rendererReady && getWin()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 200));
  return rendererReady && getWin();
}

function forward(tool, args) {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ content: [{ type: 'text', text: 'Xylform CAD n’a pas répondu à temps (30 min).' }], isError: true });
    }, 30 * 60 * 1000);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    getWin().webContents.send('mcp-request', { id, tool, args, outputDir: outputDir() });
  });
}

function handler(req, res) {
  const auth = req.headers.authorization || '';
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return json(res, 401, { error: 'jeton refusé' });
  // seules les requêtes locales sans origine de navigateur sont acceptées
  if (req.headers.origin) return json(res, 403, { error: 'origine refusée' });
  if (req.method === 'GET' && req.url === '/ping') return json(res, 200, { ok: true, version: app.getVersion() });
  if (req.method !== 'POST' || req.url !== '/call') return json(res, 404, { error: 'introuvable' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 5 * 1024 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return json(res, 400, { error: 'JSON illisible' });
    }
    if (!(await waitRenderer(60_000))) return json(res, 200, { content: [{ type: 'text', text: 'L’interface de Xylform CAD n’est pas prête.' }], isError: true });
    const win = getWin();
    if (win.isMinimized()) win.restore();
    json(res, 200, await forward(String(body.tool || ''), body.args || {}));
  });
}

async function start() {
  if (server) return;
  token = crypto.randomBytes(24).toString('hex');
  server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = server.address().port;
  writeFiles(true);
}

async function stop() {
  if (server) await new Promise((r) => server.close(() => r()));
  server = null;
  port = 0;
  token = '';
  writeFiles(false);
}

function status() {
  return {
    enabled: !!readConnection().enabled,
    running: !!server,
    port,
    bridge: bridgeFile(),
    connection: connectionFile(),
    outputDir: outputDir(),
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    config: clientConfig(),
  };
}

/** Ajoute (ou met à jour) l'entrée « xylform-cad » dans un fichier de configuration MCP choisi. */
async function install(win) {
  const appData = app.getPath('appData');
  const r = await dialog.showOpenDialog(win, {
    title: 'Fichier de configuration MCP de l’assistant IA',
    defaultPath: appData,
    filters: [{ name: 'Configuration JSON', extensions: ['json'] }],
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  let data = {};
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    return { ok: false, error: `Fichier illisible (JSON incorrect) : ${e.message}` };
  }
  try {
    fs.copyFileSync(file, `${file}.avant-xylform.bak`);
  } catch {
    /* fichier neuf : pas de copie */
  }
  data.mcpServers = { ...(data.mcpServers || {}), ...clientConfig().mcpServers };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { ok: true, file };
}

function attach(getWindow) {
  getWin = getWindow;
  ipcMain.on('renderer-ready', () => (rendererReady = true));
  ipcMain.on('mcp-response', (_e, id, result) => {
    const done = pending.get(id);
    if (done) {
      pending.delete(id);
      done(result);
    }
  });
  ipcMain.handle('mcp-status', () => status());
  ipcMain.handle('mcp-enable', async (_e, on) => {
    if (on) await start();
    else await stop();
    return status();
  });
  ipcMain.handle('mcp-install', () => install(getWin()));
  // fenêtre fermée : les appels en attente reçoivent une erreur
  app.on('browser-window-created', (_e, w) =>
    w.on('closed', () => {
      rendererReady = false;
      for (const [id, done] of pending) {
        pending.delete(id);
        done({ content: [{ type: 'text', text: 'Xylform CAD a été fermé.' }], isError: true });
      }
    }),
  );
  // réactivée au démarrage si elle l'était
  if (readConnection().enabled) start().catch((e) => console.error('MCP :', e.message));
  else {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'mcp-bridge.cjs'), bridgeFile());
    } catch {
      /* sans importance */
    }
  }
  app.on('before-quit', () => {
    if (server) {
      server.close();
      server = null;
      // le pont relancera l'application au prochain appel
      try {
        const c = readConnection();
        fs.writeFileSync(connectionFile(), JSON.stringify({ ...c, port: 0, pid: 0 }, null, 2));
      } catch {
        /* sans importance */
      }
    }
  });
}

module.exports = { attach, status };
