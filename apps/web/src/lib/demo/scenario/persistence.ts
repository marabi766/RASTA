import { checkInvariants } from './invariants';
import { SCENARIO_SCHEMA_VERSION, type ScenarioSnapshot } from './model';

/**
 * Session-scoped persistence for the interactive scenario.
 *
 * Mirrors `tour-provider.tsx`'s `readStoredTour`/`writeStoredTour` on
 * purpose — same wrapped-in-try/catch shape, same "a closed tab forgets it"
 * guarantee, same refusal to let a storage failure crash the portal. The
 * difference is that a malformed *tour* state degrades to "start of tour";
 * a malformed *scenario* state could otherwise feed a half-built object into
 * the reducer and the read-model, so every read is validated against the
 * same invariants the reducer itself upholds before it is trusted at all.
 */

const STORAGE_KEY = `rasta.demo.scenario.v${SCENARIO_SCHEMA_VERSION}`;

/**
 * A payload larger than this cannot be this engine's own state — the real
 * snapshot is a few hundred bytes even with a full activity log — so it is
 * refused before `JSON.parse` ever sees it.
 */
const MAX_PAYLOAD_BYTES = 32_000;

/**
 * Reads and validates the persisted snapshot.
 *
 * Every failure mode returns `null` rather than throwing: unavailable
 * storage (private browsing, a hardened browser), a payload over the size
 * bound, JSON that does not parse, JSON that parses to something that is not
 * an object, a `schemaVersion` that is not the current one (the versioned
 * storage key already makes this rare — it only matters for a value written
 * by a future version sharing this key), or a value that parses cleanly but
 * fails `checkInvariants`. None of these execute the stored value as code:
 * `JSON.parse` never does, and nothing here calls `eval` or a `Function`
 * constructor.
 */
export function loadPersistedScenario(): ScenarioSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (raw.length > MAX_PAYLOAD_BYTES) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isPlausibleSnapshot(parsed)) return null;
    if (parsed.schemaVersion !== SCENARIO_SCHEMA_VERSION) return null;

    if (checkInvariants(parsed).length > 0) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function persistScenario(state: ScenarioSnapshot): void {
  try {
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_PAYLOAD_BYTES) return;
    window.sessionStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    /* Quota or security exception: the demo continues without persistence. */
  }
}

export function clearPersistedScenario(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to clean up if storage was never reachable. */
  }
}

/**
 * The shallowest possible shape check before handing the value to
 * `checkInvariants`, which assumes its argument already has every field.
 */
function isPlausibleSnapshot(value: unknown): value is ScenarioSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.schemaVersion === 'number' &&
    typeof record.scenarioId === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.clock === 'string' &&
    typeof record.stage === 'string' &&
    typeof record.persona === 'string' &&
    typeof record.organizationId === 'string' &&
    typeof record.assetId === 'string' &&
    typeof record.supplierOrganizationId === 'string' &&
    typeof record.maintenance === 'object' &&
    record.maintenance !== null &&
    typeof record.order === 'object' &&
    record.order !== null &&
    typeof record.wallet === 'object' &&
    record.wallet !== null &&
    Array.isArray(record.documents) &&
    Array.isArray(record.activityLog)
  );
}
