/**
 * Outils du serveur MCP (Model Context Protocol), côté interface : un assistant IA compatible MCP
 * exécute des scripts de commandes, lit l'état du dessin, regarde une capture de la vue et
 * exporte en STL / 3MF / STEP / .xcad. Les définitions (nom, description, schéma) sont dans
 * electron/mcp-bridge.cjs ; le processus principal relaie ici chaque appel.
 */
import type { Entity } from '../../core/document/Document';
import { setSaveRedirect, type SaveOptions } from '../../io/fileAccess';
import type { AppHost } from '../AppHost';
import { buildAiGuide } from '../script/aiGuide';
import { formatReport } from '../script/ScriptRunner';

export interface McpRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  /** Dossier par défaut des fichiers exportés (Documents\Xylform CAD). */
  outputDir: string;
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface McpResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpWriter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], isError });

const r1 = (v: number) => Math.round(v * 100) / 100;
const pt = (p: { x: number; y: number; z: number }) => `${r1(p.x)},${r1(p.y)},${r1(p.z)}`;

/** Résumé du dessin : objets, dimensions, volumes, noms donnés par les scripts. */
export function drawingState(app: AppHost): string {
  const doc = app.doc;
  const names = new Map<string, string[]>();
  for (const [n, hs] of app.script.names) for (const h of hs) names.set(h, [...(names.get(h) ?? []), `$${n}`]);
  const visible = doc.all().filter((e) => e.type !== 'UNDERLAY');
  const out: string[] = [`Dessin « ${doc.fileName} » — unité : mm — ${visible.length} objet(s).`];
  const solids = visible.filter((e): e is Extract<Entity, { type: '3DSOLID' }> => e.type === '3DSOLID');
  if (solids.length) {
    out.push('', 'Solides :');
    for (const s of solids) {
      const { min, max } = s.display.bbox;
      const kind = s.display.solidCount > 0 ? `volume ${r1(s.display.volume)} mm³` : 'surface (non imprimable)';
      out.push(
        `- ${s.handle}${names.get(s.handle) ? ` ${names.get(s.handle)!.join(' ')}` : ''} « ${s.name} » : boîte ${pt(min)} → ${pt(max)} (${r1(max.x - min.x)} × ${r1(max.y - min.y)} × ${r1(max.z - min.z)}), ${kind}${s.color ? `, couleur ${s.color}` : ''}${s.hidden ? ', masqué' : ''}`,
      );
    }
  }
  const others = visible.filter((e) => e.type !== '3DSOLID');
  if (others.length) {
    const count = new Map<string, number>();
    for (const e of others) count.set(e.type, (count.get(e.type) ?? 0) + 1);
    out.push('', `Objets 2D : ${[...count].map(([t, n]) => `${n} ${t}`).join(', ')}`);
    const named = others.filter((e) => names.has(e.handle));
    for (const e of named.slice(0, 40)) out.push(`- ${e.handle} ${names.get(e.handle)!.join(' ')} : ${e.type}`);
  }
  if (app.script.names.size) out.push('', `Noms utilisables dans les scripts : ${[...app.script.names].filter(([, hs]) => hs.length).map(([n, hs]) => `$${n} (${hs.join(',')})`).join(', ')}`);
  return out.join('\n');
}

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`;

/** Chemin de sortie : fichier donné, dossier donné + nom proposé, ou dossier par défaut. */
export function outputPath(requested: string | undefined, suggested: string, outputDir: string): string {
  const r = requested?.trim();
  if (!r) return join(outputDir, suggested);
  if (/[\\/]$/.test(r) || !/\.[a-z0-9]{2,5}$/i.test(r)) return join(r, suggested);
  return r;
}

/** Une seule exécution à la fois : les appels attendent leur tour. */
let queue: Promise<unknown> = Promise.resolve();

export function handleMcp(app: AppHost, req: McpRequest, writer: McpWriter | null): Promise<McpResult> {
  const run = queue.then(() => dispatch(app, req, writer)).catch((e: Error) => text(`Erreur : ${e.message}`, true));
  queue = run;
  return run;
}

async function dispatch(app: AppHost, req: McpRequest, writer: McpWriter | null): Promise<McpResult> {
  const a = req.args ?? {};
  switch (req.tool) {
    case 'xylform_consigne':
      return text(buildAiGuide(app.registry, import.meta.env.VITE_APP_VERSION));

    case 'xylform_etat':
      return text(drawingState(app));

    case 'xylform_executer_script': {
      const script = String(a.script ?? '');
      if (!script.trim()) return text('Le script est vide.', true);
      if (a.nouveau_dessin === true) {
        app.newTab();
        app.log('Nouveau dessin ouvert par l’assistant IA.');
      }
      app.log('— Script reçu de l’assistant IA (MCP) —');
      const written: string[] = [];
      const previous = setSaveRedirect(redirectTo(writer, undefined, req.outputDir, written));
      let report;
      try {
        report = await app.script.run(script, { headless: true, continueOnError: a.continuer_apres_erreur === true });
      } finally {
        setSaveRedirect(previous);
      }
      const body = formatReport(report);
      for (const line of body.split('\n')) app.log(line);
      app.emit('prompt');
      const files = written.length ? `\n\nFichiers écrits :\n${written.map((w) => `- ${w}`).join('\n')}` : '';
      return text(`${body}${files}\n\n${drawingState(app)}`, !report.ok);
    }

    case 'xylform_capture': {
      const vue = typeof a.vue === 'string' && a.vue.trim() ? a.vue.trim() : '';
      if (vue) {
        const r = await app.script.run(`VUE ${vue}\nZOOM E`, { headless: true, singleUndo: false });
        if (!r.ok) return text(formatReport(r), true);
      }
      const vp = app.viewport;
      if (!vp) return text('Aucune vue disponible.', true);
      const w = Math.max(320, Math.min(1600, Number(a.largeur) || 1024));
      const h = Math.round((w * 3) / 4);
      const blob = (await vp.renderImage(w, h, '#eef1f4', 1)) ?? (await vp.screenshot());
      if (!blob) return text('Capture impossible.', true);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { content: [{ type: 'image', data: btoa(bin), mimeType: 'image/png' }, { type: 'text', text: drawingState(app) }] };
    }

    case 'xylform_exporter': {
      const format = String(a.format ?? 'stl').toLowerCase().replace(/^\./, '');
      const cmd = ({ stl: 'EXPORTSTL', '3mf': 'EXPORT3MF', step: 'EXPORTSTEP', stp: 'EXPORTSTEP', ifc: 'EXPORTIFC', dxf: 'EXPORTDXF', svg: 'EXPORTSVG', xcad: 'ENREGSOUS' } as Record<string, string>)[format];
      if (!cmd) return text(`Format « ${format} » non pris en charge : stl, 3mf, step, ifc, dxf, svg ou xcad.`, true);
      if (!writer) return text('L’export vers un fichier n’est possible que dans la version bureau.', true);
      // objets à exporter : noms de script ($nom) ou handles
      const pre: string[] = [];
      for (const part of String(a.objets ?? '').split(/[,\s]+/).filter(Boolean)) {
        const n = part.replace(/^\$/, '').toLowerCase();
        const hs = app.script.names.get(n) ?? (app.doc.get(part.toUpperCase()) ? [part.toUpperCase()] : null);
        if (!hs?.length) return text(`Objet « ${part} » inconnu (noms : ${[...app.script.names.keys()].map((k) => `$${k}`).join(', ') || 'aucun'}).`, true);
        pre.push(...hs);
      }
      const written: string[] = [];
      const previous = setSaveRedirect(redirectTo(writer, typeof a.chemin === 'string' ? a.chemin : undefined, req.outputDir, written));
      let report;
      try {
        report = await app.script.run(cmd, { headless: true, singleUndo: false, preselect: pre.length ? pre : undefined });
      } finally {
        setSaveRedirect(previous);
      }
      const body = formatReport(report, true);
      if (!written.length) return text(`${body}\n\nAucun fichier écrit.`, true);
      return text(`${body}\n\nFichier écrit : ${written.join(', ')}`, !report.ok);
    }

    case 'xylform_annuler': {
      const n = Math.max(1, Math.min(50, Math.floor(Number(a.etapes) || 1)));
      const done: string[] = [];
      for (let i = 0; i < n; i++) {
        const l = app.doc.undo();
        if (!l) break;
        done.push(l);
      }
      app.viewport?.redraw();
      return text(done.length ? `Annulé : ${done.join(', ')}.\n\n${drawingState(app)}` : 'Rien à annuler.');
    }

    default:
      return text(`Outil « ${req.tool} » inconnu.`, true);
  }
}

/** Enregistrements des commandes redirigés vers un fichier (sans boîte de dialogue). */
function redirectTo(writer: McpWriter | null, requested: string | undefined, outputDir: string, written: string[]) {
  return async (bytes: Uint8Array, opts: SaveOptions) => {
    if (!writer) throw new Error('Écriture de fichiers impossible hors de la version bureau.');
    const path = outputPath(requested, opts.name, outputDir);
    await writer.writeFile(path, bytes);
    written.push(path);
    const name = path.split(/[\\/]/).pop() ?? opts.name;
    return { name, handle: { path, name } };
  };
}
