import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { z } from 'zod';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { readCapped } from '../organization/organization-directory';

/** The service that knows who belongs to which organization. */
export const IDENTITY_SERVICE = 'identity-service';

/** A user belongs to a handful of organizations; anything over this is not the contract. */
export const MAX_MEMBERSHIP_BYTES = 64 * 1024;

const organizationId = z.string().min(1).max(64);

const liveSchema = z
  .object({
    userId: z.string().min(1).max(64),
    memberships: z
      .array(
        z.object({ organizationId, roles: z.array(z.string().min(1).max(64)).max(100) }).strict(),
      )
      .max(1000),
    asOf: z.string().datetime(),
  })
  .strict();

const sinceSchema = z
  .object({
    userId: z.string().min(1).max(64),
    organizationIds: z.array(organizationId).max(1000),
    asOf: z.string().datetime(),
  })
  .strict();

/** A live membership: where, and the roles held there. */
export interface LiveMembership {
  organizationId: string;
  roles: readonly string[];
}

/** The seam the conflict check and the owner-side authorisation read through; tests put an answer in directly. */
export interface MembershipSource {
  /** The live memberships of `userId` **now**, with their roles. Throws when it cannot say. */
  fetchMemberships(userId: string): Promise<readonly LiveMembership[]>;
  /**
   * The organizations `userId` held a membership in at any time between `from` and the
   * moment identity-service answered (the detective control), and that moment (`asOf`).
   * Throws when it cannot say.
   */
  fetchOrganizationIdsSince(
    userId: string,
    from: Date,
  ): Promise<{ organizationIds: readonly string[]; asOf: Date }>;
}

/**
 * Asks identity-service which organizations a user belongs to now:
 * `GET {IDENTITY_SERVICE_URL}/v1/users/{userId}/organizations` with an `X-Internal-Token`
 * signed for identity-service and for no tenant (ADR-035): a membership spans tenants.
 *
 * Without a query: the live memberships with their roles. With `from`: the organizations
 * held at any time between `from` and identity-service's own clock as it answered.
 *
 * Fail closed: anything but a 200 whose body parses strictly and names this user is
 * `UPSTREAM_UNAVAILABLE` (or a timeout) — "could not confirm" is never "no conflict".
 */
@Injectable()
export class MembershipClient implements MembershipSource {
  private readonly logger = new Logger(MembershipClient.name);

  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async fetchMemberships(userId: string): Promise<readonly LiveMembership[]> {
    return (await this.read(userId, '', liveSchema)).memberships;
  }

  async fetchOrganizationIdsSince(
    userId: string,
    from: Date,
  ): Promise<{ organizationIds: readonly string[]; asOf: Date }> {
    const answer = await this.read(
      userId,
      `?from=${encodeURIComponent(from.toISOString())}`,
      sinceSchema,
    );
    return { organizationIds: answer.organizationIds, asOf: new Date(answer.asOf) };
  }

  private async read<T extends { userId: string }>(
    userId: string,
    query: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const token = await this.tokens.issue(SERVICE_NAME, IDENTITY_SERVICE, 'SERVICE');
    const url =
      `${this.env.IDENTITY_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/users/${encodeURIComponent(userId)}/organizations${query}`;

    const timeoutMs = this.env.CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          'x-correlation-id': safeCorrelationId(),
        },
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(`identity-service answered ${response.status} to the membership read`);
        throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
      }
      const text = await readCapped(response, MAX_MEMBERSHIP_BYTES);
      if (text === null) throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success || parsed.data.userId !== userId) {
        this.logger.warn('identity-service answered memberships that are not the contract');
        throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted) throw RastaError.upstreamTimeout(IDENTITY_SERVICE, timeoutMs);
      throw RastaError.upstreamUnavailable(IDENTITY_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeCorrelationId(): string {
  try {
    return getContext().correlationId;
  } catch {
    return `membership-${Date.now()}`;
  }
}
