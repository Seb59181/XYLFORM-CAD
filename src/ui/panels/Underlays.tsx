/**
 * Palette Fonds de plan : liste des
 * DWG, DXF, PDF et images attachés, état, estompage, calques du fond et actions
 * (charger, décharger, recharger, changer de fichier, lier, détacher).
 */
import { useState } from 'react';
import type { UnderlayDef } from '../../core/document/Document';
import { UNIT_NAME } from '../../core/entities/underlay';
import { bindUnderlay, reloadUnderlay, underlayKindLabel, zoomUnderlay } from '../../app/commands/underlays';
import { Icon } from '../icons';
import { useHost } from '../context';

const KIND_ICON: Record<UnderlayDef['kind'], string> = { dwg: 'dwg', dxf: 'dxf', pdf: 'pdf', image: 'image' };

const size = (d: UnderlayDef) => {
  const w = d.bounds.max.x - d.bounds.min.x, h = d.bounds.max.y - d.bounds.min.y;
  const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  return `${f(w)} × ${f(h)}`;
};

export function UnderlaysPanel() {
  const app = useHost(['doc']);
  const doc = app.doc;
  const defs = Object.values(doc.underlays).sort((a, b) => a.name.localeCompare(b.name));
  const [selectedId, setSelected] = useState<string | null>(null);
  const sel = (selectedId && doc.underlays[selectedId]) || defs[0] || null;
  const [layerFilter, setLayerFilter] = useState('');
  const guard = (fn: () => unknown) => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e: Error) => app.ui.toast(e.message, 'error'));
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
    }
  };
  const update = (patch: Partial<UnderlayDef>, label?: string) => sel && guard(() => doc.updateUnderlayDef(sel.id, patch, label));
  const rename = async () => {
    if (!sel) return;
    const name = (await app.ui.prompt('Renommer le fond de plan', sel.name, 'Nom'))?.trim();
    if (!name || name === sel.name) return;
    if (defs.some((d) => d.id !== sel.id && d.name.toLowerCase() === name.toLowerCase())) return app.ui.toast(`« ${name} » existe déjà.`, 'error');
    update({ name }, 'Renommer le fond de plan');
  };
  const detach = async () => {
    if (!sel) return;
    const n = doc.underlayInstances(sel.id).length;
    if (await app.ui.confirm(`Détacher « ${sel.name} » ? ${n} insertion(s) seront supprimée(s) du dessin.`, 'Détacher le fond de plan')) {
      doc.removeUnderlayDef(sel.id);
      setSelected(null);
    }
  };
  const bind = async () => {
    if (!sel?.entities) return;
    if (!(await app.ui.confirm(`Lier « ${sel.name} » ? Ses ${sel.entities.length} objet(s) deviendront des objets modifiables du dessin (calques préfixés « ${sel.name}$0$ »).`, 'Lier le fond de plan'))) return;
    const n = bindUnderlay(app, sel.id);
    app.ui.toast(`${n} objet(s) ajouté(s) au dessin.`, 'success');
    setSelected(null);
  };

  return (
    <div className="lp ul">
      <div className="lp-toolbar">
        <button title="Attacher un DWG, DXF, PDF ou une image (ATTACHER)" onClick={() => app.run('ATTACHER')}>
          <Icon name="xref-attach" size={16} /> Attacher
        </button>
        <button title="Recharger tous les fonds de plan depuis leur fichier" disabled={!defs.some((d) => d.path)} onClick={() => guard(async () => { for (const d of defs) if (d.path) await reloadUnderlay(app, d.id); })}>
          <Icon name="reload" size={16} /> Tout recharger
        </button>
      </div>
      {defs.length === 0 ? (
        <div className="ul-empty">
          <Icon name="xref" size={40} />
          <p>Aucun fond de plan.</p>
          <p className="pp-hint">
            Attachez un plan DWG ou DXF, un PDF ou une image (scan, photo aérienne) : il s’affiche estompé derrière votre dessin, reste non modifiable, et vous pouvez vous y accrocher (extrémité, milieu, intersection…).
          </p>
          <button className="ul-primary" onClick={() => app.run('ATTACHER')}>
            <Icon name="xref-attach" size={18} /> Attacher un fond de plan
          </button>
          <p className="pp-hint">Astuce : glissez un PDF ou une image directement sur la zone de dessin.</p>
        </div>
      ) : (
        <>
          <table className="lp-table ul-table">
            <thead>
              <tr>
                <th />
                <th>Nom</th>
                <th>État</th>
                <th title="Nombre d’insertions">Ins.</th>
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => {
                const n = doc.underlayInstances(d.id).length;
                return (
                  <tr key={d.id} className={sel?.id === d.id ? 'sel' : ''} onClick={() => setSelected(d.id)} onDoubleClick={() => zoomUnderlay(app, d.id)} title={`${d.path ?? d.fileName} — double-clic : zoom`}>
                    <td>
                      <Icon name={KIND_ICON[d.kind]} size={18} />
                    </td>
                    <td className="lp-name">{d.name}</td>
                    <td className={d.loaded ? 'ul-ok' : 'ul-off'}>{d.loaded ? 'Chargé' : 'Déchargé'}</td>
                    <td>{n}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sel && (
            <div className="ul-details">
              <div className="ul-actions">
                <button title={sel.loaded ? 'Masquer sans détacher' : 'Afficher à nouveau'} onClick={() => update({ loaded: !sel.loaded }, sel.loaded ? 'Décharger' : 'Charger')}>
                  <Icon name={sel.loaded ? 'unload' : 'check'} size={14} /> {sel.loaded ? 'Décharger' : 'Charger'}
                </button>
                <button title={sel.path ? `Relire ${sel.path}` : 'Choisir à nouveau le fichier'} onClick={() => guard(() => reloadUnderlay(app, sel.id))}>
                  <Icon name="reload" size={14} /> Recharger
                </button>
                <button title="Remplacer par un autre fichier" onClick={() => guard(() => reloadUnderlay(app, sel.id, true))}>
                  <Icon name="open" size={14} /> Changer…
                </button>
                <button title="Cadrer le fond de plan" onClick={() => zoomUnderlay(app, sel.id)}>
                  <Icon name="zoom-ext" size={14} /> Zoom
                </button>
                <button title="Renommer" onClick={() => void rename()}>
                  Renommer
                </button>
                {sel.entities && (
                  <button title="Convertir en objets du dessin (modifiables)" onClick={() => void bind()}>
                    <Icon name="bind" size={14} /> Lier
                  </button>
                )}
                <button className="ul-danger" title="Retirer du dessin" onClick={() => void detach()}>
                  <Icon name="trash" size={14} /> Détacher
                </button>
              </div>
              <div className="pp-row">
                <span className="pp-label">Type</span>
                <span className="pp-value pp-ro">
                  {underlayKindLabel(sel)}
                  {sel.page ? ` — page ${sel.page}` : ''}
                </span>
              </div>
              <div className="pp-row">
                <span className="pp-label">Fichier</span>
                <span className="pp-value pp-ro ul-path" title={sel.path ?? sel.fileName}>
                  {sel.path ?? sel.fileName}
                </span>
              </div>
              <div className="pp-row">
                <span className="pp-label">Taille (unités du fond)</span>
                <span className="pp-value pp-ro">{size(sel)}</span>
              </div>
              {sel.units !== undefined && sel.entities && (
                <div className="pp-row">
                  <span className="pp-label">Unités</span>
                  <span className="pp-value pp-ro">{UNIT_NAME[sel.units] ?? sel.units}</span>
                </div>
              )}
              {sel.entities && (
                <div className="pp-row">
                  <span className="pp-label">Objets</span>
                  <span className="pp-value pp-ro">{sel.entities.length}</span>
                </div>
              )}
              <div className="pp-row">
                <span className="pp-label">Chargé le</span>
                <span className="pp-value pp-ro">{new Date(sel.loadedAt).toLocaleString('fr-FR')}</span>
              </div>
              <div className="pp-row">
                <span className="pp-label">Estompage</span>
                <span className="pp-value ul-fade">
                  <input type="range" min={0} max={90} step={5} value={sel.fade} onChange={(e) => update({ fade: Number(e.target.value) }, 'Estompage')} />
                  <b>{sel.fade} %</b>
                </span>
              </div>
              <label className="ul-check">
                <input type="checkbox" checked={sel.monochrome} onChange={(e) => update({ monochrome: e.target.checked }, 'Monochrome')} /> Monochrome (gris)
              </label>
              {sel.image && (
                <label className="ul-check">
                  <input type="checkbox" checked={!!sel.adjustColors} onChange={(e) => update({ adjustColors: e.target.checked }, 'Couleurs')} /> Adapter les couleurs au fond sombre (traits noirs → clairs)
                </label>
              )}
              {sel.layers && sel.layers.length > 0 && (
                <div className="ul-layers">
                  <div className="lp-states-head">
                    <span>Calques du fond ({sel.layers.filter((l) => l.visible).length}/{sel.layers.length} visibles)</span>
                    <span>
                      <button title="Tout afficher" onClick={() => update({ layers: sel.layers!.map((l) => ({ ...l, visible: true })) }, 'Calques du fond')}>
                        <Icon name="bulb" size={14} />
                      </button>
                      <button title="Tout masquer" onClick={() => update({ layers: sel.layers!.map((l) => ({ ...l, visible: false })) }, 'Calques du fond')}>
                        <Icon name="bulb-off" size={14} />
                      </button>
                    </span>
                  </div>
                  {sel.layers.length > 12 && <input className="pp-input ul-filter" placeholder="Filtrer les calques…" value={layerFilter} onChange={(e) => setLayerFilter(e.target.value)} />}
                  <div className="ul-layer-list">
                    {sel.layers
                      .filter((l) => !layerFilter || l.name.toLowerCase().includes(layerFilter.toLowerCase()))
                      .map((l) => (
                        <div key={l.name} className={`ul-layer ${l.visible ? '' : 'off'}`} onClick={() => update({ layers: sel.layers!.map((k) => (k.name === l.name ? { ...k, visible: !k.visible } : k)) }, 'Calques du fond')}>
                          <Icon name={l.visible ? 'bulb' : 'bulb-off'} size={14} />
                          <span className="ul-swatch" style={{ background: l.color }} />
                          <span>{l.name}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
