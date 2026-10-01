import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { z } from 'zod';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { readCapped } from '../organization/organization-directory';

/** The service that knows who is qualified and who is suspended. */
export const SUPPLIER_SERVICE = 'supplier-service';

/** A page is at most a few hundred short records; anything over this is not the contract. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Suppliers per page. The platform's own page bound (`MAX_PAGE_SIZE`). */
export const SNAPSHOT_PAGE_SIZE = 200;

/**
 * What supplier-service answers, as this service reads it. Declared here rather
 * than imported (no cross-service imports); `.strict()` so a field that is not in
 * the contract — a reason, a name, a note — makes the page unusable instead of
 * being quietly kept.
 */
const instant = z.string().datetime();

export const standingSnapshotPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          organizationId: z.string().min(1).max(64),
          contractingApprovedAt: instant.nullable(),
          suspensions: z.array(
            z
              .object({
                suspensionId: z.string().min(1).max(64),
                suspendedAt: instant,
                reinstatedAt: instant.nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    nextCursor: z.string().max(512).nullable(),
    hasMore: z.boolean(),
    snapshotAt: instant,
  })
  .strict();

export type StandingSnapshotPage = z.infer<typeof standingSnapshotPageSchema>;

/** One contractor's standing now: a snapshot item and the instant it was read at. */
export const standingOfOrganizationSchema = standingSnapshotPageSchema.shape.items.element
  .extend({ asOf: instant })
  .strict();

export type StandingOfOrganization = z.infer<typeof standingOfOrganizationSchema>;

/** The seam an eligibility decision reads through; tests put an answer in directly. */
export interface StandingOfSource {
  fetchStanding(organizationId: string): Promise<StandingOfOrganization>;
}

/** The seam the bootstrap reads through; tests put pages in directly. */
export interface StandingSnapshotSource {
  fetchPage(cursor: string | null, limit: number): Promise<StandingSnapshotPage>;
}

/**
 * Reads one page of the contractor-standing snapshot (ADR-061 § 4).
 *
 * `GET {SUPPLIER_SERVICE_URL}/v1/suppliers/standing-snapshot` with an
 * `X-Internal-Token` signed for supplier-service and **for no tenant**: the
 * snapshot is a platform-wide read, which ADR-035 rule 7 allows a tenant-less
 * service token only where it is meant, and supplier-service refuses a token
 * signed for a tenant. The user's token is never involved — there is none; this
 * runs at start-up.
 *
 * Fail closed in the plain sense: anything but a 200 with a body that parses
 * strictly is `UPSTREAM_UNAVAILABLE` (or a timeout), the bootstrap does not
 * advance, and nobody becomes eligible.
 */
@Injectable()
export class SupplierSnapshotClient implements StandingSnapshotSource, StandingOfSource {
  private readonly logger = new Logger(SupplierSnapshotClient.name);

  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async fetchPage(cursor: string | null, limit: number): Promise<StandingSnapshotPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.get(
      `/v1/suppliers/standing-snapshot?${query.toString()}`,
      standingSnapshotPageSchema,
    );
  }

  /**
   * One contractor's standing **now**, authoritatively (`StandingAuthority`): the
   * same service-only, tenant-less call, for one organization.
   */
  fetchStanding(organizationId: string): Promise<StandingOfOrganization> {
    return this.get(
      `/v1/suppliers/standing-snapshot/${encodeURIComponent(organizationId)}`,
      standingOfOrganizationSchema,
    );
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const token = await this.tokens.issue(SERVICE_NAME, SUPPLIER_SERVICE, 'SERVICE');
    const url = `${this.env.SUPPLIER_SERVICE_URL.replace(/\/+$/, '')}${path}`;

    const timeoutMs = this.env.CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          // A background call has no request; a fresh id still lets the callee's logs be joined.
          'x-correlation-id': safeCorrelationId(),
        },
        signal: controller.signal,
      });

      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(
          `supplier-service answered ${response.status} to the snapshot; will retry`,
        );
        throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE);
      }
      const text = await readCapped(response, MAX_SNAPSHOT_BYTES);
      if (text === null) {
        this.logger.warn('supplier-service answered a snapshot page over the size bound');
        throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        // The shape, never the content, is logged.
        this.logger.warn('supplier-service answered a standing that is not the contract');
        throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted) {
        throw RastaError.upstreamTimeout(SUPPLIER_SERVICE, timeoutMs);
      }
      throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeCorrelationId(): string {
  try {
    return getContext().correlationId;
  } catch {
    return `standing-bootstrap-${Date.now()}`;
  }
}
