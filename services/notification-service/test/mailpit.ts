/**
 * What an integration suite does when Mailpit is not there.
 *
 * Locally, `pnpm infra:up` does not start Mailpit (compose puts it behind the
 * `tools`/`all` profiles), so a suite that failed without it would be red on a
 * correct default stack: there it warns and its tests return early. CI
 * provisions Mailpit as a service container and sets `REQUIRE_MAILPIT=1`, and
 * then the same absence is an error — a green job must mean the SMTP
 * assertions ran, not that they were skipped.
 */
export const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

export async function mailpitReachable(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT_API}/api/v1/messages?limit=1`)).ok;
  } catch {
    return false;
  }
}

export function mailpitRequired(): boolean {
  return process.env.REQUIRE_MAILPIT === '1';
}

/** Call from `beforeAll` with the probe result; throws when Mailpit is required and absent. */
export function requireMailpitOrWarn(available: boolean): void {
  if (available) return;
  if (mailpitRequired()) {
    throw new Error(
      `REQUIRE_MAILPIT=1 but Mailpit is not reachable at ${MAILPIT_API}; ` +
        'refusing to skip the SMTP assertions.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    `Mailpit is not reachable at ${MAILPIT_API}; skipping. ` +
      'Start it with: docker compose --profile tools up -d mailpit',
  );
}
