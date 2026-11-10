/**
 * Gestionnaire des propriétés des calques : courant, activé, gelé, verrouillé, couleur TrueColor,
 * épaisseur de ligne, renommage, suppression et états de calque.
 */
import { LINETYPE_IDS, LINETYPES, type Linetype } from '../../core/linetypes';
import { useState } from 'react';
import { Icon } from '../icons';
import { useHost } from '../context';

const LINEWEIGHTS = [0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11];

export function LayersPanel() {
  const app = useHost(['doc']);
  const doc = app.doc;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const counts = new Map<string, number>();
  for (const e of doc.all()) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
    }
  };
  const rename = (name: string) => {
    const n = draft.trim();
    setEditing(null);
    if (n && n !== name) guard(() => doc.updateLayer(name, { name: n }));
  };
  const saveState = async () => {
    const name = await app.ui.prompt('Nouvel état de calque', `État${Object.keys(doc.layerStates).length + 1}`, 'Nom de l’état');
    if (name) doc.saveLayerState(name);
  };
  return (
    <div className="lp">
      <div className="lp-toolbar">
        <button title="Nouveau calque" onClick={() => guard(() => setSelected(doc.addLayer()))}>
          <Icon name="plus" size={16} /> Nouveau
        </button>
        <button title="Supprimer le calque" disabled={!selected} onClick={() => selected && guard(() => (doc.removeLayer(selected), setSelected(null)))}>
          <Icon name="trash" size={16} /> Supprimer
        </button>
        <button title="Rendre courant" disabled={!selected} onClick={() => selected && guard(() => doc.setCurrentLayer(selected))}>
          <Icon name="check" size={16} /> Courant
        </button>
      </div>
      <table className="lp-table">
        <thead>
          <tr>
            <th title="Courant">É</th>
            <th>Nom</th>
            <th title="Activé">Act.</th>
            <th title="Geler">Gel.</th>
            <th title="Verrouiller">Verr.</th>
            <th>Couleur</th>
            <th>Épaisseur</th>
            <th>Type de ligne</th>
          </tr>
        </thead>
        <tbody>
          {doc.layers.map((l) => (
            <tr key={l.name} className={selected === l.name ? 'sel' : ''} onClick={() => setSelected(l.name)} onDoubleClick={() => guard(() => doc.setCurrentLayer(l.name))}>
              <td>{doc.currentLayer === l.name ? <Icon name="check" size={14} /> : null}</td>
              <td
                className="lp-name"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (l.name === '0') return;
                  setEditing(l.name);
                  setDraft(l.name);
                }}
                title={`${counts.get(l.name) ?? 0} objet(s) — double-clic pour renommer`}
              >
                {editing === l.name ? (
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => rename(l.name)} onKeyDown={(e) => (e.key === 'Enter' ? rename(l.name) : e.key === 'Escape' && setEditing(null))} />
                ) : (
                  <>
                    {l.name}
                    <span className="lp-count">{counts.get(l.name) ?? 0}</span>
                  </>
                )}
              </td>
              <td>
                <button className="lp-ico" onClick={(e) => (e.stopPropagation(), guard(() => doc.updateLayer(l.name, { visible: !l.visible })))}>
                  <Icon name={l.visible ? 'bulb' : 'bulb-off'} size={16} />
                </button>
              </td>
              <td>
                <button className="lp-ico" onClick={(e) => (e.stopPropagation(), guard(() => doc.updateLayer(l.name, { frozen: !l.frozen })))}>
                  <Icon name={l.frozen ? 'snow' : 'sun'} size={16} />
                </button>
              </td>
              <td>
                <button className="lp-ico" onClick={(e) => (e.stopPropagation(), guard(() => doc.updateLayer(l.name, { locked: !l.locked })))}>
                  <Icon name={l.locked ? 'lock-closed' : 'lock-open'} size={16} />
                </button>
              </td>
              <td>
                <input type="color" value={l.color} onClick={(e) => e.stopPropagation()} onChange={(e) => guard(() => doc.updateLayer(l.name, { color: e.target.value }))} />
              </td>
              <td>
                <select value={l.lineweight} onClick={(e) => e.stopPropagation()} onChange={(e) => guard(() => doc.updateLayer(l.name, { lineweight: Number(e.target.value) }))}>
                  {LINEWEIGHTS.map((w) => (
                    <option key={w} value={w}>
                      {w.toFixed(2)} mm
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={l.linetype ?? 'CONTINUOUS'} title="Type de ligne (tirets à l’échelle LTSCALE)" onClick={(e) => e.stopPropagation()} onChange={(e) => guard(() => doc.updateLayer(l.name, { linetype: e.target.value === 'CONTINUOUS' ? undefined : (e.target.value as Linetype) }))}>
                  {LINETYPE_IDS.map((t) => (
                    <option key={t} value={t}>
                      {LINETYPES[t].label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="lp-states">
        <div className="lp-states-head">
          <span>États de calque</span>
          <button onClick={() => void saveState()}>
            <Icon name="plus" size={14} /> Enregistrer l’état
          </button>
        </div>
        {Object.keys(doc.layerStates).length === 0 && <p className="pp-hint">Un état mémorise la visibilité, le gel, le verrouillage, la couleur et l’épaisseur de tous les calques.</p>}
        {Object.keys(doc.layerStates).map((name) => (
          <div className="lp-state" key={name}>
            <span>{name}</span>
            <button onClick={() => guard(() => doc.restoreLayerState(name))}>Restaurer</button>
            <button onClick={() => doc.deleteLayerState(name)} title="Supprimer">
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
