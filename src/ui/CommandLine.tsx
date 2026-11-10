/**
 * Ligne de commande flottante : historique, invite avec options cliquables,
 * autocomplétion des commandes et des options, historique des saisies (↑ ↓).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Keyword } from '../core/commands/types';
import { useHost } from './context';

let inputEl: HTMLInputElement | null = null;

/** Donne le focus à la ligne de commande (frappe au clavier n'importe où). */
export function focusCommandLine(): void {
  inputEl?.focus();
}

export function isCommandLine(el: EventTarget | null): boolean {
  return !!el && el === inputEl;
}

/** Découpe l'invite en texte et options « [A/B/C] » cliquables. */
export function PromptText({ text, keywords, onKeyword }: { text: string; keywords?: Keyword[]; onKeyword: (k: string) => void }) {
  const m = /^(.*?)\[([^\]]+)\](.*)$/s.exec(text);
  if (!m || !keywords?.length) return <span>{text}</span>;
  const tokens = m[2]!.split('/');
  return (
    <span>
      {m[1]}[
      {tokens.map((t, i) => (
        <span key={i}>
          {i > 0 && '/'}
          <span className="kw" onMouseDown={(e) => e.preventDefault()} onClick={() => onKeyword(t)} title={keywords.find((k) => k.local === t)?.description}>
            {t}
          </span>
        </span>
      ))}
      ]{m[3]}
    </span>
  );
}

export function CommandLine() {
  const app = useHost(['log', 'prompt', 'input', 'command']);
  const [expanded, setExpanded] = useState(false);
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const proc = app.processor;
  const spec = app.activeSpec;
  const value = app.input;

  useEffect(() => {
    inputEl = ref.current;
    return () => {
      inputEl = null;
    };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        setExpanded((x) => !x);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    if (histRef.current) histRef.current.scrollTop = histRef.current.scrollHeight;
  }, [app.lines.length, expanded]);

  const suggestions = useMemo(() => (value.trim() ? proc.suggest(value).slice(0, 8) : []), [value, spec, proc]);
  useEffect(() => setSel(-1), [value, spec]);

  const submit = (raw: string) => {
    let text = raw;
    if (proc.isIdle && text.trim() && !text.trim().startsWith("'")) {
      if (!app.registry.resolve(text.trim()) && suggestions.length) text = suggestions[sel >= 0 ? sel : 0]!.insert;
    } else if (sel >= 0 && suggestions[sel]) text = suggestions[sel].insert;
    app.setInput('');
    proc.history.reset();
    proc.submit(text);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || (e.key === ' ' && spec?.kind !== 'string')) {
      e.preventDefault();
      submit(value);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const s = suggestions[sel >= 0 ? sel : 0];
      if (s) app.setInput(s.insert);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length && value.trim()) {
        setSel((i) => (e.key === 'ArrowDown' ? (i + 1) % suggestions.length : (i - 1 + suggestions.length) % suggestions.length));
        return;
      }
      const h = e.key === 'ArrowUp' ? proc.history.previous(value) : proc.history.next();
      if (h !== undefined) app.setInput(h);
    }
  };

  const visible = expanded ? app.lines.slice(-200) : app.lines.slice(-app.settings.historyLines);
  return (
    <div className={`cmdline ${expanded ? 'expanded' : ''}`} onMouseDown={(e) => e.target !== ref.current && e.preventDefault()}>
      <div className="cmd-history" ref={histRef} onClick={() => ref.current?.focus()}>
        {visible.map((l, i) => (
          <div key={app.lines.length - visible.length + i} className={l.startsWith('Commande:') ? 'h-cmd' : l.startsWith('Erreur') || l.startsWith('Commande inconnue') ? 'h-err' : ''}>
            {l}
          </div>
        ))}
      </div>
      {suggestions.length > 0 && (
        <div className="cmd-suggest">
          {suggestions.map((s, i) => (
            <div
              key={s.name + s.insert}
              className={i === sel ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                app.setInput('');
                proc.submit(s.insert);
              }}
            >
              <b>{s.insert}</b>
              {'matchedAlias' in s && s.matchedAlias && <span className="alias">({s.matchedAlias})</span>}
              {s.description && <span className="desc">{s.description}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="cmd-input">
        <button className="cmd-btn" title="Annuler la commande (Échap)" onClick={() => proc.cancel()}>
          ✕
        </button>
        <button className="cmd-btn" title="Historique (F2)" onClick={() => setExpanded(!expanded)}>
          {expanded ? '▾' : '▴'}
        </button>
        <div className="cmd-prompt">
          {spec ? <PromptText text={app.promptText} keywords={spec.keywords} onKeyword={(k) => proc.submit(k)} /> : <span className="idle">Entrez une commande</span>}
        </div>
        <input
          ref={ref}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => app.setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={spec ? '' : 'ex. L, C, BOITE, EXTRUSION…'}
        />
      </div>
    </div>
  );
}
