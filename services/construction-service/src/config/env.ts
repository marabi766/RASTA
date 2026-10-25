import { z } from 'zod';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  fixedEnvMessages,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
  serviceUrlSchema,
} from '@rasta/config';
import { isKekId, parseKekConfiguration, parseKekEntries } from '../tender/sealing/key-provider';
import { EVIDENCE_MAX_CHAIN_LINKS } from '../tender/evidence-limits';
import { PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS } from '@rasta/contracts';
import { constructionOperationBudgets, replayFenceBudgetMs } from './operation-budgets';
import {
  CANCELLABLE_BY_LIFECYCLE,
  PROJECT_STATES,
  type ProjectStateName,
} from '../project/project.state-machine';

/** The fixed texts this schema refuses with; `loadEnv` keeps only these verbatim (#385 r2 F2). */
const { fixed, seal } = fixedEnvMessages();

const EVALUATORS_MIN_OVER_MAX = fixed(
  'CONSTRUCTION_EVALUATION_MIN_EVALUATORS may not exceed CONSTRUCTION_EVALUATION_MAX_EVALUATORS: no bid could ever be complete',
);
const FOUR_EYES_OPT_OUT_REFUSED = fixed(
  'CONSTRUCTION_TENDER_OPEN_FOUR_EYES=false is accepted only when NODE_ENV is development or test (Q-91)',
);
const KEK_CURRENT_NOT_IN_KEKS = fixed(
  'CONSTRUCTION_TENDER_KEK_CURRENT must name one of the ids in CONSTRUCTION_TENDER_KEKS, ' +
    'and be set exactly when CONSTRUCTION_TENDER_KEKS is',
);

const KEKS_MALFORMED = fixed(
  'CONSTRUCTION_TENDER_KEKS must be id:base64 pairs (id a-z0-9-, 32 random bytes each)',
);
const KEK_CURRENT_MALFORMED = fixed('CONSTRUCTION_TENDER_KEK_CURRENT must be a KEK id (a-z0-9-)');

const TENDER_OPEN_ROLES_REFUSED = fixed(
  'CONSTRUCTION_TENDER_OPEN_ROLES may not name SYSTEM_ADMIN or CONTRACTOR: neither opens or reads bids (ADR-066 § 4)',
);
const TENDER_EVALUATE_ROLES_REFUSED = fixed(
  'CONSTRUCTION_TENDER_EVALUATE_ROLES may not name SYSTEM_ADMIN or CONTRACTOR: neither evaluates bids (ADR-066 § 4, ADR-067 § 4)',
);
const TENDER_AWARD_ROLES_REFUSED = fixed(
  'CONSTRUCTION_TENDER_AWARD_ROLES may not name SYSTEM_ADMIN or CONTRACTOR: neither awards a tender (ADR-066 § 4, ADR-067 § 3)',
);

export const SERVICE_NAME = 'construction-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2). */
export const CONSTRUCTION_TOPIC = 'rasta.construction.v1';

/** The port `.env.example` and the gateway's `CONSTRUCTION_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3110';

/**
 * `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS` (Codex r1 on #250, R2): never below Prisma's own 5 s default,
 * which the opening used to inherit; never above two minutes of the tender's lock. The default
 * leaves wide headroom over the measured worst case at the default caps (`tender-open-scale.int-spec`).
 */
