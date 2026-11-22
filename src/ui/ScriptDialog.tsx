/**
 * Fenêtre des scripts de commandes : coller ou ouvrir un script (écrit à la main ou par une IA),
 * copier la consigne à donner à l'IA, exécuter, lire le compte rendu ligne par ligne.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptEditorResult, ScriptEditorState } from '../app/AppHost';
import { buildAiGuide } from '../app/script/aiGuide';
import { saveFile } from '../io/fileAccess';
import { SCRIPT_ACCEPT } from '../app/commands/script';
import { useApp } from './context';
import { Frame, useKeys } from './Dialogs';

const EXAMPLE = `; Exemple : plaque percée aux angles arrondis
plaque = BOITE 0,0,0 80,50,6
RACCORDBORD R 5 $plaque:verticales
t1 = CYLINDRE 12,12,-1 2.2 8
t2 = CYLINDRE 68,12,-1 2.2 8
SOUSTRACTION $plaque $t1,$t2
VUE ISOSE
ZOOM E
`;

export function ScriptDialog({ state, onDone }: { state: ScriptEditorState; onDone: (v: ScriptEditorResult | null) => void }) {
  const app = useApp();
  const [text, setText] = useState(state.text);
  const [fileName, setFileName] = useState(state.fileName);
  const [cont, setCont] = useState(!!state.continueOnError);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const report = state.report;
  const firstError = report?.lines.find((l) => l.status === 'error');

  useEffect(() => {
    const ta = area.current;
    if (!ta) return;
    ta.focus();
    // curseur sur la ligne en erreur
    if (firstError) {
      const lines = text.split(/\r?\n/);
      const start = lines.slice(0, firstError.line - 1).reduce((n, l) => n + l.length + 1, 0);
      ta.setSelectionRange(start, start + (lines[firstError.line - 1]?.length ?? 0));
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
      ta.scrollTop = Math.max(0, (firstError.line - 4) * lh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = () => text.trim() && onDone({ text, fileName, continueOnError: cont });
  useKeys(null, () => onDone(null));

  const lineCount = useMemo(() => text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(;|\/\/)/.test(l)).length, [text]);

  const open = async () => {
    const f = await app.ui.openFile(SCRIPT_ACCEPT);
    if (!f) return;
    setText(await f.text());
    setFileName(f.name);
  };
  const save = async () => {
    const t = await saveFile(text, { name: fileName ?? 'script.xscr', mime: 'text/plain', description: 'Script Xylform CAD', extensions: ['.xscr', '.scr', '.txt'] });
    if (t) setFileName(t.name);
  };
  const copyGuide = async () => {
    try {
      await navigator.clipboard.writeText(buildAiGuide(app.registry, import.meta.env.VITE_APP_VERSION));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      app.ui.toast('Presse-papiers indisponible.', 'error');
    }
  };
  const copyReport = () => {
    if (!report) return;
    const lines = report.lines
      .filter((l) => l.status !== 'ok' || l.warnings?.length)
      .map((l) => `ligne ${l.line} : ${l.text}\n  ${l.status === 'skipped' ? 'non exécutée' : (l.error ?? l.warnings?.join(' ; ') ?? '')}${l.prompt ? `\n  question en attente : ${l.prompt}` : ''}`);
    void navigator.clipboard?.writeText(`Le script a donné ces erreurs dans Xylform CAD, corrige-le :\n\n${lines.join('\n')}`);
    app.ui.toast('Compte rendu copié : collez-le à l’IA pour qu’elle corrige le script.', 'success');
  };

  return (
    <Frame
      title={`Script de commandes${fileName ? ` — ${fileName}` : ''}`}
      onClose={() => onDone(null)}
      wide
      footer={
        <>
          <label className="check script-cont" title="Sinon le script s'arrête à la première erreur">
            <input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} />
            Continuer après une erreur
          </label>
          <button className="primary" disabled={!text.trim()} onClick={run} title="Ctrl+Entrée">
            Exécuter ({lineCount} ligne{lineCount > 1 ? 's' : ''})
          </button>
          <button onClick={() => onDone(null)}>Fermer</button>
        </>
      }
    >
      <div className="script-tools">
        <p className="modal-message">
          Collez un script écrit par une IA (ou par vous), ou ouvrez un fichier <code>.xscr</code>. Pour qu’une IA sache l’écrire, donnez-lui d’abord la consigne, puis décrivez la pièce voulue.
        </p>
        <div className="script-buttons">
          <button className="primary" onClick={() => void copyGuide()} title="Fiche de référence des commandes et du format, à coller au début de la conversation avec l'IA">
            {copied ? 'Consigne copiée ✓' : 'Copier la consigne pour l’IA'}
          </button>
          <button onClick={() => void open()}>Ouvrir…</button>
          <button onClick={() => void save()} disabled={!text.trim()}>
            Enregistrer…
          </button>
          {!text.trim() && <button onClick={() => setText(EXAMPLE)}>Exemple</button>}
        </div>
      </div>
      <textarea
        ref={area}
        className="script-text"
        spellCheck={false}
        value={text}
        placeholder={'; une commande par ligne, par exemple :\nplaque = BOITE 0,0,0 80,50,6\ntrou = CYLINDRE 40,25,-1 4 8\nSOUSTRACTION $plaque $trou'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            run();
          }
        }}
      />
      {report && (
        <div className={`script-report ${report.ok ? 'ok' : 'bad'}`}>
          <div className="script-report-head">
            <span>
              {report.ok ? `✓ ${report.executed} ligne(s) exécutée(s)` : report.aborted ? 'Script interrompu' : `${report.errors} erreur(s) — ${report.executed} ligne(s) exécutée(s) sur ${report.total}`}
            </span>
            {!report.ok && (
              <button onClick={copyReport} title="Pour le donner à l'IA qui a écrit le script">
                Copier les erreurs pour l’IA
              </button>
            )}
          </div>
          {!report.ok && report.undoLabel && <div className="dim">Le résultat partiel de cet essai sera annulé avant la prochaine exécution.</div>}
          {report.lines
            .filter((l) => l.status !== 'ok' || l.warnings?.length)
            .map((l) => (
              <div key={l.line} className={`script-line ${l.status}`}>
                <b>ligne {l.line}</b> <code>{l.text}</code>
                {l.error && <div>→ {l.error}</div>}
                {l.prompt && <div className="dim">question en attente : {l.prompt}</div>}
                {l.warnings?.map((w) => (
                  <div key={w} className="dim">
                    ! {w}
                  </div>
                ))}
                {l.status === 'skipped' && <div className="dim">non exécutée</div>}
              </div>
            ))}
        </div>
      )}
    </Frame>
  );
}
