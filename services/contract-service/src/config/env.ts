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

export const SERVICE_NAME = 'contract-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2). */
export const CONTRACT_TOPIC = 'rasta.contract.v1';

/** Where this service dead-letters what it cannot process: its own topic (ADR-061 § 3). */
export const CONTRACT_DEAD_LETTER_TOPIC = 'rasta.contract.v1.dlq';

/** The port `.env.example` and the gateway's `CONTRACT_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3111';

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

/** A closed code: upper-case words, the shape the database keeps (`ck_contract_cancellation`). */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A platform-role list that may be empty: an empty list is "nobody", never "everybody". */
function optionalRoleList(name: string) {
  return commaList().pipe(
    z
      .array(z.enum(PLATFORM_ROLES, { errorMap: () => ({ message: `Unknown role in ${name}` }) }))
      .refine((roles) => !roles.includes(REFUSED_ROLE), {
        message: `${name} may not name ${REFUSED_ROLE}: the oversight role has aggregate access only`,
      })
      .refine((roles) => !roles.includes('SYSTEM_ADMIN'), {
        message: `${name} may not name SYSTEM_ADMIN: the platform operator never accepts a contract for a party`,
      }),
  );
}

/**
 * contract-service configuration.
 *
 * ## Every domain setting here is a provisional answer to an open question
 *
 * The defaults are the provisional decisions recorded in `docs/24` (Q-95 to
 * Q-97), chosen to be the narrowest behaviour that still works, and each can be
 * changed by the client without a code change (ADR-023, AGENTS.md § 9):
 *
 *   CONTRACT_READER_ROLES               ADR-068 § 7. Which roles of the employer's
 *                                       organization read its contracts. Default
 *                                       `ORGANIZATION_ADMIN`, the owner's role set of
 *                                       construction-service. The winning contractor's
 *                                       side is the CONTRACTOR role of its own
 *                                       organization and is not configurable.
 *   (no signer setting)                 Who accepts a contract for the employer is **not** an
 *                                       environment value: it is the `contract.signature`
 *                                       approval policy of the employer's own organization
 *                                       (Q-95 (1), ADR-068 § 5) — rows written by the people
 *                                       entitled to, put in force by a platform administrator.
 *                                       An environment value can only narrow, never grant, and
 *                                       a service-wide role list would let that role sign for
 *                                       every employer. No policy in force: 422
 *                                       SIGNATURE_POLICY_REQUIRED. The contractor's side is the
 *                                       CONTRACTOR role of its own organization and is not
 *                                       configurable.
 *   ORGANIZATION_SERVICE_URL            Where the union hierarchy is confirmed when a policy is
 *                                       written, submitted and approved (`GET {url}/v1/
 *                                       organizations/{id}`, a service token signed for the
 *                                       union), as construction-service asks it.
 *   CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS
 *                                       How long that question may take, body included; no
 *                                       answer in time refuses the write (fail closed).
 *   CONTRACT_POLICY_FOUR_EYES           PROVISIONAL, pending the owner (Q-70, as in
 *                                       construction-service): default **on** — the platform
 *                                       administrator who approves a policy is neither its author
 *                                       nor its submitter. Switched off, it relaxes only a
 *                                       SYSTEM_ADMIN approving its own policy; a union-written
 *                                       policy is never approved by the person who wrote or
 *                                       submitted it.
 *   CONTRACT_CANCEL_ROLES              Q-95 (4), PR 2. Who, in the employer's organization,
 *                                       cancels a draft. Default `ORGANIZATION_ADMIN`, the
 *                                       reader default; empty is allowed and means nobody.
 *   CONTRACT_CANCEL_REASON_CODES        The closed list of reasons a draft is cancelled for;
 *                                       the request names one. The defaults are descriptive
 *                                       codes with no legal meaning; the client replaces them.
 *   CONTRACT_CANCEL_AFTER_SIGNATURE     Q-95 (4). Whether a draft one side has already signed
 *                                       may still be cancelled. Default **false**: conservative;
 *                                       a client who wants the employer to withdraw before the
 *                                       contractor signs sets it.
 *   CONTRACT_IDEMPOTENCY_TTL_HOURS / _CLAIM_LEASE_SECONDS
 *                                       How long a completed command's response is replayed,
 *                                       and how long an in-flight claim holds its key before a
 *                                       retry may take it over (docs/06 § 6.8).
 *   CONSTRUCTION_SERVICE_URL            Where the award is read (ADR-068 § 3):
 *                                       `GET {url}/v1/tenders/{id}/award`, with a service
 *                                       token signed for the tender owner's organization.
 *   CONTRACT_AWARD_REQUEST_TIMEOUT_MS   How long that read may take, headers and body
 *                                       included; no answer in time is "unavailable",
 *                                       never "no award".
 *   CONTRACT_CONSUMER_MAX_RETRIES / _RETRY_BACKOFF_MS
 *                                       How often the `TENDER_AWARDED` consumer retries an
 *                                       award that could not be read before it dead-letters
 *                                       the event as UPSTREAM_UNAVAILABLE.
 *   CONTRACT_RECONCILE_INTERVAL_MS / _BATCH_SIZE / _LEASE_SECONDS / _BACKOFF_SECONDS /
 *   _BACKOFF_MAX_SECONDS                The sweeper that suspends signing policies a moved
 *                                       organization stranded (Q-83), as construction-service's.
 *
 * `SYSTEM_ADMIN` is always accepted for the employer's side, as everywhere on the
 * platform, but only while acting for an organization it selected with
 * `X-Organization-Id`.
 *
 * Nothing here names an approval threshold, a deduction rate or a legal procedure, and no
 * default grants a signing authority. Those are rows in tables of later changes
 * (ADR-068 § 5), never environment values.
 */
