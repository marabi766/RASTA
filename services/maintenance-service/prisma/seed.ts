/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Demo seed for maintenance-service.
 *
 * Identifiers match the other services' seeds exactly — organizations from
 * organization-service, users from identity-service, assets from
 * asset-service. If they drift, a schedule points at a machine the platform
 * has never heard of, and every maintenance screen silently shows nothing.
 *
 * The data is shaped to make the interesting cases reachable without setting
 * them up by hand:
 *
 *   - a schedule on hours that is **already overdue**, so
 *     `GET /maintenance-schedules/due` returns something on its first call
 *     and the derived-verdict path is visible rather than described;
 *   - a schedule on days that is comfortably in the future, so "not due" is
 *     also demonstrable;
 *   - a schedule in a second organization, so tenant isolation can be
 *     *demonstrated* rather than asserted — ORG-DEH-0002's schedule must be
 *     invisible to ORG-DEH-0001;
 *   - a finished repair with parts, labour and a direct cost, already
 *     approved, so the cost breakdown and the settlement gate have real data
 *     behind them;
 *   - an open breakdown report with no workshop yet, so the referral path
 *     starts from a real row.
 *
 * `asset_ref` and `asset_usage_meter` are seeded too. In a running system both
 * are built by the event consumers from `ASSET_*` and `USAGE_RECORDED`, but a
 * seeded database has no Kafka history to replay — and without the meter, the
 * usage-based schedule below would read zero hours and never come due.
 *
 * CONSTRAINT: every value here is illustrative. No real machine, workshop,
 * part, price or repair exists in this file. The intervals in particular are
 * examples, not the platform's opinion about how often a grader needs oil.
 */

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_MAINTENANCE;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL or DATABASE_URL_MAINTENANCE. ' +
        'Run via `pnpm db:seed`, which loads the repo-root .env.',
    );
  }
  return url;
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const DEH_ONE = 'ORG-DEH-0001';
const DEH_TWO = 'ORG-DEH-0002';
const WORKSHOP = 'ORG-DEH-0002';

const day = 86_400_000;
const now = Date.now();

/** Mirrors asset-service's seed. Kept in sync by hand; drift breaks both. */
const ASSET_REFS = [
  {
    id: 'AST-SEED-0001',
    organizationId: DEH_ONE,
    name: 'گریدر شهرداری',
    assetType: 'GRADER',
    assetTag: '۱۲',
    status: 'ACTIVE',
  },
  {
    id: 'AST-SEED-0002',
    organizationId: DEH_ONE,
    name: 'لودر دهیاری',
    assetType: 'LOADER',
    assetTag: '۱۴',
    status: 'IDLE',
  },
  {
    id: 'AST-SEED-0003',
    organizationId: DEH_ONE,
    name: 'کامیون حمل پسماند',
    assetType: 'WASTE_COLLECTOR',
    assetTag: '۲۱',
    status: 'REGISTERED',
  },
  {
    id: 'AST-SEED-0004',
    organizationId: DEH_TWO,
    name: 'بیل مکانیکی',
    assetType: 'EXCAVATOR',
    assetTag: '۷',
    status: 'ACTIVE',
  },
];

/**
 * What each machine has run.
 *
 * In a live system these are folded from `USAGE_RECORDED`. The figures here
 * are chosen so the grader's 250-hour schedule is past due and the loader's is
 * not, which is what makes both answers visible on the first call.
 */
const METERS = [
  {
    assetId: 'AST-SEED-0001',
    organizationId: DEH_ONE,
    hourMeter: '4380.50',
    odometer: '18240.00',
    recordCount: 42,
  },
  {
    assetId: 'AST-SEED-0002',
    organizationId: DEH_ONE,
    hourMeter: '1120.25',
    odometer: '9310.00',
    recordCount: 17,
  },
  {
    assetId: 'AST-SEED-0004',
    organizationId: DEH_TWO,
    hourMeter: '2075.00',
    odometer: '6120.00',
    recordCount: 23,
  },
];

const SCHEDULES = [
  {
    id: 'MSC-SEED-0001',
    organizationId: DEH_ONE,
    assetId: 'AST-SEED-0001',
    title: 'تعویض روغن موتور',
    maintenanceType: 'PREVENTIVE' as const,
    recurrence: 'RECURRING' as const,
    status: 'ACTIVE' as const,
    // Anchored 260 hours ago on a 250-hour interval: overdue by ten hours, so
    // the due endpoint has something to report and the OVERDUE branch of the
    // evaluator is exercised by real data.
    intervalHours: '250.00',
    leadHours: '25.00',
    lastServicedHourMeter: '4120.50',
    lastServicedAt: new Date(now - 40 * day),
  },
  {
    id: 'MSC-SEED-0002',
    organizationId: DEH_ONE,
    assetId: 'AST-SEED-0002',
    title: 'سرویس شش‌ماهه',
    maintenanceType: 'PREVENTIVE' as const,
    recurrence: 'RECURRING' as const,
    status: 'ACTIVE' as const,
    // Serviced ten days ago on a 180-day interval: comfortably not due, so
    // "nothing to do" is also demonstrable.
    intervalDays: 180,
    leadDays: 14,
    lastServicedAt: new Date(now - 10 * day),
  },
  {
    id: 'MSC-SEED-0003',
    organizationId: DEH_TWO,
    assetId: 'AST-SEED-0004',
    title: 'تعویض فیلتر هیدرولیک',
    maintenanceType: 'PREVENTIVE' as const,
    recurrence: 'RECURRING' as const,
    status: 'ACTIVE' as const,
    intervalHours: '500.00',
    leadHours: '50.00',
    lastServicedHourMeter: '1900.00',
    lastServicedAt: new Date(now - 60 * day),
  },
];

