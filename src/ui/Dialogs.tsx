/**
 * Couche d'interface modale : boîtes de dialogue (saisie, confirmation, export maillé, aide),
 * menu contextuel et notifications. `UiRoot` implémente `UiApi` et l'installe sur l'hôte.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormSpec, FormValues, MenuItem, MeshExportSettings, UiApi } from '../app/AppHost';
import { Icon } from './icons';
import { CustomizeDialog } from './Customize';
import { useApp } from './context';

let modalOpen = false;
/** Vrai quand une boîte de dialogue ou un menu capte le clavier. */
export function isModalOpen(): boolean {
  return modalOpen;
}

type Dialog =
  | { id: number; kind: 'prompt'; title: string; label?: string; initial: string; resolve: (v: string | null) => void }
  | { id: number; kind: 'confirm'; title: string; message: string; labels?: { ok: string; cancel: string }; resolve: (v: boolean) => void }
  | { id: number; kind: 'mesh'; format: 'stl' | '3mf'; solids: number; unit?: MeshExportSettings['unit']; resolve: (v: MeshExportSettings | null) => void }
  | { id: number; kind: 'help' }
  | { id: number; kind: 'news'; notes: NewsNotes[]; previous: string | null; resolve: () => void }
  | { id: number; kind: 'customize' }
  | { id: number; kind: 'form'; spec: FormSpec; resolve: (v: FormValues | null) => void }
  | { id: number; kind: 'choose'; title: string; message: string; buttons: string[]; resolve: (v: number) => void };

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

let nextId = 1;

