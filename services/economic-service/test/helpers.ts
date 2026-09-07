import { ulid } from 'ulid';
import { runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerRepository } from '../src/ledger/ledger.repository';
import { LedgerService } from '../src/ledger/ledger.service';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { WalletService } from '../src/wallet/wallet.service';
import { TransactionRepository } from '../src/transaction/transaction.repository';
import { TransactionService } from '../src/transaction/transaction.service';
import { CommissionService } from '../src/commission/commission.service';
import { RewardService } from '../src/reward/reward.service';
import { SettlementService } from '../src/settlement/settlement.service';
import { loadEconomicEnv, type EconomicEnv } from '../src/config/env';
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
  return url;
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

/**
 * The environment the services see.
 *
 * The platform organization is test-specific so a run cannot post into the
 * platform accounts a developer's local stack is using — and so `cleanup` can
 * delete what it created.
 */
export function testEnv(): EconomicEnv {
  return loadEconomicEnv({
    // Authentication and broker settings the domain never reads, filled in so
    // a suite can run without a Keycloak realm. They are placeholders rather
    // than omissions, and deliberately obvious ones: nothing in these tests
    // verifies a token, because authorization is a pure function over the
    // request context and is covered in `src/access/access.spec.ts` and in
    // `tenant-isolation.int-spec.ts` against the real tenant guard.
    OIDC_ISSUER_URL: 'http://itest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://itest.invalid/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'itest_internal_secret_at_least_32_characters',
    KAFKA_BROKERS: 'localhost:9092',
    ...process.env,
    DATABASE_URL: databaseUrl(),
    ECONOMIC_PLATFORM_ORGANIZATION_ID: PLATFORM_ORGANIZATION_ID,
    // The reconciliation runs on a timer; a test drives it explicitly.
    ECONOMIC_BALANCE_AUDIT_ENABLED: 'false',
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
}

/**
 * Builds the same object graph `app.module.ts` builds, by hand.
 *
 * By hand rather than through `Test.createTestingModule` because the module
 * also starts two Kafka consumers, an outbox relay and a reconciliation timer;
 * a suite that wanted a repository would be starting a broker subscription.
 */
export function wire(prisma: PrismaService): Wiring {
  const env = testEnv();
  const ledgerRepository = new LedgerRepository(prisma);
  const ledger = new LedgerService(ledgerRepository, prisma, env, silentLogger);
  const walletRepository = new WalletRepository(prisma);
  const wallets = new WalletService(walletRepository, ledger, prisma);
  const transactionRepository = new TransactionRepository(prisma);
  const transactions = new TransactionService(
    prisma,
    transactionRepository,
    wallets,
    walletRepository,
  );
  const commissions = new CommissionService(prisma, ledger);
  const rewards = new RewardService(prisma, ledger, wallets, env);
  const settlements = new SettlementService(
    prisma,
    ledger,
    wallets,
    walletRepository,
    transactionRepository,
    commissions,
  );

  return {
    prisma,
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
    authType: options.authType ?? 'USER',
    startedAt: Date.now(),
  };

  return runWithContext(context, async () => fn());
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
    const ownedJournals = await client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM journal
        WHERE organization_id LIKE ANY($1::text[])
       UNION
       SELECT DISTINCT journal_id AS id FROM ledger_entry
        WHERE organization_id LIKE ANY($1::text[])`,
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
    if (journalIds.length > 0) {
      await prisma.transaction(async (tx) => {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE. It is bounded
        // instead by this transaction, which reverts it on every exit path.
        await tx.$executeRawUnsafe(
          'ALTER TABLE ledger_entry DISABLE TRIGGER trg_ledger_entry_immutable',
        );
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe('ALTER TABLE journal DISABLE TRIGGER trg_journal_immutable');
        // ISOLATION-ALLOW-UNBOUNDED: as above.
        await tx.$executeRawUnsafe('ALTER TABLE ledger_entry DISABLE TRIGGER trg_journal_balanced');

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
        await tx.$executeRawUnsafe('ALTER TABLE ledger_entry ENABLE TRIGGER trg_journal_balanced');
      });
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

    await client.$executeRawUnsafe(
      `DELETE FROM settlement WHERE transaction_id IN (
         SELECT id FROM "transaction"
          WHERE organization_id LIKE ANY($1::text[])
             OR counterparty_organization_id LIKE ANY($1::text[]))`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM commission WHERE transaction_id IN (
         SELECT id FROM "transaction"
          WHERE organization_id LIKE ANY($1::text[])
             OR counterparty_organization_id LIKE ANY($1::text[]))`,
      orgs,
    );

    for (const table of [
      'settlement',
      'commission',
      'reward',
      'reward_balance',
      'payment_intent',
      'wallet_hold',
      'idempotency_key',
    ]) {
      await client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id LIKE ANY($1::text[])`,
        orgs,
      );
    }
    await client.$executeRawUnsafe(
      `DELETE FROM "transaction" WHERE organization_id LIKE ANY($1::text[])
         OR counterparty_organization_id LIKE ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM wallet WHERE organization_id LIKE ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ledger_account WHERE organization_id LIKE ANY($1::text[])`,
      orgs,
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
    // `ITEST_ACTOR` exists for.
    const author = `${ITEST_ACTOR}-%`;
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
