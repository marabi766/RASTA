import { createHash } from 'node:crypto';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { Prisma } from '../src/generated/prisma';
import {
  cleanup,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  rowsFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * Every hand-written constraint in the migration actually bites.
 *
 * Each case writes a row the state machine could never legitimately produce
 * and expects PostgreSQL — not the service — to refuse it. A constraint that
 * is listed in `EXPECTED.notification` but does not reject anything would
 * survive the reversibility gate while enforcing nothing.
 */
describe('database constraints (ADR-054 § 4, § 10)', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let organizationId: string;
  let intentId: string;
  let deliveryId: string;
  let userId: string;

  const constraint = (name: string) =>
    expect.objectContaining({ message: expect.stringContaining(name) });
  // PostgreSQL names the key's columns in a unique violation, not the index
  // (PROJECT_MEMORY § 30), so uniqueness is asserted on the column list.
  const uniqueKey = (columns: string) =>
    expect.objectContaining({ message: expect.stringContaining(`Key (${columns})=`) });

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();

    organizationId = newOrganizationId();
    organizations.push(organizationId);
    userId = newUserId();
    w.recipients.answers.set(organizationId, [{ userId, role: 'FLEET_MANAGER' }]);
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await w.worker.tick();

    const rows = await rowsFor(w.prisma, organizationId);
    intentId = rows.intents[0]!.id;
    deliveryId = rows.deliveries[0]!.id;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  const sql = (statement: Prisma.Sql) =>
    runUnscoped('constraint probes write rows the service never would', () =>
      w.prisma.client.$executeRaw(statement),
    );

  describe('notification_delivery', () => {
    it('refuses SUPPRESSED with an attempt, and SUPPRESSED without a reason', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "notification_delivery" ("id","intent_id","organization_id","user_id","channel","status","template_key","template_version","attempt_count","max_attempts","suppression_reason")
          VALUES (${`NTD_${ulid()}`}, ${intentId}, ${organizationId}, ${`USR_${ulid()}`}, 'IN_APP', 'SUPPRESSED', 't', 1, 1, 1, 'OPTED_OUT')`),
      ).rejects.toEqual(constraint('ck_delivery_suppressed_shape'));

      await expect(
        sql(Prisma.sql`INSERT INTO "notification_delivery" ("id","intent_id","organization_id","user_id","channel","status","template_key","template_version","attempt_count","max_attempts")
          VALUES (${`NTD_${ulid()}`}, ${intentId}, ${organizationId}, ${`USR_${ulid()}`}, 'IN_APP', 'SUPPRESSED', 't', 1, 0, 1)`),
      ).rejects.toEqual(constraint('ck_delivery_suppressed_shape'));
    });

    it('refuses SENT without sent_at, and DEAD before the attempts are spent', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "notification_delivery" ("id","intent_id","organization_id","user_id","channel","status","template_key","template_version","attempt_count","max_attempts")
          VALUES (${`NTD_${ulid()}`}, ${intentId}, ${organizationId}, ${`USR_${ulid()}`}, 'IN_APP', 'SENT', 't', 1, 1, 1)`),
      ).rejects.toEqual(constraint('ck_delivery_sent_has_timestamp'));

      await expect(
        sql(Prisma.sql`INSERT INTO "notification_delivery" ("id","intent_id","organization_id","user_id","channel","status","template_key","template_version","attempt_count","max_attempts")
          VALUES (${`NTD_${ulid()}`}, ${intentId}, ${organizationId}, ${`USR_${ulid()}`}, 'IN_APP', 'DEAD', 't', 1, 1, 5)`),
      ).rejects.toEqual(constraint('ck_delivery_dead_exhausted'));
    });

    it('refuses a second delivery for the same (intent, user, channel) — invariant 6', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "notification_delivery" ("id","intent_id","organization_id","user_id","channel","status","template_key","template_version","attempt_count","max_attempts")
          VALUES (${`NTD_${ulid()}`}, ${intentId}, ${organizationId}, ${userId}, 'IN_APP', 'QUEUED', 't', 1, 0, 1)`),
      ).rejects.toEqual(uniqueKey('intent_id, user_id, channel'));
    });

    it('refuses a retry scheduled on a closed delivery', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_delivery" SET "next_attempt_at" = now() WHERE "id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(constraint('ck_delivery_next_attempt_only_when_open'));
    });
  });

  describe('delivery_attempt', () => {
    it('is append-only: an update is refused by the trigger', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "delivery_attempt" SET "outcome" = 'PERMANENT_FAILURE', "error_class" = 'X' WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(
        expect.objectContaining({ message: expect.stringContaining('append-only') }),
      );
    });

    it('refuses a success with an error class, and a failure without one', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "delivery_attempt" ("id","delivery_id","organization_id","attempt_no","outcome","error_class","started_at","finished_at")
          VALUES (${`NTA_${ulid()}`}, ${deliveryId}, ${organizationId}, 2, 'SUCCESS', 'X', now(), now())`),
      ).rejects.toEqual(constraint('ck_attempt_error_class_shape'));
      await expect(
        sql(Prisma.sql`INSERT INTO "delivery_attempt" ("id","delivery_id","organization_id","attempt_no","outcome","started_at","finished_at")
          VALUES (${`NTA_${ulid()}`}, ${deliveryId}, ${organizationId}, 2, 'TRANSIENT_FAILURE', now(), now())`),
      ).rejects.toEqual(constraint('ck_attempt_error_class_shape'));
    });

    it('refuses a duplicate attempt number', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "delivery_attempt" ("id","delivery_id","organization_id","attempt_no","outcome","started_at","finished_at")
          VALUES (${`NTA_${ulid()}`}, ${deliveryId}, ${organizationId}, 1, 'SUCCESS', now(), now())`),
      ).rejects.toEqual(uniqueKey('delivery_id, attempt_no'));
    });
  });

  describe('in_app_notification', () => {
    it('refuses dismissed_at without read_at — dismiss implies read', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "dismissed_at" = now() WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(constraint('ck_in_app_dismiss_implies_read'));
    });

    it('refuses an absolute or scheme-relative action path at the database, not only the DTO', async () => {
      for (const path of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)']) {
        await expect(
          sql(
            Prisma.sql`UPDATE "in_app_notification" SET "action_path" = ${path} WHERE "delivery_id" = ${deliveryId}`,
          ),
        ).rejects.toEqual(constraint('ck_in_app_action_path_relative'));
      }
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "action_path" = '/assets/AST_1' WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).resolves.toBe(1);
    });

    it('refuses a blank title or body', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "title" = '   ' WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(constraint('ck_in_app_text_not_blank'));
    });

    it('makes read state write-once: setting is allowed, rewinding and moving are refused (NTF-002)', async () => {
      const writeOnce = expect.objectContaining({
        message: expect.stringContaining('write-once'),
      });
      // Setting a null timestamp is the transition the API makes.
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "read_at" = now() WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).resolves.toBe(1);
      // Un-reading does not exist (ADR-054 § 4).
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "read_at" = NULL WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(writeOnce);
      // Neither does moving the moment it happened.
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "read_at" = now() + interval '1 minute' WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(writeOnce);
      // Dismiss on a read row is allowed once, then frozen the same way.
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "dismissed_at" = now() WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).resolves.toBe(1);
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "dismissed_at" = NULL WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).rejects.toEqual(writeOnce);
      // Other columns stay editable; the trigger is about the two facts only.
      await expect(
        sql(
          Prisma.sql`UPDATE "in_app_notification" SET "title" = 'edited' WHERE "delivery_id" = ${deliveryId}`,
        ),
      ).resolves.toBe(1);
    });

    it('refuses a second in-app row for one delivery — invariant 5', async () => {
      await expect(
        sql(Prisma.sql`INSERT INTO "in_app_notification" ("id","delivery_id","intent_id","organization_id","user_id","rule_key","severity","classification","subject_type","subject_id","title","body","occurred_at","expires_at")
          VALUES (${`NTN_${ulid()}`}, ${deliveryId}, ${intentId}, ${organizationId}, ${userId}, 'r', 'INFO', 'ROUTINE', 's', 'i', 't', 'b', now(), now() + interval '1 day')`),
      ).rejects.toEqual(uniqueKey('delivery_id'));
    });
  });

  describe('notification_intent', () => {
    it('refuses a terminal status without a reason, and a reason on a live one', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_intent" SET "status" = 'SUPPRESSED', "terminal_reason" = NULL WHERE "id" = ${intentId}`,
        ),
      ).rejects.toEqual(constraint('ck_intent_terminal_reason'));
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_intent" SET "terminal_reason" = 'X' WHERE "id" = ${intentId}`,
        ),
      ).rejects.toEqual(constraint('ck_intent_terminal_reason'));
    });

    it('refuses a partial claim triple and a claim on a non-pending intent', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_intent" SET "claim_token" = 't' WHERE "id" = ${intentId}`,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          message: expect.stringMatching(
            /ck_intent_claim_triple|ck_intent_claim_only_when_pending/,
          ),
        }),
      );
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_intent" SET "claim_token" = 't', "claim_owner" = 'o', "claim_expires_at" = now() WHERE "id" = ${intentId}`,
        ),
      ).rejects.toEqual(constraint('ck_intent_claim_only_when_pending'));
    });

    it('refuses a dedupe key that is not a SHA-256 hex digest, and a second intent for one source event', async () => {
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_intent" SET "dedupe_key" = 'not-a-hash' WHERE "id" = ${intentId}`,
        ),
      ).rejects.toEqual(constraint('ck_intent_dedupe_key_is_sha256'));

      const existing = (await rowsFor(w.prisma, organizationId)).intents[0]!;
      await expect(
        sql(Prisma.sql`INSERT INTO "notification_intent" ("id","organization_id","source_event_id","source_event_name","source_topic","source_partition_key","occurred_at","correlation_id","rule_key","template_key","severity","classification","subject_type","subject_id","dedupe_key","context_data")
          VALUES (${`NTI_${ulid()}`}, ${organizationId}, ${existing.sourceEventId}, 'X', 't', 'k', now(), 'c', 'r', 't', 'INFO', 'ROUTINE', 's', 'i', ${'a'.repeat(64)}, '{}')`),
      ).rejects.toEqual(uniqueKey('source_event_id'));
    });
  });

  describe('notification_dedupe', () => {
    it('refuses a zero seen count and an inverted window', async () => {
      const key = (await rowsFor(w.prisma, organizationId)).dedupe[0]!.dedupeKey;
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_dedupe" SET "seen_count" = 0 WHERE "dedupe_key" = ${key}`,
        ),
      ).rejects.toEqual(constraint('ck_dedupe_seen_count_positive'));
      await expect(
        sql(
          Prisma.sql`UPDATE "notification_dedupe" SET "expires_at" = "first_seen_at" WHERE "dedupe_key" = ${key}`,
        ),
      ).rejects.toEqual(constraint('ck_dedupe_window_ordered'));
    });

    it('defers the intent foreign key to commit, so the decision can precede the row', async () => {
      const key = createHash('sha256').update(ulid()).digest('hex');
      const phantom = `NTI_${ulid()}`;
      // Inside one transaction: a dedupe row naming an intent that does not
      // exist yet, then the intent. Commit succeeds only because the check is
      // deferred; an immediate check would have refused the first statement.
      await runUnscoped('constraint probe exercises the deferred foreign key', () =>
        w.prisma.transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "notification_dedupe" ("dedupe_key","organization_id","intent_id","expires_at") VALUES (${key}, ${organizationId}, ${phantom}, now() + interval '1 day')`;
          await tx.$executeRaw`INSERT INTO "notification_intent" ("id","organization_id","source_event_id","source_event_name","source_topic","source_partition_key","occurred_at","correlation_id","rule_key","template_key","severity","classification","subject_type","subject_id","dedupe_key","context_data")
            VALUES (${phantom}, ${organizationId}, ${`EVT_${ulid()}`}, 'X', 't', 'k', now(), 'c', 'r', 't', 'INFO', 'ROUTINE', 's', 'i', ${key}, '{}')`;
        }),
      );
      // And the same first statement alone is still refused at commit.
      await expect(
        runUnscoped('constraint probe exercises the deferred foreign key', () =>
          w.prisma.transaction(async (tx) => {
            await tx.$executeRaw`INSERT INTO "notification_dedupe" ("dedupe_key","organization_id","intent_id","expires_at") VALUES (${key.replace(/.$/, 'f')}, ${organizationId}, ${`NTI_${ulid()}`}, now() + interval '1 day')`;
          }),
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          message: expect.stringContaining('notification_dedupe_intent_id_fkey'),
        }),
      );
    });
  });

  it('uses restrict, not cascade: an intent with children cannot be deleted', async () => {
    await expect(
      sql(Prisma.sql`DELETE FROM "notification_intent" WHERE "id" = ${intentId}`),
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/violates foreign key constraint/),
      }),
    );
  });
});
