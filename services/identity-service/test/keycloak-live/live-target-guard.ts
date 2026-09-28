/**
 * The gate the `keycloak-live` suite passes before it writes anything.
 *
 * The suite creates, changes and deletes Keycloak users. Its Keycloak comes
 * from the environment, so a shell pointing `KEYCLOAK_URL` at a shared stack —
 * or a tunnel from localhost to one — would do all of that there (review of
 * #129, finding 1). So it writes only when all of these hold:
 *
 *   1. `NODE_ENV` is exactly `test`.
 *   2. `KEYCLOAK_URL` is on this machine's loopback interface.
 *   3. The realm itself says it is the disposable development realm: an admin
 *      `GET /admin/realms/{realm}` — nothing written — returns
 *      `attributes["rasta.disposable_stack"] === "true"`, which only the
 *      importable development realm carries (`infrastructure/docker/keycloak/
 *      rasta-realm.json`, loaded only by `dev-realm-gate.sh` into a
 *      `start-dev` Keycloak). Loopback proves where Keycloak is; the marker
 *      proves what it is.
 *
 * **A copy, not an import**, of `tests/e2e/src/target-guard.ts` (#117): that
 * file belongs to the `@rasta/e2e` package, not to a shared test utility, and
 * a service does not import another workspace's test code. The two must agree;
 * `live-target-guard.spec.ts` pins this one.
 *
 * Refusals name the setting, never its value (S-09).
 */

/** The realm attribute only the importable development realm carries. */
export const DISPOSABLE_REALM_ATTRIBUTE = 'rasta.disposable_stack';

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

/**
 * Why the environment may not run this suite — before anything is contacted.
 * Empty when it may.
 */
export function environmentRefusals(env: { NODE_ENV?: string; KEYCLOAK_URL: string }): string[] {
  const reasons: string[] = [];
  if (env.NODE_ENV !== 'test') reasons.push('NODE_ENV is not exactly "test"');
  let host: string | undefined;
  try {
    const url = new URL(env.KEYCLOAK_URL);
    host = url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : undefined;
  } catch {
    host = undefined;
  }
  if (host === undefined) reasons.push('KEYCLOAK_URL is not an http(s) URL');
  else if (!isLoopbackHost(host)) reasons.push('KEYCLOAK_URL is not a loopback address');
  return reasons;
}

/**
 * Why the realm representation an admin GET returned is not the disposable
 * development realm — or `null` when it is. Fails closed on any shape but a
 * representation of the expected realm carrying the marker exactly.
 */
export function disposableRealmRefusal(representation: unknown, realm: string): string | null {
  if (typeof representation !== 'object' || representation === null) {
    return 'Keycloak returned no realm representation for KEYCLOAK_REALM';
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

export class LiveTargetRefusedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Refusing to run the keycloak-live suite: ${reasons.join('; ')}. Nothing was written.`);
    this.name = 'LiveTargetRefusedError';
    this.reasons = reasons;
  }
}

/**
 * Runs the whole gate: the environment first, with nothing contacted, then
 * one read-only admin GET of the realm. Throws before any write.
 */
export async function assertDisposableTarget(options: {
  env: { NODE_ENV?: string; KEYCLOAK_URL: string };
  realm: string;
  readRealm: () => Promise<unknown>;
}): Promise<void> {
  const reasons = environmentRefusals(options.env);
  if (reasons.length > 0) throw new LiveTargetRefusedError(reasons);
  const refusal = disposableRealmRefusal(await options.readRealm(), options.realm);
  if (refusal) throw new LiveTargetRefusedError([refusal]);
}
