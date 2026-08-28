/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Seed data for economic-service.
 *
 * ## What this file deliberately does not contain
 *
 * **No commission rate.** Not a default, not a "typical" figure, not a
 * placeholder that a demo would quietly settle at. The product document is
 * explicit — "تعیین درصد دقیق کارمزد در هر نوع تراکنش، ساختگی و پیشینی نیست" —
 * and docs/24 Q-08 is open. A seeded rate would be exactly the invented
 * commercial term ADR-023 exists to prevent, and it would be invisible: every
 * settlement would silently charge it and nobody would remember where it came
 * from.
 *
 * With no rule, every transaction settles at **zero commission**. That is the
 * documented behaviour, not a gap (docs/10 § 10.7).
 *
 * **No reward conversion rate.** Same reasoning, docs/24 Q-09. A rule seeded
 * with `creditPerPointMinor` would start paying real wallet credit out of a
 * platform expense account at a rate nobody approved (ADR-033).
 *
 * **No wallet, and no balance.** Wallets open on first use, and a seeded
 * balance would be money that no payment created — value appearing from
 * nowhere in a ledger whose entire purpose is that it cannot.
 *
 * ## What it does contain
 *
 * The platform's own ledger accounts, so a fresh database can post a journal
 * without the first request also being the first account creation. They hold
 * nothing until something happens.
 *
 * And, only when `ECONOMIC_SEED_SAMPLE_RULES=true`, one commission rule and one
 * reward rule labelled **"نمونه — نیازمند تصویب"** — sample, pending approval —
 * exactly as ADR-023 requires demonstration data to be labelled. The flag
 * defaults to off so that no environment acquires them by accident, and the
 * label travels on the row and out through the API so a rate can never be
 * mistaken for an approved one.
 */

const prisma = new PrismaClient();

const PLATFORM_ORGANIZATION_ID = process.env.ECONOMIC_PLATFORM_ORGANIZATION_ID ?? 'ORG-PLATFORM';
const SEED_SAMPLE_RULES = process.env.ECONOMIC_SEED_SAMPLE_RULES === 'true';
const CURRENCY = 'IRR';

/** The label ADR-023 requires on any demonstration governance data. */
const SAMPLE_LABEL = 'نمونه — نیازمند تصویب';

async function seedPlatformAccounts(): Promise<void> {
  const accounts = [
    {
      purpose: 'COMMISSION_REVENUE' as const,
      accountType: 'REVENUE' as const,
      code: `REV-${PLATFORM_ORGANIZATION_ID}-COMMISSION_REVENUE`,
      title: 'platform commission revenue',
    },
    {
      purpose: 'REWARD_EXPENSE' as const,
      accountType: 'EXPENSE' as const,
      code: `EXP-${PLATFORM_ORGANIZATION_ID}-REWARD_EXPENSE`,
      title: 'platform reward expense',
    },
    {
      // An ASSET in form, holding no real money: the provider is simulated and
      // nothing has been received from a bank (ADR-024). It exists so a top-up
      // is a balanced journal rather than value appearing from nowhere.
      purpose: 'PAYMENT_CLEARING' as const,
      accountType: 'ASSET' as const,
      code: `ASST-${PLATFORM_ORGANIZATION_ID}-PAYMENT_CLEARING`,
      title: 'simulated payment clearing (no real funds)',
    },
  ];

  for (const account of accounts) {
    await prisma.ledgerAccount.upsert({
      where: {
        organizationId_purpose_currency: {
          organizationId: PLATFORM_ORGANIZATION_ID,
          purpose: account.purpose,
          currency: CURRENCY,
        },
      },
      create: {
        id: `ACC_SEED_${account.purpose}`,
        organizationId: PLATFORM_ORGANIZATION_ID,
        accountType: account.accountType,
        accountCode: account.code,
        purpose: account.purpose,
        currency: CURRENCY,
        title: account.title,
        createdBy: 'seed',
      },
      update: {},
    });
    console.log(`    - ${account.code}`);
  }
}

/**
 * Sample governance rules, behind a flag and clearly labelled.
 *
 * The rate below is **not a proposal**. It exists so that a demonstration can
 * show a non-zero commission line and prove the engine works; the real figure
 * is a steering-group decision (docs/24 Q-08). The label is what stops it
 * being read as anything else, and it is returned by the API on every rule.
 */
async function seedSampleRules(): Promise<void> {
  await prisma.commissionRule.upsert({
    where: { id: 'CMR_SAMPLE_MARKETPLACE' },
    create: {
      id: 'CMR_SAMPLE_MARKETPLACE',
      organizationId: null,
      transactionType: 'MARKETPLACE_ORDER',
      rateBasisPoints: 200,
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
      status: 'ACTIVE',
      label: SAMPLE_LABEL,
      createdBy: 'seed',
      updatedBy: 'seed',
    },
    update: { label: SAMPLE_LABEL },
  });
  console.log(`    - commission rule MARKETPLACE_ORDER @ 200bp  [${SAMPLE_LABEL}]`);

  // Points only. `creditPerPointMinor` is deliberately absent: the share of
  // commission that funds rewards is docs/24 Q-09 and open, so this rule grants
  // recognition and no money (ADR-033).
  await prisma.rewardRule.upsert({
    where: { id: 'RWR_SAMPLE_USAGE' },
    create: {
      id: 'RWR_SAMPLE_USAGE',
      organizationId: null,
      triggerEvent: 'USAGE_RECORDED',
      rewardType: 'POINTS',
      points: 5,
      creditPerPointMinor: null,
      periodCap: 100,
      periodType: 'MONTH',
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
      status: 'ACTIVE',
      label: SAMPLE_LABEL,
      createdBy: 'seed',
      updatedBy: 'seed',
    },
    update: { label: SAMPLE_LABEL },
  });
  console.log(`    - reward rule USAGE_RECORDED @ 5 points, no rial value  [${SAMPLE_LABEL}]`);
}

async function main(): Promise<void> {
  console.log('==> Seeding economic-service');
  console.log(`    platform organization: ${PLATFORM_ORGANIZATION_ID}`);

  console.log('==> Platform ledger accounts');
  await seedPlatformAccounts();

  if (SEED_SAMPLE_RULES) {
    console.log('==> Sample governance rules (ECONOMIC_SEED_SAMPLE_RULES=true)');
    await seedSampleRules();
    console.log('    ⚠  These are demonstration values pending approval, not agreed rates.');
  } else {
    console.log('==> No commission or reward rules seeded.');
    console.log('    No active commission rule means no commission — docs/24 Q-08 is open,');
    console.log('    and a seeded rate would be an invented commercial term (ADR-023).');
  }

  console.log('==> Done');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
