/**
 * The gate every demo seed passes before its first query.
 *
 * Each service's `prisma/seed.ts` upserts fixed identifiers — `ORG-DEH-0001`,
 * `USR-SEED-*` and so on — with demo values. `pnpm db:seed` runs all of them,
 * and each one connects to whatever `DATABASE_URL_<SERVICE>` is in the
 * environment. Run by an operator whose shell holds production credentials,
 * it would overwrite real tenants with sample data, with nothing to stop it.
 *
 * So a seed runs only when both hold:
 *
 *   1. `NODE_ENV` is explicitly `development` or `test`. Unset is refused: the
 *      platform's env schema defaults an unset NODE_ENV to `development`,
 *      which is the right default for a server's developer tooling and the
 *      wrong one for a command that writes. `staging` is refused too — it
 *      holds data somebody cares about.
 *   2. `RASTA_ALLOW_DEMO_SEED` is exactly `true`: an opt-in someone typed,
 *      separate from anything a deployment sets for other reasons.
 *
 * A configuration check, not business logic (AGENTS.md A-03): it decides
 * whether a script may run, never what the script writes.
 */

/** The environments a demo seed may write into. */
export const DEMO_SEED_ENVIRONMENTS = ['development', 'test'] as const;

/** The opt-in variable. Its only accepted value is `true`. */
export const DEMO_SEED_OPT_IN = 'RASTA_ALLOW_DEMO_SEED';

export class DemoSeedRefusedError extends Error {
  constructor(
    readonly service: string,
    readonly reasons: readonly string[],
  ) {
    super(
      `Refusing to seed ${service}: ${reasons.join('; ')}. ` +
        `Demo seeds overwrite fixed identifiers with sample data, so they run only with ` +
        `NODE_ENV=${DEMO_SEED_ENVIRONMENTS.join('|')} and ${DEMO_SEED_OPT_IN}=true. ` +
        'Nothing was written.',
    );
    this.name = 'DemoSeedRefusedError';
  }
}

/**
 * The reasons a seed may not run here; empty when it may.
 *
 * Never echoes a value it read — only which condition failed — so a refusal
 * printed to a shared terminal or CI log leaks nothing (S-09).
 */
export function demoSeedRefusals(env: NodeJS.ProcessEnv): string[] {
  const reasons: string[] = [];

  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv.trim() === '') {
    reasons.push('NODE_ENV is not set');
  } else if (!(DEMO_SEED_ENVIRONMENTS as readonly string[]).includes(nodeEnv)) {
    reasons.push('NODE_ENV is not a development or test environment');
  }

  if (env[DEMO_SEED_OPT_IN] !== 'true') {
    reasons.push(`${DEMO_SEED_OPT_IN} is not "true"`);
  }

  return reasons;
}

/**
 * Throws unless a demo seed may run. Call it first in the seed's `main()`,
 * before the database client issues anything.
 */
export function assertDemoSeedAllowed(service: string, env: NodeJS.ProcessEnv = process.env): void {
  const reasons = demoSeedRefusals(env);
  if (reasons.length > 0) throw new DemoSeedRefusedError(service, reasons);
}
