// -----------------------------------------------------------------------------
// What each service's migration chain must leave behind, and the SQL that
// checks it.
//
// Extracted from `verify-migration-reversible.mjs` for the same reason
// `verify-outbox-b1-lib.mjs` and `ci-image-matrix-lib.mjs` exist: the verifier
// is a CLI that does its work at import time, so nothing inside it can be
// unit-tested in place. Everything here is a pure function of constants, the
// verifier imports it, and `verify-migration-reversible-lib.test.mjs` exercises
// the same code the verifier runs rather than a copy of it.
//
// The split is along one line: this file is *what is expected*, the CLI is
// *how it is executed*.
// -----------------------------------------------------------------------------

/**
 * A cancelled-before-hold order, as the running service writes one.
 *
 * Every column the other CHECK constraints demand is populated, because a row
 * that only satisfies the constraint under test would not prove anything about
 * a real database: it has to be an order the service could genuinely have
 * produced.
 *
 * `cancellation_cause` is filled in for a `CANCELLED` row (never for
 * `FUNDS_HELD`, which this helper also produces at the last step below) so
 * that `ck_order_cancelled_has_cause` — added later by
 * `20260917192908_supplier_performance_signals` and, unlike
 * `ck_order_held_has_transaction`, not the constraint this probe exists to
 * test — never fires here and is mistaken for it.
 */
export const CANCELLED_BEFORE_HOLD = (id, status = 'CANCELLED') => `
INSERT INTO "order" (
  "id", "organization_id", "supplier_organization_id", "placed_by", "status",
  "total_amount_minor", "currency", "economic_transaction_id",
  "idempotency_key", "correlation_id",
  "cancelled_at", "cancellation_reason", "cancellation_cause",
  "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-BUYER', 'ORG-MIGCHECK-SUPPLIER', 'USR-MIGCHECK', '${status}',
  250000, 'IRR', NULL,
  'KEY-${id}', 'COR-${id}',
  NOW(), 'cancelled before the saga created the obligation',
  ${status === 'CANCELLED' ? `'BUYER'` : 'NULL'},
  'USR-MIGCHECK', NOW()
);`;

/**
 * The rollback of `20260830103500_cancel_before_hold`, run against data only
 * the migration it reverses permits.
 *
 * The whole-chain reversal below cannot test this. It runs every `down.sql` in
 * order against a schema that was created seconds earlier and holds no rows, so
 * a down script that works on an empty table and fails on a real one passes it
 * — and a constraint-restoring rollback is exactly the kind that does. This
 * one restores a *narrower* CHECK, which PostgreSQL validates against every
 * existing row unless told otherwise.
 *
 * The step that matters is `down` itself succeeding. With a plain
 * `ADD CONSTRAINT`, it aborts here with a constraint violation naming the
 * seeded order, and the rollback is left part-applied.
 */
export const MARKETPLACE_DATA_ROLLBACK = {
  migration: '20260830103500_cancel_before_hold',
  label: 'a cancellation that happened before the hold',
  steps: [
    {
      label: 'seed: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_BEFORE'),
    },
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, which would destroy the evidence this probe exists to check.
      label: 'down: the rollback succeeds with that order in the table',
      runDownScript: true,
    },
    {
      label: 'down: the order is still there, unaltered',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL
             AND cancellation_reason = 'cancelled before the saga created the obligation';
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the rollback did not preserve the cancelled-before-hold order (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'down: the restored constraint still refuses a new violating insert',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      // NOT VALID skips existing rows; it does not skip updates to them.
      // PostgreSQL checks the new row version, so a surviving row cannot be
      // edited into staying violating.
      label: 'down: the restored constraint still checks an update to the surviving row',
      sql: `UPDATE "order" SET cancellation_reason = 'edited'
             WHERE id = 'ORD_MIGCHECK_BEFORE';`,
      mustFail: 'ck_order_held_has_transaction',
    },
    { label: 'up again: the forward migration re-applies over the surviving order', reapply: true },
    {
      label: 'up again: the order survived the whole round trip',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION 'the order did not survive down → up (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
    },
    {
      // The constraint is genuinely restored and not merely absent: a status
      // that does hold money is still required to name a transaction.
      label: 'up again: the widened constraint is not vacuous',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_HELD', 'FUNDS_HELD'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      label: 'clean up the probe rows',
      sql: `DELETE FROM "order" WHERE id LIKE 'ORD_MIGCHECK%';`,
    },
  ],
};

/**
 * An infected document as the **init** schema permitted one: no quarantine
 * record, because the columns did not exist yet.
 *
 * Every column the init CHECK constraints demand is populated, so the row is
 * one the service of that era could genuinely have written.
 */
export const INFECTED_WITHOUT_QUARANTINE = (id) => `
INSERT INTO "document" (
  "id", "organization_id", "object_key", "document_class", "status",
  "content_type", "size_bytes", "filename",
  "scan_state", "scan_engine", "scan_version", "scan_signature", "scanned_at",
  "upload_intent_id", "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-DOC', 'ORG-MIGCHECK-DOC/CONTRACT/${id}', 'CONTRACT', 'REGISTERED',
  'application/pdf', 4096, 'infected.pdf',
  'INFECTED', 'clamav', '1.5.4', 'Eicar-Test-Signature', NOW(),
  'UPI_MIGCHECK_${id}', 'USR-MIGCHECK', NOW()
);`;

/**
 * The forward migration applied over data the schema it upgrades allowed.
 *
 * `ck_document_infected_is_quarantined` is validated against every existing
 * row the moment it is added, and the init schema permitted an `INFECTED`
 * document with no quarantine record. Nothing ever produced one — the only
 * scanner was a stub that inspects nothing — but "no deployment happens to
 * hold that row" is a different claim from "this migration is safe", and the
 * difference only surfaces on the deployment that does hold one.
 *
 * The whole-chain reversal below cannot test this. It runs against a schema
 * created seconds earlier holding no rows, so a forward migration that works
 * on an empty table and aborts halfway on a populated one passes it — leaving
 * the columns added and the constraints missing, which is the worst of the
 * three possible outcomes.
 *
 * The steps run in the order the harness executes them: roll this migration
 * back to the init schema, seed the row that schema allowed, re-apply, and
 * assert the row came back **quarantined** rather than merely surviving.
 */
