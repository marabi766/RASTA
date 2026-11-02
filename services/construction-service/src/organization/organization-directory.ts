import { InternalHttpClient } from '@rasta/nest-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext, upstreamExchange } from '@rasta/nest-common';
import { z } from 'zod';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';

/** The service whose hierarchy decides "under the union" (Q-70 (7)). */
export const ORGANIZATION_SERVICE = 'organization-service';

/**
 * The only valid answer is `{ "id": "<organization id>" }` — well under this.
 * Anything longer is not the contract and is refused unread.
 */
export const MAX_RESPONSE_BYTES = 1024;

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
export async function readCapped(response: Response, limit: number): Promise<string | null> {
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

/**
 * The one question construction-service asks organization-service: is
 * `organizationId` the organization `scopeOrganizationId`, or beneath it?
 *
 * Q-70 (7), decided 2026-09-26: a union administrator writes approval
 * policies for the organizations under its union, and that is checked against
 * organization-service's hierarchy when the policy is written — never guessed
 * from anything this service holds.
 *
 * ## The call
 *
 * `GET {ORGANIZATION_SERVICE_URL}/v1/organizations/{organizationId}` with an
 * `X-Internal-Token` minted for organization-service and signed for
 * `scopeOrganizationId` — the tenant is inside the signature (ADR-035).
 * organization-service answers a construction-service token with `{ id }`
 * when the organization is the signed one or beneath it, and 404 with its error
 * body (`Organization not found`) otherwise (its contract test,
 * `construction-hierarchy-contract.int-spec.ts`).
 *
 * The user's own token is deliberately not forwarded: organization-service
 * treats `UNION_ADMIN` as a platform operator that sees every organization,
 * so a union administrator's token would prove nothing about the hierarchy.
 *
 * ## Fail closed
 *
 * 200 with the same id → within. 404 with organization-service's own
 * `Organization not found` body → not within. Anything else — another status, a
 * 404 without that body (a proxy's page, an empty body, a missing route), a body
 * that does not name the organization or is larger than `MAX_RESPONSE_BYTES`, a
 * timeout (which covers the body read and parse, not only the headers), a
 * network error — is `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT`: the policy
 * write or use is refused, and the reconciliation sweeper leaves the policy as it
 * is and retries the task. "Could not confirm" is never read as "confirmed" — nor
 * as "outside", which would suspend a valid policy (as contract-service, #248).
 */
@Injectable()
export class OrganizationDirectory {
  private readonly logger = new Logger(OrganizationDirectory.name);

  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  /**
   * Does `organizationId` exist? The same call, signed for the organization
   * itself: organization-service answers `{ id }` when the organization is the
   * signed one (or beneath it), and 404 when there is no such organization.
   * Used before inviting an organization to a tender (CON-002); fail closed like
   * `isWithin` — an unconfirmed answer is an error, never "exists".
   */
  exists(organizationId: string): Promise<boolean> {
    return this.isWithin(organizationId, organizationId);
  }

  async isWithin(scopeOrganizationId: string, organizationId: string): Promise<boolean> {
    const sender = await new InternalHttpClient(this.tokens).authorize({
      from: SERVICE_NAME,
      to: ORGANIZATION_SERVICE,
      purpose: 'SERVICE',
      organizationId: scopeOrganizationId,
    });
    const url =
      `${this.env.ORGANIZATION_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/organizations/${encodeURIComponent(organizationId)}`;

    const timeoutMs = this.env.CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS;
    // One deadline for the whole exchange: headers, body and parse. A server
    // that answers 200 and then stalls its body is a timeout, not a hang.
    return upstreamExchange(
      ORGANIZATION_SERVICE,
      timeoutMs,
      (signal) =>
        sender.send(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-correlation-id': getContext().correlationId,
          },
          signal,
        }),
      async (response) => {
        if (response.status === 404) {
          // "Not within" only when organization-service's own handler said so, about an
          // organization (`isOrganizationNotFound`). Any other 404 — a proxy's HTML page, an empty
          // body, a route missing during a deploy — proves nothing about the hierarchy, and read as
          // "outside" it would suspend a valid policy: unavailable instead, and the caller retries.
          const text = await readCapped(response, MAX_RESPONSE_BYTES);
          if (text !== null && isOrganizationNotFound(parseJson(text))) return false;
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
        const body = parseJson(text) as { id?: unknown } | null;
        if (body?.id === organizationId) return true;
        this.logger.warn('organization-service answered 200 without naming the organization asked');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      },
    );
  }
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
 * signed one: `RastaError.notFound('Organization', id)` rendered by the global exception filter. A
 * route-level 404 goes through the same filter with the same code, but its message is Nest's
 * `Cannot GET …`, so the message is what tells the two apart (as contract-service, #248).
 */
const notFoundBodySchema = z.object({
  code: z.literal('NOT_FOUND'),
  message: z.literal('Organization not found'),
});

export function isOrganizationNotFound(body: unknown): boolean {
  return notFoundBodySchema.safeParse(body).success;
}
