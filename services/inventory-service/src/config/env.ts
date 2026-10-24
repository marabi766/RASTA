import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import { RETURN_DISPOSITIONS } from '@rasta/contracts';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  fixedEnvMessages,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
} from '@rasta/config';
import { inventoryOperationBudgets } from './operation-budgets';

/** The fixed texts this schema refuses with; `loadEnv` keeps only these verbatim (#385 r2 F2). */
const { fixed, seal } = fixedEnvMessages();

export const SERVICE_NAME = 'inventory-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2, ADR-056 § 6). */
export const INVENTORY_TOPIC = 'rasta.inventory.v1';

/** The port `.env.example` and the gateway's `INVENTORY_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3109';

/**
 * Roles no list here may name. The oversight role has aggregate access only (`docs/09` § 9.3),
 * and the platform administrator does not operate or read a warehouse for an organization in
 * PR 1 (Q-103): naming either is a configuration error rather than a grant.
 */
const REFUSED_ROLES = ['AUDITOR', 'SYSTEM_ADMIN'] as const;

const UNKNOWN_DISPOSITION = fixed(
  `Unknown disposition in INVENTORY_RETURN_DISPOSITIONS_ALLOWED (${RETURN_DISPOSITIONS.join(', ')})`,
);

/** A comma-separated list, trimmed, with empty elements dropped. */
function commaList() {
  return z.string().transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

/** A non-empty list of platform roles that names neither refused role. */
function roleList(name: string) {
  const unknownRole = fixed(`Unknown role in ${name}`);
  return commaList().pipe(
    z
      .array(z.enum(PLATFORM_ROLES, { errorMap: () => ({ message: unknownRole }) }))
      .min(1, fixed(`${name} must name at least one role`))
      .refine(
        (roles) => !roles.some((role) => (REFUSED_ROLES as readonly string[]).includes(role)),
        {
          message: fixed(
            `${name} may not name ${REFUSED_ROLES.join(' or ')} (docs/09 § 9.3, Q-103)`,
          ),
        },
      ),
  );
}

/**
 * inventory-service configuration.
 *
 * ## Every domain setting here is a provisional answer to an open question
 *
 * The defaults are the temporary decisions recorded in `docs/24` (Q-102 to Q-109, Q-113 to
 * Q-115), chosen to be
 * the narrowest behaviour that still works, and each can be changed without a code change
 * (ADR-023, AGENTS.md § 9):
 *
 *   INVENTORY_OPERATOR_ROLES            Q-103. Which roles of the warehouse owner's organization
 *                                       write: create a warehouse, receive, adjust, reserve,
 *                                       release and issue. Default `ORGANIZATION_ADMIN`.
 *   INVENTORY_READER_ROLES              Q-103. Which roles of the owner's organization read
 *                                       warehouses, stock levels, movements and reservations
 *                                       (an operator reads too). Default `ORGANIZATION_ADMIN`.
 *                                       AUDITOR and SYSTEM_ADMIN are refused by both lists and by
 *                                       the code; a service token reaches nothing in PR 1.
 *   INVENTORY_CONSIGNEE_READER_ROLES    Q-113. Which roles of a shipment's **consignee**
 *                                       organization read that shipment and its tracking
 *                                       (ADR-056 § 5). Default `ORGANIZATION_ADMIN`. A consignee
 *                                       only reads: every shipment command is the origin
 *                                       warehouse owner's (operators above).
 *   INVENTORY_RESERVATION_MAX_TTL_SECONDS
 *                                       Q-102. A reservation has no default lifetime: it lives
 *                                       until released or issued unless the caller sets
 *                                       `expiresAt`, which may lie at most this far ahead — a
 *                                       technical cap (default 7 days), not a business rule.
 *   INVENTORY_RESERVATION_SWEEP_INTERVAL_SECONDS / _SWEEP_BATCH_SIZE
 *                                       How often the sweeper releases reservations past their
 *                                       `expiresAt`, and how many per sweep. A command that locks
 *                                       a stock item expires that item's due reservations first,
 *                                       so the sweeper bounds how long a due one holds stock
 *                                       nobody touches (ADR-056 plan step 5).
 *   INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE
 *                                       How many due reservations of one stock item one
 *                                       transaction expires — a command's or the sweeper's.
 *                                       A backlog larger than this is worked off in committed
 *                                       batches, never in one transaction that outgrows its
 *                                       budget and rolls back every time (`ReservationExpiry`).
 *                                       Default 20: a reservation of the most lines (50) then
 *                                       expires at most 1000 in one transaction, well inside
 *                                       its budget (about 15 ms each, measured locally).
 *   INVENTORY_RETURN_DISPOSITIONS_ALLOWED
 *                                       Q-133. Which of ADR-048's six dispositions (RESTOCK,
 *                                       REPAIR, REPLACE, RETURN_TO_SUPPLIER, SCRAP, RECYCLE) a
 *                                       return shipment may be resolved with. **Unset: none** —
 *                                       a return can then be received and inspected but not
 *                                       resolved.
 *   INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED
 *                                       Q-133 (4). Whether a return shipment of which nothing
 *                                       arrived (every line received 0) may be resolved with no
 *                                       disposition. **Unset: false** — it stays INSPECTED and
 *                                       its resolution is refused by name. Never a way around
 *                                       an empty INVENTORY_RETURN_DISPOSITIONS_ALLOWED.
 *   MARKETPLACE_SERVICE_URL / INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS
 *                                       Where the return request is read and its dispatch
 *                                       reserved before a return shipment is recorded (A-13,
 *                                       Q-133 (5)), and how long each exchange may take. Not a
 *                                       business setting: nothing is recorded without an answer.
 *   INVENTORY_LOCK_TIMEOUT_MS          How long a command waits for a stock item another command
 *                                       holds before it answers 409 CONFLICT with Retry-After —
 *                                       never an unbounded wait (ADR-056 § 3).
 *   INVENTORY_IDEMPOTENCY_TTL_HOURS / _CLAIM_LEASE_SECONDS
 *                                       How long a completed command's response is replayed,
 *                                       and how long an in-flight claim holds its key before a
 *                                       retry may take it over (docs/06 § 6.8).
 *
 * No unit of measure, no low-stock threshold (Q-106), no partial issue (Q-107), no warehouse
 * lifecycle (Q-108), no control on a negative adjustment beyond the operator role (Q-109), no
 * shipment state beyond CREATED → DISPATCHED → DELIVERED (Q-114) and no link from a shipment to
 * stock (Q-115) is configured here: none is decided, and none is invented.
 */
export const inventoryEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    INVENTORY_OPERATOR_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('INVENTORY_OPERATOR_ROLES')),

    INVENTORY_READER_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('INVENTORY_READER_ROLES')),

    INVENTORY_CONSIGNEE_READER_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('INVENTORY_CONSIGNEE_READER_ROLES')),

    INVENTORY_RESERVATION_MAX_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(366 * 24 * 60 * 60)
      .default(7 * 24 * 60 * 60),

    INVENTORY_RESERVATION_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(30),
    INVENTORY_RESERVATION_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),

    /**
     * Q-133 (RUN-005, ADR-048 § 1): which dispositions a return shipment may be resolved with —
     * a comma-separated subset of the six ADR-048 names. **Empty by default, and then no return
     * shipment can be resolved**: whether a returned unit may be restocked, repaired, replaced,
     * sent back to the supplier, scrapped or recycled "is configuration and follows the contract",
     * and no such policy is decided. A deployment opts in with the outcomes its operations allow.
     */
    INVENTORY_RETURN_DISPOSITIONS_ALLOWED: commaList()
      .pipe(
        z.array(
          z.enum(RETURN_DISPOSITIONS, {
            errorMap: () => ({ message: UNKNOWN_DISPOSITION }),
          }),
        ),
      )
      .default(''),

    /**
     * Q-133 (4) (Codex r1 on #313): what a return shipment of which nothing arrived resolves to is
     * not decided — closed with no outcome, or something ADR-048 does not name (a carrier claim, a
     * loss). **False by default, and then such a shipment is not resolved** (`422
     * NOTHING_RECEIVED_TO_RESOLVE`), rather than closed by a rule nobody made. True: it resolves
     * with `dispositions: []`, and only while some disposition is allowed at all.
     */
    INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    INVENTORY_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),

    /**
     * marketplace-service, which owns the return request (ADR-048 § 2). Before a return shipment
     * is recorded, the request is read there and its dispatch reserved (A-13, ADR-061 § 4; Codex
     * r1 on #336) — over REST with an internal token signed for the supplier, never its database.
     */
    MARKETPLACE_SERVICE_URL: z.string().url().default('http://localhost:3106'),
    /**
     * How long each of those two exchanges may take, body included. Both run before the
     * command's transaction, never inside it; one that does not answer in time refuses the
     * dispatch (504 UPSTREAM_TIMEOUT) and nothing is written.
     */
    INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(200)
      .max(10_000)
      .default(3000),

    INVENTORY_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(900)
      .default(120),
  });

export const INVENTORY_ENV_MESSAGES = seal();

export type InventoryEnv = z.infer<typeof inventoryEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 *   PORT          falls back to `PORT_INVENTORY` then to 3109.
 *   DATABASE_URL  falls back to `DATABASE_URL_INVENTORY` and to nothing
 *                 else: a service that silently connected to some other
 *                 database would violate A-01 quietly.
 */
export function loadInventoryEnv(source: NodeJS.ProcessEnv = process.env): InventoryEnv {
  // A command's wait for a stock row ends in lock_timeout (55P03, a retryable
  // 409) only while the session's statement_timeout, if any, is longer than
  // the whole command (operation budgets).
  return loadEnv(
    inventoryEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
      PORT: source.PORT ?? source.PORT_INVENTORY ?? DEFAULT_PORT,
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_INVENTORY,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: inventoryOperationBudgets, fixedMessages: INVENTORY_ENV_MESSAGES },
  );
}

export function corsOrigins(env: InventoryEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
