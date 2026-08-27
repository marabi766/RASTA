/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Demo seed for asset-service.
 *
 * Organization identifiers match organization-service's seed exactly. If the
 * two drift, an asset belongs to an organization the platform has never heard
 * of, and every dossier lookup silently returns nothing.
 *
 * The data is shaped to make the interesting cases reachable without setting
 * them up by hand:
 *
 *   - two organizations, so tenant isolation can be *demonstrated* rather than
 *     asserted — ORG-DEH-0002's grader must be invisible to ORG-DEH-0001;
 *   - one asset with an insurance policy expiring inside the warning window,
 *     so the expiry sweep has something to find on the first run;
 *   - one asset still in REGISTERED with no insurance, so the activation
 *     invariant refuses it and the refusal message can be read;
 *   - coordinates around Yazd, so the radius search returns a believable
 *     ordering instead of an empty list.
 *
 * CONSTRAINT: every value here is illustrative. No real machine, plate,
 * chassis number, insurer or policy exists in this file.
 */

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ASSET;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL or DATABASE_URL_ASSET. ' +
        'Run via `pnpm db:seed`, which loads the repo-root .env.',
    );
  }
  return url;
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const DEH_ONE = 'ORG-DEH-0001';
const DEH_TWO = 'ORG-DEH-0002';
const UNION = 'ORG-UNION-YAZD';

const day = 86_400_000;
const now = Date.now();

interface SeedAsset {
  id: string;
  organizationId: string;
  assetTag: string;
  name: string;
  type: string;
  status: string;
  manufacturer?: string;
  model?: string;
  manufactureYear?: number;
  serialNumber?: string;
  /** Type-specific attributes. Free-form by design: a new AssetType needs no
   *  migration, so plate, capacity and axle count live here rather than as
   *  columns that would be null for most types. */
  specifications?: Record<string, unknown>;
  commissionedAt?: Date;
  location?: {
    siteName: string;
    latitude: number;
    longitude: number;
  };
}

const ASSETS: SeedAsset[] = [
  {
    id: 'AST-SEED-0001',
    organizationId: DEH_ONE,
    assetTag: 'D1-TRK-001',
    name: 'کامیون حمل زباله',
    type: 'WASTE_COLLECTOR',
    status: 'ACTIVE',
    manufacturer: 'نمونه‌سازان',
    model: 'GT-1800',
    manufactureYear: 2019,
    serialNumber: 'SEED-CHASSIS-0001',
    commissionedAt: new Date(now - 400 * day),
    location: { siteName: 'محل دپوی دهیاری', latitude: 31.8501, longitude: 54.2903 },
  },
  {
    id: 'AST-SEED-0002',
    organizationId: DEH_ONE,
    assetTag: 'D1-TRC-002',
    name: 'تراکتور کشاورزی',
    type: 'TRACTOR',
    status: 'IDLE',
    manufacturer: 'نمونه‌سازان',
    model: 'TR-475',
    manufactureYear: 2021,
    serialNumber: 'SEED-CHASSIS-0002',
    commissionedAt: new Date(now - 200 * day),
    location: { siteName: 'انبار مرکزی', latitude: 31.8534, longitude: 54.2971 },
  },
  {
    // Deliberately incomplete: no insurance, no ownership document. Activating
    // it must fail, and the refusal is the point.
    id: 'AST-SEED-0003',
    organizationId: DEH_ONE,
    assetTag: 'D1-LDR-003',
    name: 'لودر (ثبت‌شده، فاقد مدارک)',
    type: 'LOADER',
    status: 'REGISTERED',
    manufacturer: 'نمونه‌سازان',
    model: 'LD-220',
    manufactureYear: 2023,
    serialNumber: 'SEED-CHASSIS-0003',
  },
  {
    // The neighbouring dehyari's machine. Nothing in ORG-DEH-0001 may see it.
    id: 'AST-SEED-0004',
    organizationId: DEH_TWO,
    assetTag: 'D2-GRD-001',
    name: 'گریدر',
    type: 'GRADER',
    status: 'ACTIVE',
    manufacturer: 'نمونه‌سازان',
    model: 'GR-140',
    manufactureYear: 2018,
    serialNumber: 'SEED-CHASSIS-0004',
    commissionedAt: new Date(now - 900 * day),
    location: { siteName: 'کارگاه دهیاری دو', latitude: 31.942, longitude: 54.418 },
  },
  {
    id: 'AST-SEED-0005',
    organizationId: UNION,
    assetTag: 'UN-WTR-001',
    name: 'تانکر آبرسانی اتحادیه',
    type: 'WATER_TANKER',
    status: 'ACTIVE',
    manufacturer: 'نمونه‌سازان',
    model: 'WT-9000',
    manufactureYear: 2020,
    serialNumber: 'SEED-CHASSIS-0005',
    commissionedAt: new Date(now - 150 * day),
    location: { siteName: 'دفتر اتحادیه', latitude: 31.8912, longitude: 54.3502 },
  },
];

interface SeedPolicy {
  id: string;
  assetId: string;
  organizationId: string;
  policyNumber: string;
  insurerName: string;
  coverage: string;
  premiumMinor: bigint;
  validFrom: Date;
  validTo: Date;
}

