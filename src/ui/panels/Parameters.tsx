/**
 * Gestionnaire de paramètres : cotes pilotées (nom, expression, valeur), paramètres utilisateur
 * et liste des contraintes géométriques.
 */
import { useState } from 'react';
import { evaluateParameters } from '../../core/constraints/Solver';
import { CONSTRAINT_GLYPH, CONSTRAINT_LABEL, isDimensional, type Constraint } from '../../core/constraints/types';
import { entityLabel } from '../../core/entities/geometry';
import { Icon } from '../icons';
import { useHost } from '../context';

function Cell({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="pm-input"
      value={text ?? value}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text);
        setText(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

export function ParametersPanel() {
  const app = useHost(['doc', 'constraints']);
  const doc = app.doc;
  let values = new Map<string, number>();
  let error: string | null = null;
  try {
    values = evaluateParameters(doc.constraints, doc.parameters);
  } catch (e) {
    error = (e as Error).message;
  }
  const dims = doc.constraints.filter(isDimensional);
  const geo = doc.constraints.filter((c) => !isDimensional(c));
  const check = (constraints: Constraint[], params: Record<string, string>): boolean => {
    try {
      evaluateParameters(constraints, params);
      return true;
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
      return false;
    }
  };
  const setExpr = (id: string, expression: string) => {
    if (check(doc.constraints.map((c) => (c.id === id ? ({ ...c, expression } as Constraint) : c)), doc.parameters)) doc.updateConstraint(id, { expression } as Partial<Constraint>);
  };
  const rename = (id: string, name: string) => {
    const n = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return app.ui.toast('Nom invalide (lettres, chiffres, _).', 'error');
    if (values.has(n)) return app.ui.toast(`Le nom ${n} est déjà utilisé.`, 'error');
    const old = dims.find((c) => c.id === id)?.name;
    // les expressions qui utilisaient l'ancien nom suivent le renommage
    const re = old ? new RegExp(`\\b${old}\\b`, 'g') : null;
    doc.transaction('Renommer le paramètre', () => {
      doc.updateConstraint(id, { name: n } as Partial<Constraint>);
      if (re) for (const c of doc.constraints) if (isDimensional(c) && c.id !== id && re.test(c.expression)) doc.updateConstraint(c.id, { expression: c.expression.replace(re, n) } as Partial<Constraint>);
    });
  };
  const addUser = async () => {
    let i = 1;
    while (values.has(`user${i}`)) i++;
    const name = await app.ui.prompt('Nouveau paramètre utilisateur', `user${i}`, 'Nom');
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || values.has(name)) return app.ui.toast('Nom invalide ou déjà utilisé.', 'error');
    const expr = await app.ui.prompt(`Valeur de ${name}`, '10', 'Valeur ou expression');
    if (expr && check(doc.constraints, { ...doc.parameters, [name]: expr })) doc.setParameter(name, expr);
  };
  const st = app.constraintStatus;
  return (
    <div className="pm">
      <div className={`pm-status ${st.ok ? 'ok' : 'bad'}`}>
        {doc.constraints.length ? (st.ok ? `Résolu — ${st.dof} degré(s) de liberté restant(s)` : `Non résolu : ${st.message ?? 'conflit'}`) : 'Aucune contrainte. Utilisez l’onglet Paramétrique.'}
        {error && <div className="bad">{error}</div>}
      </div>
      <div className="pm-head">Cotes pilotées</div>
      <table className="pm-table">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Expression</th>
            <th>Valeur</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dims.map((c) => (
            <tr key={c.id}>
              <td>
                <Cell value={c.name} onCommit={(v) => rename(c.id, v)} />
              </td>
              <td>
                <Cell value={c.expression} onCommit={(v) => setExpr(c.id, v)} />
              </td>
              <td className="pm-val">{values.has(c.name) ? `${values.get(c.name)!.toFixed(4).replace(/\.?0+$/, '')}${c.type === 'angle' ? '°' : ''}` : '—'}</td>
              <td>
                <button className="lp-ico" title="Supprimer" onClick={() => doc.removeConstraint(c.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
          {!dims.length && (
            <tr>
              <td colSpan={4} className="pp-hint">
                Aucune cote pilotée.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="pm-head">
        Paramètres utilisateur
        <button onClick={() => void addUser()}>
          <Icon name="plus" size={14} /> Ajouter
        </button>
      </div>
      <table className="pm-table">
        <tbody>
          {Object.entries(doc.parameters).map(([name, expr]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>
                <Cell value={expr} onCommit={(v) => check(doc.constraints, { ...doc.parameters, [name]: v }) && doc.setParameter(name, v)} />
              </td>
              <td className="pm-val">{values.get(name)?.toFixed(4).replace(/\.?0+$/, '') ?? '—'}</td>
              <td>
                <button className="lp-ico" title="Supprimer" onClick={() => check(doc.constraints, Object.fromEntries(Object.entries(doc.parameters).filter(([k]) => k !== name))) && doc.setParameter(name, null)}>
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pm-head">Contraintes géométriques ({geo.length})</div>
      <div className="pm-geo">
        {geo.map((c) => (
          <div key={c.id} className="pm-geo-row">
            <span className="glyph">{CONSTRAINT_GLYPH[c.type]}</span>
            <span>{CONSTRAINT_LABEL[c.type]}</span>
            <span className="pp-hint">
              {c.refs
                .map((r) => {
                  const e = doc.get(r.handle);
                  return e ? `${entityLabel(e)} ${r.handle}` : r.handle;
                })
                .join(' · ')}
            </span>
            <button className="lp-ico" title="Supprimer" onClick={() => doc.removeConstraint(c.id)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
