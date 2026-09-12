import { buildInitialScenarioState } from './initial-state';
import { SCENARIO_SCHEMA_VERSION } from './model';
import { clearPersistedScenario, loadPersistedScenario, persistScenario } from './persistence';

const STORAGE_KEY = `rasta.demo.scenario.v${SCENARIO_SCHEMA_VERSION}`;

describe('session persistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('round-trips a valid snapshot', () => {
    const state = buildInitialScenarioState();
    persistScenario(state);
    expect(loadPersistedScenario()).toEqual(state);
  });

  it('writes under one namespaced, versioned key and nothing else', () => {
    persistScenario(buildInitialScenarioState());
    expect(Object.keys(window.sessionStorage)).toEqual([STORAGE_KEY]);
  });

  it('never touches localStorage', () => {
    persistScenario(buildInitialScenarioState());
    expect(window.localStorage.length).toBe(0);
  });

  it('resets safely from malformed JSON', () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadPersistedScenario()).toBeNull();
  });

  it('resets safely from a value that parses but is not an object', () => {
    window.sessionStorage.setItem(STORAGE_KEY, '"just a string"');
    expect(loadPersistedScenario()).toBeNull();
  });

  it('resets safely from an oversized payload', () => {
    const huge = JSON.stringify({ ...buildInitialScenarioState(), padding: 'x'.repeat(100_000) });
    window.sessionStorage.setItem(STORAGE_KEY, huge);
    expect(loadPersistedScenario()).toBeNull();
  });

  it('resets safely from an unknown schema version', () => {
    const state = { ...buildInitialScenarioState(), schemaVersion: 999 };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadPersistedScenario()).toBeNull();
  });

  it('resets safely from a value that violates an invariant', () => {
    const state = { ...buildInitialScenarioState(), revision: -1 };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadPersistedScenario()).toBeNull();
  });

  it('never executes the stored value as code', () => {
    // If this were ever passed to something like `eval` or `new Function`,
    // the property access below would throw or run. It must do neither.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      '{"schemaVersion":1,"toString":"() => { throw new Error(\'executed\') }"}',
    );
    expect(() => loadPersistedScenario()).not.toThrow();
    expect(loadPersistedScenario()).toBeNull();
  });

  it('refuses a value carrying a token-shaped field', () => {
    const state = { ...buildInitialScenarioState(), accessToken: 'ey.Jhbinotarealtoken' };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadPersistedScenario()).toBeNull();
  });

  it('does not crash when sessionStorage throws (private mode, hardened browser)', () => {
    const original = window.sessionStorage.getItem;
    window.sessionStorage.getItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    try {
      expect(() => loadPersistedScenario()).not.toThrow();
      expect(loadPersistedScenario()).toBeNull();
    } finally {
      window.sessionStorage.getItem = original;
    }
  });

  it('does not crash when persisting throws (quota exceeded)', () => {
    const original = window.sessionStorage.setItem;
    window.sessionStorage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      expect(() => persistScenario(buildInitialScenarioState())).not.toThrow();
    } finally {
      window.sessionStorage.setItem = original;
    }
  });

  it('clears the key on demand', () => {
    persistScenario(buildInitialScenarioState());
    clearPersistedScenario();
    expect(loadPersistedScenario()).toBeNull();
    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });
});
