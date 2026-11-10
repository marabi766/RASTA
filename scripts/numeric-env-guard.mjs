// FU-292: every allowance identifies a file, field and complete token-normalized expression.
import ts from 'typescript';
import { analyzeNumericEnv, normalized } from './numeric-env-analysis.mjs';

export function readRatchet(source) {
  const literal =
    /^export const FROZEN_RATCHET = Object\.freeze\(\s*JSON\.parse\(`([^`]+)`\),?\s*\);$/m.exec(
      source,
    )?.[1];
  const entries = JSON.parse(literal ?? source);
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        entry.some((part) => typeof part !== 'string' || part.length === 0),
    ) ||
    new Set(entries.map(JSON.stringify)).size !== entries.length
  )
    throw new Error('invalid numeric ratchet');
  return entries;
}

export const FROZEN_RATCHET = Object.freeze(
  JSON.parse(`[
  ["apps/web/src/server/env.ts", "WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( MAX_BOOTABLE_CONSTRUCTION_RETENTION_HOURS ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( MAX_REPLAY_MARGIN_SECONDS ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_CONTRACT_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( 30 * 60 ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_DISPUTE_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( 30 * 60 ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_INVENTORY_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( 30 * 60 ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 1 )"],
  ["apps/web/src/server/env.ts", "WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( Math . max ( MIN_REPLAY_MARGIN_MS / 1000 , PROCUREMENT_MIN_REPLAY_MARGIN_SECONDS ) ) . max ( MAX_REPLAY_MARGIN_SECONDS ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_RETURN_REPLAY_MARGIN_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( 30 * 60 ) . prefault ( 10 * 60 )"],
  ["apps/web/src/server/env.ts", "WEB_SESSION_MAX_AGE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 300 ) . max ( 30 * 24 * 60 * 60 ) . prefault ( 12 * 60 * 60 )"],
  ["services/asset-service/src/config/env.ts", "ASSET_DOCUMENT_LOOKUP_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/asset-service/src/config/env.ts", "ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3_600 ) . prefault ( 120 )"],
  ["services/asset-service/src/config/env.ts", "ASSET_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/asset-service/src/config/env.ts", "ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/asset-service/src/config/env.ts", "ASSET_TRANSFER_FENCE_TTL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3600 ) . prefault ( 600 )"],
  ["services/asset-service/src/config/env.ts", "EXPIRY_WARNING_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 365 ) . prefault ( 30 )"],
  ["services/asset-service/src/config/env.ts", "INSURANCE_CLAIM_MAX_DOCUMENTS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 200 ) . prefault ( 20 )"],
  ["services/audit-service/src/config/env.ts", "AUDIT_MAX_QUERY_WINDOW_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 366 ) . prefault ( DEFAULT_MAX_QUERY_WINDOW_DAYS )"],
  ["services/audit-service/src/config/env.ts", "AUDIT_MAX_VERIFICATION_RECORDS", "z . coerce . number ( ) . int ( ) . min ( 1_000 ) . max ( 5_000_000 ) . prefault ( DEFAULT_MAX_VERIFICATION_RECORDS )"],
  ["services/audit-service/src/config/env.ts", "AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 2_160 ) . prefault ( 168 )"],
  ["services/audit-service/src/config/env.ts", "AUDIT_RFQ_GAP_ALERT_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 300 )"],
  ["services/audit-service/src/config/env.ts", "AUDIT_TENDER_GAP_ALERT_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 300 )"],
  ["services/construction-service/src/config/env.ts", "CONSTRUCTION_BID_MAX_REVISIONS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( EVIDENCE_MAX_CHAIN_LINKS ) . prefault ( 50 )"],
  ["services/construction-service/src/config/env.ts", "CONSTRUCTION_EVALUATION_MAX_EVALUATORS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 9 ) . prefault ( 1 )"],
  ["services/construction-service/src/config/env.ts", "CONSTRUCTION_EVALUATION_MIN_EVALUATORS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 9 ) . prefault ( 1 )"],
  ["services/construction-service/src/config/env.ts", "CONSTRUCTION_TENDER_MAX_RECEIPTS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( EVIDENCE_MAX_CHAIN_LINKS ) . prefault ( EVIDENCE_MAX_CHAIN_LINKS )"],
  ["services/construction-service/src/config/env.ts", "CONSTRUCTION_TENDER_MAX_STANDING_BIDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( TENDER_MAX_STANDING_BIDS_CEILING ) . prefault ( TENDER_MAX_STANDING_BIDS_DEFAULT )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_AWARD_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 60_000 ) . prefault ( 5000 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_CONSUMER_MAX_RETRIES", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 20 ) . prefault ( 5 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_CONSUMER_RETRY_BACKOFF_MS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 60_000 ) . prefault ( 1000 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 900 ) . prefault ( 120 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_MILESTONE_LIMIT", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1000 ) . prefault ( 100 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 60_000 ) . prefault ( 3000 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_RECONCILE_BACKOFF_MAX_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 900 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_RECONCILE_BACKOFF_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 3600 ) . prefault ( 30 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_RECONCILE_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 500 ) . prefault ( 20 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_RECONCILE_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 500 ) . max ( 300_000 ) . prefault ( 5000 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_RECONCILE_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 3600 ) . prefault ( 120 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_SETTLEMENT_RECONCILE_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 500 ) . prefault ( 50 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_SETTLEMENT_RECONCILE_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 10_000 ) . max ( 86_400_000 ) . prefault ( 600_000 )"],
  ["services/contract-service/src/config/env.ts", "CONTRACT_SETTLEMENT_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 5000 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_CLAMAV_PORT", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 65535 ) . prefault ( 3310 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_MAX_BYTES", "z . coerce . number ( ) . int ( ) . min ( 1024 ) . max ( 200 * 1024 * 1024 ) . prefault ( 25 * 1024 * 1024 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 50 ) . prefault ( 5 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_CHUNK_BYTES", "z . coerce . number ( ) . int ( ) . min ( 4_096 ) . max ( 1_048_576 ) . prefault ( 65_536 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 3_600 ) . prefault ( 300 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_MAX_ATTEMPTS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 20 ) . prefault ( 5 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_MAX_BYTES", "z . coerce . number ( ) . int ( ) . min ( 1024 ) . max ( 64 * 1024 * 1024 ) . prefault ( 32 * 1024 * 1024 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_POLL_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 250 ) . max ( 300_000 ) . prefault ( 2_000 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_RETRY_BASE_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 600_000 ) . prefault ( 5_000 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_RETRY_MAX_MS", "z . coerce . number ( ) . int ( ) . min ( 1_000 ) . max ( 3_600_000 ) . prefault ( 300_000 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 8_760 ) . prefault ( 48 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 1_000 ) . max ( 600_000 ) . prefault ( 60_000 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SCAN_VERSION_CACHE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 3_600 ) . prefault ( 60 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_SIGNED_URL_TTL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3600 ) . prefault ( 300 )"],
  ["services/document-service/src/config/env.ts", "DOCUMENT_UPLOAD_INTENT_TTL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 60 ) . max ( 86_400 ) . prefault ( 900 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_BALANCE_AUDIT_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 5000 ) . prefault ( 500 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 86_400 ) . prefault ( 3600 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_MOCK_PAYMENT_LATENCY_MS", "z . coerce . number ( ) . int ( ) . min ( 0 ) . max ( 10_000 ) . prefault ( 0 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_ORGANIZATION_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 60_000 ) . prefault ( 10_000 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 3600 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 60 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 500 ) . prefault ( 20 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 86_400 ) . prefault ( 300 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 5 ) . max ( 3600 ) . prefault ( 60 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 3600 ) . prefault ( 120 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_MAX_AGE_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 720 ) . prefault ( 72 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_PAYMENT_RECONCILER_MAX_ATTEMPTS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 100 ) . prefault ( 12 )"],
  ["services/economic-service/src/config/env.ts", "ECONOMIC_SOURCE_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/fleet-service/src/config/env.ts", "ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS", "z . coerce . number ( ) . int ( ) . min ( 50 ) . max ( 10_000 ) . prefault ( 500 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 1_000 ) . max ( CONSUMER_SESSION_TIMEOUT_MS ) . prefault ( 14_200 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_IDEMPOTENCY_CLAIM_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3_600 ) . prefault ( 120 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_IDENTITY_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_INSURANCE_PARKED_MAX_ATTEMPTS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1_000 ) . prefault ( 12 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 86_400 ) . prefault ( 300 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_INSURANCE_PARKED_SWEEP_BATCH", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1_000 ) . prefault ( 50 )"],
  ["services/fleet-service/src/config/env.ts", "FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 5 ) . max ( 3_600 ) . prefault ( 60 )"],
  ["services/fleet-service/src/config/env.ts", "UTILIZATION_AVAILABLE_HOURS_PER_DAY", "z . coerce . number ( ) . min ( 1 ) . max ( 24 ) . prefault ( 8 )"],
  ["services/fleet-service/src/config/env.ts", "UTILIZATION_DEFAULT_WINDOW_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 365 ) . prefault ( 30 )"],
  ["services/identity-service/src/config/env.ts", "AUDIT_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/identity-service/src/config/env.ts", "KEYCLOAK_WRITE_SETTLE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 15 ) . max ( 900 ) . prefault ( 120 )"],
  ["services/identity-service/src/config/env.ts", "MEMBERSHIP_EXPIRY_SCAN_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1000 ) . prefault ( 200 )"],
  ["services/identity-service/src/config/env.ts", "MEMBERSHIP_EXPIRY_SCAN_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 5 ) . max ( 3600 ) . prefault ( 60 )"],
  ["services/identity-service/src/config/env.ts", "REGISTRATION_INTAKE_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1000 ) . prefault ( 50 )"],
  ["services/identity-service/src/config/env.ts", "REGISTRATION_INTAKE_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 3600 ) . prefault ( 5 )"],
  ["services/identity-service/src/config/env.ts", "SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS", "z . coerce . number ( ) . int ( ) . min ( AGGREGATION_WINDOW_SECONDS . MIN ) . max ( AGGREGATION_WINDOW_SECONDS . MAX ) . prefault ( AGGREGATION_WINDOW_SECONDS . DEFAULT )"],
  ["services/identity-service/src/config/env.ts", "SECURITY_EVENT_CAPTURE_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 5000 ) . prefault ( 250 )"],
  ["services/identity-service/src/config/env.ts", "SECURITY_EVENT_FLUSH_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1000 ) . prefault ( 100 )"],
  ["services/identity-service/src/config/env.ts", "SECURITY_EVENT_FLUSH_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 50 ) . max ( 60_000 ) . prefault ( 1000 )"],
  ["services/maintenance-service/src/config/env.ts", "ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 3000 )"],
  ["services/maintenance-service/src/config/env.ts", "MAINTENANCE_DUE_SCAN_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 1000 ) . prefault ( 200 )"],
  ["services/maintenance-service/src/config/env.ts", "MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 86_400 ) . prefault ( 900 )"],
  ["services/maintenance-service/src/config/env.ts", "MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3_600 ) . prefault ( 120 )"],
  ["services/maintenance-service/src/config/env.ts", "MAINTENANCE_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/marketplace-service/src/config/env.ts", "ECONOMIC_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 500 ) . max ( 60_000 ) . prefault ( 10_000 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_FULFILLMENT_WINDOW_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 365 ) . prefault ( 7 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 30 ) . max ( 3_600 ) . prefault ( 60 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_IDEMPOTENCY_TTL_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_INVENTORY_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 30_000 ) . prefault ( 2_000 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_ORGANIZATION_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( ORGANIZATION_REQUEST_CEILING_MS ) . prefault ( 2_000 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_RECEIPT_WINDOW_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 365 ) . prefault ( 3 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_REMINDER_INTERVAL_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 90 ) . prefault ( 3 )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_RETURN_WINDOW_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 730 ) . optional ( )"],
  ["services/marketplace-service/src/config/env.ts", "MARKETPLACE_SAGA_RECHECK_HOURS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 168 ) . prefault ( 24 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_DEDUPE_RETENTION_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 3_650 ) . prefault ( 45 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_IDENTITY_REQUEST_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 500 ) . max ( 60_000 ) . prefault ( 5_000 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_IN_APP_TTL_DAYS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 3_650 ) . prefault ( 60 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_MAIL_BACKOFF_MAX_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 600 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_MAIL_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 100 ) . prefault ( 10 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_MAIL_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 3_600 ) . prefault ( 120 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_MAIL_POLL_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 60_000 ) . prefault ( 2_000 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_MAX_RECIPIENTS_PER_INTENT", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 10_000 ) . prefault ( 500 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_RESOLUTION_BACKOFF_MAX_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 86_400 ) . prefault ( 600 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_RESOLUTION_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 500 ) . prefault ( 20 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_RESOLUTION_LEASE_SECONDS", "z . coerce . number ( ) . int ( ) . min ( 10 ) . max ( 3_600 ) . prefault ( 60 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 60_000 ) . prefault ( 1_000 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_SMTP_PORT", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 65_535 ) . prefault ( 1025 )"],
  ["services/notification-service/src/config/env.ts", "NOTIFICATION_SMTP_TIMEOUT_MS", "z . coerce . number ( ) . int ( ) . min ( 100 ) . max ( 120_000 ) . prefault ( 10_000 )"],
  ["services/organization-service/src/config/env.ts", "MAX_HIERARCHY_DEPTH", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( 20 ) . prefault ( 8 )"],
  ["services/procurement-service/src/config/env.ts", "PROCUREMENT_AGGREGATION_MIN_QUANTITY", "z . coerce . number ( ) . int ( ) . min ( 0 ) . max ( 2_147_483_647 ) . prefault ( 0 )"],
  ["services/procurement-service/src/config/env.ts", "PROCUREMENT_QUOTATION_MAX_REVISIONS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( MAX_QUOTATION_REVISIONS_LIMIT ) . prefault ( 10 )"],
  ["services/procurement-service/src/config/env.ts", "PROCUREMENT_RFQ_MAX_INVITEES", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( MAX_INVITEES_LIMIT ) . prefault ( 200 )"],
  ["services/procurement-service/src/config/env.ts", "PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( MAX_FOLLOW_BATCH_SIZE ) . prefault ( 2000 )"],
  ["services/procurement-service/src/config/env.ts", "PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS", "z . coerce . number ( ) . int ( ) . min ( 1 ) . max ( MAX_LIVE_DEMANDS_LIMIT ) . prefault ( DEFAULT_MAX_LIVE_DEMANDS )"]
]`),
);

export function ratchetGrowth(current, previous) {
  const allowed = new Set(readRatchet(JSON.stringify(previous)).map(JSON.stringify));
  return readRatchet(JSON.stringify(current)).filter(
    (entry) => !allowed.has(JSON.stringify(entry)),
  );
}

export function checkNumericEnv(root, files, ratchet = FROZEN_RATCHET, roots) {
  const result = analyzeNumericEnv(root, files, roots);
  const remaining = new Set(readRatchet(JSON.stringify(ratchet)).map(JSON.stringify));
  const errors = [...result.errors];
  for (const { fingerprint, kind } of result.sites) {
    const id = JSON.stringify(fingerprint);
    if (kind !== 'coerce.number' || !remaining.delete(id))
      errors.push(`unratcheted numeric conversion ${id}`);
  }
  for (const id of remaining) errors.push(`stale numeric ratchet ${id}`);
  return { ...result, errors };
}

// One-time migration from the reviewed count ratchet. Read AST/data from the
// verified git base, never execute its guard. Counts must still match exactly;
// web's thirteen explicitly approved sites are the only added baseline scope.
export function bootstrapRatchet(guardSource, files) {
  const json =
    /^export const FROZEN_RATCHET = Object\.freeze\(\s*JSON\.parse\(`([^`]+)`\),?\s*\);$/m.exec(
      guardSource,
    )?.[1];
  if (!json) throw new Error('invalid old numeric ratchet');
  const counts = JSON.parse(json);
  const entries = [];
  const expected = new Map(
    Object.entries(counts).map(([service, count]) => [
      `services/${service}/src/config/env.ts`,
      count,
    ]),
  );
  expected.set('apps/web/src/server/env.ts', 13);
  for (const [file, count] of expected) {
    if (!Number.isSafeInteger(count) || count < 1 || !files.has(file))
      throw new Error('invalid baseline source/count');
    const tree = ts.createSourceFile(file, files.get(file), ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length) throw new Error('unreadable baseline source');
    const found = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && normalized(node.expression) === 'z . coerce . number') {
        let field = node;
        while (field && !ts.isPropertyAssignment(field)) field = field.parent;
        if (!field || !ts.isIdentifier(field.name)) throw new Error('unknown baseline field');
        found.push([file, field.name.text, normalized(field.initializer)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (found.length !== count) throw new Error(`baseline count mismatch ${file}`);
    entries.push(...found);
  }
  return readRatchet(JSON.stringify(entries));
}
