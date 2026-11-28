#!/usr/bin/env node
/**
 * Xylform CAD — serveur MCP (Model Context Protocol) en entrée/sortie standard.
 *
 * Un assistant IA compatible MCP lance ce fichier (avec Node, ou avec XylformCAD.exe et la
 * variable ELECTRON_RUN_AS_NODE=1) et lui parle en JSON-RPC, une requête par ligne. Chaque appel
 * d'outil est relayé à l'application Xylform CAD ouverte (serveur HTTP local, 127.0.0.1, jeton
 * secret) ; si elle n'est pas ouverte, elle est lancée et attendue.
 *
 * L'application recopie ce fichier, avec le fichier de connexion (port, jeton, programme), dans
 * le dossier « mcp » de ses données : %APPDATA%\Xylform CAD\mcp\ sous Windows.
 * Aucune dépendance : seulement les modules de Node.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const CONNECTION = process.env.XYLFORM_MCP_CONNECTION || path.join(__dirname, 'connexion.json');
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Xylform CAD est un logiciel de CAO 2D/3D pour l’impression 3D (unité : mm, Z vers le haut).',
  'Pour modéliser, appelle d’abord xylform_consigne (format des scripts et liste des commandes), puis xylform_executer_script avec un script de commandes.',
  'Après chaque script, lis le compte rendu : en cas d’erreur, corrige la ligne en cause et relance seulement la suite.',
  'Vérifie le résultat avec xylform_capture (image) ou xylform_etat (dimensions et volumes), puis exporte avec xylform_exporter (stl ou 3mf ; ifc pour un logiciel BIM).',
].join(' ');

const TOOLS = [
  {
    name: 'xylform_consigne',
    title: 'Consigne des scripts',
    description: 'Renvoie la fiche de référence des scripts de commandes Xylform CAD (format, désignation des objets, ordre des réponses de chaque commande, exemples) et la liste de toutes les commandes. À lire avant d’écrire un premier script.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'xylform_executer_script',
    title: 'Exécuter un script',
    description:
      'Exécute un script de commandes dans le dessin ouvert de Xylform CAD (une commande par ligne, ex. « plaque = BOITE 0,0,0 100,60,8 » puis « SOUSTRACTION $plaque $trou »). Renvoie un compte rendu ligne par ligne (erreurs, question en attente, valeurs par défaut prises) et l’état du dessin. Les noms ($nom) restent valables d’un appel à l’autre. Tout le script s’annule en une fois avec xylform_annuler.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Texte du script : une commande par ligne, réponses séparées par des espaces, commentaires après « ; ».' },
        nouveau_dessin: { type: 'boolean', description: 'Ouvre d’abord un nouveau dessin vide (nouvel onglet). Défaut : non (le dessin actif est complété).' },
        continuer_apres_erreur: { type: 'boolean', description: 'Continue les lignes suivantes après une erreur. Défaut : arrêt à la première erreur.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
  },
  {
    name: 'xylform_etat',
    title: 'État du dessin',
    description: 'Liste les objets du dessin actif : solides avec boîte englobante, dimensions, volume, couleur, et les noms ($nom) utilisables dans les scripts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'xylform_capture',
    title: 'Capture de la vue',
    description: 'Image PNG de la vue 3D actuelle (pour vérifier la forme), avec l’état du dessin. Option vue : ISOSE, ISOSO, ISONE, ISONO, Dessus, Dessous, Face, Arriere, Gauche, Droite (la vue est cadrée sur tout le dessin).',
    inputSchema: {
      type: 'object',
      properties: {
        vue: { type: 'string', description: 'Vue à afficher avant la capture (ex. ISOSE, Dessus, Face). Vide : vue actuelle.' },
        largeur: { type: 'number', description: 'Largeur de l’image en pixels (320 à 1600, défaut 1024).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'xylform_exporter',
    title: 'Exporter',
    description:
      'Exporte les solides en STL ou 3MF (impression 3D, contrôle d’imprimabilité et d’étanchéité inclus), en STEP, DXF, SVG, ou enregistre le dessin (.xcad). Sans chemin, le fichier va dans Documents\\Xylform CAD.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['stl', '3mf', 'step', 'ifc', 'dxf', 'svg', 'xcad'], description: 'Format du fichier.' },
        chemin: { type: 'string', description: 'Chemin complet du fichier, ou dossier de destination. Facultatif.' },
        objets: { type: 'string', description: 'Objets à exporter : noms de script séparés par des virgules ($plaque,$capot). Défaut : tous les solides visibles.' },
      },
      required: ['format'],
      additionalProperties: false,
    },
  },
  {
    name: 'xylform_annuler',
    title: 'Annuler',
    description: 'Annule les dernières modifications du dessin (un script entier compte pour une étape).',
    inputSchema: { type: 'object', properties: { etapes: { type: 'number', description: 'Nombre d’étapes à annuler (défaut 1).' } }, additionalProperties: false },
    annotations: { destructiveHint: true },
  },
];

const log = (...a) => process.stderr.write(`[xylform-mcp] ${a.join(' ')}\n`);

function readConnection() {
  try {
    return JSON.parse(fs.readFileSync(CONNECTION, 'utf8'));
  } catch {
    return null;
  }
}

/** Requête HTTP vers l'application ; rejette si elle n'écoute pas. */
function request(conn, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: conn.port,
        path: route,
        method,
        headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(Object.assign(new Error(raw || `HTTP ${res.statusCode}`), { status: res.statusCode }));
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(conn) {
  if (!conn || !conn.port || !conn.token) return false;
  try {
    const r = await request(conn, 'GET', '/ping', undefined, 3000);
    return !!r.ok;
  } catch {
    return false;
  }
}

let launching = null;

/** Connexion à l'application, lancée si besoin (jusqu'à 60 s d'attente). */
async function connect() {
  let conn = readConnection();
  if (await ping(conn)) return conn;
  if (!conn) throw new Error('Fichier de connexion introuvable : ouvrez Xylform CAD et activez la connexion IA (onglet Insertion › Connexion IA).');
  if (conn.enabled === false) throw new Error('La connexion IA est désactivée dans Xylform CAD (onglet Insertion › Connexion IA).');
  if (!conn.exe || !fs.existsSync(conn.exe)) throw new Error('Xylform CAD n’est pas ouvert. Ouvrez-le puis réessayez.');
  if (!launching) {
    launching = (async () => {
      log('lancement de Xylform CAD :', conn.exe);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(conn.exe, conn.args || [], { detached: true, stdio: 'ignore', env, windowsHide: false });
      child.on('error', (e) => log('lancement impossible :', e.message));
      child.unref();
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const c = readConnection();
        if (await ping(c)) return c;
      }
      throw new Error('Xylform CAD ne répond pas (lancé depuis 60 s). Ouvrez-le à la main puis réessayez.');
    })().finally(() => {
      launching = null;
    });
  }
  conn = await launching;
  return conn;
}

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return { content: [{ type: 'text', text: `Outil inconnu : ${name}` }], isError: true };
  let conn;
  try {
    conn = await connect();
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
  try {
    return await request(conn, 'POST', '/call', { tool: name, args: args || {} }, 30 * 60 * 1000);
  } catch (e) {
    if (e.status === 401) return { content: [{ type: 'text', text: 'Jeton refusé : relancez l’assistant IA après avoir réactivé la connexion IA dans Xylform CAD.' }], isError: true };
    return { content: [{ type: 'text', text: `Xylform CAD n’a pas répondu : ${e.message}` }], isError: true };
  }
}

// --- JSON-RPC sur l'entrée / la sortie standard -------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'xylform-cad', title: 'Xylform CAD', version: (readConnection() || {}).version || VERSION },
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        result = await callTool(params && params.name, params && params.arguments);
        break;
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      default:
        if (!isRequest) return; // notifications (initialized, cancelled…) : rien à répondre
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${method}` } });
        return;
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

if (require.main === module) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON illisible' } });
        continue;
      }
      if (Array.isArray(msg)) msg.forEach((m) => void handle(m));
      else void handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`prêt (connexion : ${CONNECTION})`);
}

module.exports = { TOOLS, INSTRUCTIONS, handle };
