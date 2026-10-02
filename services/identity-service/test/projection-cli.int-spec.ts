import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { databaseUrl } from './helpers';

/**
 * `keycloak:backfill` / `keycloak:reconcile` refuse an owner role before they
 * read a row or call Keycloak (D-045, Codex on #177).
 *
 * The CLI builds PrismaService by hand rather than booting the application, so
 * neither of the service's gates — main.ts's preflight, AppModule's check —
 * stands in front of it. Pointed at the migrator, it would read identity data
 * and write Keycloak attributes as the database owner. It now runs
 * `preflightRuntimeRole` itself. This runs the real CLI, as the package script
 * does, against a stub Keycloak that counts the requests it receives: with the
 * migrator's URL the process exits 2 naming the role — never the URL — and
 * Keycloak is never called; with the runtime URL it gets past the gate.
 */
const SERVICE_DIR = join(__dirname, '..');
const RUN_TIMEOUT_MS = 90_000;

function migratorUrl(): string {
  const url = process.env.DATABASE_URL_IDENTITY_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_IDENTITY_MIGRATOR is not set; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return url;
}

interface CliRun {
  code: number | null;
  output: string;
}

/** `node -r @swc-node/register src/keycloak/projection.cli.ts <mode>`, as package.json runs it. */
function runCli(mode: 'backfill' | 'reconcile', url: string, keycloakUrl: string): Promise<CliRun> {
  // Exactly what the CLI needs and nothing else: no *_MIGRATOR variable, so the
  // only way the owner reaches it is the URL itself.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SERVICE_VERSION: '0.1.0-itest',
    DATABASE_URL: url,
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_ALLOW_PLAINTEXT: 'true',
    OIDC_ISSUER_URL: 'http://identitytest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://identitytest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: randomBytes(32).toString('hex'),
    KEYCLOAK_URL: keycloakUrl,
    KEYCLOAK_REALM: 'rasta',
    KEYCLOAK_BACKEND_CLIENT_ID: 'identity-itest',
    KEYCLOAK_BACKEND_CLIENT_SECRET: randomBytes(16).toString('hex'),
    KEYCLOAK_SYNC_ENABLED: 'true',
    AUDIT_SERVICE_URL: 'http://127.0.0.1:9',
  };
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ['-r', '@swc-node/register', 'src/keycloak/projection.cli.ts', mode],
      { cwd: SERVICE_DIR, env },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`projection.cli.ts ${mode} did not finish:\n${output}`));
    }, RUN_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

describe('the Keycloak projection CLI runs only as the runtime role (D-045)', () => {
  let keycloak: Server;
  let keycloakUrl: string;
  let requests = 0;

  beforeAll(async () => {
    // Answers nothing useful: a run that reached it would fail later, but the
    // count is what matters — the refused run must not reach it at all.
    keycloak = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503).end();
    });
    await new Promise<void>((listening) => keycloak.listen(0, '127.0.0.1', listening));
    keycloakUrl = `http://127.0.0.1:${(keycloak.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((closed) => keycloak.close(closed));
  });

  beforeEach(() => {
    requests = 0;
  });

  it.each(['backfill', 'reconcile'] as const)(
    '%s with the migrator URL exits 2 naming the role, before it reads a row or calls Keycloak',
    async (mode) => {
      const owner = migratorUrl();
      const run = await runCli(mode, owner, keycloakUrl);

      expect(run.code).toBe(2);
      expect(run.output).toMatch(
        /identity-service refuses to start: it is connected as rasta_identity_migrator/,
      );
      // The refusal names the role and what it owns — never the URL or its password.
      expect(run.output).not.toContain(owner);
      expect(run.output).not.toContain(decodeURIComponent(new URL(owner).password));
      expect(requests).toBe(0);
    },
    RUN_TIMEOUT_MS + 10_000,
  );

  it(
    'with the runtime URL gets past the gate',
    async () => {
      const run = await runCli('backfill', databaseUrl(), keycloakUrl);

      expect(run.output).not.toMatch(/refuses to start/);
      // Past the gate it either finds nothing to project (exit 0) or reaches
      // Keycloak, which this stub refuses: either way it ran as the runtime role.
      expect(run.code === 0 || requests > 0).toBe(true);
    },
    RUN_TIMEOUT_MS + 10_000,
  );
});
