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
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type { ListUsersQuery } from './dto';

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
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.prisma.transaction(fn, options);
  }

  /**
   * Serialises every Keycloak projection of one user, inside the caller's
   * transaction (ADR-060 § 5).
   *
   * A transaction-scoped advisory lock keyed on the user id, held until the
   * projection's transaction ends. Taken *before* the projection reads the
   * user's rows, so whichever projection writes last also read last — under
   * READ COMMITTED it sees every change committed before it took the lock.
   * The key is a bound parameter hashed by PostgreSQL; nothing is interpolated.
   */
  async lockUserProjection(tx: ExtendedPrismaClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`keycloak-projection:${userId}`}, 0))`;
  }

  /**
   * The per-user serialisation point for membership changes and the
   * active-organization switch (global audit L7-14, Codex #114 R1-1).
   *
   * Locks the user row for the rest of the caller's transaction and returns
   * its active organization together with the database's own clock. Every
   * transaction that can end a membership (revocation, the expiry sweep),
   * change one (roles) or move the active organization takes it **first**,
   * before reading or writing any membership. So a switch that validated a
   * membership cannot commit around a revocation of that same membership: one
   * of them waits for the other, then reads what it committed. `null` when no
   * such user exists.
   *
   * It is also the serialisation point for a user's **status** (#219 r4): the
   * first activation of a registration approval's account
   * (`KeycloakProjector.activateOnce`) holds it from its read of the status to
   * its write to Keycloak. Any path that changes a user's status — a suspend
   * or deactivate, none of which exists yet (D-049) — must take it first, so a
   * disable that commits first is seen and wins, and one that commits after is
   * carried to Keycloak by the projection it triggers.
   */
  async lockUserMemberships(
    tx: ExtendedPrismaClient,
    userId: string,
  ): Promise<{ activeOrganizationId: string | null; now: Date } | null> {
    const rows = await tx.$queryRaw<Array<{ active_organization_id: string | null; now: Date }>>`
      SELECT active_organization_id, now() AS now FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const row = rows[0];
    return row ? { activeOrganizationId: row.active_organization_id, now: row.now } : null;
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
   * The approved registration request of one user, or null (#219 r3).
   *
   * What a first activation needs: the projector enables a registration
   * approval's account only while its request is APPROVED, and marks the
   * account with this id (`KeycloakAdminClient.activateAccount`). A user's id
   * is minted with their request (`submitRegistration`), so there is at most
   * one.
   */
  async findApprovedRegistrationId(
    tx: ExtendedPrismaClient,
    userId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM registration_request
       WHERE user_id = ${userId} AND status = 'APPROVED'
       ORDER BY id LIMIT 1`;
    return rows[0]?.id ?? null;
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

    const memberships = await this.client.membership.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(query.role ? { roles: { has: query.role } } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      // One extra row tells us whether another page exists without a count.
      take: query.limit + 1,
    });

    const page = memberships.slice(0, query.limit);
    const userIds = page.map((m) => m.userId);

    const users = await runUnscoped(
      'users are resolved by id from memberships already scoped to this tenant',
      () =>
        this.client.user.findMany({
          where: {
            id: { in: userIds },
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
        }),
    );

    const byId = new Map(users.map((user) => [user.id, user]));

    return {
      // Preserve membership order, and drop users filtered out by status/search.
      users: page.map((m) => byId.get(m.userId)).filter((u): u is NonNullable<typeof u> => !!u),
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
   * Memberships whose `validUntil` has passed and that the expiry sweep has
   * not yet acted on (ADR-060 § 5), oldest lapse first. Platform-wide: a
   * membership expires whichever tenant it belongs to.
   */
  async findLapsedMemberships(now: Date, take: number) {
    return runUnscoped('the membership expiry sweep covers every organization', () =>
      this.client.membership.findMany({
        where: { deletedAt: null, lapseHandledAt: null, validUntil: { lte: now } },
        orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
        take,
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
