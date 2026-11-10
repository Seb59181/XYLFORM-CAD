/**
 * Navigateur : arborescence du dessin par nature d'objet — corps, surfaces,
 * esquisses (objets 2D par calque), fonds de plan — avec l'œil pour masquer/afficher,
 * clic pour sélectionner, double-clic pour cadrer (et renommer les corps).
 */
import { useState } from 'react';
import type { AppHost } from '../../app/AppHost';
import { zoomUnderlay } from '../../app/commands/underlays';
import { animateJoint } from '../../app/commands/joints';
import type { Entity, Joint } from '../../core/document/Document';
import { curvePoints } from '../../core/entities/geometry';
import { featureTitle, flattenHistory } from '../../app/history';
import { Icon } from '../icons';
import { useHost } from '../context';

type Solid = Extract<Entity, { type: '3DSOLID' }>;

function setHidden(app: AppHost, ents: Entity[], hidden: boolean): void {
  const targets = ents.filter((e) => !!e.hidden !== hidden);
  if (!targets.length) return;
  app.doc.transaction(hidden ? 'Masquer' : 'Afficher', () => targets.forEach((e) => app.doc.replaceEntity(e.handle, { hidden: hidden || undefined })));
  if (hidden) app.selection.remove(targets.map((e) => e.handle));
}

function frame(app: AppHost, ents: Entity[]): void {
  const pts = ents.flatMap((e) =>
    e.type === '3DSOLID'
      ? [e.display.bbox.min, e.display.bbox.max]
      : curvePoints(e).flat(),
  );
  if (pts.length) app.viewport?.zoomToPoints(pts);
}

function Eye({ app, ents }: { app: AppHost; ents: Entity[] }) {
  const shown = ents.some((e) => !e.hidden);
  return (
    <button
      className={`br-eye ${shown ? '' : 'off'}`}
      title={shown ? 'Masquer' : 'Afficher'}
      onClick={(ev) => {
        ev.stopPropagation();
        setHidden(app, ents, shown);
      }}
    >
      <Icon name={shown ? 'eye' : 'eye-off'} size={15} />
    </button>
  );
}

function Group(props: { app: AppHost; open: boolean; onToggle: () => void; label: string; icon: string; ents: Entity[]; count?: number; children: React.ReactNode }) {
  return (
    <div className="br-group">
      <div className="br-row br-head" onClick={props.onToggle}>
        <span className={`br-caret ${props.open ? 'open' : ''}`}>
          <Icon name="chevron" size={10} />
        </span>
        {props.ents.length > 0 && <Eye app={props.app} ents={props.ents} />}
        <Icon name={props.icon} size={16} />
        <span className="br-name">{props.label}</span>
        <span className="br-count">{props.count ?? props.ents.length}</span>
      </div>
      {props.open && <div className="br-children">{props.children}</div>}
    </div>
  );
}

