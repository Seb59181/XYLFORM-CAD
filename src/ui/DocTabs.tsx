/**
 * Onglets des dessins ouverts (sous le ruban) : menu ☰ des dessins, onglet « Démarrage », un
 * onglet par dessin (nom, astérisque si modifié, croix de fermeture) et bouton « + ».
 * Clic : activer — molette (clic milieu) ou croix : fermer — clic droit : menu — glisser :
 * réordonner. Ctrl+Tab / Ctrl+Maj+Tab : dessin suivant / précédent, Ctrl+F4 : fermer.
 * Et la page « Démarrage » : nouveau, ouvrir, dessins récents et ouverts, copies de secours.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppHost, DocTab, MenuItem } from '../app/AppHost';
import { closeTab, openRecent, recoverRecord } from '../app/commands/files';
import { desktop } from '../io/desktop';
import { readAutosaves, type AutosaveRecord } from '../io/autosave';
import { recentFiles, removeRecent, type RecentFile } from '../io/recent';
import { useHost } from './context';
import { Icon } from './icons';

/** Change de dessin (la commande en cours est annulée). */
export async function switchTo(app: AppHost, tab: DocTab): Promise<void> {
  if (tab === app.tab && !app.startPage) return;
  if (await app.leaveCommand()) app.activate(tab);
}

export async function closeFromUi(app: AppHost, tab: DocTab): Promise<void> {
  if (!(await app.leaveCommand())) return;
  await closeTab(app, tab);
}

const tabPath = (t: DocTab) => (t.fileHandle && 'path' in t.fileHandle ? t.fileHandle.path : undefined);

function tabTitle(t: DocTab): string {
  const p = tabPath(t);
  return `${p ?? t.doc.fileName}${t.doc.dirty ? ' (modifié)' : ''}\n${t.doc.size} objet(s)`;
}

/** Nom affiché : sans l'extension .xcad (ou .sebcad). */
const shortName = (name: string) => name.replace(/\.(xcad|sebcad)$/i, '');