export const DOCUMENT_DATA_ROLLBACK = {
  migration: '20260831180000_document_scan_lifecycle',
  label: 'an infected document registered before quarantine was recorded',
  steps: [
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, and this probe needs the init schema still standing.
      label: 'down: the rollback succeeds and leaves the init schema behind',
      runDownScript: true,
    },
    {
      label: 'down: the init schema accepts an infected document with no quarantine',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_INFECTED'),
    },
    { label: 'up again: the forward migration applies over that row', reapply: true },
    {
      label: 'up again: the row survived and was quarantined rather than left mid-policy',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "document"
           WHERE id = 'DOC_MIGCHECK_INFECTED'
             AND scan_state = 'INFECTED'
             AND scan_signature = 'Eicar-Test-Signature'
             AND quarantined_at IS NOT NULL
             AND quarantine_reason IS NOT NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the infected document was not carried through and quarantined (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: a new infected document with no quarantine is refused',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_REFUSED'),
      mustFail: 'ck_document_infected_is_quarantined',
    },
    {
      label: 'up again: a worker lease cannot be attached to a document that is not pending',
      sql: `UPDATE "document" SET scan_lease_owner = 'worker-1',
              scan_lease_expires_at = NOW() + INTERVAL '1 minute'
             WHERE id = 'DOC_MIGCHECK_INFECTED';`,
      mustFail: 'ck_document_scan_lease_only_when_pending',
    },
    {
      label: 'cleanup: the probe rows are removed before the chain reversal',
      sql: `DELETE FROM "document" WHERE id LIKE 'DOC_MIGCHECK_%';`,
    },
  ],
};

/**
 * What each service's schema must contain after `up`, and must not contain
 * after `down`.
 *
 * Named objects rather than "some tables exist", because the objects listed
 * here are the ones that carry the invariants: an immutability trigger that
 * the down script drops but the forward migration forgets to recreate would
 * leave a ledger that is append-only in name only.
 *
 * `dataRollback` is optional and describes a rollback that has to be tested
 * against **rows**, not just against an empty schema.
 */
