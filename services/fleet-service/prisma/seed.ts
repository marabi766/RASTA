/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Demo seed for fleet-service.
 *
 * Identifiers match the other services' seeds exactly — organizations from
 * organization-service, users from identity-service, assets from
 * asset-service. If they drift, an assignment points at a machine or a person
 * the platform has never heard of, and every fleet screen silently shows
 * nothing.
 *
 * The data is shaped to make the interesting cases reachable without setting
 * them up by hand:
 *
 *   - two organizations, so tenant isolation can be *demonstrated* rather than
 *     asserted — ORG-DEH-0002's driver must be invisible to ORG-DEH-0001;
 *   - one machine with an active assignment and one free, so the availability
 *     endpoint returns both answers on its first call;
 *   - a closed assignment alongside the open one, so the partial unique index
 *     is visibly not blocking history;
 *   - usage records over the past fortnight, so utilization returns a real
 *     percentage rather than the null it correctly reports for an empty window.
 *
 * `asset_ref` is seeded too. In a running system it is built by the event
 * consumer from `ASSET_*`, but a seeded database has no Kafka history to
 * replay, and without it every assignment here would be refused for naming an
 * unknown machine.
 *
 * CONSTRAINT: every value here is illustrative. No real person, licence,
 * machine or reading exists in this file.
 */

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_FLEET;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL or DATABASE_URL_FLEET. ' +
        'Run via `pnpm db:seed`, which loads the repo-root .env.',
    );
  }
  return url;
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const DEH_ONE = 'ORG-DEH-0001';
const DEH_TWO = 'ORG-DEH-0002';

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
    // Still REGISTERED: its dossier is incomplete, so the assignment path
    // must refuse it. That refusal is worth being able to demonstrate.
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

/** Mirrors identity-service's seeded users. */
const DRIVERS = [
  {
    id: 'DRV-SEED-0001',
    organizationId: DEH_ONE,
    // The seeded operator.one, who holds OPERATOR and DRIVER. This link is
    // what makes the object-level authorization path demonstrable: signed in
    // as this user, only their own record and assignment are visible.
    userId: 'USR-SEED-OPERATOR-ONE',
    employeeNo: 'OP-104',
    licenceClass: 'پایه یکم',
    licenceValidTo: new Date(now + 400 * day),
    status: 'ACTIVE' as const,
  },
  {
    id: 'DRV-SEED-0002',
    organizationId: DEH_ONE,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    employeeNo: 'OP-108',
    licenceClass: 'پایه دوم',
    licenceValidTo: new Date(now + 120 * day),
    status: 'ACTIVE' as const,
  },
  {
    // The other tenant's driver. Present so tenant isolation can be shown
    // against a real row rather than an empty set.
    id: 'DRV-SEED-0003',
    organizationId: DEH_TWO,
    userId: 'USR-SEED-DEHYARI2-ADMIN',
    employeeNo: 'OP-201',
    licenceClass: 'پایه یکم',
    licenceValidTo: new Date(now + 300 * day),
    status: 'ACTIVE' as const,
  },
];

const ASSIGNMENTS = [
  {
    // Open. AST-SEED-0001 is therefore not dispatchable, and the availability
    // endpoint reports ACTIVE_ASSIGNMENT as the blocker.
    id: 'ASG-SEED-0001',
    organizationId: DEH_ONE,
    driverId: 'DRV-SEED-0001',
    assetId: 'AST-SEED-0001',
    startedAt: new Date(now - 2 * day),
    endedAt: null as Date | null,
    purpose: 'تسطیح معابر روستا',
    endReason: null as string | null,
  },
  {
    // Closed. Proves the exclusivity index is partial: the same driver could
    // take another machine tomorrow, and this row does not stand in the way.
    id: 'ASG-SEED-0002',
    organizationId: DEH_ONE,
    driverId: 'DRV-SEED-0002',
    assetId: 'AST-SEED-0002',
    startedAt: new Date(now - 12 * day),
    endedAt: new Date(now - 9 * day),
    purpose: 'بارگیری مصالح',
    endReason: 'COMPLETED' as string | null,
  },
  {
    id: 'ASG-SEED-0003',
    organizationId: DEH_TWO,
    driverId: 'DRV-SEED-0003',
    assetId: 'AST-SEED-0004',
    startedAt: new Date(now - 1 * day),
    endedAt: null as Date | null,
    purpose: 'گودبرداری',
    endReason: null as string | null,
  },
];

