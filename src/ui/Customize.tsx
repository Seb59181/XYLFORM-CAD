/**
 * Fenêtre PERSONNALISER : raccourcis clavier sur mesure (touche → commande) et onglet du
 * ruban « Mon onglet » (commandes choisies, ordre, nom). Réglages enregistrés avec les autres
 * préférences de l'application.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppHost } from '../app/AppHost';
import { Icon } from './icons';
import { ribbonCommands } from './Ribbon';
import { BUILTIN, comboOf, comboProblem } from './shortcuts';

function CommandInput({ app, value, onChange, id }: { app: AppHost; value: string; onChange: (v: string) => void; id: string }) {
  const all = useMemo(() => [...app.registry.all()].sort((a, b) => a.localName.localeCompare(b.localName)), [app]);
  return (
    <>
      <input className="pp-input" list={id} value={value} placeholder="Commande (ex. BOITE, PERCAGE, CERCLE 2P)" onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <datalist id={id}>
        {all.map((d) => (
          <option key={d.localName} value={d.localName}>
            {d.description}
          </option>
        ))}
      </datalist>
    </>
  );
}

/** Validité d'un texte de commande (premier mot connu). */
function commandOk(app: AppHost, text: string): boolean {
  const first = text.trim().split(/\s+/)[0];
  return !!first && !!app.registry.resolve(first);
}