export const EXPECTED = {
  /**
   * audit-service, registered here the moment it had a real migration to
   * verify and not before.
   *
   * PR #38 deliberately left it out: `verify-migration-reversible.mjs` refuses
   * a service with no `EXPECTED` entry, and the only ways to make it pass then
   * were an empty entry that succeeds vacuously or a fabricated migration.
   * This is the entry that debt was waiting for.
   *
   * The tables list names every partition, not just the parent. `DROP TABLE
   * audit_event` would take all nineteen with it, so a down script that
   * dropped only the parent would still pass a parent-only check while leaving
   * nothing behind to notice — and, more to the point, a *forward* migration
   * that quietly stopped creating `audit_event_2028_02` would go unseen. The
   * eighteen months plus DEFAULT are the capacity claim ADR-053 § 11 makes, so
   * they are the thing asserted.
   *
   * The triggers list carries both halves of the append-only control, and the
   * second one is not redundant. PostgreSQL clones a row-level BEFORE UPDATE
   * OR DELETE trigger to every partition but does **not** clone a
   * statement-level BEFORE TRUNCATE trigger, so `audit_event_append_only`
   * alone leaves `TRUNCATE audit_event_2026_09` working. Both names must
   * survive a down/up cycle or the store is append-only in name only.
   *
   * The constraints are the ones that make a row evidence rather than a shape:
   * a blank source event id is not an idempotency key, a blank correlation id
   * joins to nothing, and `audit_event_changes_is_array` is what stops a
   * future writer putting a raw object where ADR-053 § 5 requires a bounded
   * array of redacted deltas.
   *
   * AUD-003 adds the chain head, and with it the two object kinds this list
   * could not express before. `audit_event_chain_idx` is the order the
   * verification walk reads in: without it the walk still returns the right
   * answer and does so by sequential scan over a month's partition, which is a
   * regression nothing else here would notice. `audit_chain_scope` is the
   * discriminator that keeps the platform chain from colliding with a tenant's;
   * a down script that dropped its table but left the type behind would leave
   * the second `up` to fail on a name that already exists.
   */
  audit: {
    tables: [
      'audit_event',
      'audit_event_2026_09',
      'audit_event_2026_10',
      'audit_event_2026_11',
      'audit_event_2026_12',
      'audit_event_2027_01',
      'audit_event_2027_02',
      'audit_event_2027_03',
      'audit_event_2027_04',
      'audit_event_2027_05',
      'audit_event_2027_06',
      'audit_event_2027_07',
      'audit_event_2027_08',
      'audit_event_2027_09',
      'audit_event_2027_10',
      'audit_event_2027_11',
      'audit_event_2027_12',
      'audit_event_2028_01',
      'audit_event_2028_02',
      'audit_event_default',
      'processed_event',
      'organization_ref',
      // AUD-003. The chain's tip, and the one object in this service the
      // runtime role may UPDATE.
      'audit_chain_head',
    ],
    triggers: [
      'audit_event_append_only',
      'audit_event_append_only_truncate',
      // AUD-003, and the same asymmetry as above: the row-level trigger is what
      // refuses a rewind, a re-key and a multi-record advance, and it never
      // sees a TRUNCATE. Both names or the head is forward-only in name only.
      'audit_chain_head_forward_only',
      'audit_chain_head_no_truncate',
    ],
    indexes: [
      // Verification walks one chain in `sequence_no` order within a partition.
      'audit_event_chain_idx',
      // "Which chains does this month hold" — the parent index, not a clone.
      'audit_chain_head_month_idx',
      // AUD-003's correction half: the access path for `correctedBy`. Every
      // read publishes both directions of a correction link, and the reverse
      // direction is "which later rows name this one" — an index probe per
      // partition with this, a scan of every partition since the target
      // without it. It is listed for a second reason too: its migration adds
      // one index and nothing else, so an inventory that does not name it
      // makes that whole migration invisible to the up → down → up proof.
      'audit_event_correction_idx',
    ],
    types: ['audit_chain_scope'],
    // The two trigger functions, named separately from the triggers that call
    // them. A `DROP TRIGGER` without the matching `DROP FUNCTION` leaves a
    // `refuse_*()` behind that the second `up` then fails to `CREATE`, and a
    // `DROP FUNCTION` the forward migration forgets to restore leaves a trigger
    // definition pointing at nothing -- which PostgreSQL refuses to create, so
    // the rollback and the re-apply are the only place either shows up.
    functions: ['refuse_mutation', 'refuse_chain_head_regression'],
    constraints: [
      'audit_event_source_event_id_not_blank',
      'audit_event_source_topic_not_blank',
      'audit_event_correlation_id_not_blank',
      'audit_event_occurrence_count_positive',
      'audit_event_changes_is_array',
      // AUD-002. The hierarchy projection is what `UNION_ADMIN` scoping is
      // decided from, so its integrity rules are listed for the same reason the
      // evidence table's are: a rollback that dropped them while the forward
      // migration forgot to restore them would leave a projection that can hold
      // a self-parented row -- a cycle the subtree walk would meet -- and a
      // PROJECTED row with no observation behind it, which accepts every stale
      // event that arrives after it.
      'organization_ref_parent_not_self',
      'organization_ref_projected_has_observation',
      'organization_ref_parent_not_blank',
      // AUD-003. Each of these is a rule that stops the head from describing a
      // chain nothing could produce, and each is invisible to a table-only
      // check: the scope shape is what makes "one head per tenant-or-platform
      // month" structural rather than conventional; the state rule refuses a
      // head that claims a length but names no record, which the next writer
      // would read as an empty chain and silently restart; the two segment
      // rules stop the recorded boundary between pre-chain legacy and removed
      // links from being placed after the record it opens; and the digest
      // length rule stops a short hash from being stored as if it were SHA-256.
      'audit_chain_head_scope_shape',
      'audit_chain_head_month_is_first_day',
      'audit_chain_head_state',
      'audit_chain_head_segment_start_ordered',
      'audit_chain_head_single_record_segment',
      'audit_chain_head_hash_is_sha256',
    ],
  },
  /**
   * notification-service, registered the moment it had a real migration to
   * verify and not before (ADR-053 plan, Step Zero: a vacuous entry is worse
   * than none).
   *
   * The constraints listed are ADR-054 § 4's delivery invariants made
   * structural, plus the two the semantic dedupe and the claim worker rest on.
   * `ck_delivery_suppressed_shape` is what makes "suppression is a decision,
   * not a failure" true of the row; `ux_delivery_intent_user_channel` is
   * invariant 6, the last line against a replayed consumer; and
   * `ck_in_app_action_path_relative` is the open-redirect refusal ADR § 10
   * wants at the database, not only in a DTO. A down script that dropped any
   * of them while the forward migration forgot to restore it would leave a
   * delivery table that enforces nothing while looking untouched.
   *
   * `notification_dedupe_intent_id_fkey` is listed by name for a reason the
   * others are not: it is the one foreign key hand-written after Prisma's
   * block, because it must be DEFERRABLE INITIALLY DEFERRED for the consumer's
   * single-statement dedupe decision to precede the intent row. A forward
   * migration that recreated it as an immediate constraint would pass a
   * table-only check and break every ingest.
   *
   * The trigger and its function are named separately, for the same reason
   * audit's are: a `DROP TRIGGER` without the matching `DROP FUNCTION` leaves a
   * `refuse_attempt_update()` behind that the second `up` then fails to CREATE.
   */
  notification: {
    tables: [
      'processed_event',
      'notification_intent',
      'notification_dedupe',
      'recipient_resolution',
      'notification_delivery',
      'delivery_attempt',
      'in_app_notification',
      // NTF-003.
      'notification_preference',
      // NTF-004. The templates the email channel renders from, their immutable
      // published versions, and the quiet window a delivery defers into.
      'notification_template',
      'notification_template_version',
      'notification_quiet_hours',
      // The outbox arrived with NTF-002's audit events. Before them this
      // service consumed and never produced, so it had none — which is the
      // deviation ADR-054 § 3 recorded against AGENTS.md S-06. Listed here so
      // a down script that forgot to drop them, or a forward migration that
      // forgot to recreate them, fails the round trip rather than a review.
      'outbox_message',
      'outbox_stream_sequence',
    ],
    // NTF-002 adds the second pair: read state is write-once. The trigger and
    // its function are named separately for the same reason as the first pair.
    triggers: [
      'delivery_attempt_append_only',
      'in_app_notification_state_write_once',
      // NTF-004. A published template version is immutable; editing means
      // publishing a new version, because a delivery cites `(key, version)`.
      'trg_template_version_immutable',
    ],
    functions: [
      'refuse_attempt_update',
      'refuse_in_app_state_regression',
      'notification_template_version_immutable',
    ],
    indexes: [
      'ix_intent_claimable',
      'ix_in_app_unread',
      'ux_delivery_intent_user_channel',
      // NTF-003. The partial unique index is the half of the uniqueness rule
      // the composite one cannot express, because PostgreSQL treats NULLs as
      // distinct: without it two GLOBAL rows for one channel are both legal and
      // the winning layer depends on row order.
      'ux_preference_global_channel',
      // NTF-004. The predicate the mail worker claims on. Without it the
      // sweep is a sequential scan of every delivery this service has ever
      // written, most of which are in-app rows it will never send.
      'ix_delivery_sendable',
    ],
    types: [
      'preference_scope',
      'notification_severity',
      'notification_classification',
      'intent_status',
      'resolution_source',
      'notification_channel',
      'delivery_status',
      'attempt_outcome',
    ],
    // NTF-004 widened `notification_channel` with `EMAIL`, and the down script
    // has to rebuild the type to take it away again. A type-name check cannot
    // see that; this can.
    enumValues: [['notification_channel', 'EMAIL']],
    constraints: [
      'notification_dedupe_intent_id_fkey',
      'ck_intent_terminal_reason',
      'ck_intent_dispatched_is_resolved',
      'ck_intent_claim_triple',
      'ck_intent_claim_only_when_pending',
      'ck_intent_attempts_nonneg',
      'ck_intent_dedupe_key_is_sha256',
      'ck_dedupe_seen_count_positive',
      'ck_dedupe_window_ordered',
      'ck_delivery_suppressed_shape',
      'ck_delivery_sent_has_timestamp',
      'ck_delivery_dead_exhausted',
      'ck_delivery_attempts_bounded',
      'ck_delivery_next_attempt_only_when_open',
      'ck_attempt_no_positive',
      'ck_attempt_ordered',
      'ck_attempt_error_class_shape',
      'ck_in_app_dismiss_implies_read',
      'ck_in_app_action_path_relative',
      'ck_in_app_text_not_blank',
      'ck_in_app_expires_after_created',
      // NTF-003. `ck_preference_scope_key_shape` is what keeps a GLOBAL row
      // from carrying a key, or a RULE row from lacking one — either of which
      // would sit in the unique index under a shape the ladder never looks for.
      'ck_preference_scope_key_shape',
      // The outbox's own invariants, listed for the same reason supplier's are:
      // this is the gate that verifies them. `verify-outbox-claim-migration.mjs`
      // addresses migrations by name and this service's outbox arrived in one of
      // its own (`20260919060000_notification_outbox`), so that verifier defers
      // here — and a claim triple or a published-row rule that a down script
      // dropped and a forward migration forgot would otherwise be invisible.
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_published_is_clean',
      'ck_outbox_next_attempt_requires_failure',
    ],
  },
  economic: {
    tables: ['wallet', 'ledger_account', 'journal', 'ledger_entry', 'transaction', 'settlement'],
    triggers: ['trg_ledger_entry_immutable', 'trg_journal_immutable', 'trg_journal_balanced'],
    constraints: ['ck_wallet_balances'],
    // One obligation per business fact per payer. A down script that dropped
    // it without the forward migration restoring it would bring back the
    // double-settlement race it closes, silently.
    indexes: ['ux_transaction_source_fact'],
  },
  /**
   * The constraints listed are the ones carrying a financial invariant, not a
   * sample: `ck_order_settled_after_receipt` is what makes "no settlement
   * without a recorded confirmation" true of the *row* as well as of the state
   * machine, and a down script that dropped it without the forward migration
   * restoring it would leave an order table that enforces nothing.
   */
  marketplace: {
    /**
     * The init migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and its
     * down script deliberately leaves it: the bootstrap installs pg_trgm into
     * template1 for every database, so dropping it could remove an extension
     * the migration did not add (its header explains). Leaving it installed is
     * the one extension difference this rollback may make.
     */
    keptExtensions: {
      '20260829185748_init_marketplace': ['pg_trgm'],
    },
    /**
     * The one documented exception to "down.sql is the exact inverse".
     *
     * `20260830103500_cancel_before_hold/down.sql` restores the narrower
     * `ck_order_held_has_transaction` as `NOT VALID`, on purpose: by the time
     * anyone rolls it back the table may hold cancelled-before-hold orders only
     * the widened rule allowed, and validating would abort the rollback or
     * force someone to delete or falsify real orders (its header explains).
     * Same predicate, enforced on every write; only the retroactive claim
     * differs. Exactly this difference is allowed — nothing else, and if it
     * ever stops occurring the allowance itself fails.
     */
    inexactInverse: {
      '20260830103500_cancel_before_hold': {
        missing: [
          `constraint order.ck_order_held_has_transaction CHECK (((status = ANY (ARRAY['PENDING'::"OrderStatus", 'FAILED'::"OrderStatus"])) OR (economic_transaction_id IS NOT NULL))) deferrable=false/false valid=true`,
        ],
        unexpected: [
          `constraint order.ck_order_held_has_transaction CHECK (((status = ANY (ARRAY['PENDING'::"OrderStatus", 'FAILED'::"OrderStatus"])) OR (economic_transaction_id IS NOT NULL))) NOT VALID deferrable=false/false valid=false`,
        ],
      },
    },
    tables: ['product', 'offer', 'order', 'order_line', 'fulfillment', 'order_status_history'],
    triggers: [],
    constraints: [
      'ck_order_settled_after_receipt',
      'ck_order_completed_has_settlement',
      'ck_order_line_total_consistent',
      'ck_offer_available_non_negative',
      // Added by 20260917192908_supplier_performance_signals (ADR-052 § 1-b,
      // 1-c). Each keeps a structured attribution from ever being silently
      // absent once the row reaches the state that requires one — the same
      // shape as the constraints above, for a fact this step introduces
      // rather than one the init migration already carried.
      'ck_order_cancelled_has_cause',
      'ck_dispute_resolved_has_responsibility',
    ],
    types: ['ResponsibilityAttribution'],
    dataRollback: MARKETPLACE_DATA_ROLLBACK,
  },
  /**
   * The constraints listed carry the claims a reader would otherwise have to
   * take on trust.
   *
   * `ck_document_scan_attributable` is what makes "we know which engine said
   * this" true of the row: any state but `PENDING` must name an engine and a
   * time. `ck_document_signature_only_when_infected` stops a clean document
   * from carrying a signature a consumer would act on.
   * `ck_document_deleted_has_actor` is the tombstone rule — a deletion with no
   * actor, time or reason is not an audit record. A down script that dropped
   * any of them without the forward migration restoring it would leave a
   * document table that enforces nothing while looking untouched.
   */
  document: {
    tables: ['upload_intent', 'document', 'access_grant', 'outbox_message'],
    triggers: [],
    constraints: [
      'ck_document_scan_attributable',
      'ck_document_signature_only_when_infected',
      'ck_document_deleted_has_actor',
      'ck_document_size_positive',
      'ck_document_owner_reference_complete',
      'ck_upload_intent_consumed_complete',
      'ck_grant_revoked_has_actor',
      // Added by 20260831180000_document_scan_lifecycle (ADR-049). The first
      // two are the quarantine policy expressed as a rule the database keeps:
      // an infection is held, and a hold belongs to an infection. The third
      // stops a FAILED scan from being undiagnosable, and the last two stop a
      // worker lease from outliving the work it claims.
      'ck_document_quarantine_complete',
      'ck_document_infected_is_quarantined',
      'ck_document_failure_reason_only_when_failed',
      'ck_document_scan_lease_complete',
      'ck_document_scan_lease_only_when_pending',
    ],
    dataRollback: DOCUMENT_DATA_ROLLBACK,
  },
  /**
   * supplier-service, and the reason it is verified **here** rather than by the
   * outbox verifiers.
   *
   * This service ships one initial migration that folds the domain schema,
   * ADR-050's durable claim and ADR-051 Phase B1 together, because it had no
   * previous deployed state to stay compatible with.
   * `verify-outbox-claim-migration.mjs` and `verify-outbox-b1-lib.test.mjs`
   * both address migrations *by name* — five separately named files — so adding
   * `supplier` to their service lists does not weaken them, it makes them throw
   * `20260902120000_outbox_durable_claim/migration.sql is missing`. They are
   * left alone deliberately, and each now carries an explicit exclusion entry
   * naming this service so the omission is a recorded decision rather than a
   * service nobody noticed was unverified.
   *
   * That means the outbox objects have to be verified somewhere, and this is
   * that somewhere: the constraint list below carries ADR-050's claim triple
   * and the published-row rule alongside the domain invariants, so a down
   * script that dropped any of them without the forward migration restoring it
   * fails here.
   *
   * The domain constraints listed are the ones carrying a claim a reader would
   * otherwise take on trust. `ck_qualification_decision_complete` is what makes
   * "a decision names its actor and its time" true of the row rather than of
   * the service that happens to write it; `ck_qualification_decided_after_submitted`
   * and `ck_suspension_reinstated_after_suspended` are what stop a decision from
   * predating the thing it decides.
   */
  supplier: {
    tables: [
      'supplier',
      'supplier_capability',
      'qualification',
      'qualification_evidence',
      'suspension',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      // ADR-052 step 2: the platform-wide performance formula.
      'performance_formula_version',
      'performance_formula_weight',
    ],
    // ADR-052 step 2. The freeze, the no-truncate pair, the deferred 100% sum
    // and the successor rule. A round trip that lost any one of them would
    // leave a formula table that accepts exactly the edit it exists to refuse.
    triggers: [
      'trg_performance_formula_version_guard',
      'trg_performance_formula_version_no_truncate',
      'trg_performance_formula_weight_guard',
      'trg_performance_formula_weight_no_truncate',
      'trg_performance_formula_weight_sum',
      'trg_performance_formula_version_sum',
      'trg_performance_formula_successor',
    ],
    functions: [
      'performance_formula_version_guard',
      'performance_formula_weight_guard',
      'performance_formula_weight_sum_check',
      'performance_formula_successor_check',
    ],
    indexes: [
      'ux_performance_formula_version_number',
      // "At most one ACTIVE" is this partial index and nothing else.
      'ux_performance_formula_single_active',
    ],
    types: ['PerformanceFormulaStatus', 'PerformanceComponent'],
    constraints: [
      // Domain invariants.
      'ck_supplier_display_name_not_blank',
      'ck_supplier_actor_recorded',
      'ck_supplier_capability_actor_recorded',
      'ck_qualification_decision_complete',
      'ck_qualification_decided_after_submitted',
      'ck_qualification_note_requires_decision',
      'ck_qualification_text_not_blank',
      'ck_evidence_document_id_not_blank',
      'ck_evidence_text_not_blank',
      'ck_suspension_reinstatement_complete',
      'ck_suspension_reinstated_after_suspended',
      'ck_suspension_note_requires_reinstatement',
      'ck_suspension_text_not_blank',
      // ADR-050 / ADR-051 B1, folded into the initial migration and therefore
      // out of reach of the by-name outbox verifiers.
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      // ADR-052 step 2.
      'ck_formula_version_positive',
      'ck_formula_window_positive',
      'ck_formula_min_sample_positive',
      'ck_formula_min_coverage_range',
      'ck_formula_rating_mapping',
      'ck_formula_activation_complete',
      'ck_formula_retirement_complete',
      'ck_formula_status_stamps',
      'ck_formula_chronology',
      'ck_formula_text_not_blank',
      'ck_formula_weight_bp_range',
    ],
  },
  /*
   * The five services whose initial migration had no down.sql until the
   * platform-safety pass (lane 6), so the whole-chain check could not reach
   * any of their migrations. The lists name the tables and the hand-written
   * invariants; the exact-inverse snapshot (see `snapshotQuery`) covers every
   * other object without having to be listed here.
   */
  identity: {
    tables: [
      'audit_correction_command',
      'idempotency_key',
      'membership',
      'organization_ref',
      'outbox_message',
      'outbox_stream_sequence',
      'permission',
      'processed_event',
      'registration_request',
      'role',
      'role_permission',
      'security_event_outbox',
      'user',
    ],
    triggers: ['tg_security_event_outbox_guard'],
    functions: ['security_event_outbox_guard'],
    constraints: [
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      'ck_security_event_outbox_claim_triple',
      'ck_security_event_outbox_published_was_claimed',
      'ck_security_event_outbox_window_bounds',
      'ck_security_event_outbox_occurrence_count_range',
    ],
  },
  organization: {
    // ltree / geography, unqualified in its migrations: see `scratchDatabase`
    // in verify-migration-reversible.mjs.
    scratchDatabase: true,
    // `CREATE EXTENSION IF NOT EXISTS btree_gist` for the policy no-overlap
    // exclusion; its down script leaves it, for the reason its header gives
    // (the bootstrap installs it too, so the migration may not have added it).
    keptExtensions: {
      '20260925150000_policy_timeline_and_primary_contact': ['btree_gist'],
    },
    tables: [
      'idempotency_key',
      'organization',
      'organization_contact',
      'organization_location',
      'organization_policy',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
    ],
    triggers: [],
    constraints: [
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
      'ck_policy_effective_range',
      'ex_policy_no_overlap',
    ],
  },
  asset: {
    // ltree / geography, unqualified in its migrations: see `scratchDatabase`
    // in verify-migration-reversible.mjs.
    scratchDatabase: true,
    tables: [
      'asset',
      'asset_document_ref',
      'asset_location',
      'asset_timeline_entry',
      'asset_transfer',
      'idempotency_key',
      'insurance_claim',
      'insurance_policy',
      'organization_ref',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      'technical_inspection',
    ],
    triggers: [],
    constraints: [
      'ck_claim_decided_iff_decision_recorded',
      'ck_claim_rejected_has_no_approved_amount',
      'ck_claim_settled_iff_settlement_recorded',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
  fleet: {
    tables: [
      'asset_ref',
      'assignment',
      'availability_window',
      'driver',
      'outbox_message',
      'outbox_stream_sequence',
      'processed_event',
      'usage_record',
    ],
    triggers: [],
    constraints: [
      'ck_assignment_period',
      'ck_availability_period',
      'ck_driver_status_reason',
      'ck_usage_has_measure',
      'ck_usage_non_negative',
      'ck_usage_period',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
  maintenance: {
    tables: [
      'asset_ref',
      'asset_usage_meter',
      'labor_entry',
      'maintenance_cost',
      'maintenance_request',
      'maintenance_schedule',
      'outbox_message',
      'outbox_stream_sequence',
      'part_usage',
      'processed_event',
      'repair_order',
    ],
    triggers: [],
    constraints: [
      'ck_cost_provenance',
      'ck_labor_entry_amounts',
      'ck_part_usage_amounts',
      'ck_repair_order_cancellation',
      'ck_repair_order_period',
      'ck_repair_order_totals',
      'ck_request_downtime',
      'ck_request_period',
      'ck_request_severity_matches_type',
      'ck_request_terminal_attribution',
      'ck_request_total_non_negative',
      'ck_schedule_anchors_non_negative',
      'ck_schedule_has_interval',
      'ck_schedule_intervals_positive',
      'ck_usage_meter_non_negative',
      'ck_outbox_claim_triple',
      'ck_outbox_claim_count_nonneg',
      'ck_outbox_attempts_nonneg',
      'ck_outbox_next_attempt_requires_failure',
      'ck_outbox_published_is_clean',
    ],
  },
};

/**
 * A DO block that raises unless every named object is present (or absent).
 *
 * `prisma db execute` reports no rows, only an exit status — so the assertion
 * has to be expressed as an error the database raises. That is a feature here:
 * the failure message names the object, not just "expected 6, got 5".
 *
 * `indexes`, `types` and `functions` are optional and were added for AUD-003,
 * where the objects carrying the claim are neither tables nor constraints: the
 * chain-order index the verification walk depends on, the enum that
 * discriminates a tenant chain from the platform chain, and the trigger
 * function that actually refuses a rewind. A down script that dropped the
 * enum's table but left the enum behind, a forward migration that quietly
 * stopped creating the index, or a rollback that dropped a trigger and orphaned
 * its function all pass a table-and-constraint check while leaving a store
 * whose verification either cannot run, runs by sequential scan, or cannot be
 * re-applied at all.
 */
export function assertionScript(expected, present, schema) {
  const {
    tables,
    triggers,
    constraints,
    indexes = [],
    types = [],
    functions = [],
    enumValues = [],
  } = expected;
  const not = present ? 'NOT ' : '';
  const verb = present ? 'missing' : 'still present';

  const checks = [
    ...tables.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_tables
                       WHERE schemaname = '${schema}' AND tablename = '${name}') THEN
        RAISE EXCEPTION 'table % is ${verb}', '${name}';
      END IF;`,
    ),
    ...triggers.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_trigger t
                         JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = '${schema}' AND t.tgname = '${name}') THEN
        RAISE EXCEPTION 'trigger % is ${verb}', '${name}';
      END IF;`,
    ),
    ...constraints.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_constraint con
                         JOIN pg_namespace n ON n.oid = con.connamespace
                       WHERE n.nspname = '${schema}' AND con.conname = '${name}') THEN
        RAISE EXCEPTION 'constraint % is ${verb}', '${name}';
      END IF;`,
    ),
    // `pg_class`/`pg_namespace` rather than `pg_indexes`, because an index on a
    // *partitioned* parent has no `pg_indexes` row of its own in every server
    // version, and `audit_event_chain_idx` is exactly that shape.
    ...indexes.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = '${schema}' AND c.relname = '${name}'
                         AND c.relkind IN ('i', 'I')) THEN
        RAISE EXCEPTION 'index % is ${verb}', '${name}';
      END IF;`,
    ),
    ...types.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_type t
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                       WHERE n.nspname = '${schema}' AND t.typname = '${name}') THEN
        RAISE EXCEPTION 'type % is ${verb}', '${name}';
      END IF;`,
    ),
    ...functions.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_proc p
                         JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = '${schema}' AND p.proname = '${name}') THEN
        RAISE EXCEPTION 'function % is ${verb}', '${name}';
      END IF;`,
    ),
    // A *value* inside an enum, which a type-name check cannot see. PostgreSQL
    // has no `ALTER TYPE ... DROP VALUE`, so a down script that has to remove
    // one rebuilds the whole type and re-points every column at the new one.
    // That is several statements in a specific order, and every way of getting
    // it wrong leaves a type with the right name — which is all the check above
    // ever asked about.
    ...enumValues.map(
      ([type, value]) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_enum e
                         JOIN pg_type t ON t.oid = e.enumtypid
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                       WHERE n.nspname = '${schema}' AND t.typname = '${type}'
                         AND e.enumlabel = '${value}') THEN
        RAISE EXCEPTION 'enum value %.% is ${verb}', '${type}', '${value}';
      END IF;`,
    ),
  ].join('\n');

  return `DO $$\nBEGIN\n${checks}\nEND\n$$;`;
}

// -----------------------------------------------------------------------------
// Exact inverse
//
// `assertionScript` checks that *named* objects exist or do not. That catches a
// down script that forgot a table, but not one that restored an object with a
// different definition, restored a weaker CHECK under the same name, or left
// its `_prisma_migrations` row behind so a later `migrate deploy` silently
// skipped it — which is exactly how supplier's blank-text hardening could
// "pass" while its rollback was incomplete: after the whole-chain reversal,
// its ledger row survived, the re-deploy applied only the initial migration,
// and every constraint was back under its old name with the old predicate.
//
// So each migration's down.sql is also held to the state *before* that
// migration, compared as a whole: a catalogue snapshot of the schema — every
// relation, column, constraint, index, trigger, function, enum, domain,
// sequence, view, policy, rule and comment, each rendered by PostgreSQL's own
// `pg_get_*def` — taken from a reference schema built by applying each
// migration.sql in turn.
// -----------------------------------------------------------------------------

/** A schema name safe to interpolate into SQL. */
export function assertSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Refusing schema name ${JSON.stringify(schema)}: lowercase identifiers only.`);
  }
  return schema;
}

