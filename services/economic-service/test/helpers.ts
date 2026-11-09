import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { RastaError, runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma';
import { LedgerRepository } from '../src/ledger/ledger.repository';
import { LedgerService } from '../src/ledger/ledger.service';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { WalletService } from '../src/wallet/wallet.service';
import { TransactionRepository } from '../src/transaction/transaction.repository';
import { TransactionService } from '../src/transaction/transaction.service';
import { CommissionService } from '../src/commission/commission.service';
import { RewardService } from '../src/reward/reward.service';
import { IdempotentAnswer } from '../src/shared/idempotency';
import { SettlementService } from '../src/settlement/settlement.service';
import { PaymentReconciliationRepository } from '../src/payment/payment-reconciliation.repository';
import { loadEconomicEnv, type EconomicEnv } from '../src/config/env';
import type {
  HierarchyQuestion,
  OrganizationHierarchy,
} from '../src/organization/organization-hierarchy';
import type { Logger } from '@rasta/logging';

/**
 * Shared scaffolding for the integration tests.
 *
 * Deliberately thin. The point of these tests is that they touch the real
 * database — the immutability triggers, the balance trigger, the CHECK
 * constraints, the row locks and the transaction boundaries exist only there,
 * and anything that hides the database behind a helper defeats them.
 *
 * What it does provide is a fully wired object graph without Nest, so a test
 * can call `settlements.settle()` and get the same code path an HTTP request
 * would.
 */

export const PLATFORM_ORGANIZATION_ID = 'ORG-ITEST-PLATFORM';

/**
 * One identifier per run, minted when this module is first loaded.
 *
 * It exists for the rows that carry no organization at all. A commission or
 * reward rule may be **platform-wide** (`organization_id IS NULL`, ADR-023),
 * which is the whole point of it — a rule that applies to every tenant — and
 * `organization_id LIKE ANY(...)` cannot match NULL. So the tenant prefixes
 * `cleanup` is given cannot reach a platform-wide rule, and a run that left one
 * behind would reprice or re-grant in every run after it. `reward-lifecycle`
 * writes one deliberately, and a leaked one made `consumers` and
 * `reward-lifecycle` grant three rewards where the test expects two.
 *
 * The author is what identifies those rows, and it has to be unique to the
 * run: matching `created_by LIKE 'USR-ITEST-%'` — which is what stood here —
 * deletes every *concurrent* run's governance rules too.
 *
 * Jest gives each test file its own module registry, so this is per file,
 * which is the scope `cleanup` is called at.
 */
export const RUN_TAG = ulid().slice(-10);

/**
 * The author every actor in this run writes, unless a test names its own.
 *
 * A test that does name its own should build it from this, so its rules are
 * still recognisable as this run's — `reward-lifecycle.int-spec.ts` is the
 * worked example.
 */
export const ITEST_ACTOR = `USR-ITEST-${RUN_TAG}`;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ECONOMIC;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ECONOMIC is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return withUtcSession(url);
}

/**
 * The owner connection `cleanup` alone uses to lift the ledger's immutability
 * and balance triggers (`DATABASE_URL_ECONOMIC_MIGRATOR`,
 * `rasta_economic_migrator`). **Required, with no fallback** to the runtime
 * URL: since D-045 the runtime role owns nothing and cannot lift a trigger at
 * all, and a suite that fell back would fail for a reason that hides the real
 * one — a missing variable.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_ECONOMIC_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ECONOMIC_MIGRATOR is not set. The suites lift a ledger trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export function brokers(): string[] | null {
  const raw = process.env.KAFKA_BROKERS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

/** The one issuer the suites' tokens are verified against (`OIDC_ISSUER_URL` in `testEnv`). */
export const ITEST_ISSUER = 'http://itest.invalid/realms/rasta';

/**
 * The environment the services see.
 *
 * The platform organization is test-specific so a run cannot post into the
 * platform accounts a developer's local stack is using — and so `cleanup` can
 * delete what it created.
 */
