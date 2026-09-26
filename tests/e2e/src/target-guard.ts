import type { E2eConfig } from './env';

/**
 * The gate this suite passes before it touches anything.
 *
 * The suite writes. `ensureTenantBUser` may switch the realm's user profile to
 * admin-edited attributes and create — or overwrite — a fixed ORGANIZATION_ADMIN
 * whose password sits in this repository, and the scenarios move money between
 * seeded wallets. Every URL it uses comes from the environment, so a shell
 * that points `KEYCLOAK_URL` or `E2E_GATEWAY_URL` at a shared stack would do
 * all of that there (Codex post-merge review of #105, finding 2).
 *
 * So it runs only when all three hold:
 *
 *   1. `NODE_ENV` is exactly `test` — the run says what it is.
 *   2. `E2E_ALLOW_WRITES` is exactly `true` — an opt-in typed for this suite,
 *      separate from the demo seeds' `RASTA_ALLOW_DEMO_SEED`.
 *   3. Every endpoint it will reach — gateway, each service, Keycloak and every
 *      Kafka broker — is on this machine's loopback interface. That is where
 *      `pnpm infra:up` and the CI jobs put their disposable stack, and it is
 *      the one place a remote, shared environment cannot be. There is no
 *      override: a disposable stack elsewhere is reached through a tunnel or a
 *      port-forward to localhost, which is a deliberate act.
 *
 * Refusals name the variable, never its value (S-09).
 *
 * Loopback proves where an endpoint is, not what it is: a tunnel, or a local
 * gateway with production upstreams, passes it (Codex review of #117,
 * finding 2). So before its first Keycloak write the suite also reads — with a
 * non-mutating admin GET — a marker the realm itself carries:
 * `rasta.disposable_stack = "true"`, a realm attribute set only in the
 * importable development realm (`infrastructure/docker/keycloak/
 * rasta-realm.json`, which only `dev-realm-gate.sh` loads, only into a
 * `start-dev` Keycloak). A realm without it is refused. The gateway's
 * upstreams and each service's identity are not verified yet: that needs
 * service code, and is a recorded follow-up.
 */

/** The realm attribute only the importable development realm carries. */
export const DISPOSABLE_REALM_ATTRIBUTE = 'rasta.disposable_stack';

/**
 * Why the realm representation an admin GET returned is not the disposable
 * development realm — or `null` when it is. Fails closed on any shape but a
 * representation of the expected realm carrying the marker exactly.
 */
export function disposableRealmRefusal(representation: unknown, realm: string): string | null {
  if (typeof representation !== 'object' || representation === null) {
    return `Keycloak returned no realm representation for KEYCLOAK_REALM`;
  }
  const rep = representation as { realm?: unknown; attributes?: unknown };
  if (rep.realm !== realm) return 'Keycloak answered for a different realm than KEYCLOAK_REALM';
  const attributes = rep.attributes;
  const marker =
    typeof attributes === 'object' && attributes !== null
      ? (attributes as Record<string, unknown>)[DISPOSABLE_REALM_ATTRIBUTE]
      : undefined;
  if (marker !== 'true') {
    return (
      `the Keycloak realm does not carry ${DISPOSABLE_REALM_ATTRIBUTE}="true", which only the ` +
      'importable development realm sets — it is not the disposable stack'
    );
  }
  return null;
}

/** The environment this suite may run in. */
export const E2E_ENVIRONMENT = 'test';

/** The suite's own opt-in. Its only accepted value is `true`. */
export const E2E_WRITE_OPT_IN = 'E2E_ALLOW_WRITES';

export class E2eTargetRefusedError extends Error {
  // A declared field, not a parameter property: `node --test` runs this file
  // with type stripping only, which has no parameter properties.
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      `Refusing to run the end-to-end suite: ${reasons.join('; ')}. ` +
        'It creates users and moves money, so it runs only with ' +
        `NODE_ENV=${E2E_ENVIRONMENT} and ${E2E_WRITE_OPT_IN}=true, against a stack whose every ` +
        'endpoint is on loopback (localhost, 127.0.0.0/8 or ::1). Nothing was contacted.',
    );
    this.name = 'E2eTargetRefusedError';
    this.reasons = reasons;
  }
}

/** localhost, the whole 127.0.0.0/8 block, and ::1 — nothing that resolves elsewhere. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** A broker is `host:port`; an IPv6 literal must be bracketed, as kafkajs expects. */
function brokerHost(broker: string): string | undefined {
  return urlHost(`http://${broker}`);
}

type Endpoints = Pick<
  E2eConfig,
  | 'gatewayUrl'
  | 'economicUrl'
  | 'marketplaceUrl'
  | 'documentUrl'
  | 'auditUrl'
  | 'identityUrl'
  | 'constructionUrl'
  | 'keycloakUrl'
  | 'kafkaBrokers'
>;

/**
 * Which setting names each endpoint, so a refusal says what to fix.
 */
const URL_SETTINGS: ReadonlyArray<[keyof Omit<Endpoints, 'kafkaBrokers'>, string]> = [
  ['gatewayUrl', 'E2E_GATEWAY_URL'],
  ['economicUrl', 'E2E_ECONOMIC_URL'],
  ['marketplaceUrl', 'E2E_MARKETPLACE_URL'],
  ['documentUrl', 'E2E_DOCUMENT_URL'],
  ['auditUrl', 'E2E_AUDIT_URL'],
  ['identityUrl', 'E2E_IDENTITY_URL'],
  ['constructionUrl', 'E2E_CONSTRUCTION_URL'],
  ['keycloakUrl', 'KEYCLOAK_URL'],
];

/** The reasons this suite may not run here; empty when it may. */
export function e2eTargetRefusals(endpoints: Endpoints, env: NodeJS.ProcessEnv): string[] {
  const reasons: string[] = [];

  if (env.NODE_ENV !== E2E_ENVIRONMENT) {
    reasons.push(`NODE_ENV is not "${E2E_ENVIRONMENT}"`);
  }
  if (env[E2E_WRITE_OPT_IN] !== 'true') {
    reasons.push(`${E2E_WRITE_OPT_IN} is not "true"`);
  }

  for (const [field, setting] of URL_SETTINGS) {
    const host = urlHost(endpoints[field]);
    if (host === undefined) {
      reasons.push(`${setting} is not an http(s) URL`);
    } else if (!isLoopbackHost(host)) {
      reasons.push(`${setting} is not a loopback address`);
    }
  }

  if (endpoints.kafkaBrokers.length === 0) {
    reasons.push('KAFKA_BROKERS names no broker');
  }
  for (const broker of endpoints.kafkaBrokers) {
    const host = brokerHost(broker);
    if (host === undefined || !isLoopbackHost(host)) {
      reasons.push('KAFKA_BROKERS names a broker that is not a loopback address');
      break;
    }
  }

  return reasons;
}

/**
 * Throws unless the suite may run against this stack. Call it first in
 * `globalSetup`, before any request, token or admin call.
 */
export function assertDisposableE2eTarget(
  endpoints: Endpoints,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const reasons = e2eTargetRefusals(endpoints, env);
  if (reasons.length > 0) throw new E2eTargetRefusedError(reasons);
}
