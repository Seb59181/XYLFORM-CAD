/**
 * Fenêtre « Bibliothèque de matériaux » : matériaux d'aspect réel (pelouse, carrelage, plâtre,
 * béton, bois, pierre bleue…) rangés par catégorie, avec vignettes, recherche et réglages du
 * motif (taille réelle en mm, rotation, relief). Double-clic sur une vignette = appliquer.
 */
import { useMemo, useState } from 'react';
import type { TextureLibraryChoice } from '../app/AppHost';
import { LIBRARY_CATEGORIES, LIBRARY_TEXTURES, libraryTexture, libraryUrl, searchLibrary, type LibraryCategory } from '../core/textureLibrary';
import { Frame, useKeys } from './Dialogs';

const fmtMm = (v: number) => (Math.round(v * 10) / 10).toLocaleString('fr-FR');

export function TextureLibraryDialog({ initial, onDone }: { initial: TextureLibraryChoice & { solids: number }; onDone: (v: TextureLibraryChoice | null) => void }) {
  const first = libraryTexture(initial.id);
  const [cat, setCat] = useState<LibraryCategory | 'all'>(first?.category ?? 'all');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | undefined>(first?.id);
  const [size, setSize] = useState<number>(initial.size ?? first?.size ?? 1000);
  const [angle, setAngle] = useState<number>(initial.angle ?? 0);
  const [relief, setRelief] = useState<number>(initial.relief ?? 100);
  const list = useMemo(() => searchLibrary(query, query ? 'all' : cat), [query, cat]);
  const cur = libraryTexture(sel);

  const pick = (id: string) => {
    const t = libraryTexture(id);
    if (!t) return;
    // nouvelle matière : sa taille réelle (on garde la taille choisie à la main pour la même)
    if (id !== sel) setSize(t.size);
    setSel(id);
  };
  const ok = (id = sel) => {
    if (!id || !(size > 0)) return;
    onDone({ id, size, angle, relief: Math.max(0, Math.min(400, relief)) });
  };
  useKeys(() => ok(), () => onDone(null));

  const num = (v: string, set: (n: number) => void) => {
    const n = Number(v.replace(',', '.'));
    if (Number.isFinite(n)) set(n);
  };

  return (
    <Frame
      title="Bibliothèque de matériaux"
      onClose={() => onDone(null)}
      wide
      className="texlib"
      footer={
        <>
          <span className="tl-foot-info">{initial.solids} solide(s) · {LIBRARY_TEXTURES.length} matériaux</span>
          <button onClick={() => onDone(null)}>Annuler</button>
          <button className="primary" disabled={!cur || !(size > 0)} onClick={() => ok()}>
            Appliquer
          </button>
        </>
      }
    >
      <div className="tl-layout">
        <nav className="tl-cats">
          <input className="tl-search" type="search" placeholder="Rechercher (brique, sol, toit…)" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          <button className={!query && cat === 'all' ? 'on' : ''} onClick={() => (setQuery(''), setCat('all'))}>
            Tous <span>{LIBRARY_TEXTURES.length}</span>
          </button>
          {LIBRARY_CATEGORIES.map((c) => (
            <button key={c.id} className={!query && cat === c.id ? 'on' : ''} onClick={() => (setQuery(''), setCat(c.id))}>
              {c.label} <span>{LIBRARY_TEXTURES.filter((t) => t.category === c.id).length}</span>
            </button>
          ))}
        </nav>
        <div className="tl-grid" role="listbox" aria-label="Matériaux">
          {list.length === 0 && <div className="tl-empty">Aucun matériau ne correspond à « {query} ».</div>}
          {list.map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === sel}
              className={`tl-card ${t.id === sel ? 'on' : ''}`}
              onClick={() => pick(t.id)}
              onDoubleClick={() => {
                pick(t.id);
                ok(t.id);
              }}
              title={`${t.label}${t.detail ? ` — ${t.detail}` : ''}`}
            >
              <img src={libraryUrl(t.id, 'vignette')} alt="" loading="lazy" draggable={false} />
              <span className="tl-name">{t.label}</span>
              {t.detail && <span className="tl-detail">{t.detail}</span>}
            </button>
          ))}
        </div>
        <aside className="tl-side">
          {cur ? (
            <>
              <div className="tl-preview" style={{ backgroundImage: `url(${libraryUrl(cur.id, 'couleur')})`, backgroundSize: `${Math.max(size, 1) / 10}% auto` }}>
                <span>Aperçu : 1 m de large</span>
              </div>
              <div className="tl-title">{cur.label}</div>
              <div className="tl-sub">
                {LIBRARY_CATEGORIES.find((c) => c.id === cur.category)?.label}
                {cur.detail ? ` · ${cur.detail}` : ''}
              </div>
              <div className="tl-sub">
                Image réelle : {fmtMm(cur.size)} × {fmtMm(cur.height)} mm
              </div>
              <label className="tl-field">
                <span>Taille du motif (mm)</span>
                <input type="number" min={0.01} step={10} value={size} onChange={(e) => num(e.target.value, setSize)} />
                <button className="tl-reset" disabled={size === cur.size} onClick={() => setSize(cur.size)} title="Revenir à la taille réelle du matériau">
                  Taille réelle
                </button>
              </label>
              <label className="tl-field">
                <span>Rotation (°)</span>
                <input type="number" step={15} value={angle} onChange={(e) => num(e.target.value, setAngle)} />
                <button className="tl-reset" onClick={() => setAngle((a) => (a + 90) % 360)} title="Tourner d’un quart de tour (lames, briques…)">
                  +90°
                </button>
              </label>
              <label className="tl-field">
                <span>Relief (%)</span>
                <input type="range" min={0} max={300} step={10} value={relief} onChange={(e) => setRelief(Number(e.target.value))} />
                <input type="number" min={0} max={400} step={10} value={relief} onChange={(e) => num(e.target.value, setRelief)} />
              </label>
              <p className="tl-hint">
                Les joints, brins d’herbe, fibres du bois et aspérités accrochent la lumière dans les styles Réaliste, Rendu, Photoréaliste et au lancer de rayons. 0 % = surface lisse.
              </p>
            </>
          ) : (
            <div className="tl-empty">Choisissez un matériau. La taille du motif proposée est sa taille réelle : un carreau de 20 cm fait 20 cm sur la pièce.</div>
          )}
        </aside>
      </div>
    </Frame>
  );
}
