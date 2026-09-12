import { buildInitialScenarioState } from './initial-state';
import type { ScenarioAction, ScenarioDispatchResult, ScenarioSnapshot } from './model';
import { clearPersistedScenario, loadPersistedScenario, persistScenario } from './persistence';
import { reduceScenario } from './reducer';

/**
 * A plain, framework-agnostic store.
 *
 * Not a React context, deliberately. `FixtureGatewayClient` is not a React
 * component and has no business rendering — it just needs to read the
 * current snapshot when a GET happens to land on a route the read-model
 * projects. Keeping the store framework-agnostic is what lets the non-React
 * reader and the React hook (`provider.tsx`) share one source of truth
 * without either depending on the other.
 */
export interface ScenarioStore {
  getState(): ScenarioSnapshot;
  dispatch(action: ScenarioAction): ScenarioDispatchResult;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createScenarioStore(initialState?: ScenarioSnapshot): ScenarioStore {
  let state = initialState ?? loadPersistedScenario() ?? buildInitialScenarioState();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    getState(): ScenarioSnapshot {
      return state;
    },

    dispatch(action: ScenarioAction): ScenarioDispatchResult {
      const result = reduceScenario(state, action);
      if (result.outcome === 'APPLIED') {
        state = result.state;
        persistScenario(state);
        notify();
      }
      return result;
    },

    reset(): void {
      state = buildInitialScenarioState();
      clearPersistedScenario();
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let singleton: ScenarioStore | null = null;

/**
 * The one store instance this browser tab uses.
 *
 * Created lazily rather than at module load, so importing this module has no
 * side effect until something actually asks for the store — the first real
 * call happens inside the fixture client factory in `fixture-client.ts` or
 * inside `<ScenarioProvider>`, both already gated to fixture mode.
 */
export function getScenarioStore(): ScenarioStore {
  if (!singleton) singleton = createScenarioStore();
  return singleton;
}

/** Test-only: drops the singleton so the next `getScenarioStore()` rebuilds it. */
export function resetScenarioStoreSingletonForTests(): void {
  singleton = null;
}