export function testEnv(): EconomicEnv {
  return loadEconomicEnv({
    // Placeholder endpoints allow a suite to run without a Keycloak realm.
    // These are placeholders rather
    // than omissions, and deliberately obvious ones: nothing in these tests
    // verifies a token, because authorization is a pure function over the
    // request context and is covered in `src/access/access.spec.ts` and in
    // `tenant-isolation.int-spec.ts` against the real tenant guard.
    OIDC_JWKS_URI: 'http://itest.invalid/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'itest_internal_secret_at_least_32_characters',
    KAFKA_BROKERS: 'localhost:9092',
    // Never dialled: the consumer suites stand in for both owners
    // (`source-facts.fake.ts`). A closed port, so a slip fails fast.
    MAINTENANCE_SERVICE_URL: 'http://127.0.0.1:9',
    FLEET_SERVICE_URL: 'http://127.0.0.1:9',
    CONTRACT_SERVICE_URL: 'http://127.0.0.1:9',
    ...process.env,
    // asActor uses this existing fixture issuer: inherited host settings must not split identities.
    OIDC_ISSUER_URL: ITEST_ISSUER,
    DATABASE_URL: databaseUrl(),
    ECONOMIC_PLATFORM_ORGANIZATION_ID: PLATFORM_ORGANIZATION_ID,
    // The reconciliation runs on a timer; a test drives it explicitly.
    ECONOMIC_BALANCE_AUDIT_ENABLED: 'false',
    // So does the payment reconciler (ADR-064 step B2).
    ECONOMIC_PAYMENT_RECONCILER_ENABLED: 'false',
  });
}

/** A logger that keeps the suite output readable but loses nothing important. */
export const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

const unreachableHierarchy: HierarchyQuestion = {
  withinVersion: () => Promise.reject(RastaError.upstreamUnavailable('organization-service')),
};

export interface Wiring {
  prisma: PrismaService;
  ledgerRepository: LedgerRepository;
  ledger: LedgerService;
  walletRepository: WalletRepository;
  wallets: WalletService;
  transactionRepository: TransactionRepository;
  transactions: TransactionService;
  commissions: CommissionService;
  rewards: RewardService;
  settlements: SettlementService;
  paymentReconciliation: PaymentReconciliationRepository;
}

/**
 * Builds the same object graph `app.module.ts` builds, by hand.
 *
 * By hand rather than through `Test.createTestingModule` because the module
 * also starts two Kafka consumers, an outbox relay and a reconciliation timer;
 * a suite that wanted a repository would be starting a broker subscription.
 */
/** `env` defaults to {@link testEnv}; a suite that needs another setting passes its own. */
export function wire(prisma: PrismaService, env: EconomicEnv = testEnv()): Wiring {
  const ledgerRepository = new LedgerRepository(prisma);
  const ledger = new LedgerService(ledgerRepository, prisma, env, silentLogger);
  const walletRepository = new WalletRepository(prisma);
  const wallets = new WalletService(walletRepository, ledger, prisma);
  const transactionRepository = new TransactionRepository(prisma);
  // No suite built here asks the hierarchy: a union administrator acting for
  // another organization is `union-admin-financial-authority.int-spec.ts`'s,
  // over HTTP. Asked anyway, it fails closed as an unreachable owner would.
  const hierarchy = unreachableHierarchy as unknown as OrganizationHierarchy;
  const commissions = new CommissionService(prisma, ledger);
  const transactions = new TransactionService(
    prisma,
    transactionRepository,
    wallets,
    walletRepository,
    env,
    ledger,
    commissions,
    hierarchy,
  );
  const rewards = new RewardService(prisma, ledger, wallets, env);
  const settlements = new SettlementService(
    prisma,
    ledger,
    wallets,
    walletRepository,
    transactionRepository,
    commissions,
    hierarchy,
    env,
  );

  const paymentReconciliation = new PaymentReconciliationRepository(prisma, env);

  return {
    prisma,
    paymentReconciliation,
    ledgerRepository,
    ledger,
    walletRepository,
    wallets,
    transactionRepository,
    transactions,
    commissions,
    rewards,
    settlements,
  };
}

/**
 * Three organizations, generated fresh per run.
 *
 * Generated rather than fixed so a re-run cannot collide with rows an earlier
 * run left behind, and so the tenant-isolation tests prove isolation between
 * two tenants that genuinely exist rather than between a tenant and an empty
 * set.
 *
 * **No `platform` key, deliberately.** This said "two organizations plus a
 * platform" while returning `{ a, b, c }`, and `wallet-races.int-spec.ts` read
 * the sentence rather than the code: it passed `org.platform` to `cleanup`,
 * which is `undefined`. document-service's `tenants()` does return a
 * `platform`, which is where the shape was copied from.
 *
 * The platform organization here is a constant, not a per-run tenant —
 * `PLATFORM_ORGANIZATION_ID`, which `cleanup` appends itself. Callers must not
 * pass it, and `cleanup` now refuses an argument that is not a real
 * identifier.
 */
