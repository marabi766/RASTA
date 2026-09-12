'use client';

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { ScenarioAction, ScenarioDispatchResult, ScenarioSnapshot } from './model';
import { getScenarioStore } from './store';

/**
 * The React binding over the plain `ScenarioStore`.
 *
 * `useSyncExternalStore` rather than `useState`/`useReducer`: the store is
 * the single source of truth and `FixtureGatewayClient` reads it directly,
 * outside React entirely. A component holding its own copy in `useState`
 * would drift from what a GET actually returns the moment a non-React
 * reader dispatched something — `useSyncExternalStore` is exactly the hook
 * React ships for "a component mirrors state that lives somewhere else".
 */

export interface ScenarioValue {
  readonly snapshot: ScenarioSnapshot;
  dispatch(action: ScenarioAction): ScenarioDispatchResult;
  reset(): void;
}

const ScenarioContext = createContext<ScenarioValue | null>(null);

export function ScenarioProvider({ children }: { children: ReactNode }): ReactNode {
  const store = useMemo(() => getScenarioStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const value = useMemo<ScenarioValue>(
    () => ({
      snapshot,
      dispatch: (action) => store.dispatch(action),
      reset: () => store.reset(),
    }),
    [snapshot, store],
  );

  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>;
}

/** Strict: throws when mounted outside `<ScenarioProvider>`, by design. */
export function useScenario(): ScenarioValue {
  const value = useContext(ScenarioContext);
  if (!value) throw new Error('useScenario must be used inside <ScenarioProvider>');
  return value;
}

/**
 * Forgiving: `null` outside the provider.
 *
 * For components that render in both modes — the presentation toolbar shows
 * its reset control only in fixture mode and has to mount either way — the
 * same shape `useOptionalTour` already gives `PresentationToolbar` for the
 * tour.
 */
export function useOptionalScenario(): ScenarioValue | null {
  return useContext(ScenarioContext);
}
