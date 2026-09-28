/**
 * The gate the `keycloak-live` suite passes before it creates, changes or
 * deletes any Keycloak user.
 *
 * The suite does all three. Its Keycloak comes from the environment, so a
 * shell pointing `KEYCLOAK_URL` at a shared stack — or a tunnel from localhost
 * to one — would do them there (review of #129). So it goes on only when all
 * of these hold, checked in this order:
 *
 *   1. `KEYCLOAK_LIVE_ALLOW_WRITES` is exactly `true` — an opt-in typed for
 *      this suite, as `E2E_ALLOW_WRITES` is for the e2e suite (#117). Only the
 *      `e2e` CI job's step sets it. The realm marker below is data a realm
 *      administrator controls, not proof of disposability; the opt-in is the
 *      operator saying so on purpose.
 *   2. `NODE_ENV` is exactly `test`.
 *   3. `KEYCLOAK_URL` is on this machine's loopback interface.
 *   4. The realm itself says it is the disposable development realm: an admin
 *      `GET /admin/realms/{realm}` returns
 *      `attributes["rasta.disposable_stack"] === "true"`, which only the
 *      importable development realm carries (`infrastructure/docker/keycloak/
 *      rasta-realm.json`, loaded only by `dev-realm-gate.sh` into a
 *      `start-dev` Keycloak). Loopback proves where Keycloak is; the marker
 *      says what it is.
 *
 * **What happens before the gate passes.** Checks 1–3 read only the
 * environment: a run that fails any of them — an unopted run included — makes
 * **no network call at all**. Check 4 needs one admin authentication (a
 * password grant on `master`) and one realm read. No user is created, changed
 * or deleted before all four pass.
 *
 * **A copy, not an import**, of `tests/e2e/src/target-guard.ts` (#117): that
 * file belongs to the `@rasta/e2e` package, not to a shared test utility, and
 * a service does not import another workspace's test code. The two must agree;
 * `live-target-guard.spec.ts` pins this one.
 *
 * Refusals name the setting, never its value (S-09).
 */

/** The suite's own opt-in. Its only accepted value is `true`. */
export const LIVE_WRITE_OPT_IN = 'KEYCLOAK_LIVE_ALLOW_WRITES';

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

/** What the gate reads from the environment — no network. */
export interface LiveTargetEnvironment {
  KEYCLOAK_LIVE_ALLOW_WRITES?: string;
  NODE_ENV?: string;
  KEYCLOAK_URL: string;
}

/**
 * Why the environment may not run this suite, the opt-in first. Empty when it
 * may. Reads nothing but its argument.
 */
export function environmentRefusals(env: LiveTargetEnvironment): string[] {
  const reasons: string[] = [];
  if (env.KEYCLOAK_LIVE_ALLOW_WRITES !== 'true') {
    reasons.push(`${LIVE_WRITE_OPT_IN} is not exactly "true"`);
  }
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

/** How far a refused run got: nothing contacted, or one admin authentication and one realm read. */
export type RefusalStage = 'environment' | 'realm';

export class LiveTargetRefusedError extends Error {
  readonly reasons: readonly string[];
  readonly stage: RefusalStage;

  constructor(reasons: readonly string[], stage: RefusalStage) {
    super(
      `Refusing to run the keycloak-live suite: ${reasons.join('; ')}. ` +
        (stage === 'environment'
          ? 'Nothing was contacted.'
          : 'One admin authentication and one realm read happened; ' +
            'no user was created, changed or deleted.'),
    );
    this.name = 'LiveTargetRefusedError';
    this.reasons = reasons;
    this.stage = stage;
  }
}

/**
 * Runs the whole gate: the environment first, with nothing contacted, then —
 * only if it passes — `readRealm`, the one admin authentication and realm
 * read. Throws before any user is created, changed or deleted.
 */
export async function assertDisposableTarget(options: {
  env: LiveTargetEnvironment;
  realm: string;
  readRealm: () => Promise<unknown>;
}): Promise<void> {
  const reasons = environmentRefusals(options.env);
  if (reasons.length > 0) throw new LiveTargetRefusedError(reasons, 'environment');
  const refusal = disposableRealmRefusal(await options.readRealm(), options.realm);
  if (refusal) throw new LiveTargetRefusedError([refusal], 'realm');
}
