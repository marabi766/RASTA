import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import {
  DEFAULT_RFQ_CANCELLATION_CODES,
  RESERVED_RFQ_CANCELLATION_CODES,
  RFQ_CANCELLATION_CODE_PATTERN,
} from '@rasta/contracts';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
} from '@rasta/config';
import { procurementOperationBudgets } from './operation-budgets';
import { isKekId, parseKekConfiguration, parseKekEntries } from '../rfq/key-provider';

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

/**
 * The most demands one transaction may move with a window's end: 10,000 is ~1.8 s of the 5 s
 * transaction budget on the reference machine (0.18 ms a demand, rasta-dev 2026-10-17), leaving
 * room for the rest of the transaction and a slower host.
 */
export const MAX_FOLLOW_BATCH_SIZE = 10_000;

/**
 * The window one close could digest whole in a single transaction, measured: the digest of every
 * id of a window in one statement (`string_agg` + SHA-256, the most a close could ever do at once)
 * took 2.43–2.52 s for 1,000,000 demands on rasta-dev (2026-10-17, cold cache after the seed) —
 * ~2.5 µs a demand, so ~2,000,000 in the 5 s budget. The close never does it at once: it digests
 * in batches (`WindowEnd`), which is what keeps every transaction bounded.
 */
const DIGEST_DEMANDS_PER_BUDGET = 2_000_000;

/**
 * The default `PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS`: a tenth of that (safety factor 10, for a
 * slower host and a loaded database), and the window `test/window-close-scale.int-spec.ts` closes
 * through the API on CI.
 */
export const DEFAULT_MAX_LIVE_DEMANDS = DIGEST_DEMANDS_PER_BUDGET / 10;

/** The largest `PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS`: half of it (safety factor 2). */
export const MAX_LIVE_DEMANDS_LIMIT = DIGEST_DEMANDS_PER_BUDGET / 2;

/**
 * The most suppliers one RFQ may invite, at most (Q-121 (1)): the measured bound of a tender's
 * standing bids (Q-117), since only an invited supplier quotes. `@rasta/contracts` bounds
 * `RFQ_ISSUED` by the same number.
 */
