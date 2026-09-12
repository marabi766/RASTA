/**
 * The interactive fixture scenario engine — public surface.
 *
 * Nothing outside `lib/demo/scenario/` should reach into a specific module
 * here; import from this barrel instead, so an internal reorganisation does
 * not ripple into every caller.
 */
export {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_STAGES,
  PRESENTATION_PERSONAS,
  SCENARIO_DOCUMENT_SCAN_STATES,
  SCENARIO_REJECTION_REASONS,
  type ScenarioStage,
  type PresentationPersona,
  type ScenarioDocumentScanState,
  type ScenarioSnapshot,
  type ScenarioMaintenanceState,
  type ScenarioOfferSelection,
  type ScenarioOrderState,
  type ScenarioWalletState,
  type ScenarioDocumentState,
  type ScenarioActivityLogEntry,
  type ScenarioAction,
  type ScenarioActionType,
  type ScenarioRejectionReason,
  type ScenarioDispatchResult,
} from './model';

export { buildInitialScenarioState } from './initial-state';
export {
  checkInvariants,
  assertInvariants,
  deriveStage,
  ScenarioInvariantError,
} from './invariants';
export { reduceScenario } from './reducer';
export { loadPersistedScenario, persistScenario, clearPersistedScenario } from './persistence';
export { createScenarioStore, getScenarioStore, type ScenarioStore } from './store';
export { ScenarioProvider, useScenario, useOptionalScenario, type ScenarioValue } from './provider';
export {
  projectMaintenanceRequestDetail,
  projectOrder,
  projectOrdersPage,
  projectWallet,
  projectDocumentsPage,
  projectAuditEventsPage,
} from './read-model';