/**
 * One row per catalogue object in `schema`, each a single line of text with
 * the schema's own name removed, so two schemas holding the same objects
 * produce identical rows. Prisma's `_prisma_migrations` table is excluded: its
 * rows are asserted separately, and its structure belongs to Prisma.
 * Extension members are excluded too — they are the extension's, not a
 * migration's.
 *
 * The extensions themselves are not (Codex post-merge review of #105,
 * finding 3): one row per `pg_extension` — name, version and schema — for the
 * whole database, since that is where an extension lives. A down script that
 * leaves behind an extension its migration created, drops one that was there
 * before, or leaves one at another version, differs here like any other
 * object. These rows are not stripped of the schema name — they are not the
 * schema's — but an extension in the schema under test, or in
 * `extensionHome`, reads `schema=(target)`: a migration's
 * `CREATE EXTENSION IF NOT EXISTS` lands in the first schema on the search
 * path, which is the reference schema when the reference is built and the
 * target schema (`public`, in a scratch database) when Prisma deploys. The
 * two runs put the same extension in different places by construction, and
 * only a difference a down script makes should show.
 */
export function snapshotQuery(schema, extensionHome = schema) {
  assertSchemaName(schema);
  assertSchemaName(extensionHome);
  const strip = (expression) =>
    `replace(replace(${expression}, '"${schema}".', ''), '${schema}.', '')`;
  return `
    WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = '${schema}'),
    ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
    ledger AS (
      SELECT c.oid FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relname = '_prisma_migrations'
    ),
    owned AS (
      -- Relations a migration created: not the ledger, and not an extension's
      -- (postgis puts spatial_ref_sys, geometry_columns and its composite
      -- types into public). A composite type's membership is recorded on its
      -- pg_type row, not on the relation.
      SELECT c.* FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM ns)
        AND c.relkind NOT IN ('i', 'I')
        AND c.oid NOT IN (SELECT objid FROM ext)
        AND c.reltype NOT IN (SELECT objid FROM ext)
        AND c.oid NOT IN (SELECT oid FROM ledger)
    ),
    rel AS (
      -- Plus the indexes on those relations — and only those, so an
      -- extension's index or the ledger's primary key never appears.
      SELECT * FROM owned
      UNION ALL
      SELECT c.* FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE i.indrelid IN (SELECT oid FROM owned)
    ),
    items AS (
      SELECT 'relation ' || r.relname || ' kind=' || r.relkind::text
             || ' persistence=' || r.relpersistence::text
             || ' rls=' || r.relrowsecurity || '/' || r.relforcerowsecurity
             || ' acl=' || coalesce(r.relacl::text, '-')
             || ' partkey=' || coalesce(pg_get_partkeydef(r.oid), '-')
             || ' bound=' || coalesce(pg_get_expr(r.relpartbound, r.oid), '-') AS item
      FROM rel r WHERE r.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
      UNION ALL
      SELECT 'column ' || r.relname || '.' || a.attname
             || ' ' || format_type(a.atttypid, a.atttypmod)
             || ' notnull=' || a.attnotnull
             || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
             || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
             || ' collation=' || coalesce(co.collname, '-')
      FROM rel r
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
        AND co.collname <> 'default'
      WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
      UNION ALL
      SELECT 'constraint ' || coalesce(r.relname, t.typname) || '.' || con.conname
             || ' ' || pg_get_constraintdef(con.oid)
             || ' deferrable=' || con.condeferrable || '/' || con.condeferred
             || ' valid=' || con.convalidated
      FROM pg_constraint con
      LEFT JOIN pg_class r ON r.oid = con.conrelid
      LEFT JOIN pg_type t ON t.oid = con.contypid
      WHERE con.connamespace = (SELECT oid FROM ns)
        AND (con.conrelid = 0 OR con.conrelid IN (SELECT oid FROM rel))
      UNION ALL
      SELECT 'index ' || r.relname || ' ' || pg_get_indexdef(r.oid)
      FROM rel r WHERE r.relkind IN ('i', 'I')
      UNION ALL
      SELECT 'trigger ' || r.relname || '.' || tg.tgname || ' ' || pg_get_triggerdef(tg.oid)
             || ' enabled=' || tg.tgenabled::text
      FROM pg_trigger tg JOIN rel r ON r.oid = tg.tgrelid
      WHERE NOT tg.tgisinternal
      UNION ALL
      SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
             || ' kind=' || p.prokind::text
             || ' ' || CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END
      FROM pg_proc p
      WHERE p.pronamespace = (SELECT oid FROM ns) AND p.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'enum ' || t.typname || ' '
             || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid)
      FROM pg_type t
      WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'e'
        AND t.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'domain ' || t.typname || ' ' || format_type(t.typbasetype, t.typtypmod)
             || ' notnull=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
      FROM pg_type t
      WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'd'
        AND t.oid NOT IN (SELECT objid FROM ext)
      UNION ALL
      SELECT 'sequence ' || r.relname || ' ' || format_type(s.seqtypid, NULL)
             || ' start=' || s.seqstart || ' increment=' || s.seqincrement
             || ' min=' || s.seqmin || ' max=' || s.seqmax
             || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
      FROM pg_sequence s JOIN rel r ON r.oid = s.seqrelid
      UNION ALL
      SELECT 'sequence-owner ' || s.relname || ' ' || t.relname || '.' || a.attname
      FROM pg_depend dep
      JOIN rel s ON s.oid = dep.objid AND s.relkind = 'S'
      JOIN pg_class t ON t.oid = dep.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
      WHERE dep.classid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
      UNION ALL
      SELECT 'view ' || r.relname || ' ' || pg_get_viewdef(r.oid)
      FROM rel r WHERE r.relkind IN ('v', 'm')
      UNION ALL
      SELECT 'policy ' || pol.tablename || '.' || pol.policyname || ' ' || pol.permissive
             || ' ' || pol.roles::text || ' ' || pol.cmd
             || ' using=' || coalesce(pol.qual, '-') || ' check=' || coalesce(pol.with_check, '-')
      FROM pg_policies pol
      JOIN owned r ON r.relname = pol.tablename
      WHERE pol.schemaname = '${schema}'
      UNION ALL
      SELECT 'rule ' || ru.tablename || '.' || ru.rulename || ' ' || ru.definition
      FROM pg_rules ru
      JOIN owned r ON r.relname = ru.tablename
      WHERE ru.schemaname = '${schema}'
      UNION ALL
      SELECT 'comment ' || r.relname || coalesce('.' || a.attname, '') || ' ' || dsc.description
      FROM pg_description dsc
      JOIN rel r ON r.oid = dsc.objoid AND dsc.classoid = 'pg_class'::regclass
      LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = dsc.objsubid AND dsc.objsubid > 0
    )
    SELECT ${strip('item')} AS item FROM items
    UNION ALL
    -- Database-wide, so rendered as they are, outside the schema stripping.
    SELECT 'extension ' || e.extname || ' version=' || e.extversion || ' schema='
           || CASE WHEN n.nspname IN ('${schema}', '${extensionHome}') THEN '(target)'
                   ELSE n.nspname END
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`;
}

