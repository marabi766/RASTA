import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** The development observer's principal (RUN-006, broker-acls.development.json). */
export const OBSERVER_PRINCIPAL = 'itest-observer';

/** The only credential this harness ever reads. */
export const OBSERVER_PASSWORD_VARIABLE = 'KAFKA_SASL_PASSWORD_ITEST_OBSERVER';

/** The repository root: the nearest directory up from `start` with pnpm-workspace.yaml. */
export function repositoryRoot(start: string = process.cwd()): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}

export interface ObserverKafkaSettings {
  password: string | undefined;
  /** The CA to trust, or `undefined` for PLAINTEXT. */
  caFile: string | undefined;
}

interface Files {
  exists(path: string): boolean;
  read(path: string): string;
}

const DISK: Files = { exists: existsSync, read: (path) => readFileSync(path, 'utf8') };

/** One variable's value from a dotenv-style file, or undefined. Nothing else is read. */
function valueIn(text: string, variable: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && match[1] === variable && match[2]) return match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/**
 * How the E2E harness reaches the authenticated broker, read explicitly and
 * narrowly (review of #131, finding 6): `playwright test` loads no env file,
 * and the repository `.env` deliberately holds no observer credential.
 *
 *   - the password: `KAFKA_SASL_PASSWORD_ITEST_OBSERVER` from the environment
 *     (CI sets it for this one step), else from the bootstrap-only file —
 *     `infrastructure/docker/kafka/bootstrap.env`, then its committed
 *     example. Only that one variable is read from them: the admin's and
 *     ops-replay's passwords beside it are never loaded.
 *   - TLS: `KAFKA_SSL_CA_FILE` when set (a relative path from the repository
 *     root), else the CA `pnpm infra:up` exported, when it exists;
 *     `KAFKA_SSL=false` turns TLS off.
 */
export function observerKafkaSettings(
  env: NodeJS.ProcessEnv = process.env,
  files: Files = DISK,
  root: string = repositoryRoot(),
): ObserverKafkaSettings {
  let password = env[OBSERVER_PASSWORD_VARIABLE]?.trim() || undefined;
  if (!password) {
    for (const file of ['bootstrap.env', 'bootstrap.env.example']) {
      const path = resolve(root, 'infrastructure/docker/kafka', file);
      if (!files.exists(path)) continue;
      password = valueIn(files.read(path), OBSERVER_PASSWORD_VARIABLE);
      if (password) break;
    }
  }

  const tlsOff = /^(false|0|no|off)$/i.test(env.KAFKA_SSL?.trim() ?? '');
  const configured = env.KAFKA_SSL_CA_FILE?.trim();
  const exported = resolve(root, 'infrastructure/docker/kafka/.tls/ca.pem');
  const caFile = tlsOff
    ? undefined
    : configured
      ? isAbsolute(configured)
        ? configured
        : resolve(root, 'tests/e2e', configured)
      : files.exists(exported)
        ? exported
        : undefined;
  return { password, caFile };
}