/**
 * A fortnight of readings on the two machines that have been worked.
 *
 * Hours and kilometres are both present where the machine type makes both
 * meaningful, and hour-meter readings climb monotonically — which is what a
 * usage-based maintenance schedule reads.
 */
function usageRecords() {
  const records: {
    id: string;
    organizationId: string;
    assetId: string;
    driverId: string;
    assignmentId: string | null;
    periodStart: Date;
    periodEnd: Date;
    hours: string;
    kilometres: string | null;
    hourMeter: string;
    source: 'MANUAL';
    recordedBy: string;
  }[] = [];

  let graderMeter = 1180;
  for (let i = 10; i >= 1; i -= 1) {
    const start = new Date(now - i * day - 8 * 3600_000);
    const hours = 6 + (i % 3);
    graderMeter += hours;

    records.push({
      id: `USG-SEED-G${String(11 - i).padStart(2, '0')}`,
      organizationId: DEH_ONE,
      assetId: 'AST-SEED-0001',
      driverId: 'DRV-SEED-0001',
      assignmentId: i <= 2 ? 'ASG-SEED-0001' : null,
      periodStart: start,
      periodEnd: new Date(start.getTime() + hours * 3600_000),
      hours: hours.toFixed(2),
      kilometres: null,
      hourMeter: graderMeter.toFixed(2),
      source: 'MANUAL',
      recordedBy: 'SEED',
    });
  }

  let loaderMeter = 640;
  for (let i = 12; i >= 9; i -= 1) {
    const start = new Date(now - i * day - 7 * 3600_000);
    const hours = 4 + (i % 2);
    loaderMeter += hours;

    records.push({
      id: `USG-SEED-L${String(13 - i).padStart(2, '0')}`,
      organizationId: DEH_ONE,
      assetId: 'AST-SEED-0002',
      driverId: 'DRV-SEED-0002',
      assignmentId: 'ASG-SEED-0002',
      periodStart: start,
      periodEnd: new Date(start.getTime() + hours * 3600_000),
      hours: hours.toFixed(2),
      kilometres: (hours * 3).toFixed(2),
      hourMeter: loaderMeter.toFixed(2),
      source: 'MANUAL',
      recordedBy: 'SEED',
    });
  }

  return records;
}

async function main(): Promise<void> {
  console.warn('Seeding fleet-service…');

  for (const ref of ASSET_REFS) {
    await prisma.assetRef.upsert({
      where: { id: ref.id },
      create: { ...ref, syncedAt: new Date(), sourceEvent: 'SEED' },
      update: { ...ref, syncedAt: new Date(), sourceEvent: 'SEED' },
    });
  }
  console.warn(`  asset references: ${ASSET_REFS.length}`);

  for (const driver of DRIVERS) {
    await prisma.driver.upsert({
      where: { id: driver.id },
      create: { ...driver, createdBy: 'SEED', updatedBy: 'SEED' },
      update: { ...driver, updatedBy: 'SEED' },
    });
  }
  console.warn(`  drivers: ${DRIVERS.length}`);

  for (const assignment of ASSIGNMENTS) {
    await prisma.assignment.upsert({
      where: { id: assignment.id },
      create: { ...assignment, assignedBy: 'SEED', endedBy: assignment.endedAt ? 'SEED' : null },
      update: { ...assignment, endedBy: assignment.endedAt ? 'SEED' : null },
    });
  }
  const open = ASSIGNMENTS.filter((a) => a.endedAt === null).length;
  console.warn(`  assignments: ${ASSIGNMENTS.length} (${open} open)`);

  const records = usageRecords();
  for (const record of records) {
    await prisma.usageRecord.upsert({
      where: { id: record.id },
      create: record,
      update: record,
    });
  }
  console.warn(`  usage records: ${records.length}`);

  console.warn('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
