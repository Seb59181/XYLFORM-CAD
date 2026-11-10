/**
 * Historique de construction d'un corps (palette Propriétés) : étapes dans l'ordre, cotes
 * modifiables (nombres ou expressions liées aux paramètres utilisateur), suppression
 * temporaire ou définitive d'une étape. Chaque modification rejoue l'historique.
 */
import { useEffect, useState } from 'react';
import type { AppHost } from '../../app/AppHost';
import type { Entity } from '../../core/document/Document';
import { deleteFeature, editFeatureParam, featureParams, featureTitle, flattenHistory, toggleFeature, type FeaturePath } from '../../app/history';

type Solid = Extract<Entity, { type: '3DSOLID' }>;

const f4 = (v: number) => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));
const ICON: Record<string, string> = { create: '■', modify: '◆', transform: '↔', boolean: '⊖', hole: '◎', part: '⚙' };

function ExprInput({ value, expr, onCommit }: { value: number; expr?: string; onCommit: (text: string) => void }) {
  const shown = expr ?? f4(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <input
      className={`pp-input ${expr ? 'hist-expr' : ''}`}
      title={expr ? `= ${f4(value)} (expression liée aux paramètres)` : 'Nombre ou expression (ex. ep*2, avec les paramètres utilisateur)'}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== shown && text.trim() !== '' ? onCommit(text) : setText(shown)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

export function HistoryRows({ app, e }: { app: AppHost; e: Solid }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const h = e.history ?? [];
  const steps = flattenHistory(h);
  const run = (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    fn()
      .catch((err: Error) => app.ui.toast(err.message, 'error'))
      .finally(() => setBusy(null));
  };
  const edit = (path: FeaturePath, key: string, v: number | string | boolean) => run('Reconstruction du corps…', () => editFeatureParam(app, e.handle, path, key, v));
  return (
    <div className="hist">
      {steps.map(({ f, path, depth }, n) => {
        const id = f.id;
        const params = featureParams(f);
        const isOpen = open[id] ?? (n === 0 && steps.length <= 6);
        const first = path.length === 1 && path[0] === 0;
        return (
          <div key={id} className={`hist-step ${f.off ? 'off' : ''}`} style={{ marginLeft: depth * 14 }}>
            <div className="hist-head" onClick={() => params.length && setOpen({ ...open, [id]: !isOpen })} title={params.length ? 'Cliquer pour modifier les cotes de cette étape' : undefined}>
              <span className="hist-caret">{params.length ? (isOpen ? '▾' : '▸') : ''}</span>
              <span className="hist-ico">{ICON[f.kind]}</span>
              <span className="hist-title">{featureTitle(f)}</span>
              {!first && (
                <>
                  <button className="hist-btn" title={f.off ? 'Rétablir l’étape' : 'Supprimer temporairement l’étape (ignorée)'} disabled={!!busy} onClick={(ev) => (ev.stopPropagation(), run('Reconstruction du corps…', () => toggleFeature(app, e.handle, path)))}>
                    {f.off ? '○' : '●'}
                  </button>
                  <button className="hist-btn" title="Retirer l’étape de l’historique" disabled={!!busy} onClick={(ev) => (ev.stopPropagation(), run('Reconstruction du corps…', () => deleteFeature(app, e.handle, path)))}>
                    ✕
                  </button>
                </>
              )}
            </div>
            {isOpen &&
              params.map((p) => (
                <div key={p.key} className="pp-row hist-param">
                  <span className="pp-label">{p.label}</span>
                  <span className="pp-value">
                    {p.type === 'number' && <ExprInput value={p.value as number} expr={f.exprs?.[p.key]} onCommit={(t) => edit(path, p.key, t)} />}
                    {p.type === 'select' && (
                      <select className="pp-input" value={String(p.value)} disabled={!!busy} onChange={(ev) => edit(path, p.key, ev.target.value)}>
                        {p.options!.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {p.type === 'checkbox' && <input type="checkbox" checked={!!p.value} disabled={!!busy} onChange={(ev) => edit(path, p.key, ev.target.checked)} />}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
      {busy && <p className="pp-hint">{busy}</p>}
      <p className="pp-hint">Modifier une cote rejoue tout l’historique. Une expression (ex. « ep*2 ») lie la cote aux paramètres utilisateur (palette Paramètres).</p>
    </div>
  );
}
