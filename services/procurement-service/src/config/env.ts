import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
} from '@rasta/config';
import { procurementOperationBudgets } from './operation-budgets';

export const SERVICE_NAME = 'procurement-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2, ADR-070 § 9). */
export const PROCUREMENT_TOPIC = 'rasta.procurement.v1';

/** The port `.env.example` and the gateway's `PROCUREMENT_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3107';

/** The closed set of what a window that ends short of its threshold does (ADR-070 § 2, Q-10). */
export const SHORTFALL_POLICIES = ['EXTEND', 'REFER', 'CLOSE'] as const;
export type ShortfallPolicy = (typeof SHORTFALL_POLICIES)[number];

/**
 * The oversight role. Refused by this service whatever the configuration says
 * (`docs/09` § 9.3: aggregate access only), so naming it in a role list below
 * is a configuration error rather than a grant.
 */
const REFUSED_ROLE = 'AUDITOR';

/**
 * The platform operator. It never registers, withdraws or reads a buyer's need (ADR-070 § 5 keeps
 * it off the buyer side; Q-119 note of PR 1), so naming it in a role list is a configuration error.
 */
const PLATFORM_ROLE = 'SYSTEM_ADMIN';

/** A comma-separated list, trimmed, with empty elements dropped. */
function commaList() {
  return z.string().transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

/** A list of platform roles of the buyer's own organization: never the oversight role or the operator. */
function roleList(name: string, options: { min: number }) {
  return commaList().pipe(
    z
      .array(z.enum(PLATFORM_ROLES, { errorMap: () => ({ message: `Unknown role in ${name}` }) }))
      .min(options.min, `${name} must name at least ${options.min} role`)
      .refine((roles) => !roles.includes(REFUSED_ROLE), {
        message: `${name} may not name ${REFUSED_ROLE}: the oversight role has aggregate access only`,
      })
      .refine((roles) => !roles.includes(PLATFORM_ROLE), {
        message: `${name} may not name ${PLATFORM_ROLE}: the platform operator never acts for a buyer`,
      }),
  );
}

/**
 * procurement-service configuration (COM-007 PR 1, ADR-070).
 *
 * ## Every domain setting here is a provisional answer to an open question
 *
 * The defaults are the provisional decisions recorded in `docs/24` (Q-10, Q-119, Q-120), chosen to
 * be the narrowest behaviour that still works, and each can be changed by the client without a
 * code change (ADR-023, AGENTS.md § 9):
 *
 *   PROCUREMENT_DEMAND_ROLES           ADR-070 § 2. Which roles of the buyer's own organization
 *                                      register, withdraw and read its demands and aggregations.
 *                                      Default `PROCUREMENT_USER,ORGANIZATION_ADMIN` — the
 *                                      `demand:*` of `docs/09` § 9.3 and the organization's
 *                                      administrator. AUDITOR or SYSTEM_ADMIN here stops startup.
 *   PROCUREMENT_AGGREGATION_WINDOW_HOURS
 *                                      Q-10. How long a window stays open from the first demand
 *                                      that opens it: default 168 (seven days).
 *   PROCUREMENT_AGGREGATION_MIN_QUANTITY
 *                                      Q-10. The total quantity — a quantity, never an amount — a
 *                                      window must reach to become READY: default 0 (no threshold).
 *   PROCUREMENT_AGGREGATION_SHORTFALL_POLICY
 *                                      Q-10. What a window that ends short of it does: EXTEND
 *                                      (default — "carried into the next window"; its demands stay),
 *                                      REFER (a fact only: marketplace is never called) or CLOSE.
 *   PROCUREMENT_IDEMPOTENCY_TTL_HOURS / _CLAIM_LEASE_SECONDS
 *                                      How long a completed command's response is replayed, and how
 *                                      long an in-flight claim holds its key before a retry may
 *                                      take it over (docs/06 § 6.8).
 *
 * The three aggregation values are snapshotted onto each aggregation when its window opens; a
 * change reaches only windows opened after it (`docs/08` § 8.9). The per-organization versioned
 * setting that takes precedence over them is ADR-070 plan PR 3.
 *
 * Nothing here names an amount, an approval authority or a supplier: those are rows of later
 * changes (ADR-070 § 6), never environment values.
 */
export const procurementEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    PROCUREMENT_DEMAND_ROLES: z
      .string()
      .default('PROCUREMENT_USER,ORGANIZATION_ADMIN')
      .pipe(roleList('PROCUREMENT_DEMAND_ROLES', { min: 1 })),

    /** Q-10: seven days. At most a year: a window nobody closes is not a window. */
    PROCUREMENT_AGGREGATION_WINDOW_HOURS: z.coerce.number().int().min(1).max(8760).default(168),

    /** Q-10: no threshold. A whole quantity of the product's base unit, as a demand's is (Q-105). */
    PROCUREMENT_AGGREGATION_MIN_QUANTITY: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .default(0),

    /** Q-10: "carried into the next window". */
    PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: z.enum(SHORTFALL_POLICIES).default('EXTEND'),

    PROCUREMENT_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(900)
      .default(120),
  });

export type ProcurementEnv = z.infer<typeof procurementEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 *   PORT          falls back to `PORT_PROCUREMENT` then to 3107.
 *   DATABASE_URL  falls back to `DATABASE_URL_PROCUREMENT` and to nothing
 *                 else: a service that silently connected to some other
 *                 database would violate A-01 quietly.
 */
export function loadProcurementEnv(source: NodeJS.ProcessEnv = process.env): ProcurementEnv {
  return loadEnv(
    procurementEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
      PORT: source.PORT ?? source.PORT_PROCUREMENT ?? DEFAULT_PORT,
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_PROCUREMENT,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: procurementOperationBudgets },
  );
}

export function corsOrigins(env: ProcurementEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
