/**
 * Scripts de commandes avec le noyau (OCC=1) : chaque exemple de la consigne pour l'IA
 * (docs/scripts-ia.md) s'exécute sans erreur ni valeur par défaut imprévue ; noms qui suivent
 * les objets, arêtes et faces désignées par côté, export STL / 3MF sans boîte de dialogue.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { run as runKernel } from '../src/kernel/dispatch';
import type { KernelRequest } from '../src/kernel/protocol';
import type { KernelClient } from '../src/kernel/KernelClient';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { formatReport, subElements } from '../src/app/script/ScriptRunner';
import type { Entity } from '../src/core/document/Document';
import { setSaveRedirect } from '../src/io/fileAccess';
import { handleMcp } from '../src/app/mcp/mcpTools';

type Solid = Extract<Entity, { type: '3DSOLID' }>;

/** Toutes les lignes d'exemple de la consigne, avec les objets qu'elles supposent. */
const REFERENCE = `
BOITE 0,0,0 100,60,8
CYLINDRE 0,0,0 D 20 30
CYLINDRE 0,0,10 5 A 50,0,10
CONE 0,0,0 10 R 4 20
SPHERE 0,0,20 10
PYRAMIDE C 6 0,0,0 10 15
TORE 0,0,5 20 3
HELICE 0,0,0 10 10 H 2 20
LIGNE 0,0 50,0 50,30
LIGNE 0,0 50,0 50,30 C
p = POLYLIGNE 0,0 40,0 40,20 A 0,40 L C
RECTANGLE R 5 0,0 80,50
RECTANGLE CH 2 0,0 80,50
c = CERCLE 40,25 8
CERCLE 2P 0,0 10,0
CERCLE 3P 0,0 10,0 5,5
ARC CE 0,0 10,0 0,10
POLYGONE 6 0,0 I 15
POLYGONE 6 0,0 C 15
ELLIPSE 0,0 20,0 10
SPLINE 0,0 10,5 20,0 30,5 ""
SPLINE 0,0 10,5 20,0 C
ELEV 20
ELEV 0
DECALER 3 $c 100,100
EXTRUSION $p 10
p = POLYLIGNE 0,0 40,0 40,20 0,20 C
EXTRUSION $p A 5 20
pr = POLYLIGNE 5,0 20,0 20,30 5,30 C
REVOLUTION $pr Y 360
section = CERCLE 10,0 1
helice = HELICE 0,0,0 10 10 H 3 15
BALAYAGE $section $helice
bas = CERCLE 0,0 20
ELEV 30
haut = RECTANGLE -10,-10 10,10
ELEV 0
LISSAGE $bas,$haut L
bloc = BOITE 200,0,0 250,40,20
APPUYERTIRER $bloc:haut 5
a = BOITE 300,0,0 320,20,20
b = CYLINDRE 320,10,0 8 20
c = SPHERE 300,0,20 6
UNION $a,$b,$c
plaque = BOITE 0,0,-100 100,60,8
trou1 = CYLINDRE 20,30,-101 3 120
trou2 = CYLINDRE 80,30,-101 3 120
SOUSTRACTION $plaque $trou1,$trou2
RACCORDBORD R 3 $plaque:verticales
CHANFREINBORD D 1 $plaque:haut
PERCAGE $plaque:haut T PA TA M4 15,15 85,15 ""
TEXTE3D "XYL" H 8 P 1 G $plaque:50,30,8
boite = BOITE 500,0,0 540,30,20
COQUE $boite $boite:haut "" 2
TEXTE3D "Seb" H 8 P 2 50,250,0
a = BOITE 400,0,0 420,20,20
b = SPHERE 420,20,20 12
INTERSECT $a,$b
DEPLACER $a 0,0,0 0,0,20
copie = COPIER $a 0,0,0 50,0,0
ROTATION $a 0,0 45
ROTATION3D $a 0,0,0 X 90
MIROIR3D $a YZ 0,0,0 N
ECHELLE $a 0,0,0 2
COUPE $a XY 0,0,5 0,0,10
plot = CYLINDRE 0,300,0 3 10
RESEAU3D $plot R 4 2 1 25 25
trou = CERCLE 0,400 3
RESEAUPOLAIRE $trou 0,0 6 360
aide = LIGNE 0,0 1,1
EFFACER $aide
capot = BOITE 600,0,0 640,30,5
COULEUR $capot #2a9d8f
NOMOBJET $capot "Capot avant"
VUE ISOSE
VUE Dessus
ZOOM E
`;

