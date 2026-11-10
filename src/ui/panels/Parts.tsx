/**
 * Palette « Pièces » : bibliothèque de solides prêts à l'emploi. On choisit une pièce, on
 * remplace ses cotes (ou une taille normalisée : M3…M20, Ø32…Ø125 en PVC), puis « Insérer » demande le point
 * d'insertion dans la vue (plusieurs poses possibles, Entrée pour terminer).
 */
import { useState } from 'react';
import { defaultValues, PARTS, type PartAxis, type PartDef, type PartValues } from '../../app/parts';
import { requestPart } from '../../app/commands/select';
import { Icon } from '../icons';
import { useHost } from '../context';

const CATEGORIES = [...new Set(PARTS.map((p) => p.category))];

export function PartsPanel() {
  const app = useHost(['kernel', 'settings']);
  const [def, setDef] = useState<PartDef | null>(null);
  const [values, setValues] = useState<PartValues>({});
  const [axis, setAxis] = useState<PartAxis>('Z');
  const [help, setHelp] = useState<string | null>(null);

  const choose = (d: PartDef) => {
    setDef(d);
    setValues(defaultValues(d));
    setHelp(null);
  };

  if (def) {
    // modifier une cote normalisée fait passer en taille « personnalisée »
    const bound = def.applySize ? Object.keys(def.applySize(def.sizes?.[0] ?? 'M8', {})).filter((k) => k !== 'size') : [];
    const set = (k: string, v: number | string) =>
      setValues((o) => {
        const n: PartValues = { ...o, [k]: v };
        if (bound.includes(k)) delete n.size;
        return n;
      });
    const invalid = def.params.some((p) => (!p.visible || p.visible(values)) && !p.options && !(Number(values[p.key]) >= (p.min ?? 0)));
    return (
      <div className="lp parts">
        <div className="lp-toolbar">
          <button title="Retour à la bibliothèque" onClick={() => setDef(null)}>
            <Icon name="chevron" size={12} className="flip" /> Bibliothèque
          </button>
        </div>
        <div className="pt-head">
          <Icon name={def.icon} size={40} />
          <div>
            <div className="pt-name">{def.name}</div>
            <div className="pt-desc">{def.description}</div>
          </div>
        </div>
        <div className="pt-form">
          {def.sizes && def.applySize && (
            <label className="pt-row">
              <span>Taille normalisée</span>
              <select value={String(values.size ?? '')} onChange={(e) => e.target.value && setValues(def.applySize!(e.target.value, values))}>
                <option value="">Personnalisée</option>
                {def.sizes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          {def.params.filter((p) => !p.visible || p.visible(values)).map((p) => (
            <label key={p.key} className={`pt-row ${help === p.key ? 'pt-row-help' : ''}`}>
              <span>
                {p.label}
                {p.help && (
                  <button
                    type="button"
                    className={`pt-help ${help === p.key ? 'on' : ''}`}
                    title={p.help}
                    aria-label={`Aide : ${p.label}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setHelp(help === p.key ? null : p.key);
                    }}
                  >
                    ?
                  </button>
                )}
              </span>
              {p.options ? (
                <select value={String(values[p.key])} onChange={(e) => setValues((o) => ({ ...o, [p.key]: e.target.value }))}>
                  {p.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="pt-num">
                  <input type="number" min={p.min} step={p.step ?? 'any'} value={String(values[p.key])} onChange={(e) => set(p.key, Number(e.target.value.replace(',', '.')))} />
                  {p.unit && <em>{p.unit}</em>}
                </span>
              )}
              {help === p.key && <span className="pt-help-text">{p.help}</span>}
              {p.note?.(values) && <span className={`pt-note ${values[p.key] === 'empreinte' ? 'warn' : ''}`}>{p.note(values)}</span>}
            </label>
          ))}
          <label className="pt-row">
            <span>Axe de la pièce</span>
            <select value={axis} onChange={(e) => setAxis(e.target.value as PartAxis)}>
              <option value="Z">Vertical (Z)</option>
              <option value="X">Horizontal X</option>
              <option value="Y">Horizontal Y</option>
            </select>
          </label>
        </div>
        <div className="pt-actions">
          <button className="primary" disabled={invalid} onClick={() => requestPart(app, def, values, axis)}>
            Insérer « {def.title(values)} »
          </button>
          <button onClick={() => setValues(defaultValues(def))}>Valeurs par défaut</button>
        </div>
        <div className="pt-hint">
          Cliquez dans la vue pour poser la pièce (accrochages actifs), plusieurs fois si besoin ; Entrée pour terminer.
          {values.thread === 'reel' &&
            (app.settings.threadMode === 'always'
              ? ' Le filetage réel demande 10 à 30 secondes de calcul par pièce.'
              : ' Filetage réel : aperçu cosmétique rapide pendant le dessin, filet exact calculé à l’export STL/3MF/STEP.')}
          {(app.settings.holeComp ?? 0) > 0 && def.params.some((p) => p.hole) && ` Trous agrandis de ${String(app.settings.holeComp).replace('.', ',')} mm sur le Ø (compensation des trous imprimés, OPTIONS).`}
        </div>
      </div>
    );
  }

  return (
    <div className="lp parts">
      {CATEGORIES.map((c) => (
        <div key={c} className="pt-cat">
          <div className="pt-cat-title">{c}</div>
          <div className="pt-grid">
            {PARTS.filter((p) => p.category === c).map((p) => (
              <button key={p.id} className="pt-card" title={p.description} onClick={() => choose(p)}>
                <Icon name={p.icon} size={34} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="pt-hint">Les pièces sont des solides 3D : exportables en STL / 3MF pour l’impression.</div>
    </div>
  );
}