export function tenants() {
  const suffix = ulid().slice(-10);
  return {
    a: `ORG-ITEST-A-${suffix}`,
    b: `ORG-ITEST-B-${suffix}`,
    c: `ORG-ITEST-C-${suffix}`,
  };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
  authType?: 'USER' | 'SERVICE';
  /** The token's IdP subject; the operator path compares it (ADR-064 B3). */
  subject?: string;
  /**
   * Whether the token carried `rasta_uid` (#188). By default, as the guard
   * decides it: a user with a subject other than their user id.
   */
  platformUserId?: boolean;
  /** The token's verified issuer; by default `ITEST_ISSUER` for a user with a subject. */
  issuer?: string;
}

/**
 * Runs `fn` as a user acting for an organization.
 *
 * The tenant guard reads the organization from this context, so every call
 * that touches a scoped model must go through here — which is also what the
 * production code does on every request.
 *
 * Wrapped in `async () => fn()` rather than passed straight through, and the
 * difference is the whole test. A Prisma query is lazy: a non-async arrow
 * would have its `.then` happen on the outer `await`, after this context has
 * closed, and the query would execute with no tenant at all. The same trap
 * `runUnscoped` documents, and a real bug fleet-service's copy of this file
 * had before its tests caught it.
 */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `itest-${ulid()}`,
    requestId: `itest-${ulid()}`,
    organizationId: options.organizationId,
    userId: options.userId ?? `${ITEST_ACTOR}-${ulid().slice(-8)}`,
    roles: options.roles ?? ['ORGANIZATION_ADMIN'],
    organizationIds: [],
    authType: options.authType ?? 'USER',
    ...(options.subject ? { subject: options.subject } : {}),
    ...((options.authType ?? 'USER') === 'USER' && options.subject
      ? {
          issuer: options.issuer ?? ITEST_ISSUER,
          platformUserId: options.platformUserId ?? (options.userId ?? '') !== options.subject,
        }
      : {}),
    startedAt: Date.now(),
  };

  return runWithContext(context, async () => fn());
}

/**
 * The answer a service-level call stores nowhere: for a suite that drives
 * `RewardService.createRule` directly, with no request and no key. The route
 * always passes a real one (`IdempotencyStore.run`), so this is a test-only
 * way past the requirement, never a default the service has.
 */
export function unanswered<T>(): IdempotentAnswer<T> {
  return new IdempotentAnswer<T>(
    async () => undefined,
    async () => undefined,
  );
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Gives an organization a wallet with a known balance, through the real
 * top-up path.
 *
 * Through the real path deliberately: seeding a balance with a direct UPDATE
 * would write a number the ledger does not justify, and every later assertion
 * about wallet/ledger agreement would be meaningless.
 */
export async function fundWallet(
  wiring: Wiring,
  organizationId: string,
  amountMinor: bigint,
): Promise<{ walletId: string }> {
  const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));

  if (amountMinor > 0n) {
    await asActor({ organizationId }, () =>
      wiring.prisma.transaction(async (tx) => {
        const [locked] = await wiring.walletRepository.lock(tx, [wallet.id]);
        if (!locked) throw new Error('wallet vanished');
        await wiring.wallets.credit(tx, {
          wallet: locked,
          amountMinor,
          counterpartPurpose: 'PAYMENT_CLEARING',
          journalType: 'WALLET_TOP_UP',
          description: 'itest funding',
          postedBy: 'itest',
        });
      }),
    );
  }

  return { walletId: wallet.id };
}