function Shortcuts({ app }: { app: AppHost }) {
  const map = app.settings.shortcuts;
  const [combo, setCombo] = useState('');
  const [cmd, setCmd] = useState('');
  const problem = combo ? comboProblem(combo) : null;
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  const add = () => {
    if (!combo || problem || !commandOk(app, cmd)) return;
    app.set('shortcuts', { ...map, [combo]: cmd.trim() });
    setCombo('');
    setCmd('');
  };
  return (
    <div className="cz-sec">
      <p className="pp-hint">Cliquez dans « Touche », appuyez sur la combinaison voulue (Ctrl, Alt, Maj + touche, ou F1 à F12), puis choisissez la commande. Une commande peut être suivie de ses options : « CERCLE 2P », « VUE Dessus ».</p>
      <div className="cz-add">
        <input
          className="pp-input cz-key"
          readOnly
          value={combo}
          placeholder="Touche…"
          onKeyDown={(e) => {
            if (e.key === 'Tab') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape' || e.key === 'Backspace') return setCombo('');
            const c = comboOf(e.nativeEvent);
            if (c) setCombo(c);
          }}
        />
        <CommandInput app={app} id="cz-cmds" value={cmd} onChange={setCmd} />
        <button className="primary" disabled={!combo || !!problem || !commandOk(app, cmd)} onClick={add}>
          Ajouter
        </button>
      </div>
      {problem && <p className="cz-warn">{problem}</p>}
      {!problem && combo && BUILTIN[combo] && <p className="cz-warn">Remplace le raccourci intégré : {BUILTIN[combo]}.</p>}
      {!problem && combo && map[combo] && <p className="cz-warn">Déjà attribué à {map[combo]} (sera remplacé).</p>}
      {cmd && !commandOk(app, cmd) && <p className="cz-warn">Commande inconnue.</p>}
      <table className="cz-table">
        <tbody>
          {entries.length ? (
            entries.map(([k, c]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{c}</td>
                <td className="cz-desc">{app.registry.resolve(c.split(/\s+/)[0]!)?.def.description}</td>
                <td>
                  <button
                    className="cz-x"
                    title="Supprimer le raccourci"
                    onClick={() => {
                      const next = { ...map };
                      delete next[k];
                      app.set('shortcuts', next);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td className="pp-hint">Aucun raccourci personnalisé.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CustomTab({ app }: { app: AppHost }) {
  const tab = app.settings.customTab;
  const cat = ribbonCommands();
  const [pick, setPick] = useState('');
  const [other, setOther] = useState('');
  const set = (items: string[], label = tab.label) => app.set('customTab', { label, items });
  const add = (c: string) => c && !tab.items.includes(c) && set([...tab.items, c]);
  const labelOf = (c: string) => cat.find((x) => x.cmd === c)?.label ?? c;
  const tabs = [...new Set(cat.map((c) => c.tab))];
  return (
    <div className="cz-sec">
      <p className="pp-hint">L’onglet apparaît à droite des autres dès qu’il contient une commande. Astuce : clic droit sur n’importe quel bouton du ruban → « Ajouter à {tab.label} ».</p>
      <div className="cz-add">
        <span className="cz-lbl">Nom de l’onglet</span>
        <input className="pp-input" value={tab.label} onChange={(e) => set(tab.items, e.target.value)} />
      </div>
      <div className="cz-add">
        <select className="pp-input" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Bouton du ruban…</option>
          {tabs.map((t) => (
            <optgroup key={t} label={t}>
              {cat
                .filter((c) => c.tab === t)
                .map((c) => (
                  <option key={c.cmd} value={c.cmd}>
                    {c.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button
          className="primary"
          disabled={!pick}
          onClick={() => {
            add(pick);
            setPick('');
          }}
        >
          Ajouter
        </button>
      </div>
      <div className="cz-add">
        <CommandInput app={app} id="cz-cmds2" value={other} onChange={setOther} />
        <button
          disabled={!commandOk(app, other)}
          onClick={() => {
            add(other.trim());
            setOther('');
          }}
        >
          Ajouter la commande
        </button>
      </div>
      <div className="cz-list">
        {tab.items.length ? (
          tab.items.map((c, i) => (
            <div key={c} className="cz-item">
              <Icon name={cat.find((x) => x.cmd === c)?.icon ?? 'cmd-generic'} size={18} />
              <span className="cz-name">{labelOf(c)}</span>
              <span className="cz-cmd">{c}</span>
              <button className="cz-x" title="Monter" disabled={!i} onClick={() => set(tab.items.map((x, k) => (k === i - 1 ? c : k === i ? tab.items[i - 1]! : x)))}>
                ▲
              </button>
              <button className="cz-x" title="Descendre" disabled={i === tab.items.length - 1} onClick={() => set(tab.items.map((x, k) => (k === i + 1 ? c : k === i ? tab.items[i + 1]! : x)))}>
                ▼
              </button>
              <button className="cz-x" title="Retirer" onClick={() => set(tab.items.filter((x) => x !== c))}>
                ✕
              </button>
            </div>
          ))
        ) : (
          <p className="pp-hint">Onglet vide (masqué).</p>
        )}
      </div>
    </div>
  );
}

export function CustomizeDialog({ app, onClose }: { app: AppHost; onClose: () => void }) {
  const [page, setPage] = useState<'keys' | 'tab'>('keys');
  const [, force] = useState(0);
  // les réglages changent : on redessine (useHost n'est pas branché sur la boîte de dialogue)
  useEffect(() => app.on('settings', () => force((n) => n + 1)), [app]);
  useEffect(() => {
    // Échap ferme la fenêtre, sauf pendant la saisie d'une touche (qui l'intercepte)
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal wide cz" role="dialog" aria-label="Personnaliser">
      <div className="modal-head">
        <span>Personnaliser Xylform CAD</span>
        <button className="modal-x" onClick={onClose} title="Fermer (Échap)">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="cz-tabs">
        <button className={page === 'keys' ? 'on' : ''} onClick={() => setPage('keys')}>
          Raccourcis clavier
        </button>
        <button className={page === 'tab' ? 'on' : ''} onClick={() => setPage('tab')}>
          Onglet du ruban
        </button>
      </div>
      <div className="modal-body">{page === 'keys' ? <Shortcuts app={app} /> : <CustomTab app={app} />}</div>
      <div className="modal-foot">
        <button
          onClick={() => {
            if (page === 'keys') app.set('shortcuts', {});
            else app.set('customTab', { label: 'Mon onglet', items: [] });
          }}
        >
          Tout effacer
        </button>
        <button className="primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}