export const MAX_INVITEES_LIMIT = 500;

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
 *   PROCUREMENT_AGGREGATION_SETTING_ROLES
 *                                      Q-119 (2), plan PR 3. Which roles of the buyer's own
 *                                      organization record its aggregation settings — a new
 *                                      version replacing the three environment values above for
 *                                      windows it opens afterwards. Default `ORGANIZATION_ADMIN`.
 *                                      AUDITOR or SYSTEM_ADMIN here stops startup: the platform
 *                                      operator does not write a tenant's business configuration.
 *   PROCUREMENT_RFQ_ISSUER_ROLES       ADR-070 § 3. Which roles of the buyer's own organization
 *                                      cancel a READY aggregation (plan PR 2), issue its RFQ, and
 *                                      close or cancel that RFQ (plan PR 6). Default
 *                                      `ORGANIZATION_ADMIN` — `docs/09` gives `PROCUREMENT_USER`
 *                                      only `rfq:read`. AUDITOR or SYSTEM_ADMIN here stops startup.
 *                                      The buyer's RFQs are read by these roles and by
 *                                      PROCUREMENT_DEMAND_ROLES (`rfq:read`).
 *   PROCUREMENT_SUPPLIER_ROLES         ADR-070 § 4 (plan PR 6). Which roles of an invited
 *                                      supplier's own organization read the RFQs it is invited to.
 *                                      Default `SUPPLIER`. AUDITOR or SYSTEM_ADMIN here stops
 *                                      startup: neither is ever on the supplier side.
 *   PROCUREMENT_RFQ_CANCELLATION_CODES ADR-070 § 3 (plan PR 6, the planned `CancelRfq`). The
 *                                      closed list of reason codes an RFQ is cancelled for; the
 *                                      request names one (another is 422
 *                                      CANCELLATION_CODE_NOT_ALLOWED). Default `BUYER_REQUEST`.
 *                                      Upper-case words, 2 to 64 characters, each once.
 *                                      `NO_QUALIFIED_QUOTATION` stops startup until evaluation
 *                                      (plan PR 10) can check the fact it states.
 *   PROCUREMENT_RFQ_MAX_INVITEES       Q-121 (1). The most suppliers one RFQ invites: default 200,
 *                                      at most 500 — protection of the service (each is asked of
 *                                      supplier-service before the issue), not a business rule.
 *   PROCUREMENT_RFQ_KEKS / _KEK_CURRENT
 *                                      ADR-070 § 4. The key-encryption keys that wrap each RFQ's
 *                                      private sealing key — a secret, never construction's.
 *                                      Unset, no RFQ is issued (503); there is no default key.
 *   PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS
 *                                      Not a domain setting: a technical limit (Q-119 note of
 *                                      2026-10-17). The most live demands a window holds, so that
 *                                      no window holds more than one close can digest: default
 *                                      200000, at most 1000000 (derived from a measured digest
 *                                      time, below). One more is 422
 *                                      AGGREGATION_DEMAND_LIMIT_REACHED. Read at each submit, never
 *                                      snapshotted.
 *   PROCUREMENT_IDEMPOTENCY_TTL_HOURS / _CLAIM_LEASE_SECONDS
 *                                      How long a completed command's response is replayed, and how
 *                                      long an in-flight claim holds its key before a retry may
 *                                      take it over (docs/06 § 6.8).
 *   PROCUREMENT_WINDOW_SWEEP_* / PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE
 *                                      The sweeper that ends windows on time (ADR-070 § 2, plan
 *                                      PR 2) and the bound on the demands one transaction moves
 *                                      with a window's end. Operational, not business values.
 *
 * The three aggregation values are snapshotted onto each aggregation when its window opens; a
 * change reaches only windows opened after it (`docs/08` § 8.9). The per-organization versioned
 * setting that takes precedence over them is ADR-070 plan PR 3.
 *
 * Nothing here names an amount, an approval authority or a supplier organization: those are rows
 * (ADR-070 § 6) or a buyer's choice in a command (an RFQ's invitees, § 3), never environment values.
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

    /**
     * Q-10: no threshold. A whole quantity of the product's base unit, as a demand's is (Q-105).
     * At most MAX_QUANTITY (`demand/dto.ts`), the most a window can hold (PR-300 r2 R2-1): above
     * it no window could ever be READY — EXTEND would extend it forever. The literal, because
     * `dto.ts` imports this module; `env.spec.ts` holds the two equal.
     */
    PROCUREMENT_AGGREGATION_MIN_QUANTITY: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .default(0),

    /** Q-10: "carried into the next window". */
    PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: z.enum(SHORTFALL_POLICIES).default('EXTEND'),

    /** Q-119 (2): who records the organization's aggregation settings (plan PR 3). */
    PROCUREMENT_AGGREGATION_SETTING_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('PROCUREMENT_AGGREGATION_SETTING_ROLES', { min: 1 })),

    /** ADR-070 § 3: who cancels a READY aggregation (and, from PR 6, issues its RFQ). */
    PROCUREMENT_RFQ_ISSUER_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN')
      .pipe(roleList('PROCUREMENT_RFQ_ISSUER_ROLES', { min: 1 })),

    /** ADR-070 § 4: who reads, for an invited supplier's organization, the RFQs it is invited to. */
    PROCUREMENT_SUPPLIER_ROLES: z
      .string()
      .default('SUPPLIER')
      .pipe(roleList('PROCUREMENT_SUPPLIER_ROLES', { min: 1 })),

    /**
     * ADR-070 § 3: the closed list of reason codes an RFQ is cancelled for — the client's, as the
     * planned `CancelRfq` says ("closed list from configuration"). A code that states a fact the
     * service must check (`RESERVED_RFQ_CANCELLATION_CODES`) is refused here until it can.
     */
    PROCUREMENT_RFQ_CANCELLATION_CODES: z
      .string()
      .default(DEFAULT_RFQ_CANCELLATION_CODES.join(','))
      .pipe(
        commaList().pipe(
          z
            .array(
              z
                .string()
                .regex(
                  RFQ_CANCELLATION_CODE_PATTERN,
                  'A cancellation code is upper-case words, 2 to 64 characters',
                ),
            )
            .min(1, 'PROCUREMENT_RFQ_CANCELLATION_CODES must name at least one code')
            .refine((codes) => new Set(codes).size === codes.length, {
              message: 'PROCUREMENT_RFQ_CANCELLATION_CODES names a code twice',
            })
            .refine(
              (codes) =>
                !codes.some((code) =>
                  (RESERVED_RFQ_CANCELLATION_CODES as readonly string[]).includes(code),
                ),
              {
                message:
                  'PROCUREMENT_RFQ_CANCELLATION_CODES may not name NO_QUALIFIED_QUOTATION: it ' +
                  'arrives with evaluation (plan PR 10), which checks it',
              },
            ),
        ),
      ),

    /** Q-121 (1): protection of the service, not a business rule. */
    PROCUREMENT_RFQ_MAX_INVITEES: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_INVITEES_LIMIT)
      .default(200),

    /**
     * The key-encryption keys that wrap each RFQ's private sealing key (ADR-070 § 4, ADR-066 § 2):
     * `id:base64,id:base64`, each key 32 random bytes. A **secret**, from the deployment's secret
     * store, and never construction's (`CONSTRUCTION_TENDER_KEKS`): a bid's key and a quotation's
     * are wrapped apart. Unset means no RFQ can be issued (503 — the seal fails closed); there is
     * no default key. No message here repeats a value.
     */
    PROCUREMENT_RFQ_KEKS: z
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
            'PROCUREMENT_RFQ_KEKS must be id:base64 pairs (id a-z0-9-, 32 random bytes each)',
        },
      ),
    /** The id in `PROCUREMENT_RFQ_KEKS` that wraps new RFQ keys; older ones only unwrap. */
    PROCUREMENT_RFQ_KEK_CURRENT: z
      .string()
      .optional()
      .refine((value) => value === undefined || value === '' || isKekId(value), {
        message: 'PROCUREMENT_RFQ_KEK_CURRENT must be a KEK id (a-z0-9-)',
      }),

    /**
     * Where an invitee's standing is read (ADR-070 § 7, plan PRs 5 and 6):
     * `GET {SUPPLIER_SERVICE_URL}/v1/suppliers/standing-snapshot/{organizationId}`, a service call
     * with a token signed for no tenant, before the issue's transaction. Unreachable, or anything
     * but a well-formed 200, refuses the issue (503; 504 past the timeout) and writes nothing.
     */
    SUPPLIER_SERVICE_URL: z.string().url().default('http://localhost:3108'),
    PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5000),

    /**
     * The sweeper that closes RFQs at their deadline (ADR-070 § 3, plan PR 6; the shape of the
     * window sweeper above): every `INTERVAL_MS` it claims at most `BATCH_SIZE` PUBLISHED RFQs whose
     * `quotationClosingAt` has passed, under a lease and a fencing token, and closes each in a
     * transaction of its own. A failed one waits `min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS ×
     * 2^failures)`. A person of the buyer may close one after its deadline too: the same command.
     */
    PROCUREMENT_RFQ_CLOSE_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(300_000)
      .default(5000),
    PROCUREMENT_RFQ_CLOSE_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    PROCUREMENT_RFQ_CLOSE_SWEEP_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(60),
    PROCUREMENT_RFQ_CLOSE_SWEEP_BACKOFF_BASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(10),
    PROCUREMENT_RFQ_CLOSE_SWEEP_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(900),

    /**
     * A technical limit, not a business rule (PR-327 r2 F1, PR-338 r1 F1, Q-119 note of
     * 2026-10-17): the most live demands one window holds, so that a window can never hold more
     * than one close can digest. The close itself is bounded whatever the window holds — it moves
     * and digests `PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE` demands a transaction (`WindowEnd`) — so
     * this bounds how many transactions, and how long, a window's end takes, and keeps a margin
     * should a whole-window digest ever run at once: default `DEFAULT_MAX_LIVE_DEMANDS` (200,000,
     * a tenth of what one 5 s transaction digests on rasta-dev), at most `MAX_LIVE_DEMANDS_LIMIT`
     * (1,000,000, half of it). PR 1 alone, which closes a window in one transaction, keeps 5000
     * and 10,000.
     */
    PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIVE_DEMANDS_LIMIT)
      .default(DEFAULT_MAX_LIVE_DEMANDS),

    PROCUREMENT_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(900)
      .default(120),

    /**
     * The sweeper that ends windows past `closes_at` (ADR-070 § 2, plan PR 2; the shape of
     * construction's tender close sweeper, ADR-065 § 3). A sweep every `INTERVAL_MS` claims at most
     * `BATCH_SIZE` windows — due OPEN ones, and ended ones whose demands are still following them —
     * under a lease of `LEASE_SECONDS` and a fencing token, and works each in short transactions of
     * its own, renewing the lease with each. Correctness never waits for it: a demand at or after
     * `closes_at` ends the window itself. A window whose sweep failed is not claimed again for
     * `min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS × 2^failures)`;
     * `RastaProcurementWindowSweepRetriesHigh` fires past 5 failures.
     */
    PROCUREMENT_WINDOW_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(300_000)
      .default(5000),
    PROCUREMENT_WINDOW_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    PROCUREMENT_WINDOW_SWEEP_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    PROCUREMENT_WINDOW_SWEEP_BACKOFF_BASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(10),
    PROCUREMENT_WINDOW_SWEEP_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(900),

    /**
     * The batch of a window's end (`MAX_FOLLOW_BATCH_SIZE`): the most live demands one transaction
     * moves to REFERRED or LAPSED with it, and the most ids one transaction adds to its digest. The
     * end does one batch in its own transaction — a demand's submit included — and the sweeper the
     * rest, one per transaction. So no window, however large, makes any transaction of its end
     * outrun the budget (PR-327 r1 F1: one UPDATE of every demand is ~0.13 ms each, over the 5 s
     * budget past ~35k demands; PR-338 r1 F1: the digest of every id at once grows with the window
     * too). A window up to this size ends whole, with its event, in one transaction, as in PR 1.
     */
    PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_FOLLOW_BATCH_SIZE)
      .default(2000),
  })
  .superRefine((env, ctx) => {
    try {
      parseKekEntries(env.PROCUREMENT_RFQ_KEKS);
    } catch {
      return; // malformed entries are already reported at their own field
    }
    try {
      parseKekConfiguration(env.PROCUREMENT_RFQ_KEKS, env.PROCUREMENT_RFQ_KEK_CURRENT);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PROCUREMENT_RFQ_KEK_CURRENT'],
        message:
          'PROCUREMENT_RFQ_KEK_CURRENT must name one of the ids in PROCUREMENT_RFQ_KEKS, ' +
          'and be set exactly when PROCUREMENT_RFQ_KEKS is',
      });
    }
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
