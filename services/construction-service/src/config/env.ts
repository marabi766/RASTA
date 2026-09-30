import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';
import { isKekId, parseKekEntries } from '../tender/sealing/key-provider';
import {
  CANCELLABLE_BY_LIFECYCLE,
  PROJECT_STATES,
  type ProjectStateName,
} from '../project/project.state-machine';

export const SERVICE_NAME = 'construction-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2). */
export const CONSTRUCTION_TOPIC = 'rasta.construction.v1';

/** The port `.env.example` and the gateway's `CONSTRUCTION_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3110';

/**
 * The oversight role. Refused by this service whatever the configuration says
 * (`docs/09` § 9.3: aggregate access only), so naming it in a role list below
 * is a configuration error rather than a grant.
 */
const REFUSED_ROLE = 'AUDITOR';

/** A comma-separated list, trimmed, with empty elements dropped. */
function commaList() {
  return z.string().transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

/** A list of platform roles that may never include the oversight role. */
function roleList(name: string, options: { min: number }) {
  return commaList().pipe(
    z
      .array(z.enum(PLATFORM_ROLES, { errorMap: () => ({ message: `Unknown role in ${name}` }) }))
      .min(options.min, `${name} must name at least ${options.min} role`)
      .refine((roles) => !roles.includes(REFUSED_ROLE), {
        message: `${name} may not name ${REFUSED_ROLE}: the oversight role has aggregate access only`,
      }),
  );
}

/**
 * construction-service configuration.
 *
 * ## Every domain setting here is a provisional answer to an open question
 *
 * The defaults are the provisional decisions recorded in `docs/24`, chosen to be
 * the narrowest behaviour that still works, and each can be changed by the
 * client without a code change (ADR-023, AGENTS.md § 9):
 *
 *   CONSTRUCTION_PROJECT_ROLES          Q-69. Who creates, edits, submits and
 *                                       cancels projects and needs. Default
 *                                       `ORGANIZATION_ADMIN`, the role
 *                                       `docs/16` § 16.6 gives `/projects`.
 *   CONSTRUCTION_PROJECT_READER_ROLES   Q-69. Who may only read, in addition to
 *                                       the writers. Default: nobody.
 *   CONSTRUCTION_CANCELLABLE_STATES     Q-69. Which states `cancel` may leave.
 *                                       Only a subset of the lifecycle's own
 *                                       cancellable states; anything else stops
 *                                       the service at startup.
 *   CONSTRUCTION_OPERATION_TYPES        Q-68. Empty (the default) means
 *                                       `operationType` is free text; a list
 *                                       means only those values. The platform
 *                                       ships no list of its own.
 *
 *   CONSTRUCTION_POLICY_FOUR_EYES       PROVISIONAL, pending the owner (Q-70):
 *                                       whether this may be switched off is
 *                                       still open. Default `true`: the
 *                                       SYSTEM_ADMIN who approves a policy
 *                                       differs from its author and submitter.
 *                                       `false` lets a SYSTEM_ADMIN approve its
 *                                       own policy only — never a union's —
 *                                       and logs a WARN at startup. Who writes
 *                                       a policy is not configurable: the owner
 *                                       decided that (Q-70 (7)).
 *   ORGANIZATION_SERVICE_URL            Where the union hierarchy is confirmed.
 *   CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS
 *                                       How long that confirmation may take;
 *                                       no answer in time refuses (504).
 *   CONSTRUCTION_RECONCILE_INTERVAL_MS / _BATCH_SIZE / _LEASE_SECONDS /
 *   _BACKOFF_SECONDS / _BACKOFF_MAX_SECONDS
 *                                       The sweeper that suspends policies a
 *                                       moved organization stranded (Q-83).
 *   CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS
 *                                       Q-68. Submitted needs a project must
 *                                       have before it may request approval.
 *   CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE
 *                                       Q-68. Whether an estimate is required
 *                                       before requesting approval.
 *   CONSTRUCTION_START_REQUIRES_CONTRACT
 *                                       Q-71. `true` refuses to start any
 *                                       project until the contract boundary
 *                                       (CON-003) exists.
 *   CONSTRUCTION_PROGRESS_ALLOW_DECREASE
 *                                       Q-72. Whether a submitted progress
 *                                       report may report less than the last.
 *
 * `SYSTEM_ADMIN` is always accepted for project and policy commands, as
 * everywhere on the platform, and never needs to be listed. It is **not**
 * accepted as an approval authority: only the (organization, role) a policy
 * names decides (ADR-023).
 *
 * Nothing here names an approval authority, an approval threshold or a legal
 * procedure. Those are rows in `approval_policy` (PR 2, ADR-063), never
 * environment values.
 */
export const constructionEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    CONSTRUCTION_PROJECT_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('CONSTRUCTION_PROJECT_ROLES', { min: 1 })),

    CONSTRUCTION_PROJECT_READER_ROLES: z
      .string()
      .default('')
      .pipe(roleList('CONSTRUCTION_PROJECT_READER_ROLES', { min: 0 })),

    CONSTRUCTION_CANCELLABLE_STATES: z
      .string()
      .default(CANCELLABLE_BY_LIFECYCLE.join(','))
      .pipe(
        commaList().pipe(
          z
            .array(
              z.enum(PROJECT_STATES, {
                errorMap: () => ({ message: 'Unknown state in CONSTRUCTION_CANCELLABLE_STATES' }),
              }),
            )
            .refine((states) => states.every((state) => CANCELLABLE_BY_LIFECYCLE.includes(state)), {
              message:
                'CONSTRUCTION_CANCELLABLE_STATES may only name states the lifecycle can cancel from: ' +
                CANCELLABLE_BY_LIFECYCLE.join(', '),
            }),
        ),
      ),

    CONSTRUCTION_OPERATION_TYPES: z
      .string()
      .default('')
      .pipe(
        commaList().pipe(
          z.array(
            z
              .string()
              .min(2, 'Each CONSTRUCTION_OPERATION_TYPES entry must be 2 to 100 characters')
              .max(100, 'Each CONSTRUCTION_OPERATION_TYPES entry must be 2 to 100 characters'),
          ),
        ),
      ),

    /**
     * Q-70 (7), decided 2026-09-26: a SYSTEM_ADMIN approving a policy must not
     * be the one who wrote or submitted it. `false` only where the platform
     * has a single administrator — a choice the owner records.
     */
    CONSTRUCTION_POLICY_FOUR_EYES: booleanEnv(true),

    /**
     * Where organization-service answers "is this organization within the
     * union?" (Q-70 (7)). Anything but a 200 or a 404 refuses the policy write.
     */
    ORGANIZATION_SERVICE_URL: z.string().url().default('http://localhost:3102'),
    CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(3000),

    /**
     * The sweeper behind ORGANIZATION_MOVED (Q-83, docs/23 D-041). A sweep
     * every `INTERVAL_MS` claims at most `BATCH_SIZE` due tasks, so one sweep
     * costs at most BATCH_SIZE × CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS;
     * `LEASE_SECONDS` must exceed that, or a slow sweep loses its claims to
     * another instance (harmless — the writes are conditional — but wasteful).
     * A failed task is retried after `BACKOFF_SECONDS`, doubling to `BACKOFF_MAX_SECONDS`.
     */
    CONSTRUCTION_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(500).max(300_000).default(5000),
    CONSTRUCTION_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    CONSTRUCTION_RECONCILE_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    CONSTRUCTION_RECONCILE_BACKOFF_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
    CONSTRUCTION_RECONCILE_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(900),

    CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS: z.coerce.number().int().min(0).max(1000).default(1),
    CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE: booleanEnv(true),
    CONSTRUCTION_START_REQUIRES_CONTRACT: booleanEnv(false),
    CONSTRUCTION_PROGRESS_ALLOW_DECREASE: booleanEnv(false),

    /**
     * The key-encryption keys that wrap each tender's private key (ADR-066 § 2):
     * `id:base64,id:base64`, each key 32 random bytes. A **secret**: it comes from
     * the deployment's secret store, never from a file in the repository, and no
     * message here repeats it. Unset means no tender can be published (the seal
     * fails closed, `KEY_UNAVAILABLE`); there is no default key. The platform
     * operator who can read this and the database can open a bid (D-043).
     */
    CONSTRUCTION_TENDER_KEKS: z
      .string()
      .optional()
      .refine(
        (value) => {
          try {
            parseKekEntries(value);
            return true;
          } catch {
            return false;
          }
        },
        {
          message:
            'CONSTRUCTION_TENDER_KEKS must be id:base64 pairs (id a-z0-9-, 32 random bytes each)',
        },
      ),
    /** The id in `CONSTRUCTION_TENDER_KEKS` that wraps new tender keys; older ones only unwrap. */
    CONSTRUCTION_TENDER_KEK_CURRENT: z
      .string()
      .optional()
      .refine((value) => value === undefined || value === '' || isKekId(value), {
        message: 'CONSTRUCTION_TENDER_KEK_CURRENT must be a KEK id (a-z0-9-)',
      }),

    /**
     * Q-84 (3): the shortest bidding window a tender may be published with.
     * Default 0 — the platform invents no minimum; the window must only be a
     * window that has not already closed.
     */
    CONSTRUCTION_TENDER_MIN_BIDDING_PERIOD_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(31_536_000)
      .default(0),

    /** docs/06 § 6.8: 24 hours unless configured. */
    CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  });

export type ConstructionEnv = z.infer<typeof constructionEnvSchema>;

/** The narrowed type the service reads, so callers need no casts. */
export type CancellableStates = readonly ProjectStateName[];

/**
 * Loads and validates the environment, once, at startup.
 *
 *   PORT          falls back to `PORT_CONSTRUCTION` then to 3110.
 *   DATABASE_URL  falls back to `DATABASE_URL_CONSTRUCTION` and to nothing
 *                 else: a service that silently connected to some other
 *                 database would violate A-01 quietly.
 */
export function loadConstructionEnv(source: NodeJS.ProcessEnv = process.env): ConstructionEnv {
  return loadEnv(constructionEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_CONSTRUCTION ?? DEFAULT_PORT,
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_CONSTRUCTION,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: ConstructionEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function brokersOf(env: ConstructionEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}