/**
 * One finished-and-approved repair and one open breakdown.
 *
 * The approved one is the more useful of the two: it is the only shape in
 * which the cost breakdown, the provenance of each line, and the settlement
 * gate all have data behind them.
 */
const APPROVED_REQUEST = {
  id: 'MNT-SEED-0001',
  organizationId: DEH_ONE,
  assetId: 'AST-SEED-0002',
  type: 'CORRECTIVE' as const,
  status: 'APPROVED' as const,
  severity: 'HIGH' as const,
  title: 'نشتی سیستم هیدرولیک',
  description: 'روغن هیدرولیک از شیلنگ اصلی نشت می‌کند.',
  reportedAt: new Date(now - 21 * day),
  reportedBy: 'USR-SEED-OPERATOR-ONE',
  outOfServiceAt: new Date(now - 21 * day),
  startedAt: new Date(now - 19 * day),
  startedBy: 'USR-SEED-DEHYARI-ADMIN',
  completedAt: new Date(now - 17 * day),
  completedBy: 'USR-SEED-DEHYARI-ADMIN',
  returnedToServiceAt: new Date(now - 16 * day),
  downtimeMinutes: 5 * 24 * 60,
  approvedAt: new Date(now - 15 * day),
  approvedBy: 'USR-SEED-DEHYARI-ADMIN',
  approvalNotes: 'کار انجام‌شده و صورت‌حساب بررسی شد.',
  totalCostMinor: 0n,
  currency: 'IRR',
};

const OPEN_REQUEST = {
  id: 'MNT-SEED-0002',
  organizationId: DEH_ONE,
  assetId: 'AST-SEED-0001',
  scheduleId: 'MSC-SEED-0001',
  type: 'PREVENTIVE' as const,
  status: 'OPEN' as const,
  severity: null,
  title: 'تعویض روغن موتور — سررسید',
  description: null,
  reportedAt: new Date(now - 2 * day),
  reportedBy: 'USR-SEED-DEHYARI-ADMIN',
  dueDate: new Date(now + 5 * day),
  totalCostMinor: 0n,
  currency: 'IRR',
};

const REPAIR_ORDER = {
  id: 'RPO-SEED-0001',
  organizationId: DEH_ONE,
  maintenanceRequestId: APPROVED_REQUEST.id,
  assetId: 'AST-SEED-0002',
  workshopOrganizationId: WORKSHOP,
  workshopName: 'تعمیرگاه مرکزی',
  status: 'COMPLETED' as const,
  workSummary: 'رفع نشتی سیستم هیدرولیک',
  workPerformed: 'شیلنگ اصلی و دو اورینگ تعویض شد؛ سیستم تحت فشار آزمایش شد.',
  assignedAt: new Date(now - 20 * day),
  assignedBy: 'USR-SEED-DEHYARI-ADMIN',
  startedAt: new Date(now - 19 * day),
  startedBy: 'USR-SEED-DEHYARI-ADMIN',
  completedAt: new Date(now - 17 * day),
  completedBy: 'USR-SEED-DEHYARI-ADMIN',
  currency: 'IRR',
};

/** Quantity × unit price, kept consistent with `ck_part_usage_amounts`. */
const PARTS = [
  {
    id: 'PTU-SEED-0001',
    partName: 'شیلنگ هیدرولیک',
    quantity: '1',
    unit: 'عدد',
    unitCostMinor: 4_800_000n,
    totalCostMinor: 4_800_000n,
    source: 'MARKETPLACE' as const,
  },
  {
    id: 'PTU-SEED-0002',
    partName: 'اورینگ',
    quantity: '2',
    unit: 'عدد',
    unitCostMinor: 150_000n,
    totalCostMinor: 300_000n,
    source: 'WORKSHOP_SUPPLIED' as const,
  },
  {
    id: 'PTU-SEED-0003',
    partName: 'روغن هیدرولیک',
    quantity: '12.5',
    unit: 'لیتر',
    unitCostMinor: 320_000n,
    totalCostMinor: 4_000_000n,
    source: 'INVENTORY' as const,
  },
];

const LABOUR = {
  id: 'LBR-SEED-0001',
  description: 'تعویض شیلنگ و آزمایش فشار',
  technician: 'استاد کاظمی',
  hours: '6.50',
  hourlyRateMinor: 900_000n,
  totalCostMinor: 5_850_000n,
};