describe.skipIf(!process.env.OCC)('scripts de commandes (noyau)', () => {
  let app: AppHost;
  beforeAll(async () => {
    const k = new OccKernel(await initOpenCascade());
    const kernel = {
      status: 'ready',
      busy: 0,
      ready: Promise.resolve(),
      start: () => Promise.resolve(),
      onStatus: () => undefined,
      onProgress: () => undefined,
      solid: (r: KernelRequest) => Promise.resolve(runKernel(k, r)),
      call: (r: KernelRequest) => Promise.resolve(runKernel(k, r)),
      exportMesh: (ids: string[], lin: number, ang: number) => Promise.resolve(runKernel(k, { op: 'exportMesh', shapeIds: ids, linearDeflection: lin, angularDeflectionDeg: ang } as KernelRequest)),
    } as unknown as KernelClient;
    app = new AppHost(registerAll, kernel);
  }, 60_000);

  const solids = () => app.doc.all().filter((e): e is Solid => e.type === '3DSOLID');
  const named = (n: string) => app.script.names.get(n)!.map((h) => app.doc.get(h) as Solid);

  it('plaque percée : noms, booléens, congés sur les arêtes verticales (sans les coutures des trous)', async () => {
    app.newTab();
    const r = await app.script.run(`
plaque = BOITE 0,0,0 100,60,8          ; coin opposé en x,y,z : la hauteur vient de Z
trou = CYLINDRE 20,30,-1 4 10
trou2 = CYLINDRE 80,30,-1 4 10
SOUSTRACTION $plaque $trou,$trou2
RACCORDBORD R 5 $plaque:verticales
`, { headless: true });
    expect(r.ok, formatReport(r, true)).toBe(true);
    expect(r.lines.every((l) => !l.warnings?.length)).toBe(true);
    expect(solids()).toHaveLength(1);
    const p = named('plaque')[0]!;
    const hole = Math.PI * 16 * 8;
    const corners = 4 * (25 - (Math.PI * 25) / 4) * 8;
    expect(p.display.volume).toBeCloseTo(100 * 60 * 8 - 2 * hole - corners, 0);
    expect(r.lines[4]!.messages.join(' ')).toContain('4 arête(s)');
    // la ligne 6 est l'objet du message ; le trou n'existe plus
    expect(app.script.names.get('trou')).toEqual([]);
    // Ctrl+Z annule tout le script d'un coup
    app.doc.undo();
    expect(solids()).toHaveLength(0);
  }, 120_000);

  it('sélecteurs d’arêtes et de faces', async () => {
    app.newTab();
    const r = await app.script.run('b = BOITE 0,0,0 40,20,10', { headless: true });
    expect(r.ok).toBe(true);
    const b = named('b')[0]!;
    expect(subElements(b, 'edge', 'haut')).toHaveLength(4);
    expect(subElements(b, 'edge', 'verticales')).toHaveLength(4);
    expect(subElements(b, 'edge', 'toutes')).toHaveLength(12);
    expect(subElements(b, 'face', 'haut')).toHaveLength(1);
    expect(subElements(b, 'face', 'droite')).toHaveLength(1);
    expect(subElements(b, 'edge', '40,10,10')).toHaveLength(1);
    expect(typeof subElements(b, 'edge', 'nimporte')).toBe('string');
  }, 60_000);

  it('toutes les lignes d’exemple de la consigne s’exécutent sans erreur', async () => {
    app.newTab();
    const r = await app.script.run(REFERENCE, { headless: true, continueOnError: true });
    expect(r.ok, formatReport(r, true)).toBe(true);
    const warned = r.lines.filter((l) => l.warnings?.length);
    expect(warned.map((l) => `${l.line} ${l.text} ${l.warnings}`)).toEqual([]);
    // chaque exemple de la consigne est bien dans ce script
    const guide = readFileSync('docs/scripts-ia.md', 'utf8');
    const examples = [...guide.matchAll(/\|\s*`([^`|]+)`(?:\s*·\s*`([^`|]+)`)?\s*\|\s*$/gm)].flatMap((m) => [m[1], m[2]]).filter((x): x is string => !!x);
    expect(examples.length).toBeGreaterThan(40);
    const body = REFERENCE.split('\n').map((l) => l.replace(/^\w+ = /, '').trim());
    for (const ex of examples) expect(body, ex).toContain(ex.replace(/^\w+ = /, ''));
  }, 300_000);

  it('l’exemple complet de la consigne donne un support étanche', async () => {
    app.newTab();
    const guide = readFileSync('docs/scripts-ia.md', 'utf8');
    const example = /## 5\. Exemple complet\s*```\n([\s\S]*?)```/.exec(guide)![1]!;
    const r = await app.script.run(example, { headless: true });
    expect(r.ok, formatReport(r, true)).toBe(true);
    expect(solids()).toHaveLength(1);
    const s = solids()[0]!;
    expect(s.display.solidCount).toBe(1);
    expect(s.display.bbox.max.z).toBeCloseTo(35, 3);
  }, 120_000);

  it('export STL et 3MF par script, redirigé vers un fichier', async () => {
    app.newTab();
    const files: { name: string; bytes: Uint8Array }[] = [];
    const prev = setSaveRedirect(async (bytes, opts) => (files.push({ name: opts.name, bytes }), { name: opts.name }));
    try {
      const r = await app.script.run('a = BOITE 0,0,0 20,20,10\nCOULEUR $a bleu\nNOMOBJET $a "Cale"\nEXPORTSTL\nEXPORT3MF', { headless: true });
      expect(r.ok, formatReport(r, true)).toBe(true);
    } finally {
      setSaveRedirect(prev);
    }
    expect(files.map((f) => f.name)).toEqual(['Dessin' + app.doc.fileName.replace(/^Dessin|\.xcad$/g, '') + '.stl', 'Dessin' + app.doc.fileName.replace(/^Dessin|\.xcad$/g, '') + '.3mf']);
    // STL binaire : 80 octets d'en-tête + nombre de triangles
    const stl = files[0]!.bytes;
    const n = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(stl.length).toBe(84 + 50 * n);
    expect(n).toBe(12);
    expect(named('a')[0]!.name).toBe('Cale');
    expect(named('a')[0]!.color).toBe('#1d70c9');
  }, 120_000);

  it('outils MCP : script, état, export vers un chemin, annulation', async () => {
    app.newTab();
    const written: { path: string; size: number }[] = [];
    const writer = { writeFile: async (path: string, data: Uint8Array) => void written.push({ path, size: data.length }) };
    const req = (tool: string, args: Record<string, unknown> = {}) => handleMcp(app, { id: 1, tool, args, outputDir: 'C:\\Users\\Seb\\Documents\\Xylform CAD' }, writer);
    const r = await req('xylform_executer_script', { script: 'cale = BOITE 0,0,0 30,20,5\nt = CYLINDRE 15,10,-1 3 7\nSOUSTRACTION $cale $t' });
    expect(r.isError).toBeFalsy();
    const t = (r.content[0] as { text: string }).text;
    expect(t).toContain('sans erreur');
    expect(t).toContain('$cale');
    expect(t).toContain('30 × 20 × 5');
    const bad = await req('xylform_executer_script', { script: 'BOITE 0,0,0 10,10,10\nSOUSTRACTION $rien $cale' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/ligne 2 \[ERREUR\][\s\S]*\$rien/);
    const ex = await req('xylform_exporter', { format: 'stl', objets: '$cale' });
    expect(ex.isError, (ex.content[0] as { text: string }).text).toBeFalsy();
    expect(written[0]!.path).toMatch(/^C:\\Users\\Seb\\Documents\\Xylform CAD\\Dessin\d+\.stl$/);
    const ex2 = await req('xylform_exporter', { format: '3mf', chemin: 'D:\\impressions\\cale.3mf' });
    expect(ex2.isError).toBeFalsy();
    expect(written[1]!.path).toBe('D:\\impressions\\cale.3mf');
    const before = solids().length;
    const u = await req('xylform_annuler');
    expect((u.content[0] as { text: string }).text).toContain('Annulé');
    expect(solids().length).toBe(before - 1);
  }, 120_000);
});