export const TENDER_OPEN_TIMEOUT_MIN_MS = 5_000;
export const TENDER_OPEN_TIMEOUT_MAX_MS = 120_000;
export const TENDER_OPEN_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * `CONSTRUCTION_TENDER_MAX_STANDING_BIDS` (Codex r2 on #250): the opening decrypts every standing
 * bid in its transaction, and the receipt cap alone let 10,000 organizations bid once each —
 * ~33 s of decryption before any write. PROVISIONAL default 200 (Q-117); the ceiling is the
 * largest value measured to open within the default timeout (`tender-open-scale.int-spec`, run
 * with it), so a configuration nobody has measured refuses to start.
 */
export const TENDER_MAX_STANDING_BIDS_DEFAULT = 200;
export const TENDER_MAX_STANDING_BIDS_CEILING = 500;

/**
 * The oversight role. Refused by this service whatever the configuration says
 * (`docs/09` § 9.3: aggregate access only), so naming it in a role list below
 * is a configuration error rather than a grant.
 */
const REFUSED_ROLE = 'AUDITOR';

/**
 * The conflict-of-interest rules the code implements, each off unless
 * `CONSTRUCTION_COI_RULES` names it (ADR-067 § 4, Q-90). A new rule is code and an ADR.
 */
export const COI_RULES = ['AWARDER_NOT_EVALUATOR', 'EVALUATOR_NOT_TENDER_AUTHOR'] as const;
export type CoiRule = (typeof COI_RULES)[number];

const UNKNOWN_COI_RULE = fixed(
  `Unknown rule in CONSTRUCTION_COI_RULES; the closed set is ${COI_RULES.join(', ')}`,
);
const UNKNOWN_CANCELLABLE_STATE = fixed('Unknown state in CONSTRUCTION_CANCELLABLE_STATES');

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
  const unknownRole = fixed(`Unknown role in ${name}`);
  return commaList().pipe(
    z
      .array(z.enum(PLATFORM_ROLES, { errorMap: () => ({ message: unknownRole }) }))
      .min(options.min, fixed(`${name} must name at least ${options.min} role`))
      .refine((roles) => !roles.includes(REFUSED_ROLE), {
        message: fixed(
          `${name} may not name ${REFUSED_ROLE}: the oversight role has aggregate access only`,
        ),
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
 *   CONSTRUCTION_TENDER_OPEN_FOUR_EYES  PROVISIONAL, pending the owner (Q-91): opening
 *                                       a tender's bids is proposed by one user and
 *                                       approved by a second. Default `true`; `false`
 *                                       only in development and test.
 *   CONSTRUCTION_TENDER_EVALUATE_ROLES  ADR-067 § 4. Who evaluates opened bids; default the
 *                                       tender owner's role set.
 *   CONSTRUCTION_TENDER_AWARD_ROLES     ADR-067 § 3. Who awards an evaluated tender; default the
 *                                       tender owner's role set.
 *   CONSTRUCTION_EVALUATION_MIN_EVALUATORS / _MAX_EVALUATORS
 *                                       Q-88, Q-92. Evaluators that must have scored each
 *                                       qualified bid / may score one. Default 1 and 1.
 *   CONSTRUCTION_COI_RULES              Q-90, Q-92. Optional conflict rules, off by default.
 *   IDENTITY_SERVICE_URL                Where the proposer's and the approver's current
 *                                       organizations are read at the approval of an
 *                                       opening (and CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS);
 *                                       unreadable refuses the opening.
 *   ORGANIZATION_SERVICE_URL            Where the union hierarchy is confirmed.
 *   SUPPLIER_SERVICE_URL                Where the contractor-standing snapshot is read
 *                                       (and CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS,
 *                                       CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS).
 *   CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS
 *                                       How long that confirmation may take;
 *                                       no answer in time refuses (504).
 *   CONSTRUCTION_RECONCILE_INTERVAL_MS / _BATCH_SIZE / _LEASE_SECONDS /
 *   _BACKOFF_SECONDS / _BACKOFF_MAX_SECONDS
 *                                       The sweeper that suspends policies a
 *                                       moved organization stranded (Q-83).
 *   CONSTRUCTION_TENDER_CLOSE_INTERVAL_MS / _BATCH_SIZE / _LEASE_SECONDS /
 *   _BACKOFF_BASE_SECONDS / _BACKOFF_MAX_SECONDS
 *                                       The sweeper that closes tenders past
 *                                       their deadline (ADR-065 § 3).
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
 *   CONSTRUCTION_TENDER_MAX_RECEIPTS    Construction audit F2. The receipts a
 *                                       tender's chain may hold (≤ what
 *                                       audit-service returns, 10,000).
 *   CONSTRUCTION_BID_MAX_REVISIONS      PROVISIONAL (F2, D1): revisions one
 *                                       bid may have, the submission included.
 *   CONSTRUCTION_TENDER_MAX_STANDING_BIDS
 *                                       PROVISIONAL (Q-117): bids standing on
 *                                       one tender at once; 1–500, default 200.
 *   CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS How long the opening's transaction (and
 *                                       the owner's read of every opened bid)
 *                                       may run; 5,000–120,000, default 30,000.
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
  .merge(outboxPurgeEnvSchema)
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

    /**
     * ADR-066 § 4: who may open a tender's bids and read them afterwards. Empty (the
     * default) means the tender owner's own role set, `CONSTRUCTION_PROJECT_ROLES`.
     * `SYSTEM_ADMIN` and `CONTRACTOR` are refused at startup: the platform
     * administrator has no access to a bid through the API (ADR-066 § 4), and the
     * bidder's role is the other side of the table.
     */
    CONSTRUCTION_TENDER_OPEN_ROLES: z
      .string()
      .default('')
      .pipe(roleList('CONSTRUCTION_TENDER_OPEN_ROLES', { min: 0 }))
      .refine((roles) => !roles.includes('SYSTEM_ADMIN') && !roles.includes('CONTRACTOR'), {
        message: TENDER_OPEN_ROLES_REFUSED,
      }),

    /**
     * Q-91, PROVISIONAL, pending the product owner (committee size and roles): opening a
     * tender's bids needs a proposal by one authorised user and the approval of a second,
     * neither a member of a bidding organization. Default `true`; `false` (one person
     * opens) is accepted only where NODE_ENV is `development` or `test`.
     */
    CONSTRUCTION_TENDER_OPEN_FOUR_EYES: booleanEnv(true),

    /**
     * ADR-067 § 4: who may evaluate the opened bids of a tender (qualify, score, stand
     * down, complete the evaluation) and read the matrix. Empty (the default) means the
     * tender owner's own role set, `CONSTRUCTION_PROJECT_ROLES`. The same refusals as for
     * opening bids: `SYSTEM_ADMIN` and `CONTRACTOR` are refused at startup.
     */
    CONSTRUCTION_TENDER_EVALUATE_ROLES: z
      .string()
      .default('')
      .pipe(roleList('CONSTRUCTION_TENDER_EVALUATE_ROLES', { min: 0 }))
      .refine((roles) => !roles.includes('SYSTEM_ADMIN') && !roles.includes('CONTRACTOR'), {
        message: TENDER_EVALUATE_ROLES_REFUSED,
      }),

    /**
     * ADR-067 § 3: who awards an evaluated tender. A person decides, never the platform. Empty
     * (the default) means the tender owner's own role set, `CONSTRUCTION_PROJECT_ROLES`. The same
     * refusals as for evaluating: `SYSTEM_ADMIN` and `CONTRACTOR` are refused at startup.
     */
    CONSTRUCTION_TENDER_AWARD_ROLES: z
      .string()
      .default('')
      .pipe(roleList('CONSTRUCTION_TENDER_AWARD_ROLES', { min: 0 }))
      .refine((roles) => !roles.includes('SYSTEM_ADMIN') && !roles.includes('CONTRACTOR'), {
        message: TENDER_AWARD_ROLES_REFUSED,
      }),

    /**
     * Q-88 / Q-92, PROVISIONAL: how many evaluators must have scored every qualified bid
     * before the evaluation may be completed (`MIN`), and how many may score one bid (`MAX`).
     * The defaults are ADR-067's MVP — one evaluator per bid — and make the aggregation of
     * several evaluators' scores unnecessary. `MAX` above 1 turns it on: a bid's score is the
     * mean of its evaluators' totals, compared exactly (cross-multiplied, no rounding).
     */
    CONSTRUCTION_EVALUATION_MIN_EVALUATORS: z.coerce.number().int().min(1).max(9).default(1),
    CONSTRUCTION_EVALUATION_MAX_EVALUATORS: z.coerce.number().int().min(1).max(9).default(1),

    /**
     * Q-90 / Q-92 / Q-93: the optional conflict-of-interest rules, from the closed set in code
     * (`COI_RULES`). `EVALUATOR_NOT_TENDER_AUTHOR` applies to evaluation and is OFF unless named.
     * `AWARDER_NOT_EVALUATOR` is enforced by `award` (CON-002 PR 10) and is **ON by default and
     * strict** (project manager, 2026-10-03): a person the records cannot show to be someone other
     * than an evaluator is refused (fail closed). Setting the variable to an empty value switches
     * every optional rule off. A name outside the set stops the service at startup: a rule that is
     * not implemented is not silently ignored.
     */
    CONSTRUCTION_COI_RULES: z
      .string()
      .default('AWARDER_NOT_EVALUATOR')
      .pipe(
        commaList().pipe(
          z.array(
            z.enum(COI_RULES, {
              errorMap: () => ({ message: UNKNOWN_COI_RULE }),
            }),
          ),
        ),
      ),

    CONSTRUCTION_CANCELLABLE_STATES: z
      .string()
      .default(CANCELLABLE_BY_LIFECYCLE.join(','))
      .pipe(
        commaList().pipe(
          z
            .array(
              z.enum(PROJECT_STATES, {
                errorMap: () => ({ message: UNKNOWN_CANCELLABLE_STATE }),
              }),
            )
            .refine((states) => states.every((state) => CANCELLABLE_BY_LIFECYCLE.includes(state)), {
              message: fixed(
                'CONSTRUCTION_CANCELLABLE_STATES may only name states the lifecycle can cancel from: ' +
                  CANCELLABLE_BY_LIFECYCLE.join(', '),
              ),
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
              .min(2, fixed('Each CONSTRUCTION_OPERATION_TYPES entry must be 2 to 100 characters'))
              .max(
                100,
                fixed('Each CONSTRUCTION_OPERATION_TYPES entry must be 2 to 100 characters'),
              ),
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
    ORGANIZATION_SERVICE_URL: serviceUrlSchema.default('http://localhost:3102'),
    /**
     * Where the contractor-standing snapshot is read (CON-002 PR 5, ADR-061 § 4):
     * `GET {SUPPLIER_SERVICE_URL}/v1/suppliers/standing-snapshot`, a platform-wide
     * service call with a token signed for no tenant. Until it has been loaded
     * once, no contractor is eligible.
     */
    SUPPLIER_SERVICE_URL: serviceUrlSchema.default('http://localhost:3108'),
    /**
     * Where the externally held receipt chain is read (CON-002 PR 6, ADR-066 § 2):
     * `GET {AUDIT_SERVICE_URL}/v1/internal/tender-evidence/{tenderId}/chain`, a
     * platform-wide service call with a token signed for no tenant. Opening bids
     * takes the chain head from there and nowhere else: if it cannot be read, bids
     * are not opened.
     */
    AUDIT_SERVICE_URL: serviceUrlSchema.default('http://localhost:3115'),
    /**
     * Where a user's current organizations are read (CON-002 PR 8, Q-91): `GET
     * {IDENTITY_SERVICE_URL}/v1/users/{id}/organizations`, a service call with a token
     * signed for no tenant. The conflict check at the approval of a bid opening uses it
     * for the proposer and the approver; if it cannot be read, the opening is refused.
     */
    IDENTITY_SERVICE_URL: serviceUrlSchema.default('http://localhost:3101'),
    CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5000),
    CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5000),
    /** One page of the snapshot, headers to parse; an answer too slow is a failed attempt, retried. */
    CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5000),
    /** Wait between failed attempts to load the snapshot. */
    CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(600_000)
      .default(15_000),
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

    /**
     * The sweeper that closes tenders past `bid_closing_at` (ADR-065 § 3). A sweep
     * every `INTERVAL_MS` claims at most `BATCH_SIZE` overdue tenders and closes each
     * in one short transaction (no network call), so a tender is closed at most one
     * interval late — which only delays the state: a bid after the deadline is refused
     * by the database's clock whether or not the sweeper has run. `LEASE_SECONDS` must
     * exceed one sweep (`BATCH_SIZE` × a close, milliseconds each); a tender whose
     * close failed is claimed again when its lease runs out.
     */
    CONSTRUCTION_TENDER_CLOSE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(300_000)
      .default(5000),
    CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    CONSTRUCTION_TENDER_CLOSE_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /**
     * A tender whose close failed is not claimed again for
     * `min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS × 2^failures)` — so a tender that
     * cannot be closed neither takes every sweep's first slot nor starves the later
     * overdue ones. `RastaConstructionTenderCloseRetriesHigh` fires past 5 failures.
     */
    CONSTRUCTION_TENDER_CLOSE_BACKOFF_BASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(10),
    CONSTRUCTION_TENDER_CLOSE_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(900),

    /**
     * The sweeper that makes the standing check after an award (ADR-067 § 3, residual), the close
     * sweeper's shape: a sweep every `INTERVAL_MS` claims at most `BATCH_SIZE` pending checks under a
     * lease of `LEASE_SECONDS` and a fencing token, asks supplier-service about each winner (a network
     * call, outside any transaction) and settles each in one short transaction. `LEASE_SECONDS` must
     * exceed one sweep (`BATCH_SIZE` × the supplier request timeout). A check whose answer could not be
     * had is not claimed again for `min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS × 2^attempts)`.
     * `ALERT_AGE_SECONDS`: a check still PENDING past this age is counted by the overdue gauge, which
     * `RastaConstructionAwardStandingCheckOverdue` alerts on.
     */
    CONSTRUCTION_AWARD_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(300_000)
      .default(10_000),
    CONSTRUCTION_AWARD_CHECK_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    CONSTRUCTION_AWARD_CHECK_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    CONSTRUCTION_AWARD_CHECK_BACKOFF_BASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(10),
    CONSTRUCTION_AWARD_CHECK_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(900),
    CONSTRUCTION_AWARD_CHECK_ALERT_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(604_800)
      .default(600),

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
          message: KEKS_MALFORMED,
        },
      ),
    /** The id in `CONSTRUCTION_TENDER_KEKS` that wraps new tender keys; older ones only unwrap. */
    CONSTRUCTION_TENDER_KEK_CURRENT: z
      .string()
      .optional()
      .refine((value) => value === undefined || value === '' || isKekId(value), {
        message: KEK_CURRENT_MALFORMED,
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

    /**
     * The most receipts a tender's chain may hold (construction audit F2): every submission and
     * every replacement appends one, and the opening verifies the whole chain against
     * audit-service, which returns at most `EVIDENCE_MAX_CHAIN_LINKS` links — a longer chain could
     * never be opened. So a bid that would append past this is refused (`422
     * TENDER_RECEIPT_LIMIT`), in its own transaction, and never more than audit-service returns.
     */
    CONSTRUCTION_TENDER_MAX_RECEIPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(EVIDENCE_MAX_CHAIN_LINKS)
      .default(EVIDENCE_MAX_CHAIN_LINKS),
    /**
     * PROVISIONAL, pending the PM (construction audit F2, D1): the most revisions one bid may
     * have, its submission (revision 1) included; a replacement past it is `422
     * BID_REVISION_LIMIT`. Without it one bidder could fill the tender's chain and shut every
     * competitor out. 50 lets 200 bidders use them all within the 10,000 receipts.
     */
    CONSTRUCTION_BID_MAX_REVISIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(EVIDENCE_MAX_CHAIN_LINKS)
      .default(50),
    /**
     * PROVISIONAL, pending the product owner (Q-117; Codex r2 on #250): the most bids that may
     * stand (submitted, not withdrawn) on one tender at once; a submission past it is `422
     * TENDER_BID_LIMIT`, which says the limit is reached and nothing of how many bid. Without it
     * the receipt cap was the only bound, and 10,000 bidders of one revision each fit under it:
     * an opening that decrypts every standing bid could not finish within its timeout. The
     * ceiling is what the scale test measured to open in time; above it the service refuses to
     * start rather than accept tenders it may not be able to open.
     */
    CONSTRUCTION_TENDER_MAX_STANDING_BIDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(TENDER_MAX_STANDING_BIDS_CEILING)
      .default(TENDER_MAX_STANDING_BIDS_DEFAULT),
    /**
     * How long the transaction that opens a tender's bids — and the owner's read of every opened
     * bid, which repeats the same work — may run (Codex r1 on #250, R2). It decrypts every
     * standing bid and writes an access row and event for each, under the tender's lock; Prisma's
     * 5 s default would roll a large opening back every time. Out of range is a startup failure,
     * never a silent default: too short refuses the openings the caps permit, too long holds the
     * tender's lock past any sane request.
     */
    CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(TENDER_OPEN_TIMEOUT_MIN_MS)
      .max(TENDER_OPEN_TIMEOUT_MAX_MS)
      .default(TENDER_OPEN_TIMEOUT_DEFAULT_MS),

    /** docs/06 § 6.8: 24 hours unless configured. */
    CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * The largest offset of any replica's clock from true time, in seconds (PM decision D-065).
     * The replay fence (`shared/idempotency.ts`) compares one replica's clock with the stored
     * deadline another replica fixed, so its budget is `B = 2 · skew + margin`: a deadline ends
     * `B` before its record's expiry and the purge waits `B` after it. Beyond this offset the
     * fence's guarantee is void — alarm on clock offset above half of it. Out of range is a
     * startup failure; at its largest (300) the budget is 607 s, under a sixth of the shortest
     * retention the TTL setting allows (1 hour), so a deadline can never be pushed before its claim
     * (`env.spec.ts` holds that arithmetic to the bounds).
     */
    CONSTRUCTION_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

    /**
     * How long one interactive transaction may stay open, BEGIN to COMMIT, before
     * the database client rolls it back (`PrismaService`). Every transaction of
     * this service runs on it unless its caller names its own bound (the
     * idempotency wait; the tender opening, `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`).
     *
     * Before it, every transaction ran on Prisma's unwritten 5 000 ms. A command
     * of a few milliseconds that the process could not run for six seconds — a
     * starved CI runner (main 2883320, run 38531029337), a CPU-throttled
     * container — expired and failed, though it did nothing wrong. Never below
     * that 5 000 ms, which would fail commands that pass today; at most a minute,
     * which is already longer than any command here should hold its locks.
     */
    CONSTRUCTION_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(15_000),
  })
  // The two key settings are one setting (Codex review of #163): keys with a
  // CURRENT that is not among them — or a CURRENT with no keys — used to pass
  // startup and fail only when a tender was first published. Judged together, here.
  .superRefine((env, ctx) => {
    if (env.CONSTRUCTION_EVALUATION_MIN_EVALUATORS > env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSTRUCTION_EVALUATION_MIN_EVALUATORS'],
        message: EVALUATORS_MIN_OVER_MAX,
      });
    }
    // The replay fence refuses a deadline later than claim + TTL − B (shared/idempotency.ts). The
    // portal's window is capped by the same constant (PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS), so
    // the service must be able to accept a window of that size on its slowest legal clock:
    //   TTL − B − skew ≥ K        (B = 2 · skew + margin)
    // Otherwise an honest client could meet the refusal: fail the boot instead (PM decision D-067).
    if (replayWindowRoomSeconds(env) < PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSTRUCTION_IDEMPOTENCY_TTL_HOURS'],
        message:
          'CONSTRUCTION_IDEMPOTENCY_TTL_HOURS · 3600 − B − CONSTRUCTION_CLOCK_SKEW_SECONDS must be at least ' +
          `${PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS} s (PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS), ` +
          'with B = 2 · CONSTRUCTION_CLOCK_SKEW_SECONDS + 7 s: otherwise a portal window its own boot check ' +
          'accepts could be refused by the replay fence',
      });
    }
    if (
      !env.CONSTRUCTION_TENDER_OPEN_FOUR_EYES &&
      env.NODE_ENV !== 'development' &&
      env.NODE_ENV !== 'test'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSTRUCTION_TENDER_OPEN_FOUR_EYES'],
        message: FOUR_EYES_OPT_OUT_REFUSED,
      });
    }
    try {
      parseKekEntries(env.CONSTRUCTION_TENDER_KEKS);
    } catch {
      return; // malformed entries are already reported at their own field
    }
    try {
      parseKekConfiguration(env.CONSTRUCTION_TENDER_KEKS, env.CONSTRUCTION_TENDER_KEK_CURRENT);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSTRUCTION_TENDER_KEK_CURRENT'],
        message: KEK_CURRENT_NOT_IN_KEKS,
      });
    }
  });

export const CONSTRUCTION_ENV_MESSAGES = seal();

export type ConstructionEnv = z.infer<typeof constructionEnvSchema>;

/**
 * The longest replay window (seconds, portal skew allowance included) this service can accept on its
 * slowest legal clock: `TTL − B − skew`. The boot check holds it at or above
 * `PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS`.
 */
export function replayWindowRoomSeconds(
  env: Pick<
    ConstructionEnv,
    'CONSTRUCTION_IDEMPOTENCY_TTL_HOURS' | 'CONSTRUCTION_CLOCK_SKEW_SECONDS'
  >,
): number {
  return (
    env.CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 3600 -
    replayFenceBudgetMs(env.CONSTRUCTION_CLOCK_SKEW_SECONDS) / 1000 -
    env.CONSTRUCTION_CLOCK_SKEW_SECONDS
  );
}

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
  return loadEnv(
    constructionEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
      PORT: source.PORT ?? source.PORT_CONSTRUCTION ?? DEFAULT_PORT,
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_CONSTRUCTION,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: constructionOperationBudgets, fixedMessages: CONSTRUCTION_ENV_MESSAGES },
  );
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
