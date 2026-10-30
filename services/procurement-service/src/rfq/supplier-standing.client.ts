import { InternalHttpClient } from '@rasta/nest-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ProcurementEnv } from '../config/env';

/** The service that knows who is qualified to supply goods and who is suspended. */
export const SUPPLIER_SERVICE = 'supplier-service';

/** One organization's standing is a few short records; anything over this is not the contract. */
export const MAX_STANDING_BYTES = 256 * 1024;

const instant = z.string().check(isoDateTime());

/**
 * What supplier-service answers for one organization (plan PR 5,
 * `GET /v1/suppliers/standing-snapshot/{organizationId}`), as this service reads it. Declared here
 * rather than imported (no cross-service imports, A-02); `.strict()` so a field that is not in the
 * contract — a reason, a name — makes the answer unusable instead of being quietly kept.
 * `goodsSupplyApprovedAt` is required: an older supplier-service that does not answer it cannot
 * say whether an organization may supply goods, and is treated as unavailable.
 */
export const standingOfOrganizationSchema = z
  .object({
    organizationId: z.string().min(1).max(64),
    contractingApprovedAt: instant.nullable(),
    goodsSupplyApprovedAt: instant.nullable(),
    suspensions: z.array(
      z
        .object({
          suspensionId: z.string().min(1).max(64),
          suspendedAt: instant,
          reinstatedAt: instant.nullable(),
        })
        .strict(),
    ),
    asOf: instant,
  })
  .strict();

export type StandingOfOrganization = z.infer<typeof standingOfOrganizationSchema>;

/** Whether an organization may be invited right now, from supplier-service's own record. */
export type InviteeVerdict = 'ELIGIBLE' | 'NOT_QUALIFIED' | 'SUSPENDED';

/**
 * The verdict a standing gives (ADR-070 § 3): an open suspension episode wins, then the absence of
 * an approved GOODS_SUPPLY qualification; otherwise eligible. Pure. An organization supplier-service
 * knows nothing of answers with no approval: NOT_QUALIFIED.
 */
export function inviteeVerdictOf(
  standing: Pick<StandingOfOrganization, 'goodsSupplyApprovedAt' | 'suspensions'>,
): InviteeVerdict {
  if (standing.suspensions.some((episode) => episode.reinstatedAt === null)) return 'SUSPENDED';
  return standing.goodsSupplyApprovedAt === null ? 'NOT_QUALIFIED' : 'ELIGIBLE';
}

/** The seam an invitation decision reads through; a suite may put an answer in directly. */
export interface SupplierStandingSource {
  fetchStanding(organizationId: string): Promise<StandingOfOrganization>;
}

/**
 * Asks supplier-service for one organization's standing **now** (ADR-070 § 3, § 7; ADR-061 § 4):
 * an authoritative read at the moment of the decision, never a read model built from
 * `rasta.supplier.v1` — such a model misses a suspension committed and not yet relayed.
 *
 * `X-Internal-Token` signed for supplier-service and **for no tenant** (the owner's contract:
 * supplier-service refuses a token signed for a tenant), never `Authorization`. Called before the
 * issue's transaction, never under a lock.
 *
 * Fail closed in the plain sense: anything but a 200 with a body that parses strictly, about the
 * organization asked, is `503 UPSTREAM_UNAVAILABLE`, and past
 * `PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS` `504 UPSTREAM_TIMEOUT` — the issue writes nothing.
 */
@Injectable()
export class SupplierStandingClient implements SupplierStandingSource {
  private readonly logger = new Logger(SupplierStandingClient.name);

  constructor(
    @Inject(ENV) private readonly env: ProcurementEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async fetchStanding(organizationId: string): Promise<StandingOfOrganization> {
    const sender = await new InternalHttpClient(this.tokens).authorize({
      from: SERVICE_NAME,
      to: SUPPLIER_SERVICE,
      purpose: 'SERVICE',
    });
    const url =
      `${this.env.SUPPLIER_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/suppliers/standing-snapshot/${encodeURIComponent(organizationId)}`;

    const timeoutMs = this.env.PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await sender.send(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-correlation-id': correlationId(),
        },
        signal: controller.signal,
      });

      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(`supplier-service answered ${response.status} to a standing read`);
        throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE);
      }
      const text = await readCapped(response, MAX_STANDING_BYTES);
      if (text === null) {
        this.logger.warn('supplier-service answered a standing over the size bound');
        throw RastaError.upstreamUnavailable(SUPPLIER_SERVICE);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = standingOfOrganizationSchema.safeParse(body);
      // An answer about somebody else is not an answer about this invitee.
      if (!parsed.success || parsed.data.organizationId !== organizationId) {
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

/** The request's correlation id, so the callee's logs join this one's; a fresh one outside a request. */
function correlationId(): string {
  try {
    return getContext().correlationId;
  } catch {
    return `procurement-${Date.now()}`;
  }
}

/** The body, or null when it is larger than `limit` bytes (declared or read). */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
