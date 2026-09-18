import { z } from 'zod';
import type { InternalTokenService } from '@rasta/nest-common';
import { IDENTITY_SERVICE, SERVICE_NAME } from '../config/env';
import { RESOLUTION_FAILURE_REASONS } from '../observability/metrics';
import {
  RecipientResolutionError,
  type RecipientCandidate,
  type RecipientPort,
  type RecipientQuery,
  type RecipientResolution,
} from './recipient.port';

/**
 * Recipient resolution over identity-service's REST API (ADR-054 § 1).
 *
 * ```
 * GET /v1/users?role=FLEET_MANAGER&status=ACTIVE&limit=200
 * X-Internal-Token: <SERVICE token, aud=identity-service, signed org_id>
 * ```
 *
 * ## Authentication
 *
 * Each call carries an internal token minted for exactly this target and
 * exactly one organization, with the tenant **inside the signature**
 * (ADR-035). identity-service's `AuthGuard` scopes the membership query from
 * that claim, so this adapter cannot ask about an organization the token was
 * not minted for. `X-Organization-Id` is deliberately not sent: it would add
 * no authority and one more way for two values to disagree.
 *
 * Calls do not go through the gateway, which mints `RELAY` tokens and never
 * `SERVICE` ones — precisely so the component exposed to outside traffic
 * cannot forge a service identity (D-007).
 *
 * ## What is kept from the response, and what is not
 *
 * identity's user view carries `email`, `phone` and names. The response
 * schema below is a non-strict Zod object, and Zod **strips** keys it does
 * not declare — so nothing past `id`, `status` and `roles` survives parsing.
 * No address enters this process's data model, no address can reach a log
 * line, and `email_snapshot` stays null until the story that needs it
 * (NTF-004) reads it on purpose.
 */

const userPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string(),
      roles: z.array(z.string()).default([]),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean().default(false),
});

/** identity caps a page at `MAX_PAGE_SIZE` (200); asking for more is a 400. */
const PAGE_SIZE = 200;

/** A bound on pages per role, so a pathological cursor cannot loop forever. */
const MAX_PAGES_PER_ROLE = 50;

export interface IdentityHttpOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export class IdentityHttpRecipientAdapter implements RecipientPort {
  constructor(
    private readonly options: IdentityHttpOptions,
    private readonly tokens: InternalTokenService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(query: RecipientQuery): Promise<RecipientResolution> {
    const merged = new Map<string, RecipientCandidate>();
    let truncated = false;

    // Minted once per resolution and reused across roles and pages: the same
    // target, the same organization, and a TTL far longer than the call.
    const token = await this.tokens.issue(
      SERVICE_NAME,
      IDENTITY_SERVICE,
      'SERVICE',
      query.organizationId,
    );

    for (const role of query.roles) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_ROLE; page += 1) {
        const result = await this.fetchPage(token, role, cursor, query.correlationId);

        for (const user of result.items) {
          // `status=ACTIVE` is the query; re-checking costs nothing and means
          // a producer that ignored the filter still cannot make an inactive
          // account a recipient.
          if (user.status !== 'ACTIVE') continue;
          if (merged.has(user.id)) continue;
          if (merged.size >= query.limit) {
            truncated = true;
            break;
          }
          merged.set(user.id, { userId: user.id, role });
        }

        if (truncated || !result.hasMore || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      if (truncated) break;
    }

    return { recipients: [...merged.values()], truncated };
  }

  private async fetchPage(
    token: string,
    role: string,
    cursor: string | undefined,
    correlationId: string,
  ): Promise<z.infer<typeof userPageSchema>> {
    const url = new URL('/v1/users', this.options.baseUrl);
    url.searchParams.set('role', role);
    url.searchParams.set('status', 'ACTIVE');
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          'x-correlation-id': correlationId,
        },
        signal: controller.signal,
      });
    } catch (error) {
      // The error object is not forwarded: depending on the runtime it can
      // carry the request URL and headers, and the header is the token.
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? RESOLUTION_FAILURE_REASONS.TIMEOUT
          : RESOLUTION_FAILURE_REASONS.UNREACHABLE;
      throw new RecipientResolutionError(reason, `identity-service GET /v1/users did not complete`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 401/403 (the token or the allowlist), 404 (a route that moved), 5xx
      // — all retryable from this side, all the same class: identity refused
      // to answer. The status is the only detail kept; the body is not read.
      throw new RecipientResolutionError(
        RESOLUTION_FAILURE_REASONS.REFUSED,
        `identity-service answered ${response.status}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new RecipientResolutionError(
        RESOLUTION_FAILURE_REASONS.MALFORMED_RESPONSE,
        'identity-service answered with a body that is not JSON',
      );
    }

    const page = userPageSchema.safeParse(parsed);
    if (!page.success) {
      throw new RecipientResolutionError(
        RESOLUTION_FAILURE_REASONS.MALFORMED_RESPONSE,
        'identity-service answered with a shape this adapter does not recognise',
      );
    }
    return page.data;
  }
}