/** The three balances as the database currently holds them. */
export async function readBalances(prisma: PrismaService, walletId: string) {
  const rows = await runUnscoped(
    'integration test reads balances across tenants',
    () =>
      prisma.client.$queryRaw<{ available: bigint; pending: bigint; ledger: bigint }[]>`
      SELECT available_balance_minor AS available,
             pending_balance_minor   AS pending,
             ledger_balance_minor    AS ledger
        FROM wallet WHERE id = ${walletId}
    `,
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return row;
}

/**
 * Removes everything the test tenants wrote.
 *
 * Ordered so a foreign key never blocks a delete, and the ledger triggers are
 * suspended for the three statements that need them off — they exist to stop
 * *the application* mutating history, and a test fixture that could not clean
 * up after itself would leave every subsequent run reading someone else's rows.
 *
 * Every statement here is bound to this run: by the organization prefixes the
 * caller passes, or by the journal ids resolved from them. Nothing in this
 * function may delete or alter a row it cannot show it owns —
 * `isolation-controls.int-spec.ts` seeds a foreign tenant and proves it.
 */
/**
 * An obligation of this organization and nothing else: what a hold placed directly
 * through `WalletService` has to name (`trg_wallet_hold_reference_bound`).
 */
export async function bareObligation(prisma: PrismaService, organizationId: string) {
  const id = `TXN_${ulid()}`;
  await runUnscoped('the suite records an obligation for a hold to secure', () =>
    prisma.client.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, transaction_type, status, gross_amount_minor,
                                  occurred_at, correlation_id, updated_at, created_by)
       VALUES ($1, $2, 'MARKETPLACE_ORDER', 'CREATED', 1, now(), 'itest', now(), 'itest')`,
      id,
      organizationId,
    ),
  );
  return id;
}

export async function cleanup(
  prisma: PrismaService,
  organizationIds: readonly string[],
): Promise<void> {
  // Matched by **prefix**, not by equality.
  //
  // Suites derive per-test organizations from the suite's own — `${org.a}-ATOMIC`,
  // `${org.a}-PARALLEL` — and call `cleanup` at the end of the test body. A test
  // that *fails* never reaches that line, so its rows survive; without a prefix
  // match the `afterAll` sweep would not recognise them either, and a shared
  // development database slowly fills with debris from every failed run. That
  // debris is what first made a leftover commission rule reprice a later suite.
  //
  // The suffix is a ULID, so a prefix can only ever match this run's own
  // organizations.
  // Every identifier has to be a real one before any of them becomes a LIKE
  // prefix.
  //
  // `wallet-races.int-spec.ts` passed `org.platform`, which `tenants()` does
  // not return. The `${id}%` below turned that `undefined` into the prefix
  // `'undefined%'` and the run carried on: no error, no failed test, just a
  // delete predicate carrying a term that can never match. A cleanup argument
  // that silently means nothing is the worst of the three outcomes — worse
  // than a throw, and worse than deleting too much, because it looks like
  // coverage. Suites are transpiled by `@swc/jest`, which strips types
  // without checking them, so nothing else on the path would have said so.
  //
  // This validates the **arguments**, and only that. It is not an isolation
  // guarantee: F-07 is still open, the platform tenant below is still shared
  // between concurrent runs, and a well-formed identifier naming someone
  // else's tenant would pass this check unchallenged.
  const invalid = organizationIds
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => typeof id !== 'string' || id.trim() === '');

  if (invalid.length > 0) {
    throw new Error(
      `cleanup() was given ${invalid.length} invalid organization identifier(s): ` +
        invalid
          .map(({ id, index }) => `[${index}] = ${JSON.stringify(id) ?? String(id)}`)
          .join(', ') +
        '. Every entry must be a non-empty organization id owned by this run. ' +
        'The platform organization is added by this helper and must not be passed in.',
    );
  }

  const orgs = [...organizationIds, PLATFORM_ORGANIZATION_ID].map((id) => `${id}%`);
  const client = prisma.client;

  await runUnscoped('integration cleanup spans the tenants the suite created', async () => {
    // This run's rules, whoever they are scoped to (see the rule delete below).
    const author = `${ITEST_ACTOR}-%`;
    // First of all: each names its journal by a foreign key (FU-097), so both go
    // before the journals below. In `settle()`'s own order, so no deadlock with one.
    // A settlement is append-only at the database (RLG-002-1), so this run's own
    // go with the guard lifted in one owner transaction, which restores it on every
    // exit path. By transaction as well as by organization: the payee's run clears it too.
    const settlementOwner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await settlementOwner.$transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE commission DISABLE TRIGGER trg_commission_append_only',
        );
        // By transaction as well as by organization: a commission is filed
        // under the payee, which may be another run's counterparty. And by
        // rule: the rule delete below reaches this run's rules by author, and
        // a charge still naming one would block it (`rule_id` is RESTRICT, so
        // a rule that priced a charge is never silently unlinked from it).
        await tx.$executeRawUnsafe(
          `DELETE FROM commission
            WHERE organization_id LIKE ANY($1::text[])
               OR transaction_id IN (
                    SELECT id FROM "transaction"
                     WHERE organization_id LIKE ANY($1::text[])
                        OR counterparty_organization_id LIKE ANY($1::text[]))
               OR rule_id IN (
                    SELECT id FROM commission_rule
                     WHERE organization_id LIKE ANY($1::text[])
                        OR created_by LIKE $2)`,
          orgs,
          author,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(
          'ALTER TABLE commission ENABLE TRIGGER trg_commission_append_only',
        );

        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE settlement DISABLE TRIGGER trg_settlement_append_only',
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM settlement
            WHERE organization_id LIKE ANY($1::text[])
               OR transaction_id IN (
                    SELECT id FROM "transaction"
                     WHERE organization_id LIKE ANY($1::text[])
                        OR counterparty_organization_id LIKE ANY($1::text[]))`,
          orgs,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(
          'ALTER TABLE settlement ENABLE TRIGGER trg_settlement_append_only',
        );
      });
    } finally {
      await settlementOwner.$disconnect();
    }

    // The journals this run owns, resolved **before** anything is deleted.
    //
    // Two sources, because a journal and its legs need not name the same
    // tenant: a settlement journal is filed under the organization that
    // initiated it, while its legs belong to the payer, the payee and the
    // platform. The union covers every journal this run is about to orphan
    // and — this is the whole point — nothing else.
    //
    // The two journal deletes below used to carry **no predicate at all**:
    // they removed every entry-less journal in the database. In a database
    // every run shares, that is a
    // concurrent run's ledger history, removed by a suite that never wrote
    // it — and `journal` is the one table in this platform whose contents are
    // supposed to be impossible to lose.
    //
    // This run's own settlements and commissions are gone by now, so one still
    // naming a journal is another run's, claimed through the platform's revenue leg
    // (F-07, still open): its foreign key (FU-097) keeps that journal out of this.
    const ownedJournals = await client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT owned.id FROM (
         SELECT id FROM journal
          WHERE organization_id LIKE ANY($1::text[])
         UNION
         SELECT DISTINCT journal_id AS id FROM ledger_entry
          WHERE organization_id LIKE ANY($1::text[])
       ) owned
       WHERE NOT EXISTS (SELECT 1 FROM settlement s WHERE s.journal_id = owned.id)
         AND NOT EXISTS (SELECT 1 FROM commission c WHERE c.journal_id = owned.id)`,
      orgs,
    );
    const journalIds = ownedJournals.map((row) => row.id);

    // The three financial invariants are suspended for three statements, and
    // inside one transaction.
    //
    // `ALTER TABLE ... DISABLE TRIGGER` is DDL: it takes ACCESS EXCLUSIVE, it
    // is visible to **every** session, and it persists in the catalogue.
    // Re-enabling in a `finally` covers a thrown assertion and nothing else —
    // a SIGKILL, a Jest worker torn down on `testTimeout`, or a cancelled CI
    // job (`ci.yml` sets `cancel-in-progress`, so cancellation is routine)
    // all skip it, and the database is then left with ledger immutability
    // off, silently, until someone re-runs migrations.
    //
    // A transaction has no such exit. Committing re-enables the triggers;
    // dying rolls the catalogue change back. There is no path that ends with
    // them disabled, which is a stronger statement than any `finally` can
    // make. It also holds the ACCESS EXCLUSIVE lock *across* the disabled
    // window rather than releasing it into it, so a concurrent
    // `ledger-immutability.int-spec.ts` waits for the lock instead of
    // observing a ledger it is able to rewrite — a false negative on the most
    // important control in the platform.
    //
    // Everything that does not need the triggers off is kept outside, so the
    // window is three statements rather than fifteen.
    //
    // And the window is opened by the **owner** connection, never by the
    // runtime `PrismaService` under test (D-045): the runtime role cannot
    // disable a trigger at all, and a suite that did it with the service's
    // own connection would be teaching the code to.
    if (journalIds.length > 0) {
      const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
      try {
        await owner.$transaction(async (tx) => {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE. It is bounded
          // instead by this transaction, which reverts it on every exit path.
          await tx.$executeRawUnsafe(
            'ALTER TABLE ledger_entry DISABLE TRIGGER trg_ledger_entry_immutable',
          );
          // ISOLATION-ALLOW-UNBOUNDED: as above.
          await tx.$executeRawUnsafe('ALTER TABLE journal DISABLE TRIGGER trg_journal_immutable');
          // ISOLATION-ALLOW-UNBOUNDED: as above.
          await tx.$executeRawUnsafe(
            'ALTER TABLE ledger_entry DISABLE TRIGGER trg_journal_balanced',
          );

          // Entries are removed by **journal**, never by organization.
          //
          // A settlement journal has legs belonging to the payer, the payee and
          // the platform. Deleting only the legs whose organization is in this
          // list leaves the journal behind with the rest of its legs —
          // permanently unbalanced, and picked up by the "every journal
          // balances" assertion in the next suite. That is exactly how this
          // helper first failed.
          await tx.$executeRawUnsafe(
            `DELETE FROM ledger_entry WHERE journal_id = ANY($1::text[])`,
            journalIds,
          );
          // Reversals first: `journal.reverses_id` is a self-referencing foreign
          // key with ON DELETE RESTRICT, so a reversal has to go before the
          // journal it points at.
          //
          // The `NOT IN` guard is kept as a safety net — a journal that somehow
          // still has legs is left alone rather than dragged out from under
          // them — but the delete is now bound to this run's own journal ids,
          // which is what makes it safe in a database every run shares.
          await tx.$executeRawUnsafe(
            `DELETE FROM journal
              WHERE id = ANY($1::text[])
                AND reverses_id IS NOT NULL
                AND id NOT IN (SELECT DISTINCT journal_id FROM ledger_entry)`,
            journalIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM journal
              WHERE id = ANY($1::text[])
                AND id NOT IN (SELECT DISTINCT journal_id FROM ledger_entry)`,
            journalIds,
          );

          await tx.$executeRawUnsafe(
            'ALTER TABLE ledger_entry ENABLE TRIGGER trg_ledger_entry_immutable',
          );
          await tx.$executeRawUnsafe('ALTER TABLE journal ENABLE TRIGGER trg_journal_immutable');
          await tx.$executeRawUnsafe(
            'ALTER TABLE ledger_entry ENABLE TRIGGER trg_journal_balanced',
          );
        });
      } finally {
        await owner.$disconnect();
      }
    }

    // Legs first, and by *transaction* rather than by organization: a leg
    // belongs to the payer or the payee, so clearing by organization alone
    // leaves the counterparty's leg behind and the foreign key then blocks
    // the transaction delete.
    await client.$executeRawUnsafe(
      `DELETE FROM transaction_leg
        WHERE transaction_id IN (
          SELECT id FROM "transaction"
           WHERE organization_id LIKE ANY($1::text[])
              OR counterparty_organization_id LIKE ANY($1::text[])
        )
        OR organization_id LIKE ANY($1::text[])`,
      orgs,
    );

    // The operator path's history is append-only at the database (ADR-064 B3),
    // and so is a posted commission (ADR-045 § 3). Lifted for this run's own
    // organizations only, inside one transaction that restores the triggers
    // on every exit path — and by the **owner** connection, never the runtime
    // one, which cannot lift a trigger (D-045).
    const historyOwner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await historyOwner.$transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL is bounded by the owner transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE reward_rule_status_history DISABLE TRIGGER trg_reward_rule_status_append_only',
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM reward_rule_status_history WHERE rule_id IN (
            SELECT id FROM reward_rule WHERE organization_id LIKE ANY($1::text[]) OR created_by LIKE $2)`,
          orgs,
          author,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(
          'ALTER TABLE reward_rule_status_history ENABLE TRIGGER trg_reward_rule_status_append_only',
        );

        // And an obligation names the rule it was priced with (docs/23
        // D-057), RESTRICT as well and fixed by a trigger. One filed under
        // another run's organizations may name a platform-wide rule of this
        // run; its pricing is unlinked rather than the row deleted.
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
        await tx.$executeRawUnsafe(
          'ALTER TABLE "transaction" DISABLE TRIGGER trg_transaction_pricing_fixed',
        );
        await tx.$executeRawUnsafe(
          `UPDATE "transaction" SET pricing_outcome = NULL, pricing_rule_id = NULL
            WHERE pricing_rule_id IN (
                    SELECT id FROM commission_rule
                     WHERE organization_id LIKE ANY($1::text[])
                        OR created_by LIKE $2)`,
          orgs,
          author,
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe(
          'ALTER TABLE "transaction" ENABLE TRIGGER trg_transaction_pricing_fixed',
        );

        for (const [table, trigger] of [
          ['payment_reconciliation_resolution', 'trg_payment_resolution_append_only'],
          ['payment_reconciliation_requeue', 'trg_payment_requeue_append_only'],
        ]) {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
          await tx.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE organization_id LIKE ANY($1::text[])`,
            orgs,
          );
          // ISOLATION-ALLOW-UNBOUNDED: as above.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
      });
    } finally {
      await historyOwner.$disconnect();
    }

    for (const table of [
      'reward',
      'reward_balance',
      // Children first: each foreign key here is ON DELETE RESTRICT.
      'payment_reconciliation_task',
      'payment_refund_decline',
      'idempotency_key',
    ]) {
      await client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id LIKE ANY($1::text[])`,
        orgs,
      );
    }
    // A hold and an obligation of any kind are never deleted (ADR-068 § 6; FU-097), so
    // this run's own go by the owner, with the guards lifted in this transaction only;
    // their legs, settlements and commissions are already gone above.
    const recordsOwner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await recordsOwner.$transaction(
        async (tx) => {
          const guards = [
            'wallet_hold DISABLE TRIGGER trg_wallet_hold_reference_bound',
            '"transaction" DISABLE TRIGGER trg_transaction_statement_obligation_fixed',
            '"transaction" DISABLE TRIGGER trg_transaction_terms_fixed',
            // A payment intent is never erased either (FU-230); its children are gone above.
            'payment_intent DISABLE TRIGGER trg_payment_intent_terms_fixed',
          ];
          for (const guard of guards) {
            // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
            await tx.$executeRawUnsafe(`ALTER TABLE ${guard}`);
          }
          await tx.$executeRawUnsafe(
            `DELETE FROM wallet_hold WHERE organization_id LIKE ANY($1::text[])`,
            orgs,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM payment_intent WHERE organization_id LIKE ANY($1::text[])`,
            orgs,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM "transaction" WHERE organization_id LIKE ANY($1::text[])
               OR counterparty_organization_id LIKE ANY($1::text[])`,
            orgs,
          );
          for (const guard of guards) {
            // ISOLATION-ALLOW-UNBOUNDED: as above.
            await tx.$executeRawUnsafe(`ALTER TABLE ${guard.replace('DISABLE', 'ENABLE')}`);
          }
        },
        { timeout: 30_000 },
      );
    } finally {
      await recordsOwner.$disconnect();
    }
    await client.$executeRawUnsafe(
      `DELETE FROM wallet WHERE organization_id LIKE ANY($1::text[])`,
      orgs,
    );
    // The platform's accounts go only once empty: other runs' legs may still be on them.
    await client.$executeRawUnsafe(
      `DELETE FROM ledger_account
        WHERE organization_id LIKE ANY($1::text[])
          AND (organization_id NOT LIKE $2
               OR NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.account_id = ledger_account.id))`,
      orgs,
      `${PLATFORM_ORGANIZATION_ID}%`,
    );
    // Bound by organization, or by this run's author.
    //
    // What stood here was `created_by = 'itest' OR created_by LIKE
    // 'USR-ITEST-%'`, unbounded by organization *and* by run: it deleted every
    // concurrent run's commission and reward rules too. A rule that vanishes
    // mid-run reprices a transaction, and the suite that then fails is the one
    // whose rule was taken, not the one that took it.
    //
    // The author disjunct cannot simply be dropped, though, and this is the
    // part that is easy to get wrong — it was got wrong here first. These two
    // tables are the only ones in the service where `organization_id` is
    // **nullable**: a platform-wide rule (ADR-023) applies to every tenant and
    // is stored with no tenant at all. `organization_id LIKE ANY(...)` does not
    // match NULL, so the prefixes above cannot reach one, and a leaked
    // platform-wide reward rule grants points in every run that follows —
    // which is exactly what CI caught, as a third reward in two suites that
    // expected two.
    //
    // So the disjunct stays and is bound to the run instead, which is what
    // `ITEST_ACTOR` exists for (`author`, above).
    await client.$executeRawUnsafe(
      `DELETE FROM commission_rule
        WHERE organization_id LIKE ANY($1::text[])
           OR created_by LIKE $2`,
      orgs,
      author,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM reward_rule
        WHERE organization_id LIKE ANY($1::text[])
           OR created_by LIKE $2`,
      orgs,
      author,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id LIKE ANY($1::text[])`,
      orgs,
    );
  });
}

