import { Injectable } from '@nestjs/common';
import {
  allocateStreamSeqSql,
  buildOutboxRow,
  getContext,
  RastaError,
  runUnscoped,
  type OutboxMessageInput,
} from '@rasta/nest-common';
import { assertTopicFor, resolvePartitionKey, type OutboundEventName } from './routing';
import {
  PrismaService,
  type ExtendedPrismaClient,
  type TransactionOptions,
} from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import { BACKOFF_EXPONENT_CAP, BACKOFF_FAILURES_CAP } from '../keycloak/keycloak-write-fence';
import type { ProvisioningBinding, ProvisioningIntent } from './provisioning-intent';
import type { ListUsersQuery } from './dto';
import type { Prisma } from '../generated/prisma';
import { liveMembershipWhere } from './membership-window';

/**
 * Data access for identity.
 *
 * Two things this layer owns and the service layer does not:
 *
 *  - Tenant scoping. Membership queries are scoped automatically by the Prisma
 *    extension; the places that legitimately reach across tenants go through
 *    `runUnscoped` with a stated reason, so they are greppable.
 *
 *  - Outbox writes. `enqueueEvent` inserts into the same transaction as the
 *    state change, which is the whole basis of the delivery guarantee.
 */
@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  transaction<T>(
    fn: (tx: ExtendedPrismaClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.prisma.transaction(fn, options);
  }

  /**
   * The per-user serialisation point for membership changes and the
   * active-organization switch (global audit L7-14, Codex #114 R1-1).
   *
   * Locks the user row for the rest of the caller's transaction and returns
   * its active organization. Every transaction that can end a membership
   * (revocation, the expiry sweep), change one (roles) or move the active
   * organization takes it **first**, before reading or writing any
   * membership. So a switch that validated a membership cannot commit around
   * a revocation of that same membership: one of them waits for the other,
   * then reads what it committed. `null` when no such user exists.
   *
   * It returns no clock, on purpose (#402 r1 F3): a value read in this
   * statement may predate the wait for the lock — `now()` is the
   * transaction's start, and even `clock_timestamp()` in the select list is
   * evaluated before the row is locked. A decision on validity reads
   * {@link databaseNow} in a later statement.
   *
   * It is also the serialisation point for a user's **status** (#219 r4): the
   * first activation of a provisioned account
   * (`KeycloakProjector.activateOnce`) holds it from its read of the status to
   * its write to Keycloak. Any path that changes a user's status — a suspend
   * or deactivate, none of which exists yet (D-049) — must take it first, so a
   * disable that commits first is seen and wins, and one that commits after is
   * carried to Keycloak by the projection it triggers.
   *
   * And it is the **one lock of every Keycloak writer of the user** (ADR-060,
   * write-ahead addendum, D-064, D-069): a narrowing change's write-ahead,
   * every projection — after a request, from the outbox event, the backfill,
   * the re-assertion sweep, an activation — an approval's adoption and the
   * orphan repair all take it before they read what they write, and a write
   * fence is only ever opened under it (`KeycloakWriteFences.open`). The
   * protocol is stated once, in `KeycloakProjector`'s header.
   */
  async lockUserMemberships(
    tx: ExtendedPrismaClient,
    userId: string,
  ): Promise<{ activeOrganizationId: string | null } | null> {
    const rows = await tx.$queryRaw<Array<{ active_organization_id: string | null }>>`
      SELECT active_organization_id FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const row = rows[0];
    return row ? { activeOrganizationId: row.active_organization_id } : null;
  }

  /**
   * The user locks of an identity-administration write (task 117, F1): every
   * user it changes — `targets`, `FOR UPDATE`, the lock of
   * {@link lockUserMemberships} — and the caller, whose live authority it
   * decides on (`live-authority.ts`), `FOR KEY SHARE`.
   *
   * The caller's row is locked so that a change of the caller's own
   * memberships — which takes the caller's lock `FOR UPDATE` — and this write
   * cannot both commit on what the other read: two administrators demoting each
   * other at once end with one demoted and the other refused, never both
   * demoted. `KEY SHARE` and not `UPDATE`, because it conflicts with nothing
   * else: one administrator's writes on different users still run side by side,
   * and none of them waits on another's Keycloak call.
   *
   * Taken one row at a time in ascending id order (UTF-16 code units, the same
   * in every process), whatever the mode. Every transaction that holds more
   * than one user lock takes them here, so two of them always lock in the same
   * order and cannot deadlock; every other holder takes one user lock only.
   * The platform's order is unchanged around it: a registration request first,
   * then these, then memberships, then the outbox.
   *
   * Returns {@link lockUserMemberships}'s answer for each target (null: no
   * such user). The caller's row may be absent — a `SYSTEM_ADMIN` signed in
   * without a platform id — and then nothing is locked for it.
   */
  async lockUsersInOrder(
    tx: ExtendedPrismaClient,
    targets: readonly string[],
    callerId: string | undefined,
  ): Promise<Map<string, { activeOrganizationId: string | null } | null>> {
    const updated = new Set(targets);
    const ids = [...new Set([...targets, ...(callerId ? [callerId] : [])])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const locked = new Map<string, { activeOrganizationId: string | null } | null>();
    for (const id of ids) {
      if (updated.has(id)) {
        locked.set(id, await this.lockUserMemberships(tx, id));
      } else {
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${id} FOR KEY SHARE`;
      }
    }
    return locked;
  }

  /**
   * The roles `userId` holds in `organizationId` at `now`, or null when no
   * membership of theirs there is live (`liveMembershipWhere`: `ACTIVE`, not
   * revoked, inside `[validFrom, validUntil)`) or the user is not an `ACTIVE`,
   * undeleted user. `now` is the database's clock, read after the caller's
   * locks (`databaseNow`). The caller's live authority (`live-authority.ts`).
   */
  async findLiveRoles(
    tx: ExtendedPrismaClient,
    userId: string,
    organizationId: string,
    now: Date,
  ): Promise<string[] | null> {
    const membership = await runUnscoped(
      "a caller's authority is read in the organization they act for",
      () =>
        tx.membership.findFirst({
          where: {
            userId,
            organizationId,
            ...liveMembershipWhere(now),
            user: { is: { status: 'ACTIVE', deletedAt: null } },
          },
          select: { roles: true },
        }),
    );
    return membership?.roles ?? null;
  }

  /**
   * `userId`'s membership in `organizationId` if it is live at `now`, the
   * database's clock (task 117, F3): what proves access to a person through
   * their membership — reading their profile, editing it. A membership that
   * ended, expired, is suspended or has not begun proves nothing, though it
   * stays in history ({@link findMembership} still finds it, for uniqueness).
   */
  async findLiveMembership(
    userId: string,
    organizationId: string,
    now: Date,
    tx?: ExtendedPrismaClient,
  ) {
    const db = tx ?? this.client;
    return runUnscoped('membership access proof for a specific organization', () =>
      db.membership.findFirst({
        where: { userId, organizationId, ...liveMembershipWhere(now) },
      }),
    );
  }

  /**
   * The database's wall clock, now — its own statement, so after any lock the
   * caller took before it (#402 r1 F3). The clock every validity decision
   * under the user lock is made on: the one that stamps `validFrom`, and that
   * a write fence's `takeover_at` is measured against (D-069). In UTC, like
   * every timestamp column here.
   */
  async databaseNow(db: ExtendedPrismaClient): Promise<Date> {
    const rows = await db.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    const row = rows[0];
    if (!row) throw new Error('the database did not answer its own clock');
    return row.now;
  }

  /**
   * The per-request serialisation point for a registration decision (#219 r2).
   *
   * Approve, reject and the orphan repair (`KeycloakProjector.repairOrphan`)
   * each take it **first** in their transaction and decide on the status it
   * returns, never on one read before it: two decisions on one request then
   * run one after the other, and the second sees what the first committed.
   * `null` when no such request exists.
   */
  async lockRegistrationRequest(
    tx: ExtendedPrismaClient,
    registrationId: string,
  ): Promise<{ status: string; userId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ status: string; user_id: string }>>`
      SELECT status::text AS status, user_id FROM registration_request
       WHERE id = ${registrationId} FOR UPDATE`;
    const row = rows[0];
    return row ? { status: row.status, userId: row.user_id } : null;
  }

  /**
   * What a first activation marks the account with, or null when nothing has
   * decided to provision it yet (#219 r3, D-069 addendum D).
   *
   * The approved registration request's id, for a self-registered user: the
   * projector enables their account only while it is APPROVED. For a user an
   * operator created (`IdentityService.createUser`), who has no registration
   * request at all — `submitRegistration` mints every self-registered user
   * with theirs — their own user id: that operator's decision committed with
   * the row. A request that is still pending or was rejected gives null.
   */
  async findActivationSource(tx: ExtendedPrismaClient, userId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ approved: string | null; requests: bigint }>>`
      SELECT (SELECT id FROM registration_request
                WHERE user_id = ${userId} AND status = 'APPROVED'
                ORDER BY id LIMIT 1) AS approved,
             (SELECT COUNT(*) FROM registration_request WHERE user_id = ${userId}) AS requests`;
    const row = rows[0];
    if (row?.approved) return row.approved;
    return row && Number(row.requests) === 0 ? userId : null;
  }

  /**
   * A direct provisioning's intent (task 117, F6; `provisioning-intent.ts`),
   * inserted unless the actor already used the key, then locked `FOR UPDATE`
   * and returned as it stands — this request's, or an earlier attempt's, whose
   * binding the caller compares. The lock is the provisioning's first, where
   * a registration request's is for an approval: concurrent retries of one
   * key run one after the other. `userId` and `membershipId` are used only
   * when this call inserted the row.
   */
  async claimProvisioningIntent(
    tx: ExtendedPrismaClient,
    input: ProvisioningBinding & { userId: string; membershipId: string },
  ): Promise<ProvisioningIntent> {
    await tx.$executeRaw`
      INSERT INTO user_provisioning_intent
             (actor_id, idempotency_key, acting_organization_id, request_hash, user_id, membership_id)
      VALUES (${input.actorId}, ${input.idempotencyKey}, ${input.actingOrganizationId},
              ${input.requestHash}, ${input.userId}, ${input.membershipId})
      ON CONFLICT (actor_id, idempotency_key) DO NOTHING`;
    const intent = await this.lockProvisioningIntent(tx, input.actorId, input.idempotencyKey);
    if (!intent) throw new Error('the provisioning intent is missing after its own insert');
    return intent;
  }

  /** The intent of one actor's key, locked `FOR UPDATE`; null when there is none. */
  async lockProvisioningIntent(
    tx: ExtendedPrismaClient,
    actorId: string,
    idempotencyKey: string,
  ): Promise<ProvisioningIntent | null> {
    const rows = await tx.$queryRaw<
      Array<{
        actor_id: string;
        idempotency_key: string;
        acting_organization_id: string | null;
        request_hash: string;
        user_id: string;
        membership_id: string;
        completed_at: Date | null;
        response_body: unknown;
      }>
    >`
      SELECT actor_id, idempotency_key, acting_organization_id, request_hash, user_id,
             membership_id, completed_at, response_body
        FROM user_provisioning_intent
       WHERE actor_id = ${actorId} AND idempotency_key = ${idempotencyKey}
         FOR UPDATE`;
    const row = rows[0];
    return row
      ? {
          actorId: row.actor_id,
          idempotencyKey: row.idempotency_key,
          actingOrganizationId: row.acting_organization_id,
          requestHash: row.request_hash,
          userId: row.user_id,
          membershipId: row.membership_id,
          completedAt: row.completed_at,
          responseBody: row.response_body,
        }
      : null;
  }

  /**
   * Records the answer a retry of the intent replays, in the transaction that
   * commits the user: both exist, or neither does.
   */
  async completeProvisioningIntent(
    tx: ExtendedPrismaClient,
    actorId: string,
    idempotencyKey: string,
    response: object,
  ): Promise<void> {
    const count = await tx.$executeRaw`
      UPDATE user_provisioning_intent
         SET completed_at = (clock_timestamp() AT TIME ZONE 'UTC'),
             response_body = ${JSON.stringify(response)}::jsonb
       WHERE actor_id = ${actorId} AND idempotency_key = ${idempotencyKey}
         AND completed_at IS NULL`;
    if (count !== 1) throw new Error('the provisioning intent was not open to complete');
  }

  /**
   * A public registration as received (task 130, PR #483 r1 R5): one row,
   * committed on its own — the same statement whoever the applicant is. No
   * lookup and no unique index on the username or the email, so nothing here
   * costs differently when an account already holds either.
   */
  async receiveRegistration(id: string, submission: object): Promise<void> {
    await this.client.$executeRaw`
      INSERT INTO registration_intake (id, submission)
      VALUES (${id}, ${JSON.stringify(submission)}::jsonb)`;
  }

  /**
   * Up to `limit` intake rows due now (`next_attempt_at` passed), oldest first:
   * the registration worker's read. A deferred row is not due, so it never
   * takes a pass's budget. Not locked — each is taken under its own lock by
   * {@link lockRegistrationIntake}.
   */
  async findDueRegistrationIntakes(limit: number): Promise<string[]> {
    const rows = await this.client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM registration_intake
       WHERE next_attempt_at <= (clock_timestamp() AT TIME ZONE 'UTC')
       ORDER BY id
       LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  /**
   * One intake row, locked `FOR UPDATE SKIP LOCKED`: null when it is gone —
   * handled already — or another worker holds it.
   */
  async lockRegistrationIntake(
    tx: ExtendedPrismaClient,
    id: string,
  ): Promise<{ id: string; submission: unknown; receivedAt: Date } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; submission: unknown; received_at: Date }>>`
      SELECT id, submission, received_at FROM registration_intake
       WHERE id = ${id}
         FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    return row ? { id: row.id, submission: row.submission, receivedAt: row.received_at } : null;
  }

  /** Removes a handled intake row, in the transaction that handled it. */
  async deleteRegistrationIntake(tx: ExtendedPrismaClient, id: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM registration_intake WHERE id = ${id}`;
  }

  /**
   * An intake row whose handling failed waits before it is tried again: one
   * interval, doubling per attempt, at most `maxIntervals` — so a failing
   * submission never holds back those behind it. Bounded like
   * {@link deferLapse}, so no attempt count overflows the arithmetic.
   */
  async deferRegistrationIntake(id: string, intervalSeconds: number, maxIntervals: number) {
    await this.client.$executeRaw`
      UPDATE registration_intake
         SET attempts = LEAST(attempts, ${BACKOFF_FAILURES_CAP - 1}) + 1,
             next_attempt_at = (clock_timestamp() AT TIME ZONE 'UTC')
               + make_interval(secs => ${intervalSeconds}
                   * LEAST(POWER(2, LEAST(attempts, ${BACKOFF_EXPONENT_CAP})),
                           ${maxIntervals}))
       WHERE id = ${id}`;
  }

  /** The same lock, on every registration request of one user; their statuses. */
  async lockRegistrationRequestsOfUser(
    tx: ExtendedPrismaClient,
    userId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status::text AS status FROM registration_request
       WHERE user_id = ${userId} ORDER BY id FOR UPDATE`;
    return rows.map((row) => row.status);
  }

  /**
   * Writes an event to the outbox.
   *
   * Takes the transaction client explicitly rather than reaching for the
   * ambient one: passing `tx` is what makes it impossible to enqueue an event
   * outside the transaction that produced it (ADR-021).
   */
  async enqueueEvent(tx: ExtendedPrismaClient, input: OutboxMessageInput): Promise<string> {
    // ADR-051 B3, in the order the ADR requires: routing is final *first*, the
    // sequence is allocated against that exact `(topic, partitionKey)` pair
    // *second*, and only then is the row built and inserted. All three happen
    // inside the caller's transaction, so the counter row lock is held to its
    // commit — which is what makes allocation order equal commit order, and is
    // this service's only serialisation point on the stream boundary.
    const eventName = input.eventName as OutboundEventName;
    assertTopicFor(eventName, input.topic);
    const partition = resolvePartitionKey(eventName, input.aggregateId);
    const streamSeq = await allocateStreamSeqSql(tx, input.topic, partition.key);

    const row = buildOutboxRow(
      { ...input, partitionKey: partition.key, streamSeq, streamKey: partition.key },
      {
        producer: SERVICE_NAME,
        producerVersion: process.env.SERVICE_VERSION ?? '0.1.0',
      },
    );

    await tx.outboxMessage.create({
      data: {
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventName: row.eventName,
        eventVersion: row.eventVersion,
        topic: row.topic,
        partitionKey: row.partitionKey,
        payload: row.payload as object,
        headers: row.headers,
        organizationId: row.organizationId,
        correlationId: row.correlationId,
        createdAt: row.createdAt,
        streamSeq: row.streamSeq,
      },
    });

    return row.id;
  }

  // -------------------------------------------------------------------------
  // Users
  //
  // User is not tenant-scoped: identity spans organizations. Every lookup here
  // is therefore explicitly unscoped, and callers reach a user through their
  // membership when the tenant boundary must apply.
  // -------------------------------------------------------------------------

  async findUserById(id: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return runUnscoped('user identity spans organizations and is not tenant-scoped', () =>
      db.user.findFirst({ where: { id, deletedAt: null } }),
    );
  }

  async findUserByUsernameOrEmail(username: string, email: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return runUnscoped('uniqueness check spans the whole platform, not one tenant', () =>
      db.user.findFirst({
        where: { deletedAt: null, OR: [{ username }, { email }] },
      }),
    );
  }

  async findUserWithMemberships(id: string) {
    return runUnscoped('user identity spans organizations and is not tenant-scoped', () =>
      this.client.user.findFirst({
        where: { id, deletedAt: null },
        include: {
          memberships: {
            where: { deletedAt: null, status: { not: 'REVOKED' } },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    );
  }

  /**
   * Users belonging to the requesting organization.
   *
   * Driven from Membership, which *is* tenant-scoped, so the boundary is
   * applied by the extension rather than by remembering to add a filter here.
   */
  async listUsersInOrganization(query: ListUsersQuery) {
    const { organizationId } = getContext();
    // Members **now** (task 117, F3): the live window on the database's clock,
    // like every other membership decision. Before, an expired or not-yet-valid
    // membership still listed the person, email and phone included.
    const now = await this.databaseNow(this.client);

    // Every filter is in this one query, before `take`: a page is the first
    // `limit` rows that match, so a filter never empties a page that the
    // cursor then walks past (the user filters used to run on the page
    // afterwards). The user is read through the relation; `User` itself is not
    // tenant-scoped, and is reached only through a membership that is.
    const memberships = await this.client.membership.findMany({
      where: {
        ...liveMembershipWhere(now),
        ...(query.role ? { roles: { has: query.role } } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        user: {
          is: {
            deletedAt: null,
            ...(query.status ? { status: query.status } : {}),
            ...(query.q
              ? {
                  OR: [
                    { firstName: { contains: query.q, mode: 'insensitive' as const } },
                    { lastName: { contains: query.q, mode: 'insensitive' as const } },
                    { username: { contains: query.q, mode: 'insensitive' as const } },
                    { email: { contains: query.q, mode: 'insensitive' as const } },
                  ],
                }
              : {}),
          },
        },
      },
      include: { user: true },
      orderBy: { id: 'asc' },
      // One extra row tells us whether another page exists without a count.
      take: query.limit + 1,
    });

    const page = memberships.slice(0, query.limit);

    return {
      users: page.map((m) => m.user),
      memberships: page,
      organizationId,
      nextCursor: memberships.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      hasMore: memberships.length > query.limit,
    };
  }

  // -------------------------------------------------------------------------
  // Memberships — tenant-scoped automatically
  // -------------------------------------------------------------------------

  async findMembershipById(id: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return db.membership.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * A membership whatever became of it, revoked included — so a revocation
   * sent again finds the one it already ended and answers as it did, rather
   * than 404 (D-064: the caller may not have seen the first answer). Scoped
   * to the tenant like every membership read.
   */
  async findMembershipByIdIncludingRevoked(id: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return db.membership.findFirst({ where: { id } });
  }

  /**
   * The organizations a user holds a live membership in **now**, with the roles held in
   * each, and the instant that was. "Now" is the **database's** clock, read once for the
   * whole statement: a membership's `validFrom` defaults to the database's `now()`, so
   * judging it by an application clock that lags would miss a membership created a moment ago.
   */
  async findLiveMemberships(
    userId: string,
  ): Promise<{ memberships: { organizationId: string; roles: string[] }[]; asOf: Date }> {
    const rows = await runUnscoped(
      'a service asks which organizations a user belongs to; a membership spans tenants',
      () =>
        this.client.$queryRaw<
          Array<{ as_of: Date; memberships: { organizationId: string; roles: string[] }[] }>
        >`
          WITH t AS MATERIALIZED (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now)
          SELECT t.now AS as_of,
                 COALESCE((
                   SELECT json_agg(json_build_object('organizationId', m.organization_id,
                                                     'roles', m.roles)
                                   ORDER BY m.organization_id ASC)
                     FROM membership m
                    WHERE m.user_id = ${userId}
                      AND m.status = 'ACTIVE'
                      AND m.deleted_at IS NULL
                      AND m.valid_from <= t.now
                      AND (m.valid_until IS NULL OR m.valid_until > t.now)
                 ), '[]'::json) AS memberships
            FROM t`,
    );
    const row = rows[0];
    if (!row) throw new Error('the database did not answer its own clock');
    return { memberships: row.memberships, asOf: row.as_of };
  }

  /**
   * Whether `userId` holds a live membership in **the requesting organization** now, and
   * the instant that was: one bit, for fleet-service registering a driver (task 095).
   *
   * The organization is never a parameter. `Membership` is tenant-scoped, so the guard
   * extension adds the organization the caller's token was signed for; a membership in any
   * other organization is not seen. Live is `liveMembershipWhere` — the one definition —
   * judged on the **database's** clock, read first, for the reason
   * {@link findLiveMemberships} gives. The person must still be one: not deleted, and
   * `ACTIVE` (a suspended, deactivated or pending account cannot act for anybody).
   */
  async findLiveMembershipInScope(userId: string): Promise<{ live: boolean; asOf: Date }> {
    const rows = await this.client.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    const now = rows[0]?.now;
    if (!now) throw new Error('the database did not answer its own clock');
    const membership = await this.client.membership.findFirst({
      where: { userId, ...liveMembershipWhere(now), user: { deletedAt: null, status: 'ACTIVE' } },
      select: { id: true },
    });
    return { live: membership !== null, asOf: now };
  }

  /**
   * The organizations a user held a membership in at any time between `from` and the
   * database's clock as this statement ran (`asOf`), ids only: history, for the detective
   * control after a bid opening. Wider than "live": a suspended membership counts, since
   * when it was suspended is not recorded; only a revocation ends one, at its `deletedAt`.
   * An end at exactly `from` counts too — timestamps are millisecond-rounded, and a false
   * positive here is an alert, a false negative a missed conflict.
   */
  async findOrganizationIdsSince(
    userId: string,
    from: Date,
  ): Promise<{ organizationIds: string[]; asOf: Date }> {
    const rows = await runUnscoped(
      'a service asks which organizations a user belonged to over an interval; a membership spans tenants',
      () =>
        this.client.$queryRaw<Array<{ organization_ids: string[]; as_of: Date }>>`
          WITH t AS MATERIALIZED (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now)
          SELECT t.now AS as_of,
                 ARRAY(
                   SELECT DISTINCT m.organization_id FROM membership m
                    WHERE m.user_id = ${userId}
                      AND m.valid_from <= t.now
                      AND (m.valid_until IS NULL OR m.valid_until >= ${from})
                      AND (m.deleted_at IS NULL OR m.deleted_at >= ${from})
                    ORDER BY m.organization_id ASC
                 ) AS organization_ids
            FROM t`,
    );
    const row = rows[0];
    if (!row) throw new Error('the database did not answer its own clock');
    return { organizationIds: row.organization_ids, asOf: row.as_of };
  }

  /**
   * Revokes a membership, in the caller's transaction (which holds the user's lock). The
   * end of the membership, `deletedAt`, is the **database's** clock — the one that stamps
   * `validFrom` and that every history read compares against — read here, after the lock.
   */
  async revokeMembership(tx: ExtendedPrismaClient, membershipId: string, actor: string) {
    const count = await tx.$executeRaw`
      UPDATE membership
         SET status = 'REVOKED',
             deleted_at = (clock_timestamp() AT TIME ZONE 'UTC'),
             updated_at = (clock_timestamp() AT TIME ZONE 'UTC'),
             updated_by = ${actor},
             version = version + 1
       WHERE id = ${membershipId} AND deleted_at IS NULL`;
    if (count !== 1) throw RastaError.notFound('Membership', membershipId);
  }

  async findMembership(userId: string, organizationId: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return runUnscoped('membership lookup for a specific organization during provisioning', () =>
      db.membership.findFirst({
        where: { userId, organizationId, deletedAt: null },
      }),
    );
  }

  /**
   * Memberships whose `validUntil` has passed, that the expiry sweep has not
   * yet acted on, and that are not waiting out a retry (`lapse_retry_at`,
   * #402 r1 F2) — oldest lapse first, a page at a time: strictly after
   * `after` (the last one before) and, when given, no later than `until`, so
   * the sweep's cursor walks on from where it stopped across passes and wraps
   * round once. Ids compare in the database's order, never this process's.
   * Platform-wide: a membership expires whichever tenant it belongs to.
   */
  async findLapsedMemberships(
    now: Date,
    take: number,
    after: { validUntil: Date | null; id: string } | null = null,
    until: { validUntil: Date | null; id: string } | null = null,
  ) {
    const bounds: Prisma.MembershipWhereInput[] = [];
    if (after?.validUntil) {
      bounds.push({
        OR: [
          { validUntil: { gt: after.validUntil } },
          { validUntil: after.validUntil, id: { gt: after.id } },
        ],
      });
    }
    if (until?.validUntil) {
      bounds.push({
        OR: [
          { validUntil: { lt: until.validUntil } },
          { validUntil: until.validUntil, id: { lte: until.id } },
        ],
      });
    }
    return runUnscoped('the membership expiry sweep covers every organization', () =>
      this.client.membership.findMany({
        where: {
          deletedAt: null,
          lapseHandledAt: null,
          validUntil: { lte: now },
          OR: [{ lapseRetryAt: null }, { lapseRetryAt: { lte: now } }],
          ...(bounds.length > 0 ? { AND: bounds } : {}),
        },
        orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
        take,
      }),
    );
  }

  /**
   * One more failed attempt at a lapse: not to be tried again for twice as
   * many scan intervals as last time, up to `maxIntervals` (#402 r1 F2). In
   * the row, so a restart or another replica waits too, and the sweep reaches
   * the lapses behind it. Raw SQL, so neither `version` nor `updated_at`
   * moves: this is the sweep's bookkeeping, not a change to the membership.
   * Its own statement, after the failed transaction ended. The exponent and
   * the counter are bounded before the arithmetic (#402 r2 F4,
   * `BACKOFF_EXPONENT_CAP`), so no failure count can overflow it.
   */
  async deferLapse(membershipId: string, intervalSeconds: number, maxIntervals: number) {
    await runUnscoped(
      'the membership expiry sweep covers every organization',
      () =>
        this.client.$executeRaw`
        UPDATE membership
           SET lapse_failures = LEAST(lapse_failures, ${BACKOFF_FAILURES_CAP - 1}) + 1,
               lapse_retry_at = (clock_timestamp() AT TIME ZONE 'UTC')
                 + make_interval(secs => ${intervalSeconds}
                     * LEAST(POWER(2, LEAST(lapse_failures, ${BACKOFF_EXPONENT_CAP}) + 1),
                             ${maxIntervals}))
         WHERE id = ${membershipId} AND lapse_handled_at IS NULL`,
    );
  }

  /** How many lapses are past `validUntil` and not yet acted on: the sweep's backlog. */
  async countLapsedMemberships(
    now: Date,
    client: ExtendedPrismaClient = this.client,
  ): Promise<number> {
    return runUnscoped('the membership expiry backlog covers every organization', () =>
      client.membership.count({
        where: { deletedAt: null, lapseHandledAt: null, validUntil: { lte: now } },
      }),
    );
  }

  /**
   * One page of users that have a Keycloak account, by id — the backfill and
   * reconcile sweep (ADR-060 § 5). Platform-wide by nature: projection is not
   * something a tenant does.
   */
  async listUserIdsWithAccount(after: string | null, take: number): Promise<string[]> {
    const rows = await runUnscoped('the Keycloak projection sweep covers every account', () =>
      this.client.user.findMany({
        where: {
          deletedAt: null,
          keycloakId: { not: null },
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true },
      }),
    );
    return rows.map((row) => row.id);
  }

  /**
   * Users with no Keycloak account, a page at a time — the orphan sweep's
   * input (`projection.command.ts`). The username is read only to look the
   * account up and is never logged.
   */
  async listUsersWithoutAccount(
    after: string | null,
    take: number,
  ): Promise<{ id: string; username: string }[]> {
    return runUnscoped('the Keycloak orphan sweep covers every user without an account', () =>
      this.client.user.findMany({
        where: {
          deletedAt: null,
          keycloakId: null,
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, username: true },
      }),
    );
  }

  async listMembershipsForUser(userId: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return runUnscoped('a user must be able to see every organization they belong to', () =>
      db.membership.findMany({
        where: { userId, deletedAt: null, status: { not: 'REVOKED' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Reference replica
  // -------------------------------------------------------------------------

  async findOrganizationRefs(ids: readonly string[]) {
    if (ids.length === 0) return [];
    return runUnscoped('organization reference data is platform-wide, not tenant data', () =>
      this.client.organizationRef.findMany({ where: { id: { in: [...ids] } } }),
    );
  }

  async upsertOrganizationRef(data: {
    id: string;
    name: string;
    type: string;
    status: string;
    sourceEvent: string;
  }) {
    return runUnscoped('organization reference replica is platform-wide', () =>
      this.client.organizationRef.upsert({
        where: { id: data.id },
        create: { ...data, syncedAt: new Date() },
        update: { ...data, syncedAt: new Date() },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Consumer idempotency
  // -------------------------------------------------------------------------

  /**
   * Records that an event has been handled.
   *
   * Returns false when it was already recorded, which is the signal to skip.
   * Called inside the handler's transaction so the marker and the effect
   * commit together — otherwise a crash between them either loses the effect
   * or applies it twice.
   */
  async markEventProcessed(
    tx: ExtendedPrismaClient,
    eventId: string,
    consumerName: string,
  ): Promise<boolean> {
    try {
      await tx.processedEvent.create({ data: { eventId, consumerName } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

/** Prisma's unique-constraint error, without importing its error classes. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/** Prisma's "no record matched the `where` of an update", without importing its error classes. */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2025'
  );
}