export const contractEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    CONTRACT_READER_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('CONTRACT_READER_ROLES', { min: 1 })),

    ORGANIZATION_SERVICE_URL: z.string().url().default('http://localhost:3102'),

    CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(3000),

    CONTRACT_POLICY_FOUR_EYES: booleanEnv(true),

    CONTRACT_CANCEL_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(optionalRoleList('CONTRACT_CANCEL_ROLES')),

    CONTRACT_CANCEL_REASON_CODES: z
      .string()
      .default('TERMS_NOT_AGREED,CONTRACTOR_WITHDREW,AWARD_ERROR,OTHER')
      .pipe(
        commaList().pipe(
          z
            .array(
              z
                .string()
                .regex(CODE_PATTERN, 'A reason code is upper-case words, 2 to 64 characters'),
            )
            .min(1, 'CONTRACT_CANCEL_REASON_CODES must name at least one reason')
            .refine((codes) => new Set(codes).size === codes.length, {
              message: 'CONTRACT_CANCEL_REASON_CODES names a reason twice',
            }),
        ),
      ),

    /**
     * Q-95 (4) leaves open whether a draft one side has already signed may still be cancelled.
     * The conservative answer is the default: **no** — once a side has accepted, the draft is
     * not withdrawn by the other, and ending it is a decision for the client, who sets this.
     */
    CONTRACT_CANCEL_AFTER_SIGNATURE: booleanEnv(false),

    CONTRACT_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(10).max(900).default(120),

    CONSTRUCTION_SERVICE_URL: z.string().url().default('http://localhost:3110'),

    CONTRACT_AWARD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),

    CONTRACT_CONSUMER_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
    CONTRACT_CONSUMER_RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(60_000).default(1000),

    /**
     * The sweeper behind ORGANIZATION_MOVED (Q-83, docs/23 D-041), construction-service's
     * numbers. A sweep every `INTERVAL_MS` claims at most `BATCH_SIZE` due tasks, so one sweep
     * costs at most BATCH_SIZE × CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS; `LEASE_SECONDS` must
     * exceed that, or a slow sweep loses its claims to another instance (harmless — the writes are
     * conditional — but wasteful). A failed task is retried after `BACKOFF_SECONDS`, doubling to
     * `BACKOFF_MAX_SECONDS`.
     */
    CONTRACT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(500).max(300_000).default(5000),
    CONTRACT_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    CONTRACT_RECONCILE_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    CONTRACT_RECONCILE_BACKOFF_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
    CONTRACT_RECONCILE_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
  });

export type ContractEnv = z.infer<typeof contractEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 *   PORT          falls back to `PORT_CONTRACT` then to 3111.
 *   DATABASE_URL  falls back to `DATABASE_URL_CONTRACT` and to nothing
 *                 else: a service that silently connected to some other
 *                 database would violate A-01 quietly.
 */
export function loadContractEnv(source: NodeJS.ProcessEnv = process.env): ContractEnv {
  return loadEnv(contractEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_CONTRACT ?? DEFAULT_PORT,
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_CONTRACT,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: ContractEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