export function UiRoot() {
  const app = useApp();
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    const push = (d: Dialog) => setDialogs((ds) => [...ds, d]);
    const api: UiApi = {
      toast: (message, kind = 'info') => {
        const id = nextId++;
        setToasts((ts) => [...ts.slice(-4), { id, message, kind }]);
        setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
      },
      openFile: (accept) =>
        new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = accept;
          input.style.display = 'none';
          let done = false;
          const finish = (f: File | null) => {
            if (done) return;
            done = true;
            input.remove();
            resolve(f);
          };
          input.addEventListener('change', () => finish(input.files?.[0] ?? null));
          input.addEventListener('cancel', () => finish(null));
          document.body.appendChild(input);
          input.click();
        }),
      prompt: (title, initial = '', label) => new Promise((resolve) => push({ id: nextId++, kind: 'prompt', title, initial, label, resolve })),
      confirm: (message, title = 'Xylform CAD', labels) => new Promise((resolve) => push({ id: nextId++, kind: 'confirm', title, message, labels, resolve })),
      meshExport: (format, solids, unit) => new Promise((resolve) => push({ id: nextId++, kind: 'mesh', format, solids, unit, resolve })),
      showHelp: () => push({ id: nextId++, kind: 'help' }),
      showNews: (notes, previous) => new Promise((resolve) => push({ id: nextId++, kind: 'news', notes, previous, resolve })),
      customize: () => push({ id: nextId++, kind: 'customize' }),
      contextMenu: (x, y, items) => setMenu({ x, y, items }),
      form: (spec) => new Promise((resolve) => push({ id: nextId++, kind: 'form', spec, resolve })),
      choose: (message, title, buttons) => new Promise((resolve) => push({ id: nextId++, kind: 'choose', title, message, buttons, resolve })),
    };
    const previous = app.ui;
    app.ui = api;
    return () => {
      app.ui = previous;
    };
  }, [app]);

  const top = dialogs[dialogs.length - 1];
  modalOpen = !!top || !!menu;
  const close = (id: number) => setDialogs((ds) => ds.filter((d) => d.id !== id));

  return (
    <>
      {top && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && top.kind === 'help' && close(top.id)}>
          {top.kind === 'prompt' && (
            <PromptDialog
              key={top.id}
              d={top}
              onDone={(v) => {
                close(top.id);
                top.resolve(v);
              }}
            />
          )}
          {top.kind === 'confirm' && (
            <ConfirmDialog
              key={top.id}
              d={top}
              onDone={(v) => {
                close(top.id);
                top.resolve(v);
              }}
            />
          )}
          {top.kind === 'choose' && (
            <ChooseDialog
              key={top.id}
              d={top}
              onDone={(v) => {
                close(top.id);
                top.resolve(v);
              }}
            />
          )}
          {top.kind === 'mesh' && (
            <MeshExportDialog
              key={top.id}
              format={top.format}
              solids={top.solids}
              drawingUnit={top.unit}
              onDone={(v) => {
                close(top.id);
                top.resolve(v);
              }}
            />
          )}
          {top.kind === 'help' && <HelpDialog key={top.id} onClose={() => close(top.id)} />}
          {top.kind === 'news' && (
            <NewsDialog
              key={top.id}
              d={top}
              onClose={() => {
                close(top.id);
                top.resolve();
              }}
            />
          )}
          {top.kind === 'customize' && <CustomizeDialog key={top.id} app={app} onClose={() => close(top.id)} />}
          {top.kind === 'form' && (
            <FormDialog
              key={top.id}
              spec={top.spec}
              onDone={(v) => {
                close(top.id);
                top.resolve(v);
              }}
            />
          )}
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

type NewsNotes = { version: string; date: string; body: string };

/** Mise en forme minimale du Markdown du CHANGELOG : gras, code, liens. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|<(https?:\/\/[^>]+)>|\[([^\]]+)\]\((https?:[^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<b key={m.index}>{inline(m[1])}</b>);
    else if (m[2] !== undefined) out.push(<code key={m.index}>{m[2]}</code>);
    else {
      const href = m[3] ?? m[5];
      out.push(
        <a key={m.index} href={href} target="_blank" rel="noreferrer">
          {m[4] ?? href}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Listes à puces (deux niveaux) et paragraphes. */
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let items: { text: string; sub: string[] }[] = [];
  let paraOpen = false;
  let paraText = '';
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={blocks.length}>
        {items.map((it, i) => (
          <li key={i}>
            {inline(it.text)}
            {it.sub.length > 0 && (
              <ul>
                {it.sub.map((x, j) => (
                  <li key={j}>{inline(x)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const top = /^- (.*)$/.exec(line);
    const sub = /^\s{2,}- (.*)$/.exec(line);
    const last = items[items.length - 1];
    if (top) items.push({ text: top[1] ?? '', sub: [] });
    else if (sub && last) last.sub.push(sub[1] ?? '');
    else if (/^\s*$/.test(line)) {
      paraOpen = false;
      continue;
    }
    else if (/^#{2,4} /.test(line)) {
      flush();
      blocks.push(<h4 key={blocks.length}>{inline(line.replace(/^#+ /, ''))}</h4>);
    } else if (/^\s+\S/.test(line) && last) {
      if (last.sub.length) last.sub[last.sub.length - 1] += ` ${line.trim()}`;
      else last.text += ` ${line.trim()}`;
    } else {
      flush();
      // lignes consécutives d'un même paragraphe
      const prev = blocks[blocks.length - 1];
      if (paraOpen && prev) blocks[blocks.length - 1] = <p key={blocks.length - 1}>{inline(`${paraText} ${line.trim()}`)}</p>;
      else blocks.push(<p key={blocks.length}>{inline(line.trim())}</p>);
      paraText = paraOpen ? `${paraText} ${line.trim()}` : line.trim();
      paraOpen = true;
      continue;
    }
    paraOpen = false;
  }
  flush();
  return <>{blocks}</>;
}

function NewsDialog({ d, onClose }: { d: Extract<Dialog, { kind: 'news' }>; onClose: () => void }) {
  useKeys(onClose, onClose);
  const first = d.notes[0];
  return (
    <Frame
      title={first ? `Quoi de neuf dans Xylform CAD ${first.version}` : 'Quoi de neuf'}
      onClose={onClose}
      footer={
        <>
          <a className="news-all" href="https://github.com/Seb59181/XYLFORM-CAD/releases" target="_blank" rel="noreferrer">
            Toutes les versions
          </a>
          <button className="btn primary" autoFocus onClick={onClose}>
            Continuer
          </button>
        </>
      }
    >
      <div className="news">
        <img className="news-banner" src="/logo-xylform.jpg" alt="" />
        {d.previous && <p className="news-from">Mise à jour depuis la version {d.previous}.</p>}
        {d.notes.map((n) => (
          <section key={n.version}>
            <h3>
              Version {n.version} {n.date && <small>— {n.date}</small>}
            </h3>
            <Markdown text={n.body} />
          </section>
        ))}
      </div>
    </Frame>
  );
}

function Frame({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
      <div className="modal-head">
        <span>{title}</span>
        <button className="modal-x" onClick={onClose} title="Fermer (Échap)">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );
}

/** Échap / Entrée pour la boîte de dialogue active. */
function useKeys(onEnter: (() => void) | null, onEscape: () => void) {
  const ref = useRef({ onEnter, onEscape });
  ref.current = { onEnter, onEscape };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        ref.current.onEscape();
      } else if (e.key === 'Enter' && ref.current.onEnter && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        e.stopPropagation();
        ref.current.onEnter();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);
}

function PromptDialog({ d, onDone }: { d: Extract<Dialog, { kind: 'prompt' }>; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(d.initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useKeys(
    () => onDone(value),
    () => onDone(null),
  );
  return (
    <Frame
      title={d.title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="primary" onClick={() => onDone(value)}>
            OK
          </button>
          <button onClick={() => onDone(null)}>Annuler</button>
        </>
      }
    >
      {d.label && <label className="modal-label">{d.label}</label>}
      <input ref={ref} className="modal-input" value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
    </Frame>
  );
}

function ConfirmDialog({ d, onDone }: { d: Extract<Dialog, { kind: 'confirm' }>; onDone: (v: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  useKeys(
    () => onDone(true),
    () => onDone(false),
  );
  return (
    <Frame
      title={d.title}
      onClose={() => onDone(false)}
      footer={
        <>
          <button ref={ok} className="primary" onClick={() => onDone(true)}>
            {d.labels?.ok ?? 'Continuer'}
          </button>
          <button onClick={() => onDone(false)}>{d.labels?.cancel ?? 'Annuler'}</button>
        </>
      }
    >
      <p className="modal-message">{d.message}</p>
    </Frame>
  );
}

/** Choix entre plusieurs boutons (Enregistrer / Ne pas enregistrer / Annuler) ; Échap = dernier. */
function ChooseDialog({ d, onDone }: { d: Extract<Dialog, { kind: 'choose' }>; onDone: (v: number) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const cancel = d.buttons.length - 1;
  useKeys(
    () => onDone(0),
    () => onDone(cancel),
  );
  return (
    <Frame
      title={d.title}
      onClose={() => onDone(cancel)}
      footer={
        <>
          {d.buttons.map((b, i) => (
            <button key={b} ref={i === 0 ? first : undefined} className={i === 0 ? 'primary' : ''} onClick={() => onDone(i)}>
              {b}
            </button>
          ))}
        </>
      }
    >
      <p className="modal-message">{d.message}</p>
    </Frame>
  );
}

function FormDialog({ spec, onDone }: { spec: FormSpec; onDone: (v: FormValues | null) => void }) {
  const [v, setV] = useState<FormValues>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.value])));
  const first = useRef<HTMLElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  useKeys(
    () => onDone(v),
    () => onDone(null),
  );
  return (
    <Frame
      title={spec.title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="primary" onClick={() => onDone(v)}>
            {spec.ok ?? 'OK'}
          </button>
          <button onClick={() => onDone(null)}>Annuler</button>
        </>
      }
    >
      {spec.intro && <p className="modal-message">{spec.intro}</p>}
      <div className="form-grid">
        {spec.fields.map((f, i) => {
          const set = (x: string | number | boolean) => setV((o) => ({ ...o, [f.key]: x }));
          const reg = (el: HTMLElement | null) => {
            if (i === 0) first.current = el;
          };
          if (f.type === 'checkbox')
            return (
              <label key={f.key} className="check form-span" title={f.hint}>
                <input ref={reg} type="checkbox" checked={!!v[f.key]} onChange={(e) => set(e.target.checked)} />
                {f.label}
              </label>
            );
          return (
            <Fragment key={f.key}>
              <label title={f.hint}>{f.label}</label>
              {f.type === 'select' ? (
                <select ref={reg} value={String(v[f.key])} onChange={(e) => set(e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  ref={reg}
                  type={f.type === 'number' ? 'number' : 'text'}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 'any'}
                  spellCheck={false}
                  value={String(v[f.key])}
                  onChange={(e) => set(f.type === 'number' ? Number(e.target.value.replace(',', '.')) : e.target.value)}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Export pour l'impression 3D
// ---------------------------------------------------------------------------

const PRESETS = [
  { id: 'draft', label: 'Brouillon', linear: 0.1, angular: 20, hint: 'Fichier léger, facettes visibles sur les courbes' },
  { id: 'standard', label: 'Standard', linear: 0.05, angular: 15, hint: 'Bon compromis pour la plupart des impressions FDM' },
  { id: 'fine', label: 'Fin', linear: 0.01, angular: 8, hint: 'Courbes lisses, résine ou petites pièces' },
  { id: 'ultra', label: 'Très fin', linear: 0.005, angular: 5, hint: 'Très nombreux triangles, fichiers volumineux' },
] as const;

const UNITS: { id: MeshExportSettings['unit']; label: string }[] = [
  { id: 'mm', label: 'Millimètres (recommandé)' },
  { id: 'cm', label: 'Centimètres' },
  { id: 'm', label: 'Mètres' },
  { id: 'in', label: 'Pouces' },
  { id: 'ft', label: 'Pieds' },
];

const MESH_KEY = 'sebcad.meshExport';

/** Réglages mémorisés ; l'unité, elle, est toujours celle du dessin. */
function loadMeshSettings(unit: MeshExportSettings['unit'] = 'mm'): MeshExportSettings {
  const def: MeshExportSettings = { unit, linearDeflection: 0.05, angularDeflection: 15, repair: true, separate: true, check: true, minWall: 0.8, overhang: 45 };
  try {
    const raw = localStorage.getItem(MESH_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<MeshExportSettings>), unit };
  } catch {
    /* stockage indisponible */
  }
  return def;
}

function MeshExportDialog({ format, solids, drawingUnit, onDone }: { format: 'stl' | '3mf'; solids: number; drawingUnit?: MeshExportSettings['unit']; onDone: (v: MeshExportSettings | null) => void }) {
  const [s, setS] = useState(() => loadMeshSettings(drawingUnit));
  const preset = PRESETS.find((p) => p.linear === s.linearDeflection && p.angular === s.angularDeflection);
  const valid = s.linearDeflection > 0 && s.angularDeflection > 0 && s.angularDeflection <= 45 && (!s.check || ((s.minWall ?? 0) >= 0 && (s.overhang ?? 45) > 0 && (s.overhang ?? 45) < 90));
  const ok = () => {
    if (!valid) return;
    try {
      localStorage.setItem(MESH_KEY, JSON.stringify(s));
    } catch {
      /* ignoré */
    }
    onDone(s);
  };
  useKeys(ok, () => onDone(null));
  const num = (v: string) => Number(v.replace(',', '.'));
  return (
    <Frame
      title={`Exporter en ${format.toUpperCase()} pour l’impression 3D`}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="primary" disabled={!valid} onClick={ok}>
            Exporter
          </button>
          <button onClick={() => onDone(null)}>Annuler</button>
        </>
      }
    >
      <p className="modal-message">
        {solids} solide{solids > 1 ? 's' : ''} à exporter{format === 'stl' && solids > 1 ? ' (réunis dans un seul fichier STL)' : ''}.
      </p>
      <div className="modal-label">Qualité de facettisation</div>
      <div className="seg">
        {PRESETS.map((p) => (
          <button key={p.id} className={preset?.id === p.id ? 'on' : ''} onClick={() => setS({ ...s, linearDeflection: p.linear, angularDeflection: p.angular })} title={p.hint}>
            {p.label}
          </button>
        ))}
        <button className={!preset ? 'on' : ''} disabled>
          Personnalisé
        </button>
      </div>
      {preset && <div className="modal-hint">{preset.hint}</div>}
      <div className="form-grid">
        <label>Déviation de corde (mm)</label>
        <input type="number" step="0.001" min="0.0001" value={s.linearDeflection} onChange={(e) => setS({ ...s, linearDeflection: num(e.target.value) })} />
        <label>Déviation angulaire (°)</label>
        <input type="number" step="0.5" min="0.5" max="45" value={s.angularDeflection} onChange={(e) => setS({ ...s, angularDeflection: num(e.target.value) })} />
        <label>Unités du dessin</label>
        <select value={s.unit} onChange={(e) => setS({ ...s, unit: e.target.value as MeshExportSettings['unit'] })}>
          {UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
              {u.id === drawingUnit ? ' (dessin)' : ''}
            </option>
          ))}
        </select>
      </div>
      {s.unit !== 'mm' && <div className="modal-hint">Le fichier sera écrit en millimètres (unité des trancheurs) : 1 unité du dessin = {s.unit === 'cm' ? '10' : s.unit === 'm' ? '1000' : s.unit === 'in' ? '25,4' : '304,8'} mm.</div>}
      <label className="check">
        <input type="checkbox" checked={s.repair} onChange={(e) => setS({ ...s, repair: e.target.checked })} />
        Réparer le maillage (soudure des sommets, triangles dégénérés, orientation des normales)
      </label>
      {format === '3mf' && (
        <label className="check">
          <input type="checkbox" checked={s.separate} onChange={(e) => setS({ ...s, separate: e.target.checked })} />
          Un objet par solide (nommés et colorés comme dans le dessin)
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={!!s.check} onChange={(e) => setS({ ...s, check: e.target.checked })} />
        Contrôler l’imprimabilité : solides qui se chevauchent, parois trop fines, porte-à-faux (zones colorées dans la vue)
      </label>
      {s.check && (
        <div className="form-grid">
          <label>Paroi minimale (mm)</label>
          <input type="number" step="0.1" min="0" value={s.minWall ?? 0.8} onChange={(e) => setS({ ...s, minWall: num(e.target.value) })} title="Environ 2 largeurs de ligne : 0,8 mm avec une buse de 0,4" />
          <label>Porte-à-faux maximal (°)</label>
          <input type="number" step="1" min="1" max="89" value={s.overhang ?? 45} onChange={(e) => setS({ ...s, overhang: num(e.target.value) })} title="Inclinaison depuis la verticale au-delà de laquelle il faut des supports" />
        </div>
      )}
      <div className="modal-hint">L’étanchéité (maillage manifold) est vérifiée avant l’écriture. Les logiciels de tranchage attendent des millimètres.</div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Aide
// ---------------------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ['F1', 'Aide'],
  ['F2', 'Historique de la ligne de commande'],
  ['F3', 'Accrochage aux objets'],
  ['F7', 'Grille'],
  ['F8', 'Ortho'],
  ['F9', 'Résolution (accrochage à la grille)'],
  ['F10', 'Repérage polaire'],
  ['F12', 'Saisie dynamique'],
  ['Entrée / Espace', 'Valider, ou répéter la dernière commande'],
  ['Échap', 'Annuler la commande, puis vider la sélection'],
  ['Suppr', 'Effacer la sélection'],
  ['Ctrl+Z / Ctrl+Y', 'Annuler / Rétablir'],
  ['Ctrl+N / Ctrl+O', 'Nouveau / Ouvrir'],
  ['Ctrl+S / Ctrl+Maj+S', 'Enregistrer / Enregistrer sous'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copier / Couper / Coller'],
  ['Ctrl+A', 'Tout sélectionner'],
  ['Ctrl+1', 'Palette Propriétés'],
  ['Molette', 'Zoom centré sur le curseur'],
  ['Clic milieu (glisser)', 'Panoramique'],
  ['Maj + clic milieu', 'Orbite (espace 3D)'],
  ['Double-clic milieu', 'Zoom étendu'],
  ['Clic droit court', 'Entrée (valider, terminer, répéter la commande)'],
  ['Clic droit maintenu ≥ 0,5 s', 'Menu contextuel (durée réglable : CLICDROIT)'],
  ['Cube de vue (3D)', 'Clic : face, arête ou coin ; glisser : orbite ; maison : vue d’accueil'],
];

const SYNTAX: [string, string][] = [
  ['10,20', 'Point absolu (X,Y)'],
  ['10,20,5', 'Point absolu (X,Y,Z)'],
  ['@30,0', 'Relatif au dernier point'],
  ['@50<30', 'Polaire relatif : distance < angle'],
  ['50', 'Distance dans la direction du curseur'],
  ['largeur/2+5', 'Expression (paramètres utilisateur acceptés)'],
  ['_LINE', 'Nom de commande international'],
  ["'ZOOM", 'Commande transparente pendant une autre'],
];

function HelpDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useKeys(null, onClose);
  const commands = useMemo(() => [...app.registry.all()].sort((a, b) => a.localName.localeCompare(b.localName, 'fr')), [app]);
  const f = filter
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const fold = (s: string) => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const shown = f ? commands.filter((c) => [c.name, c.localName, ...(c.aliases ?? []), c.description ?? ''].some((s) => fold(s).includes(f))) : commands;
  return (
    <Frame title="Aide de Xylform CAD, by Seb." onClose={onClose} wide>
      <div className="help">
        <div className="help-commands">
          <input ref={ref} className="modal-input" placeholder={`Rechercher parmi ${commands.length} commandes…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="help-list">
            <table>
              <tbody>
                {shown.map((c) => (
                  <tr
                    key={c.name}
                    onClick={() => {
                      onClose();
                      app.run(c.localName);
                    }}
                    title="Cliquer pour lancer la commande"
                  >
                    <td className="help-name">{c.localName}</td>
                    <td className="help-alias">{[...(c.aliases ?? []), c.name !== c.localName ? `_${c.name}` : ''].filter(Boolean).join(', ')}</td>
                    <td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="help-side">
          <div className="modal-label">Raccourcis</div>
          <table className="help-keys">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-label">Saisie des coordonnées</div>
          <table className="help-keys">
            <tbody>
              {SYNTAX.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Menu contextuel
// ---------------------------------------------------------------------------

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('mousedown', down, true), 0);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} onContextMenu={(e) => e.preventDefault()}>
      <MenuList x={x} y={y} items={items} onClose={onClose} />
    </div>
  );
}

/** Liste d'un menu (ou d'un sous-menu) repositionnée pour rester dans la fenêtre. */
function MenuList({ x, y, items, onClose, sub }: { x: number; y: number; items: MenuItem[]; onClose: () => void; sub?: { left: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<{ index: number; x: number; y: number; left: number } | null>(null);
  const timer = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // sous-menu : à gauche du parent s'il ne tient pas à droite
    const nx = x + r.width > window.innerWidth - 4 && sub ? sub.left - r.width : Math.min(x, window.innerWidth - r.width - 4);
    setPos({ x: Math.max(4, nx), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y, sub]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const openSub = (i: number, el: HTMLElement) => {
    clearTimeout(timer.current);
    const r = el.getBoundingClientRect();
    timer.current = window.setTimeout(() => setOpen({ index: i, x: r.right - 2, y: r.top - 5, left: r.left + 2 }), open ? 120 : 0);
  };
  return (
    <>
      <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              className={open?.index === i ? 'open' : ''}
              onMouseEnter={(e) => (it.children ? openSub(i, e.currentTarget) : (clearTimeout(timer.current), (timer.current = window.setTimeout(() => setOpen(null), 150))))}
              onClick={(e) => {
                if (it.children) return openSub(i, e.currentTarget);
                onClose();
                it.action?.();
              }}
            >
              <span className="ctx-ico">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={16} /> : null}</span>
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-key">{it.shortcut}</span>}
              {it.children && <span className="ctx-arrow">›</span>}
            </button>
          ),
        )}
      </div>
      {open && items[open.index]?.children && <MenuList key={open.index} x={open.x} y={open.y} items={items[open.index]!.children!} onClose={onClose} sub={{ left: open.left }} />}
    </>
  );
}
