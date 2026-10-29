import { InternalHttpClient } from '@rasta/nest-common';
import { Logger } from '@nestjs/common';
import { RastaError, getContext, type InternalTokenService } from '@rasta/nest-common';
import { z } from 'zod';
import { SERVICE_NAME } from '../config/env';

/** The owner of the organization hierarchy (A-13): the only service that decides "within". */
export const ORGANIZATION_SERVICE = 'organization-service';

/**
 * The only valid answer is `{ "id": "<organization id>", "hierarchyVersion": <n> }` — well under
 * this. Anything longer is not the contract and is refused unread.
 */
export const MAX_RESPONSE_BYTES = 1024;

/** "Within", and the hierarchy version of the organization in the tree the answer came from. */
export interface WithinAnswer {
  hierarchyVersion: number;
}

/** The one question access.ts asks of the hierarchy — what a test stands in for. */
export interface HierarchyQuestion {
  withinVersion(scopeOrganizationId: string, organizationId: string): Promise<WithinAnswer | null>;
}

export interface OrganizationHierarchyOptions {
  /** `ORGANIZATION_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `MARKETPLACE_ORGANIZATION_REQUEST_TIMEOUT_MS`: the whole exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
}

/**
 * Is `organizationId` the organization `scopeOrganizationId`, or beneath it? Asked of
 * organization-service, which owns the hierarchy (A-13), exactly as construction-service,
 * contract-service and economic-service ask it (Q-70 (7), ADR-068 § 5): a union administrator
 * decides a dispute — settle or refund — only for an order whose buyer is in its own union's
 * subtree, and for no other (docs/24 Q-136). The same client as economic-service's
 * (`services/economic-service/src/organization/organization-hierarchy.ts`), so the two services
 * read the same answer the same way.
 *
 * `GET {ORGANIZATION_SERVICE_URL}/v1/organizations/{organizationId}` with an `X-Internal-Token`
 * minted for organization-service and signed for `scopeOrganizationId` — the tenant is inside the
 * signature (ADR-035), so nothing the client sends names the hierarchy. organization-service
 * answers `{ id, hierarchyVersion }` when the organization is the signed one or beneath it, and 404
 * with its error body (`Organization not found`) otherwise.
 *
 * The user's own token is deliberately not forwarded: organization-service treats `UNION_ADMIN` as
 * a platform operator that sees every organization, so a union administrator's token would prove
 * nothing about the hierarchy.
 *
 * ## Fail closed
 *
 * 200 naming the organization with a valid hierarchy version → within. 404 with
 * organization-service's own `Organization not found` body → not within. Anything else — another
 * status, a 404 without that body, a body that does not name the organization or names no valid
 * version or is larger than `MAX_RESPONSE_BYTES`, a timeout (which covers the body read and parse,
 * not only the headers), a network error — is `UPSTREAM_UNAVAILABLE` (503) / `UPSTREAM_TIMEOUT`
 * (504), and the command it was asked for writes nothing. "Could not confirm" is never read as
 * "confirmed".
 */
export class OrganizationHierarchy implements HierarchyQuestion {
  private readonly logger = new Logger(OrganizationHierarchy.name);

  constructor(private readonly options: OrganizationHierarchyOptions) {}

  async withinVersion(
    scopeOrganizationId: string,
    organizationId: string,
  ): Promise<WithinAnswer | null> {
    const sender = await new InternalHttpClient(this.options.tokens).authorize({
      from: SERVICE_NAME,
      to: ORGANIZATION_SERVICE,
      purpose: 'SERVICE',
      organizationId: scopeOrganizationId,
    });
    const url =
      `${this.options.baseUrl.replace(/\/+$/, '')}` +
      `/v1/organizations/${encodeURIComponent(organizationId)}`;

    const timeoutMs = this.options.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // One deadline for the whole exchange: headers, body and parse. A server that answers 200 and
    // then stalls its body is a timeout, not a hang inside a transaction holding a row lock.
    try {
      const response = await sender.send(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-correlation-id': getContext().correlationId,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        // "Not within" only when organization-service's own handler said so. Any other 404 — a
        // proxy's page, an empty body, a route missing during a deploy — proves nothing.
        const text = await readCapped(response, MAX_RESPONSE_BYTES);
        if (text !== null && isOrganizationNotFound(parseJson(text))) return null;
        this.logger.warn('organization-service answered a 404 that is not its own; refusing');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(
          `organization-service answered ${response.status}; refusing (fail closed)`,
        );
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }

      const text = await readCapped(response, MAX_RESPONSE_BYTES);
      if (text === null) {
        this.logger.warn('organization-service answered a body larger than { id }; refusing');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      const body = parseJson(text) as { id?: unknown; hierarchyVersion?: unknown } | null;
      if (body?.id !== organizationId) {
        this.logger.warn('organization-service answered 200 without naming the organization asked');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      const version = body.hierarchyVersion;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        // "Within" without its version is not evidence a command can be ordered against (D-050).
        this.logger.warn('organization-service answered 200 without a hierarchy version; refusing');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      return { hierarchyVersion: version };
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted) {
        throw RastaError.upstreamTimeout(ORGANIZATION_SERVICE, timeoutMs);
      }
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
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

/** The body as JSON, or `null` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * organization-service's error body for an organization it looked for and did not find within the
 * signed one (`OrganizationService.confirmWithinCaller`). A route-level 404 goes through the same
 * filter with the same code, but its message is Nest's `Cannot GET …`, so the message is what
 * tells the two apart.
 */
const notFoundBodySchema = z.object({
  code: z.literal('NOT_FOUND'),
  message: z.literal('Organization not found'),
});

export function isOrganizationNotFound(body: unknown): boolean {
  return notFoundBodySchema.safeParse(body).success;
}
