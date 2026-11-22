/**
 * Scripts de commandes sans noyau : lecture du format, compte rendu des erreurs (commande
 * inconnue, valeur refusée, valeurs en trop ou manquantes, nom inconnu), noms et DERNIER,
 * annulation en une fois, couleurs, chemins de sortie MCP, consigne pour l'IA.
 */
import { describe, expect, it } from 'vitest';
import { AppHost } from '../src/app/AppHost';
import { registerAll } from '../src/app/commands';
import { parseScript, tokenize } from '../src/app/script/scriptParser';
import { formatReport } from '../src/app/script/ScriptRunner';
import { parseColor, scriptSession } from '../src/app/commands/script';
import { buildAiGuide } from '../src/app/script/aiGuide';
import { drawingState, outputPath } from '../src/app/mcp/mcpTools';

const newApp = () => new AppHost(registerAll);

describe('format des scripts', () => {
  it('mots, guillemets, Entrée, commentaires, noms, continuation', () => {
    expect(tokenize('TEXTE 0,0 5 0 "Deux mots" ""').tokens).toEqual(['TEXTE', '0,0', '5', '0', 'Deux mots', '']);
    expect(tokenize('A "x \\"y\\""').tokens).toEqual(['A', 'x "y"']);
    expect(tokenize('A "ouvert').error).toBeTruthy();
    const p = parseScript('; titre\n\nplaque = BOITE 0,0,0 10,10,10 ; commentaire\nCERCLE 0,0 \\\n  5 // fin\nTEXTE 0,0 2 0 "a ; b"\n2x = LIGNE 0,0 1,1\nnom =\n');
    expect(p.lines.map((l) => [l.line, l.name, l.command, l.args])).toEqual([
      [3, 'plaque', 'BOITE', ['0,0,0', '10,10,10']],
      [4, undefined, 'CERCLE', ['0,0', '5']],
      [6, undefined, 'TEXTE', ['0,0', '2', '0', 'a ; b']],
    ]);
    expect(p.errors.map((e) => e.line)).toEqual([7, 8]);
  });

  it('une option avec « = » n’est pas prise pour un nom', () => {
    expect(parseScript('PARAMETRES L=100').lines[0]).toMatchObject({ command: 'PARAMETRES', args: ['L=100'], name: undefined });
  });
});