export function DocTabs() {
  const app = useHost(['tabs', 'doc', 'settings']);
  const [drag, setDrag] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const active = app.tab;

  // l'onglet actif reste visible quand la barre défile
  useEffect(() => {
    bar.current?.querySelector('.dt-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, app.startPage, app.docs.length]);

  if (!app.settings.fileTabs) return null;

  const tabMenu = (t: DocTab): MenuItem[] => [
    { label: 'Nouveau', icon: 'new', action: () => app.run('NOUVEAU') },
    { label: 'Ouvrir…', icon: 'open', action: () => app.run('OUVRIR') },
    { label: 'Enregistrer', icon: 'save', action: () => void switchTo(app, t).then(() => app.tab === t && app.run('ENREG')) },
    { label: 'Enregistrer sous…', icon: 'saveas', action: () => void switchTo(app, t).then(() => app.tab === t && app.run('ENREGSOUS')) },
    { label: 'Enregistrer tout', action: () => app.run('ENREGTOUT'), disabled: !app.docs.some((d) => d.doc.dirty && d.doc.size) },
    { separator: true, label: '' },
    { label: 'Fermer', icon: 'close', shortcut: 'Ctrl+F4', action: () => void closeFromUi(app, t) },
    {
      label: 'Fermer tous les autres dessins',
      disabled: app.docs.length < 2,
      action: () =>
        void (async () => {
          if (!(await app.leaveCommand())) return;
          for (const o of [...app.docs]) if (o !== t && !(await closeTab(app, o))) return;
          app.activate(t);
        })(),
    },
    { label: 'Fermer tout', action: () => app.run('FERMERTOUT') },
    ...(tabPath(t) ? [{ separator: true, label: '' }, { label: 'Copier le chemin complet', action: () => void navigator.clipboard?.writeText(tabPath(t)!) }] : []),
  ];

  const listMenu = (): MenuItem[] => [
    ...app.docs.map((t) => ({ label: `${shortName(t.doc.fileName)}${t.doc.dirty ? ' *' : ''}`, checked: t === active && !app.startPage, action: () => void switchTo(app, t) })),
    { separator: true, label: '' },
    { label: 'Démarrage', icon: 'start', action: () => app.showStart(true) },
    { label: 'Nouveau dessin', icon: 'new', shortcut: 'Ctrl+N', action: () => app.run('NOUVEAU') },
    { label: 'Ouvrir…', icon: 'open', shortcut: 'Ctrl+O', action: () => app.run('OUVRIR') },
    { label: 'Enregistrer tout', action: () => app.run('ENREGTOUT') },
    { label: 'Fermer tout', action: () => app.run('FERMERTOUT') },
    { separator: true, label: '' },
    { label: 'Masquer la barre d’onglets', action: () => app.set('fileTabs', false) },
  ];

  const onDrop = (target: DocTab) => {
    const t = app.docs.find((d) => d.id === drag);
    setDrag(null);
    if (t && t !== target) app.moveTab(t, app.docs.indexOf(target));
  };

  return (
    <div className="doctabs" onContextMenu={(e) => e.preventDefault()}>
      <button
        className="dt-menu"
        title="Dessins ouverts"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          app.ui.contextMenu(r.left, r.bottom + 2, listMenu());
        }}
      >
        <Icon name="menu" size={16} />
      </button>
      <div className="dt-scroll" ref={bar}>
        <button className={`dt-tab dt-start ${app.startPage ? 'on' : ''}`} title="Page de démarrage : nouveau dessin, ouvrir, dessins récents" onClick={() => app.showStart(true)}>
          Démarrage
        </button>
        {app.docs.map((t) => {
          const on = t === active && !app.startPage;
          return (
            <div
              key={t.id}
              className={`dt-tab ${on ? 'on' : ''} ${drag === t.id ? 'dragging' : ''}`}
              title={tabTitle(t)}
              draggable
              onDragStart={(e) => (setDrag(t.id), e.dataTransfer.setData('text/plain', t.id), (e.dataTransfer.effectAllowed = 'move'))}
              onDragOver={(e) => drag && (e.preventDefault(), e.stopPropagation())}
              onDrop={(e) => (e.preventDefault(), e.stopPropagation(), onDrop(t))}
              onDragEnd={() => setDrag(null)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && void closeFromUi(app, t)}
              onClick={() => void switchTo(app, t)}
              onContextMenu={(e) => {
                e.preventDefault();
                app.ui.contextMenu(e.clientX, e.clientY, tabMenu(t));
              }}
            >
              <span className="dt-name">
                {shortName(t.doc.fileName)}
                {t.doc.dirty && <span className="dt-dirty">*</span>}
              </span>
              <button
                className="dt-close"
                title="Fermer (Ctrl+F4)"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeFromUi(app, t);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}
        <button className="dt-new" title="Nouveau dessin (Ctrl+N)" onClick={() => app.run('NOUVEAU')}>
          <Icon name="plus" size={15} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page « Démarrage »
// ---------------------------------------------------------------------------

function ago(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? `aujourd’hui ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function StartPage() {
  const app = useHost(['tabs', 'doc']);
  const [recent, setRecent] = useState<RecentFile[]>(recentFiles);
  const [backups, setBackups] = useState<(AutosaveRecord & { key: string })[]>([]);
  useEffect(() => {
    if (!app.startPage) return;
    setRecent(recentFiles());
    void readAutosaves().then((r) => setBackups(r.filter((b) => !app.docs.some((t) => b.key === `doc:${t.id}`))));
  }, [app.startPage, app.docs.length]);
  if (!app.startPage) return null;
  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '';
  return (
    <div className="startpage" onContextMenu={(e) => e.stopPropagation()}>
      <div className="st-inner">
        <div className="st-head">
          <img className="st-banner" src="/logo-xylform.jpg" alt="Xylform CAD — Design. Create. Print. By Seb" />
          <div className="st-ver">
            Version {version} — CAO 2D / 3D et impression 3D
            <button className="st-news" onClick={() => app.run('QUOIDENEUF')}>
              Quoi de neuf ?
            </button>
          </div>
        </div>
        <div className="st-cols">
          <section className="st-actions">
            <button onClick={() => app.run('NOUVEAU')}>
              <Icon name="new" size={30} />
              <span>
                <b>Nouveau dessin</b>
                <small>Ctrl+N — dans un nouvel onglet</small>
              </span>
            </button>
            <button onClick={() => app.run('OUVRIR')}>
              <Icon name="open" size={30} />
              <span>
                <b>Ouvrir…</b>
                <small>.xcad, .sebcad, DWG, DXF, STEP, STL, 3MF</small>
              </span>
            </button>
            {app.docs.some((t) => t.doc.size || t.fileHandle) && (
              <button onClick={() => app.showStart(false)}>
                <Icon name="arrow-left" size={30} />
                <span>
                  <b>Revenir au dessin</b>
                  <small>{app.doc.fileName}</small>
                </span>
              </button>
            )}
            {backups.length > 0 && (
              <div className="st-backups">
                <h3>Copies de secours</h3>
                {backups.map((b) => (
                  <button
                    key={b.key}
                    title="Dessin non enregistré lors d’une session précédente"
                    onClick={() =>
                      void (async () => {
                        if (!(await app.leaveCommand())) return;
                        try {
                          await recoverRecord(app, b, (m) => app.log(m));
                        } catch (e) {
                          app.ui.toast(`Récupération impossible : ${(e as Error).message}`, 'error');
                        }
                      })()
                    }
                  >
                    <b>{b.name}</b> <small>{ago(b.time)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
          <section className="st-lists">
            <h3>Dessins ouverts</h3>
            <ul>
              {app.docs.map((t) => (
                <li key={t.id} onClick={() => void switchTo(app, t)} title={tabPath(t) ?? t.doc.fileName}>
                  <Icon name="file-tabs" size={18} />
                  <span className="st-name">
                    {t.doc.fileName}
                    {t.doc.dirty && ' *'}
                  </span>
                  <small>{t.doc.size} objet(s)</small>
                </li>
              ))}
            </ul>
            <h3>Dessins récents</h3>
            {recent.length === 0 && <p className="st-empty">Les dessins ouverts ou enregistrés apparaîtront ici.</p>}
            <ul>
              {recent.map((r) => (
                <li key={`${r.path ?? ''}|${r.name}`} title={r.path ?? (desktop ? r.name : `${r.name} — le navigateur ne garde pas le chemin : la boîte Ouvrir s’affiche`)} onClick={() => void openRecent(app, r)}>
                  <Icon name="open" size={18} />
                  <span className="st-name">
                    {r.name}
                    {r.path && <em>{r.path.replace(/[\\/][^\\/]*$/, '')}</em>}
                  </span>
                  <small>{ago(r.time)}</small>
                  <button
                    className="st-remove"
                    title="Retirer de la liste"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecent(r);
                      setRecent(recentFiles());
                    }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
