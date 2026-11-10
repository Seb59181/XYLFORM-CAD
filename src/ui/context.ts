import { createContext, useContext, useEffect, useReducer } from 'react';
import type { AppHost, HostEvent } from '../app/AppHost';
import type { Interaction } from '../app/Interaction';

export const AppContext = createContext<AppHost | null>(null);

export function useApp(): AppHost {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppContext manquant');
  return app;
}

/** Re-rend le composant à chaque événement listé de l'hôte. */
export function useHost(events: HostEvent[]): AppHost {
  const app = useApp();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const key = events.join(',');
  useEffect(() => {
    const offs = key.split(',').map((ev) => app.on(ev as HostEvent, bump));
    return () => offs.forEach((o) => o());
  }, [app, key]);
  return app;
}

/** Interaction du viewport (curseur, accrochage, navigation), partagée avec la barre d'état. */
export const InteractionContext = createContext<{ current: Interaction | null; listeners: Set<() => void> }>({ current: null, listeners: new Set() });

export function useInteraction(): Interaction | null {
  const ref = useContext(InteractionContext);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    ref.listeners.add(bump);
    const off = ref.current?.subscribe(bump);
    return () => {
      ref.listeners.delete(bump);
      off?.();
    };
  }, [ref, ref.current]);
  return ref.current;
}
