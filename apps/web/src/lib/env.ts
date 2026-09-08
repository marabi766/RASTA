import { z } from 'zod';

/**
 * The browser's view of its configuration.
 *
 * Four variables, all already defined in `.env.example`, all `NEXT_PUBLIC_`
 * and therefore all public by construction. That is the point: a public OIDC
 * client has nothing secret to hold (ADR-008), and docs/16 § 16.11 states the
 * rule plainly — «هیچ Secret در متغیرهای NEXT_PUBLIC_».
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only when the full
 * member expression appears in source, so each one is written out literally
 * rather than read through a loop or an index.
 */

const envSchema = z.object({
  /**
   * The API Gateway origin — and the only origin this application may call.
   *
   * Not a service port. Every cross-cutting control the platform has (JWT
   * verification, tenant resolution, rate limiting, correlation, circuit
   * breaking) lives in the gateway (ADR-009); a browser that reached
   * `localhost:3106` directly would be running with none of them.
   */
  apiBaseUrl: z.string().url(),
  keycloakUrl: z.string().url(),
  keycloakRealm: z.string().min(1),
  /** The public PKCE client from `rasta-realm.json`. No secret exists for it. */
  keycloakClientId: z.string().min(1),
});

export type PublicEnv = z.infer<typeof envSchema>;

export class MissingConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Frontend configuration is incomplete: ${issues.join(', ')}`);
    this.name = 'MissingConfigurationError';
  }
}

/**
 * Reads and validates the public configuration.
 *
 * Throws rather than falling back to a default. A default gateway URL is the
 * kind of convenience that turns a misconfigured deployment into a demo that
 * silently talks to the wrong environment.
 */
export function readPublicEnv(source: Record<string, string | undefined> = rawEnv()): PublicEnv {
  const parsed = envSchema.safeParse({
    apiBaseUrl: source.NEXT_PUBLIC_API_BASE_URL,
    keycloakUrl: source.NEXT_PUBLIC_KEYCLOAK_URL,
    keycloakRealm: source.NEXT_PUBLIC_KEYCLOAK_REALM,
    keycloakClientId: source.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID,
  });

  if (!parsed.success) {
    throw new MissingConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  return parsed.data;
}

/** The authority URL Keycloak publishes its discovery document under. */
export function oidcAuthority(env: PublicEnv): string {
  return `${env.keycloakUrl.replace(/\/+$/, '')}/realms/${env.keycloakRealm}`;
}

function rawEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_KEYCLOAK_URL: process.env.NEXT_PUBLIC_KEYCLOAK_URL,
    NEXT_PUBLIC_KEYCLOAK_REALM: process.env.NEXT_PUBLIC_KEYCLOAK_REALM,
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID,
  };
}