/** The table snapshots are recorded into, in a schema of the verifier's own. */
export function snapshotStoreScript(metaSchema) {
  assertSchemaName(metaSchema);
  return `DROP SCHEMA IF EXISTS "${metaSchema}" CASCADE;
CREATE SCHEMA "${metaSchema}";
CREATE TABLE "${metaSchema}".snapshot (label text NOT NULL, item text NOT NULL);`;
}

/** Records `schema`'s current state under `label`. */
export function recordSnapshotScript(metaSchema, label, schema, extensionHome = schema) {
  assertSchemaName(metaSchema);
  if (!/^[A-Za-z0-9_:.-]+$/.test(label)) throw new Error(`Unsafe snapshot label ${label}`);
  return `INSERT INTO "${metaSchema}".snapshot (label, item)
SELECT '${label}', item FROM (${snapshotQuery(schema, extensionHome)}) s;`;
}

/**
 * Raises unless `schema` is exactly the state recorded under `label`, listing
 * what is missing and what is extra — as PostgreSQL renders each — so a
 * failure says which object a down script got wrong, not just that one did.
 *
 * `keptExtensions` names extensions this down script may leave installed
 * (`EXPECTED[service].keptExtensions`). Such an extension is tolerated as
 * extra only as the **exact** row recorded under `keptFrom` — the target's own
 * state right after `prisma migrate deploy` — name, version and schema alike
 * (Codex review of #117, finding 4): a down script that leaves it at another
 * version, or moves it to another schema, still fails. Nothing else is
 * tolerated — not another extension, and not a missing one. Unlike
 * `allowance`, it cannot be required to match: whether the migration's
 * `CREATE EXTENSION IF NOT EXISTS` created anything depends on the cluster
 * (the bootstrap pre-installs it into template1), so it is pinned statically
 * instead — see the lib test.
 *
 * `extensionHome`: see `snapshotQuery`.
 */
