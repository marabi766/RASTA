/**
 * How the browser suite starts a server it needs on a fixed port (TASK 323,
 * FU-021 from the review of #574; reworked in TASK 325 after the review of #675).
 *
 * `reuseExistingServer: true` answers "is something there?" and nothing more. A
 * hand-run `next dev` on :3200 satisfied it, so the production build was skipped
 * and the suite ran against the wrong server. The rule is the opposite way round
 * and fails closed: **the suite never reuses a server, and "ready" means that the
 * server this run launched is listening and no other process holds the port.**
 *
 * That cannot be decided when the config loads: the config is loaded again by
 * workers and by UI mode's loader (which would then refuse this run's own
 * servers), and a port that is free at load can be taken before the server binds.
 * So locally each server is started through `own-server.mjs`, which checks the
 * port before the command runs, checks every listening socket of the port (any
 * address family) against its own process tree for as long as the server lives,
 * and prints `RASTA_E2E_OWNED <port>`. Playwright waits for that line instead of
 * polling a URL, which a foreign listener could answer.
 *
 * CI starts its servers on a fresh machine, with the URL poll, as before.
 */

/** The line `own-server.mjs` prints once the port is held by its own server alone. */
export const OWNED_MARKER = 'RASTA_E2E_OWNED';

/** The `webServer` fields that decide how a server is started and when it is ready. */
export interface ServerStart {
  command: string;
  env: Record<string, string>;
  url?: string;
  wait?: { stdout: RegExp };
  reuseExistingServer: false;
}

export function serverStart(input: {
  ci: boolean;
  port: number;
  command: string;
  /** Polled in CI only; locally the launcher's proof replaces it. */
  url: string;
  env?: Record<string, string>;
}): ServerStart {
  const env = input.env ?? {};
  if (input.ci) {
    return { command: input.command, env, url: input.url, reuseExistingServer: false };
  }
  return {
    command: `node e2e/own-server.mjs ${input.port}`,
    env: { ...env, OWN_SERVER_COMMAND: input.command },
    wait: { stdout: new RegExp(`^${OWNED_MARKER} ${input.port}$`, 'm') },
    reuseExistingServer: false,
  };
}
