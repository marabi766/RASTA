import { z } from 'zod';

/**
 * Reading the access token's claims, for the interface only.
 *
 * ## Why the access token and not the ID token
 *
 * Not a preference. `infrastructure/docker/keycloak/rasta-realm.json` maps
 * `org_ids` with `"id.token.claim": "false"` and `"access.token.claim":
 * "true"`, so the membership set exists on the access token and nowhere else.
 * The gateway reads the same token, so what this file sees is what the
 * platform will enforce against.
 *
 * ## Why there is no signature check here
 *
 * There cannot be a meaningful one. A browser verifying a token it received
 * over the same channel proves nothing an attacker who controls that channel
 * could not also fake. Verification happens where it counts: the gateway
 * checks the signature, `iss`, `aud` and `exp` against Keycloak's JWKS
 * (ADR-008 Compliance), and every service re-checks independently (ADR-020).
 *
 * **Everything derived here is user-experience only** — which organizations to
 * offer in the switcher, which name to greet, which navigation entries to
 * show. docs/16 § 16.11 is explicit that hiding a control is not a security
 * control. If this file were fed a forged token, the result would be a portal
 * that renders buttons the server then refuses.
 */

const claimsSchema = z.object({
  sub: z.string(),
  exp: z.number().optional(),
  /** Platform user id (`rasta_uid`), absent for externally provisioned accounts. */
  rasta_uid: z.string().optional(),
  /** Active organization, when identity-service has synced one. */
  org_id: z.string().optional(),
  /** The membership set. Keycloak emits a single-valued claim as a bare string. */
  org_ids: z.union([z.array(z.string()), z.string()]).optional(),
  preferred_username: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  realm_access: z
    .object({ roles: z.array(z.string()) })
    .partial()
    .optional(),
});

export interface TokenClaims {
  readonly subject: string;
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  /** The active organization the identity provider knows about, if any. */
  readonly activeOrganizationId: string | null;
  /** Every organization the token says this user belongs to. */
  readonly organizationIds: readonly string[];
  readonly expiresAt: number | null;
}

export class UnreadableTokenError extends Error {
  constructor(reason: string) {
    super(`Access token claims could not be read: ${reason}`);
    this.name = 'UnreadableTokenError';
  }
}

export function readClaims(accessToken: string): TokenClaims {
  const parsed = claimsSchema.safeParse(decodePayload(accessToken));
  if (!parsed.success) throw new UnreadableTokenError(parsed.error.issues[0]?.message ?? 'invalid');

  const claims = parsed.data;
  const memberships = normalizeMemberships(claims.org_ids, claims.org_id);

  return {
    subject: claims.sub,
    userId: claims.rasta_uid ?? claims.sub,
    displayName: claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub,
    roles: claims.realm_access?.roles ?? [],
    activeOrganizationId: claims.org_id ?? null,
    organizationIds: memberships,
    expiresAt: claims.exp ? claims.exp * 1000 : null,
  };
}

/**
 * The membership set, with the active organization folded in.
 *
 * `mergeMemberships` in `packages/nest-common/src/guards/auth.guard.ts` does
 * the same on the server: an `org_id` that is not also in `org_ids` is still a
 * membership, and dropping it here would hide an organization the platform
 * would happily accept.
 */
function normalizeMemberships(
  organizationIds: string[] | string | undefined,
  activeOrganizationId: string | undefined,
): string[] {
  const collected = new Set<string>();

  if (Array.isArray(organizationIds)) for (const id of organizationIds) collected.add(id);
  else if (typeof organizationIds === 'string' && organizationIds) collected.add(organizationIds);

  if (activeOrganizationId) collected.add(activeOrganizationId);

  return [...collected];
}

function decodePayload(token: string): unknown {
  const segments = token.split('.');
  if (segments.length !== 3) throw new UnreadableTokenError('not a three-segment JWT');

  const payload = segments[1];
  if (!payload) throw new UnreadableTokenError('empty payload segment');

  try {
    return JSON.parse(base64UrlDecode(payload)) as unknown;
  } catch {
    throw new UnreadableTokenError('payload is not JSON');
  }
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);

  // Claims carry Persian names, so the bytes have to be read as UTF-8 rather
  // than as latin-1, which `atob` alone would produce.
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