export function assertSnapshotScript(
  metaSchema,
  label,
  schema,
  context,
  allowance = { missing: [], unexpected: [] },
  { keptExtensions = [], keptFrom = null, extensionHome = schema } = {},
) {
  assertSchemaName(metaSchema);
  if (!/^[A-Za-z0-9_:.-]+$/.test(label)) throw new Error(`Unsafe snapshot label ${label}`);
  for (const name of keptExtensions) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe extension name ${name}`);
  }
  if (keptExtensions.length > 0 && keptFrom === null) {
    throw new Error('keptExtensions needs keptFrom: the snapshot whose exact rows it may keep');
  }
  if (keptFrom !== null && !/^[A-Za-z0-9_:.-]+$/.test(keptFrom)) {
    throw new Error(`Unsafe snapshot label ${keptFrom}`);
  }
  const safeContext = context.replaceAll("'", "''");
  const literalArray = (items) =>
    items.length === 0
      ? 'ARRAY[]::text[]'
      : `ARRAY[${items.map((item) => `'${item.replaceAll("'", "''")}'`).join(', ')}]::text[]`;
  const allowedMissing = literalArray(allowance.missing ?? []);
  const allowedUnexpected = literalArray(allowance.unexpected ?? []);
  const kept = literalArray(keptExtensions);
  const live = snapshotQuery(schema, extensionHome);
  const recorded = `SELECT item FROM "${metaSchema}".snapshot WHERE label = '${label}'`;
  return `DO $exact$
DECLARE
  missing text[];
  unexpected text[];
BEGIN
  IF NOT EXISTS (${recorded}) AND EXISTS (${live}) THEN
    RAISE EXCEPTION '${safeContext}: no reference snapshot "${label}", and the schema is not empty';
  END IF;
  missing := ARRAY(${recorded} EXCEPT ALL SELECT item FROM (${live}) l);
  unexpected := ARRAY(SELECT item FROM (${live}) l EXCEPT ALL ${recorded});

  -- A documented allowance must match exactly: its items must really be part
  -- of the difference, or it has gone stale — which is itself a failure, so
  -- the exception cannot outlive the reason for it.
  IF NOT (${allowedMissing} <@ missing) OR NOT (${allowedUnexpected} <@ unexpected) THEN
    RAISE EXCEPTION E'${safeContext}: a documented inexact-inverse allowance no longer matches\\n expected but missing:\\n  %\\n present but not expected:\\n  %',
      array_to_string(missing, E'\\n  '), array_to_string(unexpected, E'\\n  ');
  END IF;
  missing := ARRAY(SELECT unnest(missing) EXCEPT ALL SELECT unnest(${allowedMissing}));
  unexpected := ARRAY(SELECT unnest(unexpected) EXCEPT ALL SELECT unnest(${allowedUnexpected}));
  -- An extension this down script is documented to leave installed: by exact
  -- name (btree_gist must not also excuse btree_gin), and only as the exact
  -- row the target had right after its deploy — same version, same schema.
  unexpected := ARRAY(
    SELECT u FROM unnest(unexpected) u
    WHERE NOT (
      split_part(u, ' ', 1) = 'extension'
      AND split_part(u, ' ', 2) = ANY (${kept})
      AND u IN (SELECT item FROM "${metaSchema}".snapshot WHERE label = ${keptFrom === null ? 'NULL' : `'${keptFrom}'`})
    )
  );

  IF cardinality(missing) > 0 OR cardinality(unexpected) > 0 THEN
    RAISE EXCEPTION E'${safeContext}: not the exact expected schema\\n expected but missing:\\n  %\\n present but not expected:\\n  %',
      coalesce(nullif(array_to_string(ARRAY(SELECT unnest(missing) ORDER BY 1), E'\\n  '), ''), '(none)'),
      coalesce(nullif(array_to_string(ARRAY(SELECT unnest(unexpected) ORDER BY 1), E'\\n  '), ''), '(none)');
  END IF;
END
$exact$;`;
}

/**
 * Raises unless the ledger holds exactly `applied`, one row each, every one
 * finished and none rolled back. After a down script, that is every earlier
 * migration and not this one; after a re-deploy, all of them.
 *
 * Every row counts (Codex post-merge review of #105, finding 4). Reading only
 * finished, non-rolled-back rows let a down script that marked its row rolled
 * back — or a half-applied deploy's unfinished row — pass as removed, and
 * `migrate deploy` treats neither like an absent row. So: an unfinished or
 * rolled-back row anywhere fails, a duplicate fails, and `removed` (the
 * migration whose down script just ran) must have no row at all.
 */
export function ledgerAssertionScript(applied, context, removed = null) {
  const safeName = (name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe migration name ${name}`);
    return `'${name}'`;
  };
  const names = applied.map(safeName);
  const expected = names.length > 0 ? `ARRAY[${names.join(', ')}]::text[]` : `ARRAY[]::text[]`;
  const removedCheck =
    removed === null
      ? ''
      : `
  IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${safeName(removed)}) THEN
    RAISE EXCEPTION E'${context.replaceAll("'", "''")}: _prisma_migrations still has a row for %, in any state', ${safeName(removed)};
  END IF;`;
  const safeContext = context.replaceAll("'", "''");
  return `DO $ledger$
DECLARE
  actual text[];
  irregular text[];
BEGIN${removedCheck}
  irregular := ARRAY(
    SELECT migration_name || CASE WHEN finished_at IS NULL THEN ' (unfinished)' ELSE ' (rolled back)' END
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
    ORDER BY 1
  );
  IF cardinality(irregular) > 0 THEN
    RAISE EXCEPTION E'${safeContext}: _prisma_migrations holds rows that are not cleanly applied: %', irregular;
  END IF;
  -- Every row, duplicates included: two rows for one name is not one migration.
  SELECT coalesce(array_agg(migration_name ORDER BY migration_name), ARRAY[]::text[]) INTO actual
  FROM "_prisma_migrations";
  IF actual IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) FROM unnest(${expected}) x) THEN
    RAISE EXCEPTION E'${safeContext}: _prisma_migrations holds %, expected %', actual, ${expected};
  END IF;
END
$ledger$;`;
}