const DIRECT_COST = {
  id: 'MCS-SEED-0004',
  category: 'SERVICE' as const,
  amountMinor: 1_200_000n,
  description: 'هزینه ایاب و ذهاب تعمیرکار',
};

async function main(): Promise<void> {
  console.warn('Seeding maintenance-service…');

  for (const asset of ASSET_REFS) {
    await prisma.assetRef.upsert({
      where: { id: asset.id },
      create: { ...asset, syncedAt: new Date(), sourceEvent: 'SEED' },
      update: { ...asset, syncedAt: new Date(), sourceEvent: 'SEED' },
    });
  }
  console.warn(`  asset references: ${ASSET_REFS.length}`);

  for (const meter of METERS) {
    await prisma.assetUsageMeter.upsert({
      where: { assetId: meter.assetId },
      create: { ...meter, lastPeriodEnd: new Date(now - day), updatedAt: new Date() },
      update: { ...meter, lastPeriodEnd: new Date(now - day), updatedAt: new Date() },
    });
  }
  console.warn(`  usage meters: ${METERS.length}`);

  for (const schedule of SCHEDULES) {
    await prisma.maintenanceSchedule.upsert({
      where: { id: schedule.id },
      create: { ...schedule, createdBy: 'SEED', updatedBy: 'SEED' },
      update: { ...schedule, updatedBy: 'SEED' },
    });
  }
  console.warn(`  schedules: ${SCHEDULES.length}`);

  for (const request of [APPROVED_REQUEST, OPEN_REQUEST]) {
    await prisma.maintenanceRequest.upsert({
      where: { id: request.id },
      create: request,
      update: request,
    });
  }
  console.warn('  requests: 2 (1 approved, 1 open)');

  await prisma.repairOrder.upsert({
    where: { id: REPAIR_ORDER.id },
    create: REPAIR_ORDER,
    update: REPAIR_ORDER,
  });

  // Parts and labour first, then their cost lines: `ck_cost_provenance`
  // requires a PART line to name a real part, which is the whole point of it.
  for (const part of PARTS) {
    await prisma.partUsage.upsert({
      where: { id: part.id },
      create: {
        ...part,
        organizationId: DEH_ONE,
        repairOrderId: REPAIR_ORDER.id,
        recordedAt: new Date(now - 18 * day),
        recordedBy: 'USR-SEED-DEHYARI-ADMIN',
      },
      update: {},
    });
  }

  await prisma.laborEntry.upsert({
    where: { id: LABOUR.id },
    create: {
      ...LABOUR,
      organizationId: DEH_ONE,
      repairOrderId: REPAIR_ORDER.id,
      performedAt: new Date(now - 18 * day),
      recordedAt: new Date(now - 18 * day),
      recordedBy: 'USR-SEED-DEHYARI-ADMIN',
    },
    update: {},
  });

  const costLines = [
    ...PARTS.map((part, index) => ({
      id: `MCS-SEED-000${index + 1}`,
      category: 'PART' as const,
      amountMinor: part.totalCostMinor,
      description: `${part.partName} × ${part.quantity} ${part.unit}`,
      partUsageId: part.id,
      laborEntryId: null,
    })),
    {
      id: 'MCS-SEED-0005',
      category: 'LABOUR' as const,
      amountMinor: LABOUR.totalCostMinor,
      description: LABOUR.description,
      partUsageId: null,
      laborEntryId: LABOUR.id,
    },
    { ...DIRECT_COST, partUsageId: null, laborEntryId: null },
  ];

  for (const line of costLines) {
    await prisma.maintenanceCost.upsert({
      where: { id: line.id },
      create: {
        ...line,
        organizationId: DEH_ONE,
        repairOrderId: REPAIR_ORDER.id,
        maintenanceRequestId: APPROVED_REQUEST.id,
        currency: 'IRR',
        recordedAt: new Date(now - 18 * day),
        recordedBy: 'USR-SEED-DEHYARI-ADMIN',
      },
      update: {},
    });
  }
  console.warn(`  cost lines: ${costLines.length}`);

  // Totals written from the lines, exactly as the service computes them —
  // never typed in by hand. A seed whose totals disagree with its own lines
  // would make the first thing anyone looks at the wrong thing.
  const parts = PARTS.reduce((sum, part) => sum + part.totalCostMinor, 0n);
  const labour = LABOUR.totalCostMinor;
  const other = DIRECT_COST.amountMinor;

  await prisma.repairOrder.update({
    where: { id: REPAIR_ORDER.id },
    data: {
      partsCostMinor: parts,
      labourCostMinor: labour,
      otherCostMinor: other,
      totalCostMinor: parts + labour + other,
    },
  });

  await prisma.maintenanceRequest.update({
    where: { id: APPROVED_REQUEST.id },
    data: { totalCostMinor: parts + labour + other },
  });

  console.warn(`  approved repair total: ${parts + labour + other} IRR (minor units)`);
  console.warn('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