const POLICIES: SeedPolicy[] = [
  {
    id: 'INS-SEED-0001',
    assetId: 'AST-SEED-0001',
    organizationId: DEH_ONE,
    policyNumber: 'SEED-POL-0001',
    insurerName: 'بیمه نمونه',
    coverage: 'THIRD_PARTY',
    premiumMinor: 45_000_000_00n,
    validFrom: new Date(now - 340 * day),
    // Inside the default 30-day warning window, so the first sweep has work.
    validTo: new Date(now + 21 * day),
  },
  {
    id: 'INS-SEED-0002',
    assetId: 'AST-SEED-0002',
    organizationId: DEH_ONE,
    policyNumber: 'SEED-POL-0002',
    insurerName: 'بیمه نمونه',
    coverage: 'COMPREHENSIVE',
    premiumMinor: 62_000_000_00n,
    validFrom: new Date(now - 100 * day),
    validTo: new Date(now + 265 * day),
  },
  {
    id: 'INS-SEED-0003',
    assetId: 'AST-SEED-0004',
    organizationId: DEH_TWO,
    policyNumber: 'SEED-POL-0003',
    insurerName: 'بیمه نمونه',
    coverage: 'THIRD_PARTY',
    premiumMinor: 88_000_000_00n,
    validFrom: new Date(now - 60 * day),
    validTo: new Date(now + 305 * day),
  },
];

const INSPECTIONS = [
  {
    id: 'INP-SEED-0001',
    assetId: 'AST-SEED-0001',
    organizationId: DEH_ONE,
    certificateNo: 'SEED-INSP-0001',
    centerName: 'مرکز معاینه فنی نمونه',
    inspectedAt: new Date(now - 180 * day),
    validTo: new Date(now + 185 * day),
    result: 'PASSED',
  },
  {
    id: 'INP-SEED-0002',
    assetId: 'AST-SEED-0004',
    organizationId: DEH_TWO,
    certificateNo: 'SEED-INSP-0002',
    centerName: 'مرکز معاینه فنی نمونه',
    inspectedAt: new Date(now - 20 * day),
    validTo: new Date(now + 345 * day),
    result: 'PASSED',
  },
];

/** Organization replica rows. Normally filled by consuming organization events;
 *  seeded here so a fresh database is usable before Kafka has caught up. */
const ORGANIZATION_REFS = [
  { id: DEH_ONE, name: 'دهیاری نمونه یک', type: 'DEHYARI' },
  { id: DEH_TWO, name: 'دهیاری نمونه دو', type: 'DEHYARI' },
  { id: UNION, name: 'اتحادیه دهیاری‌های یزد', type: 'UNION' },
];

async function main(): Promise<void> {
  console.warn('Seeding asset-service…');

  for (const ref of ORGANIZATION_REFS) {
    await prisma.organizationRef.upsert({
      where: { id: ref.id },
      create: { ...ref, status: 'ACTIVE', sourceEvent: 'SEED', syncedAt: new Date() },
      update: { name: ref.name, syncedAt: new Date() },
    });
  }
  console.warn(`  organization refs: ${ORGANIZATION_REFS.length}`);

  for (const asset of ASSETS) {
    await prisma.asset.upsert({
      where: { id: asset.id },
      create: {
        id: asset.id,
        organizationId: asset.organizationId,
        assetTag: asset.assetTag,
        name: asset.name,
        type: asset.type as never,
        status: asset.status as never,
        manufacturer: asset.manufacturer ?? null,
        model: asset.model ?? null,
        manufactureYear: asset.manufactureYear ?? null,
        serialNumber: asset.serialNumber ?? null,
        specifications: (asset.specifications ?? {}) as object,
        commissionedAt: asset.commissionedAt ?? null,
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      // Only the mutable descriptive fields. Re-running the seed must not
      // rewind a status somebody changed while exploring the system.
      update: { name: asset.name, model: asset.model ?? null },
    });

    if (asset.location) {
      const locationId = `ALC-SEED-${asset.id.slice(-4)}`;
      await prisma.assetLocation.upsert({
        where: { id: locationId },
        create: {
          id: locationId,
          assetId: asset.id,
          organizationId: asset.organizationId,
          siteName: asset.location.siteName,
          source: 'MANUAL',
          isCurrent: true,
          recordedBy: 'SEED',
        },
        update: { siteName: asset.location.siteName },
      });

      // Prisma cannot write the `Unsupported` geography column, so the point is
      // set with raw SQL. Longitude first — reversing the pair is the classic
      // PostGIS mistake and would put Yazd in the Indian Ocean.
      await prisma.$executeRawUnsafe(
        `UPDATE asset_location
         SET point = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
         WHERE id = $3`,
        asset.location.longitude,
        asset.location.latitude,
        locationId,
      );
    }
  }
  console.warn(`  assets: ${ASSETS.length} (one deliberately missing its documents)`);

  for (const policy of POLICIES) {
    await prisma.insurancePolicy.upsert({
      where: { id: policy.id },
      create: {
        id: policy.id,
        assetId: policy.assetId,
        organizationId: policy.organizationId,
        policyNumber: policy.policyNumber,
        insurerName: policy.insurerName,
        coverage: policy.coverage as never,
        premiumMinor: policy.premiumMinor,
        validFrom: policy.validFrom,
        validTo: policy.validTo,
        status: 'ACTIVE',
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      update: { validTo: policy.validTo, status: 'ACTIVE' },
    });
  }
  console.warn(`  insurance policies: ${POLICIES.length} (one expires within 21 days)`);

  for (const inspection of INSPECTIONS) {
    await prisma.technicalInspection.upsert({
      where: { id: inspection.id },
      create: {
        id: inspection.id,
        assetId: inspection.assetId,
        organizationId: inspection.organizationId,
        certificateNo: inspection.certificateNo,
        centerName: inspection.centerName,
        inspectedAt: inspection.inspectedAt,
        validTo: inspection.validTo,
        result: inspection.result as never,
        createdBy: 'SEED',
      },
      update: { validTo: inspection.validTo },
    });
  }
  console.warn(`  inspections: ${INSPECTIONS.length}`);

  console.warn('Asset seed complete.');
}

main()
  .catch((error) => {
    console.error('Asset seed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