/** Waits for `check` to become truthy, or gives up with a readable failure. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; last error: ${String(last)}` : ''),
  );
}

/** Owner-only cleanup of explicitly named rule fixtures, including immutable history. */
export async function removeRewardRules(ruleIds: readonly string[]): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL is bounded by this owner transaction.
      await tx.$executeRawUnsafe(
        'ALTER TABLE reward_rule_status_history DISABLE TRIGGER trg_reward_rule_status_append_only',
      );
      await tx.$executeRawUnsafe(
        'DELETE FROM reward_rule_status_history WHERE rule_id = ANY($1::text[])',
        [...ruleIds],
      );
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(
        'ALTER TABLE reward_rule_status_history ENABLE TRIGGER trg_reward_rule_status_append_only',
      );
      await tx.$executeRawUnsafe('DELETE FROM reward_rule WHERE id = ANY($1::text[])', [
        ...ruleIds,
      ]);
    });
  } finally {
    await owner.$disconnect();
  }
}

/**
 * The deadline marketplace-service fixes on an order before its first hold send (D-144),
 * here far enough off never to pass during a run. economic-service refuses an `ORDER` hold
 * without one (D-150), as only a build that counts nothing sends it so.
 */
export const ORDER_HOLD_DEADLINE = '2999-01-01T00:00:00.000Z';