describe('exécution des scripts (2D)', () => {
  it('objets nommés, DERNIER, coordonnées absolues malgré la saisie dynamique relative', async () => {
    const app = newApp();
    app.processor.dynamicRelative = true;
    const r = await app.script.run('c = CERCLE 10,10 5\nl = LIGNE 0,0 20,0\nDEPLACER DERNIER 0,0 0,5\nDEPLACER $c 0,0 @0,10\nRECTANGLE 0,0 30,20', { headless: true });
    expect(r.ok, formatReport(r, true)).toBe(true);
    const c = app.doc.get(app.script.names.get('c')![0]!) as { center: { x: number; y: number } };
    expect(c.center).toMatchObject({ x: 10, y: 20 });
    const l = app.doc.get(app.script.names.get('l')![0]!) as { start: { y: number }; end: { x: number } };
    expect(l.start.y).toBe(5);
    expect(l.end.x).toBe(20);
    const rect = app.doc.all().find((e) => e.type === 'POLYLINE') as { points: { x: number; y: number }[] };
    expect(Math.max(...rect.points.map((p) => p.x))).toBe(30);
    expect(app.processor.dynamicRelative).toBe(true);
  });

  it('compte rendu : commande inconnue, arrêt à la première erreur', async () => {
    const app = newApp();
    const r = await app.script.run('CERCLE 0,0 5\nCARRE 0,0 10\nCERCLE 5,5 1', { headless: true });
    expect(r.ok).toBe(false);
    expect(r.lines.map((l) => l.status)).toEqual(['ok', 'error', 'skipped']);
    expect(r.lines[1]!.error).toContain('CARRE');
    expect(formatReport(r)).toMatch(/ligne 2 \[ERREUR\] CARRE 0,0 10/);
    expect(app.doc.all()).toHaveLength(1);
  });

  it('continuer après une erreur', async () => {
    const app = newApp();
    const r = await app.script.run('CERCLE 0,0 abc\nCERCLE 5,5 1', { headless: true, continueOnError: true });
    expect(r.lines.map((l) => l.status)).toEqual(['error', 'ok']);
    expect(r.lines[0]!.error).toMatch(/« abc » refusé/);
    expect(r.lines[0]!.prompt).toMatch(/rayon/i);
  });

  it('valeurs en trop, réponse manquante, nom inconnu, $nom à une invite de point', async () => {
    const app = newApp();
    const extra = await app.script.run('CERCLE 0,0 5 9', { headless: true });
    expect(extra.lines[0]!.error).toMatch(/reste des valeurs : 9/);
    const missing = await app.script.run('RECTANGLE 0,0', { headless: true });
    expect(missing.lines[0]!.error).toMatch(/attend encore/);
    expect(missing.lines[0]!.prompt).toMatch(/autre coin/i);
    const dflt = await app.script.run('CERCLE 0,0', { headless: true });
    expect(dflt.ok).toBe(true);
    expect(dflt.lines[0]!.warnings?.[0]).toMatch(/Valeur par défaut .* rayon/i);
    const unknown = await app.script.run('a = CERCLE 0,0 5\nDEPLACER $b 0,0 1,1', { headless: true });
    expect(unknown.lines[1]!.error).toMatch(/\$b.*inconnu.*\$a/);
    const point = await app.script.run('CERCLE $a 5', { headless: true });
    expect(point.lines[0]!.error).toMatch(/attend ici un point/);
    expect(app.processor.isIdle).toBe(true);
  });

  it('un script s’annule en une seule fois', async () => {
    const app = newApp();
    await app.script.run('CERCLE 0,0 5', { headless: true });
    await app.script.run('CERCLE 10,0 5\nCERCLE 20,0 5\nLIGNE 0,0 10,10', { headless: true });
    expect(app.doc.all()).toHaveLength(4);
    app.doc.undo();
    expect(app.doc.all()).toHaveLength(1);
  });

  it('fenêtre SCRIPT : après une erreur, le nouvel essai remplace le résultat partiel', async () => {
    const app = newApp();
    await app.script.run('CERCLE 100,100 1', { headless: true });
    const answers = ['CERCLE 0,0 5\nCERCLE 10,0 5\nDEPLACER $x 0,0 1,1', 'CERCLE 0,0 5\nCERCLE 10,0 5', null];
    const seen: (string | undefined)[] = [];
    app.ui = {
      ...app.ui,
      toast: () => undefined,
      scriptEditor: async (st) => {
        seen.push(st.report ? (st.report.ok ? 'ok' : 'erreur') : undefined);
        const t = answers.shift();
        return t == null ? null : { text: t, continueOnError: false };
      },
    };
    await scriptSession(app, { text: '' });
    // 1er essai en erreur (fenêtre rouverte), 2e réussi (fenêtre fermée)
    expect(seen).toEqual([undefined, 'erreur']);
    expect(app.doc.all()).toHaveLength(3);
  });

  it('COULEUR et noms d’objets', async () => {
    const app = newApp();
    const r = await app.script.run('c = CERCLE 0,0 5\nCOULEUR $c rouge\nd = CERCLE 9,0 1\nCOULEUR $d 10,200,30\nCOULEUR $d mauve DuCalque', { headless: true, continueOnError: true });
    expect(app.doc.get(app.script.names.get('c')![0]!)!.color).toBe('#e63946');
    expect(app.doc.get(app.script.names.get('d')![0]!)!.color).toBeUndefined();
    expect(r.lines[3]!.status).toBe('ok');
    expect(parseColor('#abc')).toBe('#aabbcc');
    expect(parseColor('Bleu')).toBe('#1d70c9');
    expect(parseColor('DuCalque')).toBeNull();
    expect(parseColor('mauve')).toBeUndefined();
  });

  it('les noms survivent d’un script à l’autre, par dessin', async () => {
    const app = newApp();
    await app.script.run('a = CERCLE 0,0 5', { headless: true });
    const r = await app.script.run('DEPLACER $a 0,0 5,0', { headless: true });
    expect(r.ok).toBe(true);
    app.newTab();
    const r2 = await app.script.run('DEPLACER $a 0,0 5,0', { headless: true });
    expect(r2.ok).toBe(false);
  });
});

describe('consigne pour l’IA et outils MCP', () => {
  it('la consigne contient le format et toutes les commandes', () => {
    const app = newApp();
    const g = buildAiGuide(app.registry, '9.9.9');
    expect(g).toContain('nom = COMMANDE');
    expect(g).toContain('$nom:verticales');
    expect(g).toContain('Xylform CAD 9.9.9');
    for (const n of ['BOITE', 'SOUSTRACTION', 'RACCORDBORD', 'EXPORT3MF', 'COULEUR', 'SCRIPT']) expect(g).toMatch(new RegExp(`^- ${n} `, 'm'));
  });

  it('chemins de sortie', () => {
    expect(outputPath(undefined, 'a.stl', 'C:\\Docs\\Xylform CAD')).toBe('C:\\Docs\\Xylform CAD\\a.stl');
    expect(outputPath('D:\\out\\', 'a.stl', 'C:\\x')).toBe('D:\\out\\a.stl');
    expect(outputPath('D:\\out', 'a.stl', 'C:\\x')).toBe('D:\\out\\a.stl');
    expect(outputPath('D:\\out\\piece.3mf', 'a.3mf', 'C:\\x')).toBe('D:\\out\\piece.3mf');
    expect(outputPath('/home/seb/p.stl', 'a.stl', '/tmp')).toBe('/home/seb/p.stl');
  });

  it('état du dessin', async () => {
    const app = newApp();
    await app.script.run('cercle = CERCLE 0,0 5\nLIGNE 0,0 1,1', { headless: true });
    const s = drawingState(app);
    expect(s).toContain('2 objet(s)');
    expect(s).toContain('$cercle');
  });
});
