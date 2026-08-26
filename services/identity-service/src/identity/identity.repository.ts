import { Injectable } from '@nestjs/common';
import {
  buildOutboxRow,
  getContext,
  runUnscoped,
  type OutboxMessageInput,
} from '@rasta/nest-common';
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

  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn);
  }

  /**
   * Writes an event to the outbox.
   *
   * Takes the transaction client explicitly rather than reaching for the
   * ambient one: passing `tx` is what makes it impossible to enqueue an event
   * outside the transaction that produced it (ADR-021).
   */
  async enqueueEvent(tx: ExtendedPrismaClient, input: OutboxMessageInput): Promise<string> {
    const row = buildOutboxRow(input, {
      producer: SERVICE_NAME,
      producerVersion: process.env.SERVICE_VERSION ?? '0.1.0',
    });

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

  async findMembership(userId: string, organizationId: string, tx?: ExtendedPrismaClient) {
    const db = tx ?? this.client;
    return runUnscoped('membership lookup for a specific organization during provisioning', () =>
      db.membership.findFirst({
        where: { userId, organizationId, deletedAt: null },
      }),
    );
  }

  async listMembershipsForUser(userId: string) {
    return runUnscoped('a user must be able to see every organization they belong to', () =>
      this.client.membership.findMany({
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