/** Liaison d'assemblage : curseur (aperçu en direct, appliqué au relâchement), animation. */
function JointRow({ app, j }: { app: AppHost; j: Joint }) {
  const [live, setLive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = live ?? j.value;
  const unit = j.type === 'revolute' ? '°' : '';
  const step = j.type === 'revolute' ? 1 : Math.max((j.max - j.min) / 200, 0.01);
  const preview = (v: number) => {
    setLive(v);
    app.viewport?.setLiveTransform(j.parts, app.jointMatrix(j, v - j.value));
  };
  const commit = async (v: number) => {
    setBusy(true);
    try {
      await app.driveJoint(j.id, v);
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
    } finally {
      app.viewport?.setLiveTransform(j.parts, null);
      setLive(null);
      setBusy(false);
    }
  };
  return (
    <div className="br-joint" title={`${j.type === 'revolute' ? 'Pivot' : 'Glissière'} : ${j.parts.length} corps — clic sur le nom : sélectionner les pièces`}>
      <div className="br-row">
        <Icon name={j.type === 'revolute' ? 'rotate' : 'move'} size={15} />
        <span className="br-name" onClick={() => app.selection.set(j.parts.filter((h) => app.doc.get(h)))}>
          {j.name}
        </span>
        <span className="br-count">
          {shown.toFixed(j.type === 'revolute' ? 0 : 2)}
          {unit}
        </span>
        <button className="br-zoom" title="Animer (aller-retour entre les bornes)" disabled={busy} onClick={() => void animateJoint(app, j)}>
          ▶
        </button>
        <button className="br-zoom" title="Supprimer la liaison (les corps restent en place)" onClick={() => app.doc.removeJoint(j.id)}>
          ✕
        </button>
      </div>
      <input
        className="br-slider"
        type="range"
        min={j.min}
        max={j.max}
        step={step}
        value={shown}
        disabled={busy}
        onChange={(e) => preview(Number(e.target.value))}
        onPointerUp={(e) => void commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => void commit(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

export function BrowserPanel() {
  const app = useHost(['doc', 'selection']);
  const doc = app.doc;
  const [open, setOpen] = useState<Record<string, boolean>>({ bodies: true, surfaces: true, sketches: true, underlays: true });
  const all = doc.all();
  const bodies = all.filter((e): e is Solid => e.type === '3DSOLID' && e.display.solidCount > 0);
  const surfaces = all.filter((e): e is Solid => e.type === '3DSOLID' && e.display.solidCount === 0);
  const flat = all.filter((e) => e.type !== '3DSOLID' && e.type !== 'UNDERLAY');
  const byLayer = new Map<string, Entity[]>();
  for (const e of flat) byLayer.set(e.layer, [...(byLayer.get(e.layer) ?? []), e]);
  const defs = Object.values(doc.underlays).sort((a, b) => a.name.localeCompare(b.name));

  const select = (ents: Entity[], add: boolean) => {
    const hs = ents.filter((e) => doc.isPickable(e)).map((e) => e.handle);
    if (add) app.selection.add(hs);
    else app.selection.set(hs);
  };
  const rename = async (s: Solid) => {
    const name = (await app.ui.prompt('Renommer le corps', s.name, 'Nom'))?.trim();
    if (name && name !== s.name) doc.transaction('Renommer le corps', () => doc.replaceEntity(s.handle, { name }));
  };

  const [steps, setSteps] = useState<Record<string, boolean>>({});
  const bodyRow = (s: Solid, icon: string) => (
    <div key={s.handle}>
    <div
      className={`br-row ${app.selection.has(s.handle) ? 'sel' : ''} ${s.hidden ? 'hidden' : ''}`}
      title="Clic : sélectionner (Maj : ajouter) — double-clic : renommer"
      onClick={(ev) => select([s], ev.shiftKey || ev.ctrlKey)}
      onDoubleClick={() => void rename(s)}
    >
      {s.history ? (
        <span className={`br-caret ${steps[s.handle] ? 'open' : ''}`} title="Historique de construction" onClick={(ev) => (ev.stopPropagation(), setSteps({ ...steps, [s.handle]: !steps[s.handle] }))}>
          <Icon name="chevron" size={10} />
        </span>
      ) : (
        <span className="br-caret" />
      )}
      <Eye app={app} ents={[s]} />
      <span className="br-swatch" style={{ background: doc.colorOf(s) }} />
      <Icon name={icon} size={15} />
      <span className="br-name">{s.name || `Corps ${s.handle}`}</span>
      <button className="br-zoom" title="Cadrer" onClick={(ev) => (ev.stopPropagation(), frame(app, [s]))}>
        <Icon name="zoom-ext" size={13} />
      </button>
    </div>
      {s.history && steps[s.handle] && (
        <div className="br-steps">
          {flattenHistory(s.history).map(({ f, depth }) => (
            <div
              key={f.id}
              className={`br-step ${f.off ? 'off' : ''}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              title="Clic : modifier les cotes de cette étape (palette Propriétés)"
              onClick={() => {
                app.selection.set([s.handle]);
                app.set('panel', 'properties');
              }}
            >
              {featureTitle(f)}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const hiddenCount = all.filter((e) => e.hidden).length;

  return (
    <div className="lp br">
      <div className="lp-toolbar">
        <button title="Afficher tous les objets masqués (AFFICHERTOUT)" disabled={!hiddenCount} onClick={() => app.run('AFFICHERTOUT')}>
          <Icon name="eye" size={16} /> Tout afficher{hiddenCount ? ` (${hiddenCount})` : ''}
        </button>
        <button title="Isoler la sélection (ISOLER)" disabled={!app.selection.size} onClick={() => app.run('ISOLER')}>
          Isoler
        </button>
        <button title="Masquer la sélection (MASQUEROBJETS)" disabled={!app.selection.size} onClick={() => app.run('MASQUEROBJETS')}>
          <Icon name="eye-off" size={16} /> Masquer
        </button>
      </div>
      <div className="br-tree">
        <div className="br-row br-root">
          <Icon name="ws-3d" size={16} />
          <span className="br-name">{doc.fileName}</span>
        </div>
        <Group app={app} open={!!open.bodies} onToggle={() => setOpen({ ...open, bodies: !open.bodies })} label="Corps" icon="box" ents={bodies}>
          {bodies.length ? bodies.map((s) => bodyRow(s, 'box')) : <div className="br-empty">Aucun corps : BOITE, EXTRUSION, APPUYERTIRER…</div>}
        </Group>
        {surfaces.length > 0 && (
          <Group app={app} open={!!open.surfaces} onToggle={() => setOpen({ ...open, surfaces: !open.surfaces })} label="Surfaces" icon="planesurf" ents={surfaces}>
            {surfaces.map((s) => bodyRow(s, 'planesurf'))}
          </Group>
        )}
        <Group app={app} open={!!open.sketches} onToggle={() => setOpen({ ...open, sketches: !open.sketches })} label="Esquisses (objets 2D par calque)" icon="sketch" ents={flat}>
          {byLayer.size ? (
            [...byLayer.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([layer, ents]) => {
                const l = doc.layer(layer);
                const sel = ents.every((e) => app.selection.has(e.handle));
                return (
                  <div
                    key={layer}
                    className={`br-row ${sel ? 'sel' : ''} ${ents.every((e) => e.hidden) ? 'hidden' : ''}`}
                    title="Clic : sélectionner les objets de ce calque — double-clic : cadrer"
                    onClick={(ev) => select(ents, ev.shiftKey || ev.ctrlKey)}
                    onDoubleClick={() => frame(app, ents)}
                  >
                    <Eye app={app} ents={ents} />
                    <span className="br-swatch" style={{ background: l?.color ?? '#fff' }} />
                    <span className="br-name">
                      {layer}
                      {l && !l.visible ? ' (calque éteint)' : ''}
                    </span>
                    <span className="br-count">{ents.length}</span>
                  </div>
                );
              })
          ) : (
            <div className="br-empty">Aucun objet 2D.</div>
          )}
        </Group>
        {doc.joints.length > 0 && (
          <Group app={app} open={open.joints !== false} onToggle={() => setOpen({ ...open, joints: open.joints === false })} label="Liaisons (assemblage)" icon="rotate" ents={[]} count={doc.joints.length}>
            {doc.joints.map((j) => (
              <JointRow key={j.id} app={app} j={j} />
            ))}
          </Group>
        )}
        {defs.length > 0 && (
          <Group app={app} open={!!open.underlays} onToggle={() => setOpen({ ...open, underlays: !open.underlays })} label="Fonds de plan" icon="xref" ents={[]}>
            {defs.map((d) => (
              <div key={d.id} className={`br-row ${d.loaded ? '' : 'hidden'}`} title="Double-clic : cadrer" onDoubleClick={() => zoomUnderlay(app, d.id)}>
                <button className={`br-eye ${d.loaded ? '' : 'off'}`} title={d.loaded ? 'Décharger' : 'Charger'} onClick={() => doc.updateUnderlayDef(d.id, { loaded: !d.loaded }, d.loaded ? 'Décharger' : 'Charger')}>
                  <Icon name={d.loaded ? 'eye' : 'eye-off'} size={15} />
                </button>
                <Icon name={d.kind === 'image' ? 'image' : d.kind} size={15} />
                <span className="br-name">{d.name}</span>
              </div>
            ))}
          </Group>
        )}
      </div>
    </div>
  );
}
