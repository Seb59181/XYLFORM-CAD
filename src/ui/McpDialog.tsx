/**
 * Connexion IA (serveur MCP local) : activation, configuration à donner à l'assistant IA,
 * ajout automatique dans son fichier de configuration (version bureau).
 */
import { useEffect, useState } from 'react';
import { desktop, type McpStatus } from '../io/desktop';
import { useApp } from './context';
import { Frame, useKeys } from './Dialogs';

export function McpDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [st, setSt] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  useKeys(null, onClose);
  useEffect(() => {
    void desktop?.mcpStatus?.().then(setSt);
  }, []);

  const config = st ? JSON.stringify(st.config, null, 2) : '';
  const toggle = async () => {
    if (!desktop?.mcpEnable || !st) return;
    setBusy(true);
    try {
      const n = await desktop.mcpEnable(!st.running);
      setSt(n);
      app.log(n.running ? `Connexion IA activée (serveur MCP local, port ${n.port}).` : 'Connexion IA désactivée.');
    } catch (e) {
      setMsg({ text: (e as Error).message, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    const r = await desktop?.mcpInstall?.();
    if (!r || r.canceled) return;
    setMsg(r.ok ? { text: `Configuration ajoutée dans ${r.file} (copie de l’ancien fichier : .avant-xylform.bak). Redémarrez complètement l’assistant IA.`, kind: 'ok' } : { text: r.error ?? 'Échec.', kind: 'bad' });
  };
  const copy = () => {
    void navigator.clipboard?.writeText(config).then(() => setMsg({ text: 'Configuration copiée.', kind: 'ok' }));
  };

  return (
    <Frame title="Connexion IA (serveur MCP)" onClose={onClose} footer={<button onClick={onClose}>Fermer</button>}>
      <p className="modal-message">
        Un assistant IA compatible <b>MCP</b> (Model Context Protocol, protocole ouvert) peut dessiner directement dans Xylform CAD : il exécute des scripts de commandes, lit les dimensions des pièces, regarde une capture de la vue et exporte en STL ou 3MF.
      </p>
      {!desktop?.mcpStatus ? (
        <p className="modal-message">
          La connexion IA demande la <b>version bureau</b> de Xylform CAD. Dans le navigateur, utilisez la commande <code>SCRIPT</code> : copiez la consigne pour l’IA, puis collez le script qu’elle écrit.
        </p>
      ) : !st ? (
        <p className="modal-message">Lecture de l’état…</p>
      ) : (
        <>
          <div className="mcp-state">
            <span className={`mcp-dot ${st.running ? 'on' : ''}`} />
            <span>{st.running ? `Activée — l’assistant peut se connecter (port local ${st.port})` : 'Désactivée'}</span>
            <button className={st.running ? '' : 'primary'} disabled={busy} onClick={() => void toggle()}>
              {st.running ? 'Désactiver' : 'Activer'}
            </button>
          </div>
          <p className="modal-label">1. Activez la connexion (elle le reste aux prochains démarrages).</p>
          <p className="modal-label">2. Déclarez le serveur dans la configuration MCP de l’assistant IA (bloc « mcpServers ») :</p>
          <pre className="mcp-config">{config}</pre>
          <div className="script-buttons">
            <button className="primary" onClick={() => void install()} title="Choisissez le fichier JSON de configuration MCP de l'assistant : l'entrée xylform-cad y est ajoutée (les autres serveurs sont conservés)">
              Ajouter à un fichier de configuration…
            </button>
            <button onClick={copy}>Copier la configuration</button>
          </div>
          {st.portable && <p className="modal-label">Version portable : la configuration lance le pont avec Node.js (à installer s’il ne l’est pas). La version installée n’en a pas besoin.</p>}
          <p className="modal-label">3. Redémarrez l’assistant IA, puis demandez-lui une pièce (« dessine un support d’étagère de 60 mm avec deux trous M4 et exporte-le en STL »). Si Xylform CAD est fermé, il est lancé automatiquement.</p>
          <p className="modal-label">
            Fichiers exportés par l’assistant : <code>{st.outputDir}</code>. Tout script reçu s’annule en une fois (Ctrl+Z).
          </p>
        </>
      )}
      {msg && <p className={`mcp-msg ${msg.kind}`}>{msg.text}</p>}
    </Frame>
  );
}
