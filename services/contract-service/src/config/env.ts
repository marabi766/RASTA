import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import {
  authEnvSchema,
  baseEnvSchema,
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
 *
 * `SYSTEM_ADMIN` is always accepted for the employer's side, as everywhere on the
 * platform, but only while acting for an organization it selected with
 * `X-Organization-Id`.
 *
 * Nothing here names an approval authority, an approval threshold, a deduction
 * rate or a legal procedure. Those are rows in tables of later changes
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

    CONSTRUCTION_SERVICE_URL: z.string().url().default('http://localhost:3110'),

    CONTRACT_AWARD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),

    CONTRACT_CONSUMER_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
    CONTRACT_CONSUMER_RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
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