/**
 * Money in a WALLET or ESCROW account a fixture is about to debit by hand (FU-228).
 *
 * Such an account never sums below zero at commit (`trg_ledger_entry_wallet_covered`), so a fixture
 * that moves money out of one it never funded credits the shortfall first, from the same
 * organization's reward expense in that currency, as the owner. Nothing is written when the account
 * already holds `amountMinor`, or has another purpose. Like any hand-written leg, it leaves the
 * wallet row to the next recompute.
 */
export async function coverByHand(accountId: string, amountMinor: bigint): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      const [account] = await tx.$queryRawUnsafe<
        { organization_id: string; currency: string; balance: bigint }[]
      >(
        `SELECT a.organization_id, a.currency,
                COALESCE((SELECT SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END)
                            FROM ledger_entry e WHERE e.account_id = a.id), 0)::bigint AS balance
           FROM ledger_account a WHERE a.id = $1 AND a.purpose IN ('WALLET', 'ESCROW')`,
        accountId,
      );
      if (!account || account.balance >= amountMinor) return;
      const { organization_id: organizationId, currency } = account;
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
         VALUES ($1, $2, 'EXPENSE', $3, 'REWARD_EXPENSE', $4, 'itest') ON CONFLICT DO NOTHING`,
        `ACC_${ulid()}`,
        organizationId,
        `ITEST-COVER-${ulid()}`,
        currency,
      );
      const journalId = `JRN_COVER_${ulid()}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
         VALUES ($1, $2, 'REWARD_GRANT', 'covers a hand-written debit', now(), 'itest', 'itest')`,
        journalId,
        organizationId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         SELECT 'LGE_' || md5(a.id || $1), $1, a.id, a.organization_id,
                (CASE WHEN a.id = $2 THEN 'CREDIT' ELSE 'DEBIT' END)::"EntryDirection", $3, a.currency, now()
           FROM ledger_account a
          WHERE a.id = $2
             OR (a.organization_id = $4 AND a.purpose = 'REWARD_EXPENSE' AND a.currency = $5)`,
        journalId,
        accountId,
        amountMinor - account.balance,
        organizationId,
        currency,
      );
    });
  } finally {
    await owner.$disconnect();
  }
}

/**
 * Writes a payment-intent state the database now refuses: a row from before a column existed, or
 * one forged to prove a reader refuses it (FU-230). As the owner, with
 * `trg_payment_intent_terms_fixed` lifted for this one write, in one transaction that restores it.
 */
export async function plantPaymentIntent(sql: string, ...params: unknown[]): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(
        'ALTER TABLE payment_intent DISABLE TRIGGER trg_payment_intent_terms_fixed',
      );
      await tx.$executeRawUnsafe(sql, ...params);
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(
        'ALTER TABLE payment_intent ENABLE TRIGGER trg_payment_intent_terms_fixed',
      );
    });
  } finally {
    await owner.$disconnect();
  }
}
